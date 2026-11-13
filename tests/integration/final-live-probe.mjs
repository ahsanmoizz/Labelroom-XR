// Fixed-staging acceptance. All mutations use existing visible app controls, guest B only.
export async function runLive(c,e){
 const r={schema:'labelxr-final-staging-browser/v1',runId:c.runId,nonce:c.nonce,manifestSha256:c.manifestSha256,phase:c.phase,result:'stopped',errorCode:null,step:'inputs',startedAt:e.now(),finishedAt:null,ownerId:null,projectId:null,revision:null,sourceSha256:null,sourceBytes:null,labelsSha256:null,cases:[],tests:[],approvedMutations:0,resetRequests:0,modelRequests:0};
 let token,sourceBytes;const need=(ok,code)=>{if(!ok)throw Error(code)},uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v),same=(a,b)=>JSON.stringify(stable(a))===JSON.stringify(stable(b));
 function stable(v){if(Array.isArray(v))return v.map(stable);if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])]));return v}
 const digest=async b=>[...new Uint8Array(await e.crypto.subtle.digest('SHA-256',b))].map(n=>n.toString(16).padStart(2,'0')).join('');
 const jhash=v=>digest(new TextEncoder().encode(JSON.stringify(stable(v))));
 const pass=(name,extra={})=>r.tests.push({name,passed:true,...extra});
 async function get(name,path,{unsigned=false,limit=6*1024*1024}={}){
  r.step=name;need(path.startsWith('/auth/v1/user')||path.startsWith('/rest/v1/')||path.startsWith('/storage/v1/object/'),'request-path');
  const headers={apikey:c.publishableKey};if(!unsigned)headers.Authorization='Bearer '+token;
  const res=await e.fetch(c.supabaseUrl+path,{method:'GET',headers,credentials:'omit',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(25000)});
  const parts=[];let size=0;const reader=res.body?.getReader();need(reader,'response-body');try{for(;;){const p=await reader.read();if(p.done)break;size+=p.value.length;need(size<=limit,'response-size');parts.push(p.value)}}finally{await reader.cancel().catch(()=>{});reader.releaseLock()}
  const bytes=new Uint8Array(size);let at=0;for(const p of parts){bytes.set(p,at);at+=p.length}
  let body;try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))}catch{}
  const item={name,method:'GET',httpStatus:res.status,bytes:size,rowCount:Array.isArray(body)?body.length:null,bodySha256:await digest(bytes),outcome:'observed'};r.cases.push(item);return{res,body,bytes,item};
 }
 const query=(table,select,filter)=>'/rest/v1/'+table+'?select='+select+'&'+filter;
 async function identity(name){const v=await get(name,'/auth/v1/user',{limit:65536});need(v.res.status===200&&uuid(v.body?.id)&&v.body?.is_anonymous===true&&v.body?.role==='authenticated','anonymous-identity');v.item.outcome='identity';return v.body.id}
 async function head(name,id){const f='owner_id=eq.'+r.ownerId+'&kind=eq.demo&status=eq.ready&order=created_at.desc&limit=4'+(id?'&id=eq.'+id:'');const v=await get(name,query('projects','id,owner_id,status,source_hash,source_bytes,storage_prefix,current_revision',f),{limit:16384});need(v.res.status===200&&Array.isArray(v.body)&&v.body.length===1,'own-project');const p=v.body[0];need(uuid(p.id)&&p.owner_id===r.ownerId&&p.storage_prefix===r.ownerId+'/'+p.id&&p.source_hash===c.sourceSha256&&p.source_bytes===c.sourceBytes&&p.status==='ready','project-source');v.item.outcome='allowed';return p}
 async function version(name,p){const v=await get(name,query('label_versions','project_id,revision,label_doc,review_verdicts','project_id=eq.'+p.id+'&revision=eq.'+p.current_revision+'&limit=2'));need(v.res.status===200&&v.body?.length===1&&v.body[0].project_id===p.id&&v.body[0].revision===p.current_revision,'own-version');v.item.outcome='allowed';return v.body[0]}
 const sourcePath=p=>'/storage/v1/object/authenticated/project-data/'+p.storage_prefix+'/original.lrx.zip';
 async function source(name,p){const v=await get(name,sourcePath(p),{limit:25*1024*1024});need(v.res.status===200&&v.bytes.length===c.sourceBytes&&v.item.bodySha256===c.sourceSha256,'source-hash');v.item.outcome='allowed';return v.bytes}
 async function history(name,p){const v=await get(name,query('mutations','id,request_id,project_id,revision,owner_id,operation,frame_id,object_id,partner_id,reason,payload_hash,undo_of','project_id=eq.'+p.id+'&order=revision.asc&limit=301'));need(v.res.status===200&&Array.isArray(v.body)&&v.body.length===p.current_revision&&v.body.every((x,i)=>x.project_id===p.id&&x.owner_id===r.ownerId&&x.revision===i+1&&uuid(x.request_id)),'own-history');v.item.outcome='allowed';return v.body}
 async function snap(n){const p=await head('head-r'+n,r.projectId);need(p.current_revision===n,'revision-mismatch');const v=await version('version-r'+n,p),h=await history('history-r'+n,p);return{p,v,h}}
 const review=()=>e.document.querySelector('.review-panel');
 const field=name=>{const el=review()?.querySelector('[aria-label="'+name+'"]');need(el,'missing-control');return el};
 const button=(text,root=review())=>[...(root?.querySelectorAll('button')??[])].find(x=>x.textContent.trim()===text);
 const click=(text,root=review())=>{const b=button(text,root);need(b&&!b.disabled&&!b.hidden,'unavailable-action');b.click()};
 async function wait(fn,code){const end=Date.now()+20000;while(Date.now()<end){if(fn())return;await new Promise(resolve=>setTimeout(resolve,100))}throw Error(code)}
 function set(name,value){const el=field(name);need(!el.disabled,'locked-control');el.value=String(value);el.dispatchEvent(new e.document.defaultView.Event(el.tagName==='SELECT'?'change':'input',{bubbles:true}))}
 const message=()=>review()?.querySelector('[role="status"]')?.textContent??'';
 const ready=()=>!!button('Preview edit')&&!button('Preview edit').disabled;
 async function proposed(){await wait(()=>!!button('Approve and save')&&!button('Approve and save').disabled,'preview-timeout')}
 async function save(n){click('Approve and save');await wait(()=>ready()&&message().includes('Saved revision '+n+'.'),'save-unconfirmed');r.approvedMutations++;return snap(n)}
 async function denyRows(name,table,filter,unsigned=false){const v=await get(name,query(table,table==='label_versions'?'project_id,revision':'id',filter+'&limit=2'),{unsigned,limit:65536});need(unsigned?v.res.status===401:v.res.status===200&&Array.isArray(v.body)&&v.body.length===0,'read-isolation');v.item.outcome='denied'}
 async function denySource(name,path,unsigned=false){const v=await get(name,path,{unsigned,limit:65536});need([400,403,404].includes(v.res.status)&&v.body&&typeof v.body==='object'&&['NoSuchKey','NoSuchBucket','not_found','Unauthorized','ObjectNotFound','403','404'].includes(String(v.body.code??v.body.error??v.body.statusCode)),'storage-isolation');v.item.outcome='denied'}
 try{
  need(e.origin===c.appOrigin&&c.appOrigin==='https://guest-staging.labelroom-xr.pages.dev'&&c.supabaseUrl==='https://aawwmcbhyyokkhhvcfmv.supabase.co','fixed-staging-origin');
  const session=JSON.parse(e.storage.getItem('sb-aawwmcbhyyokkhhvcfmv-auth-token')||'null');need(typeof session?.access_token==='string'&&session.access_token.length<8192,'guest-session');token=session.access_token;
  r.ownerId=await identity('user-initial');let p=await head('own-initial');r.projectId=p.id;r.revision=p.current_revision;r.sourceSha256=p.source_hash;r.sourceBytes=p.source_bytes;
  let v=await version('own-initial-version',p);await history('own-initial-history',p);sourceBytes=await source('own-initial-source',p);r.labelsSha256=await jhash(v.label_doc);
  if(c.phase==='a-control'){pass('guest-a-positive-read-control');}
  else if(c.phase==='b-lifecycle'){
   need(c.guestA&&r.ownerId!==c.guestA.ownerId&&r.projectId!==c.guestA.projectId,'different-guest-required');need(p.current_revision===0,'disposable-revision-zero-required');
   await denyRows('cross-guest-project','projects','id=eq.'+c.guestA.projectId);await denyRows('cross-guest-version','label_versions','project_id=eq.'+c.guestA.projectId);await denyRows('cross-guest-history','mutations','project_id=eq.'+c.guestA.projectId);await denySource('cross-guest-source','/storage/v1/object/authenticated/project-data/'+c.guestA.ownerId+'/'+c.guestA.projectId+'/original.lrx.zip');
   await denyRows('unsigned-project','projects','id=eq.'+p.id,true);await denyRows('unsigned-version','label_versions','project_id=eq.'+p.id,true);await denySource('unsigned-source',sourcePath(p),true);pass('cross-guest-and-unsigned-isolation');
   const show=button('Show controls',e.document);if(show)show.click();await wait(ready,'review-not-ready');
   const frameId=field('Review frame').value,objectId=field('Review object').value,before=v.label_doc.openlabel.frames[frameId]?.objects?.[objectId]?.object_data?.cuboid?.[0]?.val;
   need(Array.isArray(before)&&before.length===10&&Number(field('X (metres)').value)===before[0],'initial-form-differs');
   const afterX=before[0]+.01;set('X (metres)',afterX);set('Review reason','other');click('Preview edit');await proposed();need((await head('reject-before',p.id)).current_revision===0,'preview-wrote');click('Reject preview');await wait(ready,'reject-timeout');need((await head('reject-after',p.id)).current_revision===0,'reject-wrote');pass('preview-reject-no-save');
   set('X (metres)',afterX);set('Review reason','other');click('Preview edit');await proposed();let one=await save(1);const expected=structuredClone(v.label_doc),actual=one.v.label_doc.openlabel.frames[frameId].objects[objectId].object_data.cuboid[0].val;
   need(actual[0]===afterX&&[1,2,7,8,9].every(i=>Math.abs(actual[i]-before[i])<1e-9)&&Math.abs(actual[3])+Math.abs(actual[4])<1e-9&&Math.abs(Math.abs((actual[5]*before[5]+actual[6]*before[6])/Math.hypot(before[5],before[6]))-1)<1e-9,'edit-values-differ');
   expected.openlabel.frames[frameId].objects[objectId].object_data.cuboid[0].val=actual;need(same(one.v.label_doc,expected)&&one.h[0].operation==='updateCuboid','single-edit-differs');r.edit={frameId,objectId,beforeX:before[0],afterX,delta:.01};pass('single-approved-edit',{revision:1});
   const issue=()=>[...review().querySelectorAll('button[aria-label]')].find(x=>x.getAttribute('aria-label').includes('"LOW_SUPPORT"')&&!x.disabled);await wait(()=>!!issue(),'issue-unavailable');issue().click();set('Review reason','occlusion');click('Preview keep with reason');await proposed();const two=await save(2);need(same(two.v.label_doc,one.v.label_doc)&&two.h[1].operation==='keepIssue','keep-changed-geometry');pass('reasoned-keep-preserves-geometry',{revision:2});
   let selected=false;for(const option of [...field('Review object').options]){set('Review object',option.value);if(field('Duplicate partner').options.length){selected=true;break}}need(selected,'duplicate-partner-unavailable');
   const df=field('Review frame').value,di=field('Review object').value,partner=field('Duplicate partner').value;need(di!==partner,'duplicate-partner');set('Review reason','duplicate');click('Remove duplicate…');need((await head('duplicate-confirmation-control',p.id)).current_revision===2,'duplicate-without-confirmation');click('Confirm duplicate removal');await proposed();const three=await save(3),removed=structuredClone(two.v.label_doc);delete removed.openlabel.frames[df].objects[di];need(same(three.v.label_doc,removed)&&three.h[2].operation==='removeDuplicate','duplicate-scope');pass('confirmed-removal-only-selected-occurrence',{revision:3});
   click('Preview last-edit undo');await proposed();need((await head('undo-preview-control',p.id)).current_revision===3,'undo-without-approval');const four=await save(4);need(same(four.v.label_doc,two.v.label_doc)&&same(four.v.review_verdicts,two.v.review_verdicts)&&four.h[3].operation==='undo','undo-differs');pass('approved-undo-restores-prior-state',{revision:4});
   click('Export saved revision');await wait(()=>ready()&&message().includes('Saved revision 4 exported.'),'export-unconfirmed');pass('app-produced-saved-export',{revision:4});r.exportFile='review-'+p.id+'-r4.lrx.zip';r.originalFile='labelxr-final-'+c.runId+'-original.lrx.zip';e.offerSource(sourceBytes,r.originalFile);r.revision=4;r.labelsSha256=await jhash(four.v.label_doc);
  }else if(c.phase==='b-reopen-reset'){
   const previous=c.guestB;need(previous&&r.ownerId===previous.ownerId&&r.projectId===previous.projectId&&p.current_revision===4&&r.labelsSha256===previous.labelsSha256,'saved-reopen-differs');pass('same-guest-saved-project-reopened',{revision:4});
   await wait(ready,'review-not-ready');set('Review frame',previous.edit.frameId);set('Review object',previous.edit.objectId);need(Math.abs(Number(field('X (metres)').value)-previous.edit.afterX)<1e-9,'reopened-ui-value-differs');pass('reopened-ui-shows-approved-value');
   click('Reset demo',e.document);need((await head('reset-confirmation-control',p.id)).current_revision===4,'reset-without-confirmation');click('Keep my demo',e.document);need((await head('reset-cancel-control',p.id)).current_revision===4,'cancel-reset-changed-state');pass('cancelled-reset-preserves-project');
   click('Reset demo',e.document);click('Confirm reset and discard demo edits',e.document);r.resetRequests=1;await wait(()=>[...e.document.querySelectorAll('[role="status"]')].some(x=>x.textContent==='Private demo loaded at revision 0.'),'reset-unconfirmed');
   const fresh=await head('fresh-reset-project');need(fresh.id!==p.id&&fresh.current_revision===0,'reset-project-identity');const fv=await version('fresh-reset-version',fresh);await history('fresh-reset-history',fresh);await source('fresh-reset-source',fresh);
   await denyRows('old-project-after-reset','projects','id=eq.'+p.id);await denyRows('old-versions-after-reset','label_versions','project_id=eq.'+p.id);await denyRows('old-history-after-reset','mutations','project_id=eq.'+p.id);await denySource('old-source-after-reset',sourcePath(p));
   r.oldProjectId=p.id;r.projectId=fresh.id;r.revision=0;r.labelsSha256=await jhash(fv.label_doc);pass('confirmed-reset-fresh-source-and-old-reads-denied');
  }else throw Error('phase');
  need(await identity('user-final')===r.ownerId,'identity-changed');r.result='completed';r.step='finished';
 }catch(error){r.errorCode=/^[a-z][a-z0-9-]{0,79}$/.test(error?.message??'')?error.message:'network-or-check-failed';}
 finally{token=undefined;r.finishedAt=e.now()}
 return r;
}
