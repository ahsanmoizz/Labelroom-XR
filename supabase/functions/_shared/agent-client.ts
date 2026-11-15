// LABELXR-AI-SDK-BOUNDARY-v1
import{createAgentHandler,AgentProblem,type AgentPort,type ProviderDiagnostic}from'./agent.ts';import type{AuthenticationClient}from'./auth.ts';
interface RpcClient extends AuthenticationClient{rpc(name:string,args:Record<string,unknown>):{abortSignal(signal:AbortSignal):PromiseLike<{data:unknown;error:{code?:string}|null}>}}
export type AgentSdkFactory=(url:string,key:string,options:{auth:{persistSession:false;autoRefreshToken:false;detectSessionInUrl:false};global:{fetch:typeof fetch;headers?:Record<string,string>}})=>RpcClient;
export async function boundedJson(response:Response,max:number,signal:AbortSignal):Promise<unknown>{if(!response.body)throw Error('No body');const reader=response.body.getReader(),chunks:Uint8Array[]=[];let n=0;try{for(;;){if(signal.aborted)throw Error('Cancelled');const r=await reader.read();if(r.done)break;n+=r.value.length;if(n>max)throw Error('Response bound');chunks.push(r.value)}}finally{await reader.cancel().catch(()=>{});reader.releaseLock()}const b=new Uint8Array(n);let at=0;for(const c of chunks){b.set(c,at);at+=c.length}return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(b))}
export function createAgentSdkHandler(config:{url:string;publicKey:string;serverKey:string;origin:string;enabled:boolean;groqKey:string},factory:AgentSdkFactory,fetcher:typeof fetch=globalThis.fetch){
 const u=new URL(config.url);if(u.origin!==config.url||u.protocol!=='https:'||!/^sb_publishable_[A-Za-z0-9_-]+$/.test(config.publicKey)||config.publicKey.length>512||!config.serverKey||config.serverKey.length>8192||config.enabled&&(!/^gsk_[A-Za-z0-9_-]+$/.test(config.groqKey)||config.groqKey.length>256))throw Error('Configuration');
 const auth={persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}as const;
 function bounded(kind:'auth'|'context'|'budget',token?:string,outer?:AbortSignal):typeof fetch{return async(input,init)=>{const target=new URL(input instanceof Request?input.url:String(input)),headers=new Headers(input instanceof Request?input.headers:undefined);new Headers(init?.headers).forEach((v,k)=>headers.set(k,v));const method=(init?.method??(input instanceof Request?input.method:'GET')).toUpperCase(),key=kind==='budget'?config.serverKey:config.publicKey,expected=kind==='auth'?'/auth/v1/user':'/rest/v1/rpc/'+(kind==='context'?'ai_context':'reserve_ai_budget');if(target.origin!==u.origin||target.pathname!==expected||target.search||target.hash||target.username||target.password||method!==(kind==='auth'?'GET':'POST')||headers.get('apikey')!==key||kind==='context'&&headers.get('Authorization')!=='Bearer '+token)throw Error('RPC scope');const signals=[AbortSignal.timeout(8000)];if(outer)signals.push(outer);if(init?.signal)signals.push(init.signal);if(input instanceof Request)signals.push(input.signal);const signal=AbortSignal.any(signals),r=await fetcher(input,{...init,headers,signal,redirect:'error',credentials:'omit'});if(kind==='auth')return r;const json=await boundedJson(r,524288,signal);return new Response(JSON.stringify(json),{status:r.status,statusText:r.statusText,headers:r.headers})}}
 const verifier=factory(config.url,config.publicKey,{auth,global:{fetch:bounded('auth')}});
 const port:AgentPort={
  async context(token,identity,scope,consent,signal){if(!identity.id)throw new AgentProblem('input');const client=factory(config.url,config.publicKey,{auth,global:{headers:{Authorization:'Bearer '+token},fetch:bounded('context',token,signal)}}),r=await client.rpc('ai_context',{p_project:scope.projectId,p_source_hash:scope.sourceBundleSha256,p_revision:scope.revision,p_consent:consent}).abortSignal(signal);if(r.error)throw new AgentProblem(r.error.code==='PT409'?'conflict':r.error.code==='42501'?'consent':'unavailable');return r.data;},
  async reserve(identity,step,signal){const client=factory(config.url,config.serverKey,{auth,global:{fetch:bounded('budget',undefined,signal)}});return await client.rpc('reserve_ai_budget',{p_owner:identity.id,p_project:step.projectId,p_turn:step.turnId,p_base_revision:step.revision,p_call_index:step.callIndex}).abortSignal(signal)},
  async provider(body,signal){
   const combined=AbortSignal.any([signal,AbortSignal.timeout(12000)]);let r:Response;
   try{r=await fetcher('https://api.groq.com/openai/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+config.groqKey,'Content-Type':'application/json'},body:JSON.stringify(body),credentials:'omit',redirect:'error',signal:combined})}
   catch{throw new AgentProblem('provider',undefined,{reason:combined.aborted?'timeout':'network'})}
   if(!r.ok){
    const diagnostic:ProviderDiagnostic={reason:r.status===429?'rate-limit':[401,403].includes(r.status)?'credentials':r.status>=500||r.status===498?'upstream-unavailable':'request-rejected',httpStatus:r.status};
    const integer=(name:string,max:number)=>{const raw=r.headers.get(name);if(raw!==null&&/^[0-9]{1,10}$/.test(raw)){const value=Number(raw);if(value<=max)return value;}};
    const retry=integer('retry-after',3600),limit=integer('x-ratelimit-limit-tokens',1000000000),remaining=integer('x-ratelimit-remaining-tokens',1000000000);
    if(retry!==undefined)diagnostic.retryAfterSeconds=retry;if(limit!==undefined&&limit>0)diagnostic.rateLimitTokens=limit;if(remaining!==undefined)diagnostic.remainingTokens=remaining;
    // Never forward provider prose, failed_generation, request bodies, IDs or keys.
    try{const raw=await boundedJson(r,4096,combined) as {error?:{code?:unknown;type?:unknown}};for(const code of [raw?.error?.code,raw?.error?.type])if(typeof code==='string'&&['rate_limit_exceeded','tokens','requests','tool_use_failed','invalid_request_error','invalid_api_key','model_not_found'].includes(code)){diagnostic.code=code as ProviderDiagnostic['code'];break;}}catch{}
    throw new AgentProblem('provider',undefined,diagnostic);
   }
   try{return await boundedJson(r,65536,combined)}catch{throw new AgentProblem('provider',undefined,{reason:combined.aborted?'timeout':'invalid-response'})}
  }
 };
 return createAgentHandler({origin:config.origin,client:verifier,port,enabled:config.enabled});
}
