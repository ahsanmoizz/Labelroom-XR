// LABELXR-REVIEW-SERVICE-v1
import {validateReviewCommand,ReviewCommandError,type ValidatedReviewRequest,type ReviewContext} from '../domain/revision';
import {verifyReviewAcknowledgement,type ReviewAcknowledgement} from '../domain/review-ack';
import {parseBoundedJsonBytes} from '../domain/schema';
import type {ProjectsAuthClient} from './projects';
import type {PublicAppConfig} from '../app/config';
export type ReviewServiceCode='AUTH'|'CANCELLED'|'INVALID'|'CONFLICT'|'LIMIT'|'UNKNOWN';
const messages={AUTH:'Sign in again before continuing.',CANCELLED:'The review was cancelled before sending.',INVALID:'The review command or current context is invalid.',CONFLICT:'The project changed. Reload before continuing.',LIMIT:'The review revision limit has been reached. You can still read or export.',UNKNOWN:'The save outcome is unknown. Retry the exact same request ID and command.'};
export class ReviewServiceError extends Error {
 constructor(readonly code:ReviewServiceCode,readonly outcomeUnknown=false,readonly requestId:string|null=null){super(messages[code])}
}
export interface ReviewSession {readonly ownerId:string;current():Promise<boolean>;commit(command:ValidatedReviewRequest['command']):Promise<unknown>}
export type ReviewSessionFactory=(signal:AbortSignal)=>Promise<ReviewSession>;
const cancelled=(signal:AbortSignal)=>{if(signal.aborted)throw new ReviewServiceError('CANCELLED')};
function bounded<T>(work:Promise<T>,signal:AbortSignal):Promise<T>{
 return new Promise((resolve,reject)=>{let settled=false;const finish=(fn:(value:any)=>void,value:unknown)=>{if(settled)return;settled=true;clearTimeout(timer);signal.removeEventListener('abort',abort);fn(value)},abort=()=>finish(reject,new ReviewServiceError('CANCELLED')),timer=setTimeout(()=>finish(reject,new ReviewServiceError('AUTH')),10000);signal.addEventListener('abort',abort,{once:true});work.then(v=>finish(resolve,v),e=>finish(reject,e));if(signal.aborted)abort()});
}
async function current(session:ReviewSession,signal:AbortSignal,requestId:string|null=null,afterSend=false){
 if(signal.aborted)throw new ReviewServiceError(afterSend?'UNKNOWN':'CANCELLED',afterSend,requestId);
 let active=false;try{active=await bounded(session.current(),signal)}catch{}
 if(signal.aborted)throw new ReviewServiceError(afterSend?'UNKNOWN':'CANCELLED',afterSend,requestId);
 if(!active)throw new ReviewServiceError('AUTH',afterSend,requestId);
 if(signal.aborted)throw new ReviewServiceError(afterSend?'UNKNOWN':'CANCELLED',afterSend,requestId);
}
export function createReviewService(begin:ReviewSessionFactory){
 return {async commit(bytes:Uint8Array,context:ReviewContext,signal:AbortSignal):Promise<ReviewAcknowledgement>{
  cancelled(signal);const sourceHash=context.sourceBundleSha256;let proof:Awaited<ReturnType<typeof validateReviewCommand>>;
  try{proof=await validateReviewCommand(bytes,context)}catch(error){if(error instanceof ReviewCommandError)throw new ReviewServiceError(error.code==='CONFLICT'?'CONFLICT':error.code==='LIMIT'?'LIMIT':'INVALID');throw new ReviewServiceError('INVALID')}
  cancelled(signal);let session:ReviewSession;try{session=await begin(signal)}catch{cancelled(signal);throw new ReviewServiceError('AUTH')}await current(session,signal,proof.command.requestId);let answer:unknown;
  try{answer=await session.commit(proof.command)}catch(error){if(error instanceof ReviewServiceError)throw error;throw new ReviewServiceError('UNKNOWN',true,proof.command.requestId)}
  await current(session,signal,proof.command.requestId,true);
  try{return verifyReviewAcknowledgement(answer,proof.command,sourceHash,proof.payloadSha256)}catch{throw new ReviewServiceError('UNKNOWN',true,proof.command.requestId)}
 }};
}
/** A single remotely verified bearer is retained for the entire command;there is no automatic retry. */
export function createSupabaseReviewSessions(client:ProjectsAuthClient,config:Pick<PublicAppConfig,'supabaseUrl'|'supabasePublishableKey'>,fetcher:typeof fetch=globalThis.fetch):ReviewSessionFactory {
 let base:URL;try{base=new URL(config.supabaseUrl)}catch{throw new ReviewServiceError('INVALID')}
 if(base.origin!==config.supabaseUrl||base.protocol!=='https:'||typeof config.supabasePublishableKey!=='string'||config.supabasePublishableKey.length>512||!/^sb_publishable_[A-Za-z0-9_-]+$/.test(config.supabasePublishableKey))throw new ReviewServiceError('INVALID');
 return async signal=>{
  cancelled(signal);let token:string,owner:string,guest:boolean;
  try{const s=await bounded(client.auth.getSession(),signal),t=s.data.session?.access_token;if(s.error||typeof t!=='string'||t.length>8192||!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(t))throw Error();const r=await bounded(client.auth.getUser(t),signal),u=r.data.user;if(r.error||!u||!uuid(u.id)||u.role!=='authenticated'||typeof u.is_anonymous!=='boolean')throw Error();token=t;owner=u.id;guest=u.is_anonymous}catch{throw new ReviewServiceError('AUTH')}
  cancelled(signal);
  return {ownerId:owner,
   async current(){if(signal.aborted)return false;try{const r=await bounded(client.auth.getUser(),signal),u=r.data.user;return !r.error&&u?.id===owner&&u.is_anonymous===guest&&u.role==='authenticated'}catch{return false}},
   async commit(command){
    cancelled(signal);let response:Response;
    try{response=await fetcher(config.supabaseUrl+'/functions/v1/review-commit',{method:'POST',credentials:'omit',redirect:'error',headers:{apikey:config.supabasePublishableKey,Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(command),signal:AbortSignal.any([signal,AbortSignal.timeout(20000)])})}
    catch{throw new ReviewServiceError('UNKNOWN',true,command.requestId)}
    if(signal.aborted)throw new ReviewServiceError('UNKNOWN',true,command.requestId);
    let value:unknown;
    try{if(!response.body||!/^application\/json(?:\s*;|$)/i.test(response.headers.get('Content-Type')??''))throw Error();const reader=response.body.getReader(),chunks:Uint8Array[]=[];let n=0;
     try{for(;;){const part=await reader.read();if(part.done)break;n+=part.value.length;if(n>65536)throw Error();chunks.push(part.value)}}finally{await reader.cancel().catch(()=>{});reader.releaseLock()}
     const bytes=new Uint8Array(n);let at=0;for(const b of chunks){bytes.set(b,at);at+=b.length}value=parseBoundedJsonBytes(bytes,'review-response.json',65536,8);
    }catch{throw new ReviewServiceError('UNKNOWN',true,command.requestId)}
    if(!response.ok){const code=response.status===401||response.status===403?'AUTH':response.status===409?'CONFLICT':response.status===400||response.status===413?'INVALID':'UNKNOWN';throw new ReviewServiceError(code,code==='UNKNOWN',command.requestId)}
    if(!value||typeof value!=='object'||Array.isArray(value)||!Object.prototype.hasOwnProperty.call(value,'data')||Object.keys(value).some(k=>!['data','requestId'].includes(k))||!uuid((value as {requestId?:unknown}).requestId))throw new ReviewServiceError('UNKNOWN',true,command.requestId);
    return(value as {data:unknown}).data;
   },
  };
 };
}
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
