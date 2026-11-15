import {describe,it,expect,vi} from 'vitest';
import {createClient} from '@supabase/supabase-js';
import {AI_SCHEMA,type AiStep} from '../../src/ai/protocol';
import {AgentProblem,providerRequest,providerReasons} from '../../supabase/functions/_shared/agent';
import {createAgentSdkHandler} from '../../supabase/functions/_shared/agent-client';

const owner='11111111-1111-4111-8111-111111111111',projectId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',turnId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const scope={projectId,sourceBundleSha256:'a'.repeat(64),revision:0};
const objectId='0165f0a8-0b6d-4445-a61b-ef68b76c82da',selected={frameId:'00',objectId};
const box=[0,0,1,0,0,0,1,4,2,2];
const context={...scope,consent:true,frames:Array.from({length:5},(_,frame)=>({id:String(frame).padStart(2,'0'),timestamp:frame/10,pointCount:175778,objects:Array.from({length:37},(_,n)=>({id:n===0?objectId:`10000000-0000-4000-8000-${String(n+1).padStart(12,'0')}`,box}))}))};
const first:AiStep={schema:AI_SCHEMA,operation:'step',...scope,...selected,turnId,callIndex:1,task:'Inspect measured support.',rounds:[]};
const call={id:'measured-support',name:'inspectBoxSupport' as const,args:selected};
const evidence={call,result:{objectId,support:687,pointCount:175778}};
const second:AiStep={...first,callIndex:2,rounds:[{calls:[call],results:[evidence]}]};
function sdk(reply:Response|(()=>Promise<Response>),abort?:AbortController){
 const calls:{url:string;body:any}[]=[];
 const fetcher:typeof fetch=async(input,init)=>{
  const url=new URL(input instanceof Request?input.url:String(input)),body=init?.body?JSON.parse(String(init.body)):null;calls.push({url:url.href,body});
  if(url.pathname==='/auth/v1/user')return Response.json({id:owner,role:'authenticated',is_anonymous:false});
  if(url.pathname.endsWith('/ai_context'))return Response.json(context);
  if(url.pathname.endsWith('/reserve_ai_budget'))return Response.json({disposition:'new',projectId,turnId,baseRevision:0,callIndex:2});
  if(url.origin==='https://api.groq.com'){if(abort){abort.abort();throw new DOMException('private cancellation','AbortError')}return typeof reply==='function'?reply():reply;}
  throw Error('Unexpected transport');
 };
 const handler=createAgentSdkHandler({url:'https://example.supabase.co',publicKey:'sb_publishable_synthetic',serverKey:'sb_secret_synthetic',origin:'http://localhost:8081',enabled:true,groqKey:'gsk_synthetic'},createClient as any,fetcher);
 return{calls,send:()=>handler(new Request('https://example.supabase.co/functions/v1/agent',{method:'POST',headers:{Origin:'http://localhost:8081','Content-Type':'application/json',Authorization:'Bearer aa.bb.cc'},body:JSON.stringify(second),signal:abort?.signal}))};
}
describe('Compact multi-frame AI context without loss of authorization',()=>{
 it('sends selected identity and authorized frame IDs without broadcasting all185 object IDs',()=>{
  const body=providerRequest(first,context),data=JSON.parse(body.messages[1].content as string),text=JSON.stringify(body);
  expect(data.selected).toEqual(selected);expect(data.availableFrames).toEqual(context.frames.map(f=>({frameId:f.id})));
  for(const other of context.frames[0].objects.slice(1))expect(text).not.toContain(other.id);
  expect(text).not.toMatch(/pointCount|175778/);
  const old={...body,messages:[body.messages[0],{role:'user',content:JSON.stringify({...data,availableFrames:context.frames.map(f=>({frameId:f.id,objectIds:f.objects.map(o=>o.id)}))})}]};
  expect(text.length).toBeLessThan(JSON.stringify(old).length*.55);
 });
 it('names tool results and preserves exact call IDs, scope and measured evidence on follow-up',()=>{
  const body=providerRequest(second,context),tool=body.messages.find((m:any)=>m.role==='tool') as any;
  expect(tool.name).toBe(call.name);expect(tool.tool_call_id).toBe(call.id);
  expect(JSON.parse(tool.content)).toEqual({scope:{...scope,frameId:'00'},measurement:evidence.result});
 });
 it('retains all five tools and the third-call strict final mode',()=>{
  const two=providerRequest(second,context);expect(two.tools).toHaveLength(5);expect(two.response_format).toBeUndefined();expect(two.parallel_tool_calls).toBe(false);
  const three=providerRequest({...second,callIndex:3},context);expect(three.tools).toBeUndefined();expect(three.response_format?.type).toBe('json_schema');expect(three.response_format?.json_schema.strict).toBe(true);
  for(const body of [two,three]){expect(body.model).toBe('openai/gpt-oss-20b');expect(body.max_completion_tokens).toBe(700);expect(body.stream).toBe(false)}
 });
 it('still refuses a selected object outside the verified saved context',()=>expect(()=>providerRequest({...first,objectId:'foreign'},context)).toThrow());
});
describe('Redacted provider-specific diagnostics at the actual installed SDK transport',()=>{
 it('returns bounded429 metadata without upstream prose, private keys or a second provider attempt',async()=>{
  const f=sdk(Response.json({error:{code:'rate_limit_exceeded',message:'private gsk_secret source data',failed_generation:'never expose'}},{status:429,headers:{'retry-after':'19','x-ratelimit-limit-tokens':'8000','x-ratelimit-remaining-tokens':'12'}}));
  const r=await f.send(),raw=await r.text(),body=JSON.parse(raw);expect(r.status).toBe(503);expect(body.error.code).toBe('ai_provider');
  expect(body.diagnostic).toEqual({reason:'rate-limit',httpStatus:429,retryAfterSeconds:19,rateLimitTokens:8000,remainingTokens:12,code:'rate_limit_exceeded'});
  expect(raw).not.toMatch(/private|gsk_|never expose|aa\.bb\.cc|failed_generation/);
  expect(f.calls.filter(c=>c.url.startsWith('https://api.groq.com'))).toHaveLength(1);expect(f.calls.filter(c=>c.url.endsWith('/reserve_ai_budget'))).toHaveLength(1);
 });
 it.each([[400,'request-rejected'],[401,'credentials'],[403,'credentials'],[413,'request-rejected'],[422,'request-rejected'],[500,'upstream-unavailable'],[503,'upstream-unavailable']])('distinguishes upstream%s without changing the API contract',async(status,reason)=>{
  const f=sdk(new Response('private provider prose',{status:status as number})),r=await f.send(),body=await r.json();expect(r.status).toBe(503);expect(body.error.code).toBe('ai_provider');expect(body.diagnostic).toEqual({reason,httpStatus:status});expect(JSON.stringify(body)).not.toContain('private');expect(f.calls.filter(c=>c.url.startsWith('https://api.groq.com'))).toHaveLength(1);
 });
 it('exposes only an allowlisted error code for tool-generation rejection',async()=>{
  const r=await sdk(Response.json({error:{code:'tool_use_failed',message:'private generated functions',failed_generation:'gsk_secret'}},{status:400})).send();expect((await r.json()).diagnostic).toEqual({reason:'request-rejected',httpStatus:400,code:'tool_use_failed'});
 });
 it('drops invalid or excessive header values instead of returning raw values',async()=>{
  const r=await sdk(Response.json({error:{code:'private secret'}},{status:429,headers:{'retry-after':'999999','x-ratelimit-limit-tokens':'private','x-ratelimit-remaining-tokens':'-1'}})).send();expect((await r.json()).diagnostic).toEqual({reason:'rate-limit',httpStatus:429});
 });
 it('bounds rejected response bodies and never exposes truncated content',async()=>{
  const f=sdk(new Response('private'.repeat(1000),{status:400})),r=await f.send();expect((await r.json()).diagnostic).toEqual({reason:'request-rejected',httpStatus:400});expect(f.calls.filter(c=>c.url.startsWith('https://api.groq.com'))).toHaveLength(1);
 });
 it('classifies malformed successful provider JSON without echoing it',async()=>{
  const r=await sdk(new Response('private invalid JSON')).send();expect((await r.json()).diagnostic).toEqual({reason:'invalid-response'});
 });
 it('classifies a transport exception without revealing its message',async()=>{
  const r=await sdk(async()=>{throw Error('private gsk_secret')}).send();const body=await r.json();expect(body.diagnostic).toEqual({reason:'network'});expect(JSON.stringify(body)).not.toContain('private');
 });
 it('classifies aborted dispatch without retrying',async()=>{
  const f=sdk(new Response(),new AbortController()),r=await f.send();expect((await r.json()).diagnostic).toEqual({reason:'timeout'});expect(f.calls.filter(c=>c.url.startsWith('https://api.groq.com'))).toHaveLength(1);
 });
 it('rejects diagnostic fields outside the fixed schema',()=>{
  expect(new AgentProblem('provider',undefined,{reason:'network',message:'private'} as any).providerDiagnostic).toBeUndefined();
  expect(providerReasons).toEqual(['rate-limit','credentials','request-rejected','upstream-unavailable','timeout','network','invalid-response']);
 });
 it('accepts a successful measured follow-up response with unchanged evidence validation',async()=>{
  const f=sdk(Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({assessment:'needs-user-review',evidenceIds:[call.id]})}}]})),r=await f.send();expect(r.status).toBe(200);expect((await r.json()).data.kind).toBe('final');expect(f.calls.filter(c=>c.url.startsWith('https://api.groq.com'))).toHaveLength(1);
 });
});
