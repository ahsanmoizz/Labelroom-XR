// Real browser storage, SDK auth and application/review controllers; synthetic cloud and scene.
import * as api from './bridge.mjs';
const ownerA='22222222-2222-4222-8222-222222222222',ownerB='33333333-3333-4333-8333-333333333333',project='00000000-0000-4000-8000-000000000002';
const rid=n=>'99999999-9999-4999-8999-'+String(n).padStart(12,'0'),clone=structuredClone,json=v=>new TextEncoder().encode(JSON.stringify(v));
const assert={equal(a,b){if(a!==b)throw Error('Synthetic revision differs')}};
const stored=(key,fallback)=>{const raw=localStorage.getItem(key);return raw===null?fallback:JSON.parse(raw)};
const counts=stored('synthetic-reload-counts',{provisions:0,projectReads:0,commits:0,resets:0,worlds:0,aiContexts:0,modelCalls:0,consentWrites:0});
const count=k=>{counts[k]++;localStorage.setItem('synthetic-reload-counts',JSON.stringify(counts))};
let owner=stored('synthetic-reload-owner',ownerA),deny=false,first=true,release;
const held=new Promise(r=>{release=r});
const raw=new Uint8Array(await(await fetch('/source.zip')).arrayBuffer()),members=api.unzipSync(raw);
const manifest=JSON.parse(new TextDecoder().decode(members['manifest.json'])),labels=JSON.parse(new TextDecoder().decode(members['labels.openlabel.json']));
const old=manifest.frames[0],firstId=old.id;
manifest.frames.push({...old,id:'1',timestamp:.1,pcd:'frames/001.pcd'});members['frames/001.pcd']=members[old.pcd];
labels.openlabel.frames['1']=clone(labels.openlabel.frames[firstId]);labels.openlabel.frames['1'].frame_properties.timestamp=.1;
members['labels.openlabel.json']=json(labels);manifest.hashes['labels.openlabel.json']=[...new Uint8Array(await crypto.subtle.digest('SHA-256',members['labels.openlabel.json']))].map(x=>x.toString(16).padStart(2,'0')).join('');members['manifest.json']=json(manifest);
const source=await api.loadBundleBytes(api.zipSync(members,{mtime:new Date('2026-01-01T00:00:00Z')}));
const scope={ownerId:owner,projectId:project,sourceBundleSha256:source.bundleSha256};
function backend(original=source,sc=scope,initial){let revision=initial?.revision??0,calls=initial?.calls??0,reads=0;const versions=clone(initial?.versions??[original.labelsDocument]),verdicts=clone(initial?.verdicts??[{}]),history=clone(initial?.history??[]),details=clone(initial?.details??[]),receipts=new Map(clone(initial?.receipts??[])),received=[];
 const head=()=>({id:sc.projectId,owner_id:sc.ownerId,status:'ready',source_hash:sc.sourceBundleSha256,source_bytes:original.getOriginalZipBytes().length,current_revision:revision}),version=()=>({project_id:sc.projectId,revision,label_doc:clone(versions[revision]),review_verdicts:clone(verdicts[revision])});
 const snapshot=()=>api.validateReviewSnapshot(sc,original,head(),version(),clone(history));
 const commit=async(bytes,context)=>{calls++;received.push(new Uint8Array(bytes));const command=JSON.parse(new TextDecoder().decode(bytes));if(receipts.has(command.requestId))return clone(receipts.get(command.requestId));const proof=await api.validateReviewCommand(bytes,snapshot().contextFor(command));assert.equal(command.baseRevision,revision);let doc=clone(versions[revision]),verdict=clone(verdicts[revision]);const objects=()=>doc.openlabel.frames[command.frameId].objects;
  if(command.operation==='updateCuboid')objects()[command.objectId].object_data.cuboid[0].val=command.after;
  if(command.operation==='removeDuplicate')delete objects()[command.objectId];
  if(command.operation==='keepIssue')verdict[command.fingerprint]={frameId:command.frameId,objectId:command.objectId,reason:command.reason};
  if(command.operation==='undo'){doc=clone(versions[revision-1]);verdict=clone(verdicts[revision-1])}
  const previous=history[history.length-1],oldDoc=versions[revision],beforeDoc=command.operation==='updateCuboid'?command.before:command.operation==='removeDuplicate'?clone(oldDoc.openlabel.frames[command.frameId].objects[command.objectId]):command.operation==='undo'?clone(details[details.length-1].after_doc):clone(verdicts[revision][command.fingerprint]??null),afterDoc=command.operation==='updateCuboid'?command.after:command.operation==='removeDuplicate'?null:command.operation==='undo'?clone(details[details.length-1].before_doc):clone(verdict[command.fingerprint]);revision++;const row={id:rid(1000+revision),request_id:command.requestId,project_id:sc.projectId,revision,owner_id:sc.ownerId,operation:command.operation,frame_id:command.frameId,object_id:command.objectId,partner_id:command.partnerId??null,reason:command.reason,payload_hash:proof.payloadSha256,undo_of:command.operation==='undo'?previous.id:null,created_at:'2026-11-02T00:00:00.000Z'};history.push(row);details.push({...clone(row),before_doc:beforeDoc,after_doc:afterDoc});versions.push(doc);verdicts.push(verdict);const ack={projectId:sc.projectId,sourceBundleSha256:sc.sourceBundleSha256,requestId:command.requestId,payloadSha256:proof.payloadSha256,revision,mutationId:row.id,operation:command.operation,frameId:command.frameId,objectId:command.objectId};receipts.set(command.requestId,ack);return clone(ack);
 };
 return{dump:()=>({revision,calls,versions:clone(versions),verdicts:clone(verdicts),history:clone(history),details:clone(details),receipts:[...receipts]}),head,version,snapshot,commit,history,details,received,audit:async s=>json({schema:'labelxr-review-audit/v1',projectId:sc.projectId,sourceBundleSha256:sc.sourceBundleSha256,revision:s.revision,mutations:clone(details.filter(d=>d.revision<=s.revision))}),get revision(){return revision},get calls(){return calls},get reads(){return reads},async load(){reads++;return snapshot()}};
}
const model=backend(source,scope,stored('synthetic-reload-server',undefined));
const user=()=>({id:owner,role:'authenticated',is_anonymous:stored('synthetic-reload-kind','guest')==='guest',email:'member@example.com',aud:'authenticated',app_metadata:{provider:'anonymous',providers:['anonymous']},user_metadata:{},created_at:'2026-01-01T00:00:00Z'});
const encode=v=>btoa(JSON.stringify(v)).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
const expiry=Math.floor(Date.now()/1000)+3600;
if(!localStorage.getItem('synthetic-reload-signed-out'))localStorage.setItem('synthetic-reload-session',JSON.stringify({access_token:encode({alg:'HS256',typ:'JWT'})+'.'+encode({sub:owner,role:'authenticated',exp:expiry})+'.c3ludGhldGlj',refresh_token:'synthetic-refresh',expires_at:expiry,expires_in:3600,token_type:'bearer',user:user()}));
const client=api.createClient('https://reload-fixture.supabase.co','sb_publishable_synthetic_reload',{auth:{storageKey:'synthetic-reload-session',persistSession:true,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:async(input,init)=>{
 const url=new URL(typeof input==='string'?input:input.url??String(input));
 if(url.origin!=='https://reload-fixture.supabase.co')throw Error('Unexpected auth destination');
 if(url.pathname==='/auth/v1/user'){if(first){first=false;await held;}return deny?Response.json({code:'bad_jwt'},{status:401}):Response.json(user())}
 if(url.pathname==='/auth/v1/logout'){localStorage.setItem('synthetic-reload-signed-out','true');return new Response(null,{status:204})}
 throw Error('Unexpected auth request');
}}});
let review;
const result=()=>({original:source,project:model.head(),labels:{document:model.version().label_doc}});
const service={async open(id){count('projectReads');if(id!==project||localStorage.getItem('synthetic-reload-fail-open'))throw Error('Synthetic source unavailable');return result()},async list(){return[model.head()]},async create(){throw Error('No upload allowed')},async remove(){throw Error('No delete allowed')}};
let consent=false;
const agent={async request(input){if(input.operation==='context'||input.operation==='consent'){count('aiContexts');if(input.operation==='consent'){count('consentWrites');consent=input.enabled;}return{projectId:project,sourceBundleSha256:source.bundleSha256,revision:model.revision,kind:'context',enabled:!localStorage.getItem('synthetic-ai-disabled'),consent}}count('modelCalls');const base={projectId:project,sourceBundleSha256:source.bundleSha256,revision:model.revision,turnId:input.turnId,callIndex:input.callIndex};return input.callIndex===1?{...base,kind:'tools',calls:[{id:'measured-support',name:'inspectBoxSupport',args:{frameId:input.frameId,objectId:input.objectId}}]}:{...base,kind:'final',answer:{assessment:'needs-user-review',evidenceIds:['measured-support']}}}};
const open=api.createDatasetWorkspace(async()=>async container=>{count('worlds');const canvas=document.createElement('div');canvas.textContent='Synthetic scene';container.append(canvas);return{exitXR(){},destroy(){},createTransformEntity(){throw Error('No XR scene')},renderer:{domElement:canvas,dispose(){}}}},{
 createView:()=>({showFrame(){},setScale(){},resetView(){},dispose(){}}),
 guestDemo:async()=>{count('provisions');return result()},resetGuestDemo:async()=>{count('resets');throw Error('Unexpected reset')},projects:()=>service,
 review(root,signal,context,opened,presentation){
  review=api.mountReviewWorkspace(root,{scope,original:source,signal,cache:api.createIndexedDbDraftCache(),formCache:api.createIndexedDbFormCache(),load:async()=>model.snapshot(),audit:model.audit,commit:async(bytes,context)=>{count('commits');const out=await model.commit(bytes,context);localStorage.setItem('synthetic-reload-server',JSON.stringify(model.dump()));return out},agent,analysis:api.createReviewAnalysisClient(),...presentation});return review;
 }
});
const host=api.createApplicationHost({statusRoot:document.getElementById('setup-status'),accountRoot:document.getElementById('account-container'),privateRoot:document.getElementById('scene-container'),connect:async()=>api.createSupabaseAuthPort(client),challenge(){return{getState:()=>({status:'idle'}),subscribe:()=>()=>{},async start(){},async reset(){},takeToken(){return null},pause(){},dispose(){}}},openWorkspace:open,reload(){location.reload()}});
void host.start({VITE_SUPABASE_URL:'https://reload-fixture.supabase.co',VITE_SUPABASE_PUBLISHABLE_KEY:'sb_publishable_synthetic_reload',VITE_TURNSTILE_SITE_KEY:'synthetic_reload',VITE_APP_ORIGIN:location.origin},'development',location.origin);
window.labelxrReload={release(fail=false){deny=fail;release()},state(){return{...counts,bookmarks:Object.keys(localStorage).filter(k=>k.startsWith('labelxr-open-workspace/')).map(k=>JSON.parse(localStorage.getItem(k))),revision:model.revision,phase:review?.store.state().phase??null,firstId,sourceHash:source.bundleSha256}},nextOwner(){localStorage.setItem('synthetic-reload-owner',JSON.stringify(ownerB));localStorage.removeItem('synthetic-reload-server')},makeMember(){localStorage.setItem('synthetic-reload-kind',JSON.stringify('member'))},loginAgain(){localStorage.removeItem('synthetic-reload-signed-out')},dispose(){host.dispose()}};
window.addEventListener('pagehide',()=>host.dispose(),{once:true});
