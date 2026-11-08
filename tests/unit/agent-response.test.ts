// LABELXR-AI-RESPONSE-RECOVERY-TESTS-v1
import {describe,it,expect,vi} from 'vitest';
import {AI_SCHEMA,requestSchema,type AiStep} from '../../src/ai/protocol';
import {createAgentSdkHandler} from '../../supabase/functions/_shared/agent-client';
import {AgentProblem,createAgentHandler,parseProvider,providerRequest,responseReasons} from '../../supabase/functions/_shared/agent';
const owner='11111111-1111-4111-8111-111111111111',projectId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',turnId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const scope={projectId,sourceBundleSha256:'a'.repeat(64),revision:7},target={frameId:'0',objectId:'box-a'};
const call={id:'measured-support',name:'inspectBoxSupport' as const,args:target};
const result={call,result:{objectId:'box-a',support:8,pointCount:100}};
const context={...scope,consent:true,frames:[{id:'0',timestamp:0,pointCount:100,objects:[{id:'box-a',box:[0,0,1,0,0,0,1,4,2,2]}]}]};
const first=requestSchema.parse({schema:AI_SCHEMA,operation:'step',...scope,...target,turnId,callIndex:1,task:'Inspect measured support.',rounds:[]});
if(first.operation!=='step')throw Error('Fixture scope');
const second:AiStep={...first,callIndex:2,rounds:[{calls:[call],results:[result]}]};
const fitCall={id:'measured-fit',name:'proposeFit' as const,args:target};
const fitResult={call:fitCall,result:{safe:false,reason:'SPARSE',objectId:'box-a',original:{center:[0,0,1],size:[4,2,2],yaw:0},originalSupport:8,candidateSupport:0,eligiblePoints:8,robustPoints:0,centerMovementM:0,yawDeltaDegrees:0,sizeRatios:[1,1,1]}};
const finalStep=requestSchema.parse({...first,callIndex:3,rounds:[{calls:[call],results:[result]},{calls:[fitCall],results:[fitResult]}]}) as AiStep;
const finalReply=(content=JSON.stringify({assessment:'needs-user-review',evidenceIds:[call.id]}),finish_reason='stop')=>({choices:[{finish_reason,message:{content}}]});
const toolReply=(args=JSON.stringify(target),name='inspectBoxSupport',id='fresh-support')=>({choices:[{finish_reason:'tool_calls',message:{content:null,tool_calls:[{id,type:'function',function:{name,arguments:args}}]}}]});
function reason(value:unknown,step:AiStep=second){try{parseProvider(value,step,context);throw Error('Unexpected acceptance')}catch(e){if(!(e instanceof AgentProblem))throw e;return e.responseReason}}
describe('Provider wire request modes',()=>{
 it.each([first,second])('omits response_format from tool request %#',step=>{const b=JSON.parse(JSON.stringify(providerRequest(step,context)));expect('response_format' in b).toBe(false);expect(b.parallel_tool_calls).toBe(false);expect(b.tools).toHaveLength(5);expect(b.tool_choice).toBe('auto')});
 it('removes all tool settings and tool-role messages from strict final mode',()=>{const b=JSON.parse(JSON.stringify(providerRequest(finalStep,context)));expect(b.response_format.type).toBe('json_schema');expect(b.response_format.json_schema.strict).toBe(true);for(const k of ['tools','tool_choice','parallel_tool_calls'])expect(k in b).toBe(false);expect(b.messages.map((x:{role:string})=>x.role)).toEqual(['system','user'])});
 it('binds final citation enum to the actual completed tool IDs',()=>{const b=providerRequest(finalStep,context);expect(b.response_format).toMatchObject({json_schema:{schema:{required:['assessment','evidenceIds'],additionalProperties:false,properties:{evidenceIds:{items:{enum:[call.id,fitCall.id]}}}}}});const payload=JSON.parse(b.messages[1].content as string);expect(payload.completedEvidence).toEqual([result,fitResult]);expect(payload.selected).toEqual(target)});
 it('retains the existing model, completion limit and nonstreaming policy',()=>{for(const step of [first,second,finalStep]){const b=providerRequest(step,context);expect(b.model).toBe('openai/gpt-oss-20b');expect(b.max_completion_tokens).toBe(700);expect(b.stream).toBe(false);expect(b.reasoning_effort).toBe('low')}});
 it('does not fabricate final evidence when none exists',()=>expect(()=>providerRequest({...finalStep,rounds:[]},context)).toThrow());
 it('keeps the existing 60000-character provider input bound',()=>expect(()=>providerRequest({...first,task:'x'.repeat(60001)},context)).toThrow());
});
describe('Redacted provider reply diagnostics',()=>{
 it('accepts a valid supported tool call and measured final reply',()=>{expect(parseProvider(toolReply(),first,context).kind).toBe('tools');expect(parseProvider(finalReply(),second,context).kind).toBe('final')});
 it.each([null,{}, {choices:[]},{choices:[{finish_reason:'stop',message:{content:9}}]}])('classifies malformed provider envelope %#',reply=>expect(reason(reply)).toBe('provider-envelope'));
 it.each([['length','finish-length'],['content_filter','finish-content-filter'],['unknown','finish-reason']])('classifies rejected finish %s', (finish,want)=>expect(reason(finalReply('{}',finish))).toBe(want));
 it('rejects malformed tool argument JSON',()=>expect(reason(toolReply('{'))).toBe('tool-json'));
 it('rejects an ungranted tool',()=>expect(reason(toolReply(JSON.stringify(target),'save'))).toBe('tool-schema'));
 it('rejects a foreign model target',()=>expect(reason(toolReply(JSON.stringify({...target,objectId:'foreign'})))).toBe('tool-target'));
 it('rejects repeated tool IDs from earlier evidence',()=>expect(reason(toolReply(JSON.stringify(target),call.name,call.id))).toBe('tool-duplicate'));
 it('does not accept another tool at the final request limit',()=>expect(reason(toolReply(),finalStep)).toBe('tool-limit'));
 it('rejects markdown around JSON instead of silently repairing it',()=>expect(reason(finalReply('```json\n{}\n```'))).toBe('final-json'));
 it('rejects missing assessment fields',()=>expect(reason(finalReply('{}'))).toBe('final-schema'));
 it('rejects invented numeric prose',()=>expect(reason(finalReply(JSON.stringify({assessment:'There are 900 points',evidenceIds:[call.id]})))).toBe('final-schema'));
 it('rejects empty evidence',()=>expect(reason(finalReply(JSON.stringify({assessment:'needs-user-review',evidenceIds:[]})))).toBe('final-schema'));
 it('rejects unknown evidence references',()=>expect(reason(finalReply(JSON.stringify({assessment:'needs-user-review',evidenceIds:['invented']})))).toBe('final-evidence'));
 it('rejects duplicate evidence references',()=>expect(reason(finalReply(JSON.stringify({assessment:'needs-user-review',evidenceIds:[call.id,call.id]})))).toBe('final-evidence'));
 it('limits diagnostics to a fixed enum',()=>expect(responseReasons).toEqual(['provider-envelope','finish-length','finish-content-filter','finish-reason','tool-limit','tool-json','tool-schema','tool-target','tool-duplicate','final-json','final-schema','final-evidence']));
 it('returns a reason with ai_response without exposing model prose or retrying',async()=>{
  const provider=vi.fn(async()=>finalReply('private gsk_secret upstream prose'));
  const handler=createAgentHandler({origin:'http://localhost:8081',enabled:true,client:{auth:{getUser:async()=>({data:{user:{id:owner,role:'authenticated',is_anonymous:false}},error:null})}},port:{context:async()=>context,reserve:async()=>({data:{disposition:'new',turnId,projectId,baseRevision:7,callIndex:2},error:null}),provider}});
  const reply=await handler(new Request('https://example.supabase.co/functions/v1/agent',{method:'POST',headers:{Origin:'http://localhost:8081','Content-Type':'application/json',Authorization:'Bearer aa.bb.cc'},body:JSON.stringify(second)}));
  expect(reply.status).toBe(502);const body=await reply.json();expect(body.error.code).toBe('ai_response');expect(body.diagnostic).toEqual({reason:'final-json'});expect(JSON.stringify(body)).not.toMatch(/private|gsk_secret|upstream prose/);expect(provider).toHaveBeenCalledTimes(1);
 });
});

