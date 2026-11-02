// LABELXR-REVIEW-SDK-v1
import {createReviewHandler,type ReviewRpcPort} from './reviews.ts';
import {approvedOrigin} from './http.ts';
import type {AuthenticationClient} from './auth.ts';
import type {ReviewCommand} from '../../../src/domain/revision.ts';
interface ReviewSdkClient extends AuthenticationClient {
 rpc(name:'commit_review',args:{command:ReviewCommand}):{abortSignal(signal:AbortSignal):PromiseLike<Awaited<ReturnType<ReviewRpcPort['commit']>>>};
}
export type ReviewSdkFactory=(url:string,key:string,options:{auth:{persistSession:false;autoRefreshToken:false;detectSessionInUrl:false};global:{fetch:typeof fetch;headers?:Record<string,string>}})=>ReviewSdkClient;
export interface ReviewEndpointConfig {url:string;publishableKey:string;origin:string}
/** Each mutation gets a fresh public-key client carrying only its verified caller JWT. */
export function createReviewSdkHandler(config:ReviewEndpointConfig,createClient:ReviewSdkFactory,fetcher:typeof fetch=globalThis.fetch){
 const u=new URL(config.url),origin=approvedOrigin(config.origin),key=config.publishableKey;
 if(u.origin!==config.url||u.protocol!=='https:'||typeof key!=='string'||key.length>512||!/^sb_publishable_[A-Za-z0-9_-]+$/.test(key))throw Error('Configuration');
 const bounded=(kind:'auth'|'rpc',token?:string,requestSignal?:AbortSignal):typeof fetch=>async(input,init)=>{
  const target=new URL(input instanceof Request?input.url:String(input)),headers=new Headers(input instanceof Request?input.headers:undefined);
  new Headers(init?.headers).forEach((v,k)=>headers.set(k,v));
  const method=(init?.method??(input instanceof Request?input.method:'GET')).toUpperCase(),authorization=headers.get('Authorization');
  if(target.origin!==u.origin||target.username||target.password||target.search||target.hash||target.pathname!==(kind==='auth'?'/auth/v1/user':'/rest/v1/rpc/commit_review')||method!==(kind==='auth'?'GET':'POST')||headers.get('apikey')!==key||!/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/i.test(authorization??'')||kind==='rpc'&&authorization!=='Bearer '+token)throw Error('Request scope');
  const signals=[AbortSignal.timeout(8000)];if(requestSignal)signals.push(requestSignal);if(input instanceof Request)signals.push(input.signal);if(init?.signal)signals.push(init.signal);
  return fetcher(input,{...init,headers,redirect:'error',credentials:'omit',signal:AbortSignal.any(signals)});
 };
 const auth={persistSession:false,autoRefreshToken:false,detectSessionInUrl:false} as const;
 const verifier=createClient(config.url,key,{auth,global:{fetch:bounded('auth')}});
 return createReviewHandler({origin,client:verifier,async open(token,identity,signal){
  if(signal.aborted||!identity.id)throw Error('Cancelled');
  const caller=createClient(config.url,key,{auth,global:{headers:{Authorization:'Bearer '+token},fetch:bounded('rpc',token,signal)}});
  return {async commit(command,commandSignal){return await caller.rpc('commit_review',{command}).abortSignal(AbortSignal.any([signal,commandSignal,AbortSignal.timeout(8000)]))}};
 }});
}
