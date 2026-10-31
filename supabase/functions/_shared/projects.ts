// LABELXR-PROJECT-ADMIN-v1
import {createVerifiedJsonHandler,type AuthenticationClient} from './auth.ts';
import {HttpProblem} from './http.ts';
import {loadBundleBytes} from '../../../src/data/bundle.ts';
export interface ProjectRecord {id:string;owner_id:string;status:'staging'|'ready'|'deleting';source_hash:string;source_bytes:number;storage_prefix:string;current_revision:number}
export interface ProjectAdminPort {rpc(name:string,args:Record<string,unknown>):Promise<{data:unknown;error:{code?:string}|null}>;download(path:string):Promise<Uint8Array>;remove(paths:readonly string[]):Promise<void>}
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
function row(v:unknown,owner:string,id:string):ProjectRecord {
 if(!v||typeof v!=='object'||Array.isArray(v))throw new HttpProblem('projectUnavailable');const p=v as ProjectRecord;
 if(p.id!==id||p.owner_id!==owner||!['staging','ready','deleting'].includes(p.status)||typeof p.source_hash!=='string'||!/^[a-f0-9]{64}$/.test(p.source_hash)||!Number.isSafeInteger(p.source_bytes)||p.source_bytes<1||p.source_bytes>26214400||p.storage_prefix!==owner+'/'+id||!Number.isSafeInteger(p.current_revision)||p.current_revision<0||p.current_revision>300)throw new HttpProblem('projectUnavailable');
 return {id,owner_id:owner,status:p.status,source_hash:p.source_hash,source_bytes:p.source_bytes,storage_prefix:p.storage_prefix,current_revision:p.current_revision};
}
function shape(body:Record<string,unknown>,required:string[],optional:string[]=[]){if(required.some(k=>!Object.prototype.hasOwnProperty.call(body,k))||Object.keys(body).some(k=>!required.includes(k)&&!optional.includes(k)))throw new HttpProblem('projectInput')}
async function rpc(port:ProjectAdminPort,name:string,args:Record<string,unknown>){
 let r:Awaited<ReturnType<ProjectAdminPort['rpc']>>;try{r=await port.rpc(name,args)}catch{throw new HttpProblem('projectUnavailable')}
 if(!r||r.error){const c=r?.error?.code;throw new HttpProblem(c==='42501'?'projectAccess':c==='P0001'?'projectQuota':c==='40001'?'projectConflict':c==='22023'?'projectInput':'projectUnavailable')}return r.data;
}
export function createProjectAdminHandler(o:{origin:string;client:AuthenticationClient;port:ProjectAdminPort}){
 return createVerifiedJsonHandler({origin:o.origin,client:o.client,access:'member'},async(user,b)=>{
  if(!uuid(b.projectId))throw new HttpProblem('projectInput');const id=b.projectId,owner=user.id,p=o.port;
  if(b.operation==='reserve'){
   shape(b,['operation','projectId','sourceHash','sourceBytes']);if(typeof b.sourceHash!=='string'||!/^[a-f0-9]{64}$/.test(b.sourceHash)||!Number.isSafeInteger(b.sourceBytes)||(b.sourceBytes as number)<1||(b.sourceBytes as number)>26214400)throw new HttpProblem('projectInput');
   return row(await rpc(p,'labelroom_project_reserve',{p_owner:owner,p_id:id,p_hash:b.sourceHash,p_bytes:b.sourceBytes}),owner,id);
  }
  if(b.operation==='finalize'){
   shape(b,['operation','projectId']);const r=row(await rpc(p,'labelroom_project_lookup',{p_owner:owner,p_id:id}),owner,id);if(r.status==='deleting')throw new HttpProblem('projectConflict');
   let bytes:Uint8Array;try{bytes=await p.download(r.storage_prefix+'/original.lrx.zip')}catch{throw new HttpProblem('projectUnavailable')}
   if(!(bytes instanceof Uint8Array)||!(bytes.buffer instanceof ArrayBuffer)||bytes.length!==r.source_bytes)throw new HttpProblem('projectData');
   let source:Awaited<ReturnType<typeof loadBundleBytes>>;try{source=await loadBundleBytes(bytes)}catch{throw new HttpProblem('projectData')}
   if(source.bundleSha256!==r.source_hash)throw new HttpProblem('projectData');const saved=row(await rpc(p,'labelroom_project_finalize',{p_owner:owner,p_id:id,p_hash:source.bundleSha256,p_bytes:bytes.length,p_manifest:source.manifest,p_labels:source.labelsDocument}),owner,id);
   if(saved.status!=='ready'||saved.source_hash!==r.source_hash||saved.source_bytes!==r.source_bytes)throw new HttpProblem('projectUnavailable');return saved;
  }
  if(b.operation==='delete'){
   shape(b,['operation','projectId'],['stagingOnly']);if(b.stagingOnly!==undefined&&typeof b.stagingOnly!=='boolean')throw new HttpProblem('projectInput');
   const answer=await rpc(p,'labelroom_project_begin_delete',{p_owner:owner,p_id:id,p_staging_only:b.stagingOnly??false});
   if(answer&&typeof answer==='object'&&(answer as {id?:unknown}).id===id&&(answer as {deleted?:unknown}).deleted===true)return{id,deleted:true};
   const r=row(answer,owner,id);if(b.stagingOnly===true&&r.status==='ready')return r;if(r.status!=='deleting')throw new HttpProblem('projectUnavailable');
   const paths=[r.storage_prefix+'/original.lrx.zip'];for(let n=0;n<=300;n++)paths.push(r.storage_prefix+'/exports/revision'+n+'.lrx.zip');
   try{for(let n=0;n<paths.length;n+=100)await p.remove(paths.slice(n,n+100))}catch{throw new HttpProblem('projectUnavailable')}
   const removed=await rpc(p,'labelroom_project_finish_delete',{p_owner:owner,p_id:id});if(!removed||typeof removed!=='object'||(removed as {id?:unknown}).id!==id||(removed as {deleted?:unknown}).deleted!==true)throw new HttpProblem('projectUnavailable');return{id,deleted:true};
  }
  throw new HttpProblem('projectInput');
 });
}