// Model the confirmed provider protocol restriction at the actual serialized HTTP boundary.
describe('Groq tool and JSON compatibility regression',()=>{
 function sdk(step:AiStep,reply:unknown){const sent:Record<string,unknown>[]=[],provider=vi.fn(async(_url:unknown,init?:RequestInit)=>{const b=JSON.parse(String(init?.body));sent.push(b);if(b.tools&&b.response_format)return Response.json({error:{type:'invalid_request_error',param:'response_format',message:'json mode cannot be combined with tool/function calling'}},{status:400});return Response.json(reply)}),factory:any=()=>({auth:{getUser:async()=>({data:{user:{id:owner,role:'authenticated',is_anonymous:false}},error:null})},rpc:(name:string,args:Record<string,unknown>)=>({abortSignal:async()=>({data:name==='ai_context'?context:{disposition:'new',turnId,projectId,baseRevision:7,callIndex:args.p_call_index},error:null})})}),handler=createAgentSdkHandler({url:'https://example.supabase.co',publicKey:'sb_publishable_synthetic',serverKey:'sb_secret_synthetic',groqKey:'gsk_synthetic',origin:'http://localhost:8081',enabled:true},factory,provider as any);
 return {sent,provider,send:()=>handler(new Request('https://example.supabase.co/functions/v1/agent',{method:'POST',headers:{Origin:'http://localhost:8081','Content-Type':'application/json',Authorization:'Bearer aa.bb.cc'},body:JSON.stringify(step)}))};}
 it('passes a tool request through a provider that rejects JSON plus tools',async()=>{const f=sdk(first,toolReply()),r=await f.send();expect(r.status).toBe(200);expect((await r.json()).data.kind).toBe('tools');expect(f.sent[0].tools).toBeDefined();expect('response_format' in f.sent[0]).toBe(false);expect(f.provider).toHaveBeenCalledTimes(1)});
 it('uses strict final JSON without tool settings at the same HTTP boundary',async()=>{const f=sdk(finalStep,finalReply()),r=await f.send();expect(r.status).toBe(200);expect((await r.json()).data.kind).toBe('final');expect(f.sent[0].response_format).toMatchObject({type:'json_schema',json_schema:{strict:true}});for(const k of ['tools','tool_choice','parallel_tool_calls'])expect(k in f.sent[0]).toBe(false);expect(f.provider).toHaveBeenCalledTimes(1)});
 it('rejects an invented evidence ID after the wire-format repair',async()=>{const f=sdk(finalStep,finalReply(JSON.stringify({assessment:'needs-user-review',evidenceIds:['invented']}))),r=await f.send();expect(r.status).toBe(502);const b=await r.json();expect(b.error.code).toBe('ai_response');expect(b.diagnostic.reason).toBe('final-evidence');expect(f.provider).toHaveBeenCalledTimes(1)});
});
