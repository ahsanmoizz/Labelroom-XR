// LABELXR-PRIVATE-PROJECTS-v1
import {loadBundleBytes,type BundleSource} from '../data/bundle';
import {parseOpenLabelBytes} from '../data/openlabel';
import {manifestSchema} from '../domain/schema';
import type {PublicAppConfig} from '../app/config';
export interface PrivateProject {id:string;owner_id:string;status:'staging'|'ready'|'deleting';source_hash:string;source_bytes:number;storage_prefix:string;current_revision:number}
export type ProjectErrorCode='AUTH'|'CANCELLED'|'SOURCE'|'CONFLICT'|'QUOTA'|'UNAVAILABLE';
const messages={AUTH:'Sign in with a permanent account.',CANCELLED:'Project operation was cancelled.',SOURCE:'The dataset or saved source failed validation.',CONFLICT:'The project changed. Reload before continuing.',QUOTA:'Your three-project limit has been reached.',UNAVAILABLE:'Project storage is unavailable. Retry with the same project ID.'};
export class ProjectStoreError extends Error {constructor(readonly code:ProjectErrorCode,readonly projectId:string|null=null,readonly cleanupPending=false){super(messages[code])}}
export interface ProjectsSession {readonly ownerId:string;admin(body:Record<string,unknown>):Promise<unknown>;cleanup(id:string):Promise<unknown>;upload(path:string,bytes:Uint8Array):Promise<void>;download(path:string):Promise<Uint8Array>;rows(id?:string):Promise<unknown>;version(id:string,revision:number):Promise<unknown>;current():Promise<boolean>}
export type ProjectsSessionFactory=(signal:AbortSignal)=>Promise<ProjectsSession>;
export interface ProjectsAuthClient {auth:{getSession():Promise<{data:{session:{access_token:string}|null};error:unknown}>;getUser(token?:string):Promise<{data:{user:{id:string;is_anonymous?:boolean;role?:string}|null};error:unknown}>}}
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const cancelled=(s:AbortSignal)=>{if(s.aborted)throw new ProjectStoreError('CANCELLED')};
function row(v:unknown,owner:string,id?:string):PrivateProject {
 if(!v||typeof v!=='object'||Array.isArray(v))throw new ProjectStoreError('SOURCE',id??null);const p=v as PrivateProject;
 if(!uuid(p.id)||(id!==undefined&&id!==p.id)||p.owner_id!==owner||!['staging','ready','deleting'].includes(p.status)||typeof p.source_hash!=='string'||!/^[a-f0-9]{64}$/.test(p.source_hash)||!Number.isSafeInteger(p.source_bytes)||p.source_bytes<1||p.source_bytes>26214400||p.storage_prefix!==owner+'/'+p.id||!Number.isSafeInteger(p.current_revision)||p.current_revision<0||p.current_revision>300)throw new ProjectStoreError('SOURCE',id??null);
 return Object.freeze({id:p.id,owner_id:owner,status:p.status,source_hash:p.source_hash,source_bytes:p.source_bytes,storage_prefix:p.storage_prefix,current_revision:p.current_revision});
}
async function current(p:ProjectsSession,s:AbortSignal){cancelled(s);if(!await p.current())throw new ProjectStoreError('AUTH');cancelled(s)}
function same(p:PrivateProject,b:BundleSource,n:number){if(p.source_hash!==b.bundleSha256||p.source_bytes!==n)throw new ProjectStoreError('SOURCE',p.id)}
export function createProjectsService(begin:ProjectsSessionFactory){
 async function read(p:ProjectsSession,id:string){const v=await p.rows(id);if(!Array.isArray(v)||v.length!==1)throw new ProjectStoreError('UNAVAILABLE',id);const r=row(v[0],p.ownerId,id);if(r.status!=='ready')throw new ProjectStoreError('CONFLICT',id);return r}
 return {
  async list(signal:AbortSignal){cancelled(signal);const p=await begin(signal),values=await p.rows();if(!Array.isArray(values)||values.length>3)throw new ProjectStoreError('SOURCE');const result=values.map(v=>row(v,p.ownerId));if(result.some(v=>v.status!=='ready')||new Set(result.map(v=>v.id)).size!==result.length)throw new ProjectStoreError('SOURCE');await current(p,signal);return Object.freeze(result)},
  async create(input:Uint8Array,id:string,signal:AbortSignal){
   if(!uuid(id))throw new ProjectStoreError('SOURCE');cancelled(signal);let b:BundleSource;try{b=await loadBundleBytes(input)}catch{throw new ProjectStoreError('SOURCE',id)}cancelled(signal);const bytes=b.getOriginalZipBytes(),p=await begin(signal);let reserved:PrivateProject;
   try{reserved=row(await p.admin({operation:'reserve',projectId:id,sourceHash:b.bundleSha256,sourceBytes:bytes.length}),p.ownerId,id);same(reserved,b,bytes.length)}catch(e){throw new ProjectStoreError(e instanceof ProjectStoreError?e.code:'UNAVAILABLE',id,!(e instanceof ProjectStoreError&&['AUTH','QUOTA'].includes(e.code)))}
   if(reserved.status==='ready'){const r=await read(p,id);same(r,b,bytes.length);await current(p,signal);return r}if(reserved.status!=='staging')throw new ProjectStoreError('CONFLICT',id);
   try{
    await current(p,signal);try{await p.upload(reserved.storage_prefix+'/original.lrx.zip',bytes)}catch{cancelled(signal)}cancelled(signal);
    const saved=row(await p.admin({operation:'finalize',projectId:id}),p.ownerId,id);same(saved,b,bytes.length);if(saved.status!=='ready')throw new ProjectStoreError('UNAVAILABLE',id);await current(p,signal);return saved;
   }catch(e){let pending=true;try{const c=await p.cleanup(id);if(c&&typeof c==='object'&&(c as {id?:unknown}).id===id&&(c as {deleted?:unknown}).deleted===true)pending=false;else{const r=row(c,p.ownerId,id);same(r,b,bytes.length);if(r.status==='ready'){const saved=await read(p,id);same(saved,b,bytes.length);await current(p,signal);return saved}}}catch{/* Outcome remains explicit; do not invent a save or cleanup acknowledgement. */}throw new ProjectStoreError(signal.aborted?'CANCELLED':e instanceof ProjectStoreError?e.code:'UNAVAILABLE',id,pending)}
  },
  async open(id:string,signal:AbortSignal){
   if(!uuid(id))throw new ProjectStoreError('SOURCE');cancelled(signal);const p=await begin(signal),r=await read(p,id),bytes=await p.download(r.storage_prefix+'/original.lrx.zip');cancelled(signal);let original:BundleSource;
   try{original=await loadBundleBytes(bytes)}catch{throw new ProjectStoreError('SOURCE',id)}same(r,original,bytes.length);const versions=await p.version(id,r.current_revision);
   if(!Array.isArray(versions)||versions.length!==1||!versions[0]||versions[0].project_id!==id||versions[0].revision!==r.current_revision)throw new ProjectStoreError('SOURCE',id);
   let labels:ReturnType<typeof parseOpenLabelBytes>;try{labels=parseOpenLabelBytes(new TextEncoder().encode(JSON.stringify(versions[0].label_doc)),manifestSchema.parse(original.manifest))}catch{throw new ProjectStoreError('SOURCE',id)}
   const latest=await read(p,id);if(latest.current_revision!==r.current_revision||latest.source_hash!==r.source_hash||latest.source_bytes!==r.source_bytes)throw new ProjectStoreError('CONFLICT',id);await current(p,signal);return{project:r,original,labels};
  },
  async remove(id:string,signal:AbortSignal){if(!uuid(id))throw new ProjectStoreError('SOURCE');cancelled(signal);const p=await begin(signal),r=await p.admin({operation:'delete',projectId:id});if(!r||typeof r!=='object'||(r as {id?:unknown}).id!==id||(r as {deleted?:unknown}).deleted!==true)throw new ProjectStoreError('UNAVAILABLE',id);await current(p,signal)},
 };
}
/** All requests retain one remotely verified bearer across refresh/account changes. */
export function createSupabaseProjectsSessions(client:ProjectsAuthClient,config:Pick<PublicAppConfig,'supabaseUrl'|'supabasePublishableKey'>,fetcher:typeof fetch=globalThis.fetch):ProjectsSessionFactory {
 const u=new URL(config.supabaseUrl);if(u.origin!==config.supabaseUrl||u.protocol!=='https:')throw new ProjectStoreError('UNAVAILABLE');
 return async signal=>{
  cancelled(signal);let token:string,owner:string;
  try{const s=await client.auth.getSession(),t=s.data.session?.access_token;if(s.error||typeof t!=='string'||t.length>8192||!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(t))throw Error();const r=await client.auth.getUser(t),v=r.data.user;if(r.error||!v||!uuid(v.id)||v.is_anonymous!==false||v.role!=='authenticated')throw Error();token=t;owner=v.id}catch{throw new ProjectStoreError('AUTH')}cancelled(signal);
  async function request(relative:string,options:RequestInit,max:number,independent=false){
   if(!independent)cancelled(signal);try{const r=await fetcher(config.supabaseUrl+relative,{...options,credentials:'omit',redirect:'error',headers:{apikey:config.supabasePublishableKey,Authorization:'Bearer '+token,...options.headers},signal:independent?AbortSignal.timeout(10000):AbortSignal.any([signal,AbortSignal.timeout(10000)])});if(!r.body)throw Error();const reader=r.body.getReader(),chunks:Uint8Array[]=[];let n=0;
    try{for(;;){const item=await reader.read();if(item.done)break;n+=item.value.length;if(n>max)throw Error();chunks.push(item.value)}}finally{await reader.cancel().catch(()=>{});reader.releaseLock()}
    const bytes=new Uint8Array(n);let offset=0;for(const b of chunks){bytes.set(b,offset);offset+=b.length}
    if(!r.ok){let code='';try{code=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)).error?.code??''}catch{}throw new ProjectStoreError(r.status===401||r.status===403?'AUTH':code==='projectQuota'?'QUOTA':r.status===409?'CONFLICT':'UNAVAILABLE')}return bytes;
   }catch(e){if(e instanceof ProjectStoreError)throw e;throw new ProjectStoreError(!independent&&signal.aborted?'CANCELLED':'UNAVAILABLE')}
  }
  async function json(relative:string,options:RequestInit={},max=65536,independent=false):Promise<unknown>{const bytes=await request(relative,options,max,independent);try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))}catch{throw new ProjectStoreError('SOURCE')}}
  async function admin(body:Record<string,unknown>,independent=false){const v=await json('/functions/v1/project-admin',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)},65536,independent);if(!v||typeof v!=='object'||!Object.prototype.hasOwnProperty.call(v,'data'))throw new ProjectStoreError('SOURCE');return(v as {data:unknown}).data}
  function object(p:string){const parts=p.split('/');if(parts.length!==3||parts[0]!==owner||!uuid(parts[1])||parts[2]!=='original.lrx.zip')throw new ProjectStoreError('SOURCE');return p}
  return {ownerId:owner,admin,cleanup:id=>admin({operation:'delete',projectId:id,stagingOnly:true},true),
   async upload(p,bytes){await request('/storage/v1/object/project-data/'+object(p),{method:'POST',headers:{'Content-Type':'application/zip'},body:new Uint8Array(bytes).buffer},65536)},
   download:p=>request('/storage/v1/object/authenticated/project-data/'+object(p),{method:'GET'},26214400),
   rows:id=>{if(id!==undefined&&!uuid(id))return Promise.reject(new ProjectStoreError('SOURCE'));return json('/rest/v1/projects?select=id,owner_id,status,source_hash,source_bytes,storage_prefix,current_revision&owner_id=eq.'+owner+'&kind=eq.private&status=eq.ready&order=created_at.desc&limit=4'+(id?'&id=eq.'+id:''))},
   version:(id,rev)=>{if(!uuid(id)||!Number.isSafeInteger(rev)||rev<0||rev>300)return Promise.reject(new ProjectStoreError('SOURCE'));return json('/rest/v1/label_versions?select=project_id,revision,label_doc&project_id=eq.'+id+'&revision=eq.'+rev+'&limit=2',{},4194304)},
   async current(){if(signal.aborted)return false;try{const r=await client.auth.getUser();return !r.error&&r.data.user?.id===owner&&r.data.user.is_anonymous===false&&r.data.user.role==='authenticated'}catch{return false}},
  };
 };
}
