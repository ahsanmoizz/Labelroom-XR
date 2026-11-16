// Live integration: normal Auth and caller-owned APIs only. No service key,
// privileged SQL, CAPTCHA token, fake backend/provider, retries or budget resets.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {buildSync} from 'esbuild';
import {createClient} from '@supabase/supabase-js';
const args=process.argv.slice(2),output=args[0];
assert(output&&path.isAbsolute(output)&&!fs.existsSync(output),'Pass a new absolute output directory.');
const option=name=>{const at=args.indexOf(name);return at<0?undefined:args[at+1];};
const runAi=args.includes('--run-ai')||args.includes('--extended-ai'),extended=args.includes('--extended-ai');
const base='https://aawwmcbhyyokkhhvcfmv.supabase.co',origin='https://guest-staging.labelroom-xr.pages.dev';
const publicKey='sb_publishable_gpgueoI1SaEgmRSnlYWj0w_sLICFemf';
const config={supabaseUrl:base,supabasePublishableKey:publicKey,appOrigin:origin};
const report={schema:'labelxr-live-staging-integration/v1',startedAt:new Date().toISOString(),commit:process.env.GITHUB_SHA||null,backend:base,passed:false,checks:[],normalAuthApi:true,syntheticBackend:false,syntheticProvider:false,browserUiTested:false,physicalQuestTested:false,productionAuthTested:false,hostedDatabaseBackupTested:false,modelStepRequests:0,ai:{requested:runAi,extendedRequested:extended,turns:[]}};
fs.mkdirSync(output,{recursive:true});const temp=fs.mkdtempSync(path.join(os.tmpdir(),'labelxr-live-integration-'));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),encoded=value=>new TextEncoder().encode(JSON.stringify(value));
const mark=name=>{report.checks.push({name,passed:true});console.log(JSON.stringify({check:name,passed:true}));};
let client,second,analysis;
const fetcher=async(input,init={})=>{const url=new URL(input instanceof Request?input.url:String(input));assert.equal(url.origin,base,'Unexpected service origin.');const headers=new Headers(init.headers??(input instanceof Request?input.headers:undefined));headers.set('Origin',origin);if(url.pathname==='/functions/v1/agent'&&init.body){try{if(JSON.parse(init.body).operation==='step')report.modelStepRequests++;}catch{}}return fetch(input,{...init,headers,redirect:'error',signal:init.signal??AbortSignal.timeout(40000)});};
const makeClient=()=>createClient(base,publicKey,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:fetcher}});
async function request(pathname,token,body){const r=await fetcher(base+pathname,{method:body===undefined?'GET':'POST',headers:{apikey:publicKey,Authorization:'Bearer '+token,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});let value;try{value=await r.json();}catch{}return{status:r.status,value};}
const signal=()=>AbortSignal.timeout(240000);
try{
 const modules={
  'src/services/projects.ts':['createGuestDemoService','createProjectsService','createSupabaseGuestProjectsSessions','createSupabaseProjectsSessions'],
  'src/services/review-snapshots.ts':['createReviewSnapshotService','createSupabaseReviewSnapshotSessions'],
  'src/services/reviews.ts':['createReviewService','createSupabaseReviewSessions'],
  'src/domain/review-actions.ts':['manualReviewCommand','keepReviewCommand','duplicateReviewCommand','selectedBox'],
  'src/domain/revision.ts':['validateReviewCommand'],
  'src/data/export.ts':['exportBundleBytes'],'src/data/bundle.ts':['loadBundleBytes'],
  'src/services/analysis.ts':['createReviewAnalysisClient'], 'src/workers/review.worker.ts':['createReviewWorkerEngine'],
  'src/services/agent.ts':['createAgentService','runAgentTurn'],'src/ai/tools.ts':['createInspectionTools'],'src/ai/protocol.ts':['AI_SCHEMA']
 };
 const entry=Object.entries(modules).map(([file,names])=>'export {'+names.join(',')+'} from '+JSON.stringify(path.resolve(file))+';').join('\n');
 buildSync({stdin:{contents:entry,resolveDir:process.cwd()},bundle:true,format:'esm',platform:'node',target:'esnext',outfile:path.join(temp,'api.mjs'),logLevel:'silent'});
 const api=await import(pathToFileURL(path.join(temp,'api.mjs')).href);
 client=makeClient();let auth;
 if(option('--session-file')){const p=path.resolve(option('--session-file')),st=fs.lstatSync(p);assert(st.isFile()&&!st.isSymbolicLink()&&st.size<65536);const session=JSON.parse(fs.readFileSync(p,'utf8'));auth=await client.auth.setSession({access_token:session.access_token,refresh_token:session.refresh_token});}
 else auth=await client.auth.signInAnonymously();
 assert(!auth.error&&auth.data.session,'Normal Auth sign-in or session recovery failed.');
 const verified=await client.auth.getUser();assert(!verified.error&&verified.data.user?.role==='authenticated','Remote identity verification failed.');
 const owner=verified.data.user.id,guest=verified.data.user.is_anonymous===true;report.identitySha256=hash(owner);report.anonymous=guest;
 if(extended)assert(!guest&&option('--project-id'),'Extended evaluation requires one legitimate permanent account and its existing test project; guest limits are never bypassed.');
 mark('Normal Auth API and remote getUser verified');
 const guestService=api.createGuestDemoService(client,config,fetcher);
 const projects=api.createProjectsService((guest?api.createSupabaseGuestProjectsSessions:api.createSupabaseProjectsSessions)(client,config,fetcher));
 const opened=guest?await guestService.open(owner,signal()):await projects.open(option('--project-id'),signal());
 assert(guest?opened.project.current_revision===0:true,'A fresh disposable revision-zero guest is required.');
 const original=opened.original,scope={ownerId:owner,projectId:opened.project.id,sourceBundleSha256:original.bundleSha256};
 report.source={sha256:original.bundleSha256,bytes:original.getOriginalZipBytes().length,frames:original.frames.length,kind:original.manifest.source.kind};
 fs.writeFileSync(path.join(output,'original.lrx.zip'),original.getOriginalZipBytes(),{flag:'wx'});
 mark('Real licensed source downloaded and independently parsed');
 const snapshots=api.createReviewSnapshotService(api.createSupabaseReviewSnapshotSessions(client,config,fetcher,guest?'demo':'private'));
 const reviews=api.createReviewService(api.createSupabaseReviewSessions(client,config,fetcher,guest?'demo':'private'));
 let snapshot=await snapshots.load(scope,original,signal());const initialRevision=snapshot.revision,initialLabels=structuredClone(snapshot.labelsDocument);
 // Same production worker engine and client-side response validators, in a
 // Node event adapter. This is measured geometry, not a browser Worker test.
 function worker(){const engine=api.createReviewWorkerEngine(),listeners=new Map();let closed=false;return{postMessage(value){queueMicrotask(()=>{if(closed)return;try{const data=engine.handle(value);for(const fn of listeners.get('message')??[])fn({data});}catch(error){for(const fn of listeners.get('error')??[])fn(error);}});},addEventListener(type,fn){if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type).add(fn);},removeEventListener(type,fn){listeners.get(type)?.delete(fn);},terminate(){closed=true;engine.clear();listeners.clear();}};}
 analysis=api.createReviewAnalysisClient({createWorker:worker,timeoutMs:60000});
 const allIssues=[];for(const frame of snapshot.frames){await analysis.setFrame(snapshot,frame.id);let cursor=0;for(;;){const page=await analysis.listIssues(cursor,10);allIssues.push(...page.issues);if(page.next===null)break;cursor=page.next;}}
 report.measuredIssues=Object.fromEntries(['LOW_SUPPORT','DUPLICATE','DIMENSION_JUMP'].map(type=>[type,allIssues.filter(x=>x.type===type).length]));mark('Actual source points measured with production geometry engine');
 if(runAi){try{
  const service=api.createAgentService(client,config,owner,fetcher),aiScope=()=>({projectId:scope.projectId,sourceBundleSha256:scope.sourceBundleSha256,revision:snapshot.revision});
  const availability=await service.request({schema:api.AI_SCHEMA,operation:'context',...aiScope()},signal());assert(availability.kind==='context'&&availability.enabled,'Live AI is disabled in staging.');
  await service.request({schema:api.AI_SCHEMA,operation:'consent',...aiScope(),enabled:true},signal());
  const stepsBefore=report.modelStepRequests;
  const target=snapshot.frames[0].boxes[0],frame=snapshot.frames[0];
  const families=[['LOW_SUPPORT','inspectBoxSupport','Measure the selected box point support. Explain uncertainty; sparse support alone does not prove a label is wrong.'],['DUPLICATE','listIssues','List the measured issues for this frame, including any potential duplicate. Do not remove an object or change labels.'],['DIMENSION_JUMP','compareTrack','Compare this track across neighbouring frames using the measurement tool. A dimension change is a review candidate, not proof of a wrong label.'],['SPARSE_VALID','proposeFit','Measure whether a safe fit is possible. If evidence is sparse, occluded or ambiguous, refuse an automatic change.']];
  const plan=extended?[...families.flatMap(f=>Array.from({length:5},()=>({family:f,evaluation:true}))),...Array.from({length:10},()=>({family:families[0],evaluation:false}))]:families.slice(0,3).map(f=>({family:f,evaluation:false}));
  if(extended){const session=(await client.auth.getSession()).data.session;const budget=await request('/rest/v1/daily_budget?select=turns&scope=eq.user&owner_id=eq.'+owner+'&day=eq.'+new Date().toISOString().slice(0,10),session.access_token);assert.equal(budget.status,200);assert.equal(budget.value.reduce((n,x)=>n+x.turns,0),0,'Thirty evaluation turns require a full remaining member budget; wait for its normal UTC reset.');}
  for(const [index,item]of plan.entries()){
   const [family,expectedTool,task]=item.family,candidate=allIssues.find(x=>x.type===family),frameId=candidate?.frameId??frame.id,objectId=candidate?.objectIds[0]??target.id;
   const evidence=[],turn={index:index+1,family,evaluation:item.evaluation,passed:false,tools:[]};report.ai.turns.push(turn);const before=JSON.stringify(snapshot.labelsDocument),revision=snapshot.revision;
   const tools=api.createInspectionTools({snapshot,current:()=>true,analysis,signal:signal(),focus:(f,o)=>snapshot.frames.some(x=>x.id===f&&x.boxes.some(b=>b.id===o))});
   try{const answer=await api.runAgentTurn({service,scope:aiScope(),frameId,objectId,task,turnId:randomUUID(),signal:signal(),current:()=>true,execute:call=>tools.execute(call),evidence:value=>evidence.push(value)});turn.tools=evidence.map(x=>x.call.name);turn.expectedTool=expectedTool;turn.traceableCitations=answer.evidenceIds.every(id=>evidence.some(x=>x.call.id===id));turn.assessment=answer.assessment;turn.measurements=evidence;turn.passed=turn.traceableCitations&&turn.tools.includes(expectedTool);}
   catch(error){turn.error=error.code||'turn-failed';}
   snapshot=await snapshots.load(scope,original,signal());assert.equal(snapshot.revision,revision,'AI changed a saved revision.');assert.equal(JSON.stringify(snapshot.labelsDocument),before,'AI changed saved labels.');turn.noAutomaticEdit=true;
   if(!turn.passed){report.ai.stoppedAt=index+1;break;} // No retries or replacement turns.
  }
  await service.request({schema:api.AI_SCHEMA,operation:'consent',...aiScope(),enabled:false},signal());
  report.ai.completedTurns=report.ai.turns.length;report.ai.modelStepRequests=report.modelStepRequests-stepsBefore;
  report.ai.passed=report.ai.turns.length===plan.length&&report.ai.turns.every(x=>x.passed);
  report.ai.extendedPassed=extended&&report.ai.passed;report.ai.consentRevoked=true;
  if(report.ai.passed)mark(extended?'20 measured evaluation requests and 10 rehearsals passed':'Three bounded live AI tool turns passed without edits');
 }catch(error){report.ai.passed=false;report.ai.error=String(error.message).slice(0,300);}}
 const frame=snapshot.frames[0],object=frame.boxes[0],values=api.selectedBox(snapshot,frame.id,object.id),first=api.manualReviewCommand(snapshot,frame.id,object.id,{...values,x:values.x+.01},'other',randomUUID()),firstBytes=encoded(first),firstContext=snapshot.contextFor();
 await api.validateReviewCommand(firstBytes,firstContext);const rejected=await snapshots.load(scope,original,signal());assert.equal(rejected.revision,initialRevision);assert.deepEqual(rejected.labelsDocument,initialLabels);mark('Validated preview discarded without a hosted revision');
 const receipt=await reviews.commit(firstBytes,firstContext,signal());snapshot=await snapshots.load(scope,original,signal());assert.equal(snapshot.revision,initialRevision+1);assert.equal(api.selectedBox(snapshot,frame.id,object.id).x,values.x+.01);mark('One acknowledged manual change saved atomically');
 const replay=await reviews.commit(firstBytes,snapshot.contextFor(first),signal());assert.deepEqual(replay,receipt);assert.equal((await snapshots.load(scope,original,signal())).revision,snapshot.revision);mark('Identical request replay produced no additional revision');
 let conflict=false;try{await reviews.commit(encoded({...first,requestId:randomUUID()}),firstContext,signal());}catch(error){conflict=error.code==='CONFLICT';}assert(conflict,'Stale save did not produce the expected conflict.');mark('Stale writer rejected without a lost update');
 const low=allIssues.find(x=>x.type==='LOW_SUPPORT');assert(low,'No measured keep candidate.');
 const keep=await api.keepReviewCommand(snapshot,low.frameId,low.objectIds[0],{type:low.type,objectIds:low.objectIds},'occlusion',randomUUID());const beforeKeep=structuredClone(snapshot.labelsDocument);await reviews.commit(encoded(keep),snapshot.contextFor(),signal());snapshot=await snapshots.load(scope,original,signal());assert.deepEqual(snapshot.labelsDocument,beforeKeep);mark('Reasoned keep saved while preserving geometry');
 const dupe=allIssues.find(x=>x.type==='DUPLICATE');assert(dupe,'No measured duplicate candidate.');
 const command=api.duplicateReviewCommand(snapshot,{projectId:scope.projectId,sourceBundleSha256:scope.sourceBundleSha256,revision:snapshot.revision,frameId:dupe.frameId,objectId:dupe.objectIds[0],partnerId:dupe.objectIds[1]},randomUUID());
 await reviews.commit(encoded(command),snapshot.contextFor(),signal());snapshot=await snapshots.load(scope,original,signal());assert(!snapshot.frames.find(f=>f.id===dupe.frameId).boxes.some(b=>b.id===dupe.objectIds[0]));mark('Explicit duplicate confirmation removed only the selected occurrence');
 async function exportSaved(name){const audit=await snapshots.audit(snapshot,signal()),bytes=await api.exportBundleBytes(original,snapshot.exportState(audit)),imported=await api.loadBundleBytes(bytes);assert.deepEqual(imported.labelsDocument,snapshot.labelsDocument);for(const f of original.manifest.frames)assert.equal(hash(imported.getMemberBytes(f.pcd)),hash(original.getMemberBytes(f.pcd)));fs.writeFileSync(path.join(output,name),bytes,{flag:'wx'});return hash(bytes);}
 report.savedExportSha256=await exportSaved('saved-export.lrx.zip');mark('Saved revision exported and reimported with unchanged point bytes');
 const last=snapshot.mutations.at(-1),undo={projectId:scope.projectId,requestId:randomUUID(),baseRevision:snapshot.revision,operation:'undo',undoOf:last.request_id,frameId:last.frame_id,objectId:last.object_id,reason:'other'};
 await reviews.commit(encoded(undo),snapshot.contextFor(),signal());snapshot=await snapshots.load(scope,original,signal());assert.deepEqual(snapshot.labelsDocument,beforeKeep);report.undoExportSha256=await exportSaved('undo-export.lrx.zip');mark('Last-edit undo restored the exact preceding labels and exported');
 const token=(await client.auth.getSession()).data.session.access_token;
 const direct=await request('/rest/v1/label_versions',token,{project_id:scope.projectId,revision:snapshot.revision+1,label_doc:snapshot.labelsDocument});assert.equal(direct.status,403);assert.equal(direct.value?.code,'42501');mark('Client cannot insert versions directly');
 second=makeClient();const authB=await second.auth.signInAnonymously();assert(!authB.error&&authB.data.session);const whoB=await second.auth.getUser();assert(!whoB.error&&whoB.data.user?.is_anonymous&&whoB.data.user.id!==owner);const bDemo=await api.createGuestDemoService(second,config,fetcher).open(whoB.data.user.id,signal());assert.notEqual(bDemo.project.id,scope.projectId);const bToken=authB.data.session.access_token;
 for(const [table,filter]of[['projects','id'],['label_versions','project_id'],['mutations','project_id']]){
  const denied=await request('/rest/v1/'+table+'?select='+(table==='projects'?'id':'project_id')+'&'+filter+'=eq.'+scope.projectId+'&limit=1',bToken);assert.equal(denied.status,200);assert.deepEqual(denied.value,[]);}
 const deniedSource=await request('/storage/v1/object/authenticated/project-data/'+owner+'/'+scope.projectId+'/original.lrx.zip',bToken);assert([400,403,404].includes(deniedSource.status));assert(['NoSuchKey','not_found','Unauthorized','ObjectNotFound','403','404'].includes(String(deniedSource.value?.code??deniedSource.value?.error??deniedSource.value?.statusCode)),'Storage denial did not identify a normal authorization/not-found result.');
 mark('Two independently verified guests retain owner-only project/version/audit access');
 if(guest){const oldId=scope.projectId,reset=await guestService.reset(owner,oldId,signal());assert.notEqual(reset.project.id,oldId);assert.equal(reset.project.current_revision,0);assert.equal(reset.original.bundleSha256,original.bundleSha256);const retired=await request('/rest/v1/projects?select=id&id=eq.'+oldId+'&limit=1',token);assert.equal(retired.status,200);assert.deepEqual(retired.value,[]);mark('Confirmed guest reset retired the old project and loaded unchanged revision-zero source');}
 report.finalSavedRevision=initialRevision+4;report.passed=(!runAi||report.ai.passed===true);if(!report.passed)report.error='live-ai-evaluation-incomplete';
}catch(error){report.error=String(error.message).slice(0,500);process.exitCode=1;}
finally{
 analysis?.dispose();if(client){try{const out=await client.auth.signOut({scope:'local'});report.signOutCompleted=!out.error;}catch{report.signOutCompleted=false;}}if(second){try{await second.auth.signOut({scope:'local'});}catch{}}
 report.finishedAt=new Date().toISOString();fs.writeFileSync(path.join(output,'live-staging-report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});fs.rmSync(temp,{recursive:true,force:true});console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,aiTurns:report.ai.turns.length,error:report.error}));if(!report.passed)process.exitCode=1;
}
