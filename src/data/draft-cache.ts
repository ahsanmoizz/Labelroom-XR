// LABELXR-REVIEW-DRAFT-CACHE-v1
import {z} from 'zod';
import {reviewCommandSchema,type ValidatedReviewRequest} from '../domain/revision';
import {reviewScopeSchema,reviewHash,reviewUuid,type ReviewScope} from '../domain/review-snapshot';
const draftSchema=z.strictObject({schema:z.literal('labelxr-pending-review/v1'),ownerId:reviewUuid,projectId:reviewUuid,sourceBundleSha256:reviewHash,requestId:reviewUuid,payloadSha256:reviewHash,commandJson:z.string().max(16384),createdAt:z.string().max(64).refine(s=>Number.isFinite(Date.parse(s)))});
export type ReviewDraft=Readonly<z.infer<typeof draftSchema>>;
export class DraftCacheError extends Error {constructor(readonly code:'UNAVAILABLE'|'INVALID'|'EXISTS'|'MISMATCH'){super('Local review recovery '+code.toLowerCase()+'.')}}
export function draftKey(scope:ReviewScope){const s=reviewScopeSchema.parse(scope);return[s.ownerId,s.projectId,s.sourceBundleSha256].join('/')}
export function validateReviewDraft(value:unknown,scope:ReviewScope):ReviewDraft {
 try{const d=draftSchema.parse(value),s=reviewScopeSchema.parse(scope);if(d.ownerId!==s.ownerId||d.projectId!==s.projectId||d.sourceBundleSha256!==s.sourceBundleSha256||new TextEncoder().encode(d.commandJson).length>16384)throw Error();const c=reviewCommandSchema.parse(JSON.parse(d.commandJson));if(c.projectId!==s.projectId||c.requestId!==d.requestId||JSON.stringify(c)!==d.commandJson)throw Error();return Object.freeze(d)}catch{throw new DraftCacheError('INVALID')}
}
export function createReviewDraft(scope:ReviewScope,proof:ValidatedReviewRequest,createdAt=new Date().toISOString()):ReviewDraft{return validateReviewDraft({schema:'labelxr-pending-review/v1',...reviewScopeSchema.parse(scope),requestId:proof.command.requestId,payloadSha256:proof.payloadSha256,commandJson:JSON.stringify(proof.command),createdAt},scope)}
export interface ReviewDraftCache {
 read(scope:ReviewScope):Promise<ReviewDraft|undefined>;
 claim(scope:ReviewScope,draft:ReviewDraft):Promise<void>;
 acknowledge(scope:ReviewScope,requestId:string,payloadSha256:string):Promise<void>;
 discard(scope:ReviewScope,requestId:string):Promise<void>;
}
/** Read/compare/write happens in one IndexedDB transaction; there is no memory fallback for saves. */
export function createIndexedDbDraftCache(factory:IDBFactory=globalThis.indexedDB):ReviewDraftCache {
 if(!factory)throw new DraftCacheError('UNAVAILABLE');
 const open=()=>new Promise<IDBDatabase>((resolve,reject)=>{let done=false;const request=factory.open('labelxr-review-recovery',1),timer=setTimeout(()=>fail(),5000);function fail(){if(done)return;done=true;clearTimeout(timer);reject(new DraftCacheError('UNAVAILABLE'))}request.onupgradeneeded=()=>{const db=request.result;if(!db.objectStoreNames.contains('pending'))db.createObjectStore('pending',{keyPath:'key'})};request.onblocked=fail;request.onerror=fail;request.onsuccess=()=>{if(done){request.result.close();return}done=true;clearTimeout(timer);request.result.onversionchange=()=>request.result.close();resolve(request.result)}});
 async function transaction<T>(scope:ReviewScope,mode:IDBTransactionMode,work:(old:ReviewDraft|undefined,store:IDBObjectStore,key:string)=>T):Promise<T>{
  const key=draftKey(scope),db=await open();return new Promise<T>((resolve,reject)=>{let result:T,error:unknown,finished=false;const tx=db.transaction('pending',mode),store=tx.objectStore('pending'),request=store.get(key),timer=setTimeout(()=>{error=new DraftCacheError('UNAVAILABLE');try{tx.abort()}catch{}},5000);const finish=(ok:boolean)=>{if(finished)return;finished=true;clearTimeout(timer);db.close();if(ok)resolve(result);else reject(error instanceof DraftCacheError?error:new DraftCacheError('UNAVAILABLE'))};request.onsuccess=()=>{try{const raw=request.result;if(raw!==undefined&&(!raw||raw.key!==key||Object.keys(raw).some(k=>!['key','draft'].includes(k))))throw new DraftCacheError('INVALID');const old=raw===undefined?undefined:validateReviewDraft(raw.draft,scope);result=work(old,store,key)}catch(e){error=e;tx.abort()}};request.onerror=()=>{error=new DraftCacheError('UNAVAILABLE')};tx.oncomplete=()=>finish(true);tx.onabort=tx.onerror=()=>finish(false)});
 }
 return{
  read:scope=>transaction(scope,'readonly',old=>old),
  claim:async(scope,input)=>{const draft=validateReviewDraft(input,scope);await transaction(scope,'readwrite',(old,store,key)=>{if(old&&(old.requestId!==draft.requestId||old.payloadSha256!==draft.payloadSha256||old.commandJson!==draft.commandJson))throw new DraftCacheError('EXISTS');if(!old)store.add({key,draft})})},
  acknowledge:async(scope,id,hash)=>{reviewUuid.parse(id);reviewHash.parse(hash);await transaction(scope,'readwrite',(old,store,key)=>{if(old&&(old.requestId!==id||old.payloadSha256!==hash))throw new DraftCacheError('MISMATCH');if(old)store.delete(key)})},
  discard:async(scope,id)=>{reviewUuid.parse(id);await transaction(scope,'readwrite',(old,store,key)=>{if(old&&old.requestId!==id)throw new DraftCacheError('MISMATCH');if(old)store.delete(key)})},
 };
}
