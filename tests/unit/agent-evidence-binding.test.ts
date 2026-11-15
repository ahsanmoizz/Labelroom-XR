import {describe,it,expect,vi} from 'vitest';
import {requestSchema,type AiStep} from '../../src/ai/protocol';
import {AgentProblem,parseProvider,providerRequest,createAgentHandler} from '../../supabase/functions/_shared/agent';
const owner='11111111-1111-4111-8111-111111111111',projectId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',turnId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const scope={projectId,sourceBundleSha256:'a'.repeat(64),revision:0},selected={frameId:'00',objectId:'0165f0a8-0b6d-4445-a61b-ef68b76c82da'};
const call={id:'functions.inspectBoxSupport:0',name:'inspectBoxSupport' as const,args:selected};
const evidence={call,result:{objectId:selected.objectId,support:687,pointCount:175778}};
const context={...scope,consent:true,frames:[{id:'00',timestamp:0,pointCount:175778,objects:[{id:selected.objectId,box:[0,0,1,0,0,0,1,4,2,2]}]}]};
const first=requestSchema.parse({schema:'labelxr-ai/v1',operation:'step',...scope,...selected,turnId,callIndex:1,task:'Use inspectBoxSupport. Cite measured evidence without editing.',rounds:[]}) as AiStep;
const second=requestSchema.parse({...first,callIndex:2,rounds:[{calls:[call],results:[evidence]}]}) as AiStep;
const extra={...call,id:'opaque-provider-id-2'},third=requestSchema.parse({...first,callIndex:3,rounds:[...second.rounds,{calls:[extra],results:[{...evidence,call:extra}]}]}) as AiStep;
const reply=(value:unknown)=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]});
function why(value:unknown,step=second){try{parseProvider(reply(value),step,context)}catch(e){if(e instanceof AgentProblem)return e.responseReason;throw e}throw Error('Unexpected acceptance')}
describe('Server-owned evidence references',()=>{
 it.each(['review-measurements','cannot-suggest-safely','no-change-recommended','needs-user-review'])('binds %s to completed measurement IDs instead of asking the model to copy them',assessment=>{
  const out=parseProvider(reply({assessment}),second,context);expect(out.kind).toBe('final');if(out.kind==='final')expect(out.answer).toEqual({assessment,evidenceIds:[call.id]});
 });
 it('requires only the assessment in the strict final provider schema',()=>{const b=providerRequest(third,context),s=b.response_format!.json_schema.schema;expect(s.required).toEqual(['assessment']);expect(Object.keys(s.properties)).toEqual(['assessment']);expect(s.additionalProperties).toBe(false);expect(b.tools).toBeUndefined()});
 it('preserves all exact completed IDs across rounds',()=>{const out=parseProvider(reply({assessment:'needs-user-review'}),third,context);if(out.kind!=='final')throw Error();expect(out.answer.evidenceIds).toEqual([call.id,extra.id])});
 it('retains measured numeric values unchanged in the final provider input',()=>{const payload=JSON.parse(providerRequest(third,context).messages[1].content as string);expect(payload.completedEvidence[0]).toEqual(evidence);expect(payload.completedEvidence[0].result.support).toBe(687)});
 it('does not attach evidence when no tool has completed',()=>expect(why({assessment:'needs-user-review'},first)).toBe('final-evidence'));
 it('rejects unknown legacy references instead of replacing them with valid ones',()=>expect(why({assessment:'needs-user-review',evidenceIds:['invented']})).toBe('final-evidence'));
 it('rejects duplicate legacy references',()=>expect(why({assessment:'needs-user-review',evidenceIds:[call.id,call.id]})).toBe('final-evidence'));
 it('keeps valid legacy replies compatible but binds the full completed set',()=>{const out=parseProvider(reply({assessment:'needs-user-review',evidenceIds:[extra.id]}),third,context);if(out.kind!=='final')throw Error();expect(out.answer.evidenceIds).toEqual([call.id,extra.id])});
 it.each([{assessment:'687 points'},{assessment:'needs-user-review',support:687},{assessment:'needs-user-review',save:true},{assessment:'needs-user-review',evidenceIds:[]}])('rejects numeric prose, extra claims or empty legacy citations %#',body=>expect(why(body)).toBe('final-schema'));
 it('rejects corrupted completed evidence before producing a final assessment',()=>{const bad={...second,rounds:[{calls:[call],results:[{...evidence,result:{...evidence.result,support:175779}}]}]};expect(why({assessment:'needs-user-review'},bad as AiStep)).toBe('final-evidence')});
 it('rejects a mismatched transcript call instead of inventing a match',()=>{const bad={...second,rounds:[{calls:[call],results:[{...evidence,call:extra}]}]};expect(why({assessment:'needs-user-review'},bad as AiStep)).toBe('final-evidence')});
 it('rejects a completed tool that no longer belongs to the verified context',()=>{expect(()=>parseProvider(reply({assessment:'needs-user-review'}),second,{...context,frames:[{...context.frames[0],objects:[]}]})).toThrow(AgentProblem)});
 it('passes through the normal authenticated handler with one provider dispatch and unchanged client response format',async()=>{
  const provider=vi.fn(async()=>reply({assessment:'needs-user-review'})),reserve=vi.fn(async()=>({data:{disposition:'new',turnId,projectId,baseRevision:0,callIndex:2},error:null}));
  const h=createAgentHandler({origin:'http://localhost:8081',enabled:true,client:{auth:{getUser:async()=>({data:{user:{id:owner,role:'authenticated',is_anonymous:true}},error:null})}},port:{context:async()=>context,reserve,provider}});
  const response=await h(new Request('https://example.supabase.co/functions/v1/agent',{method:'POST',headers:{Origin:'http://localhost:8081',Authorization:'Bearer aa.bb.cc','Content-Type':'application/json'},body:JSON.stringify(second)}));
  expect(response.status).toBe(200);const body=await response.json();expect(body.data.answer).toEqual({assessment:'needs-user-review',evidenceIds:[call.id]});expect(body.data.sourceBundleSha256).toBe(scope.sourceBundleSha256);expect(body.data.revision).toBe(0);expect(provider).toHaveBeenCalledTimes(1);expect(reserve).toHaveBeenCalledTimes(1);
 });
});

// Cross the real client/server JSON boundary and the actual browser turn loop.
import {createAgentService,runAgentTurn} from '../../src/services/agent';
it.each([2,3])('finishes a %i-request measured turn through the unchanged public client contract without a retry or edit callback',async total=>{
 const requests:unknown[]=[],providerBodies:any[]=[],executed:any[]=[],shown:any[]=[];let reservations=0;
 const later={...call,id:'second:opaque-id'};
 const tools=(c:typeof call)=>({choices:[{finish_reason:'tool_calls',message:{content:null,tool_calls:[{id:c.id,type:'function',function:{name:c.name,arguments:JSON.stringify(c.args)}}]}}]});
 const handler=createAgentHandler({origin:'http://localhost:8081',enabled:true,client:{auth:{getUser:async()=>({data:{user:{id:owner,role:'authenticated',is_anonymous:true}},error:null})}},port:{context:async()=>context,reserve:async(_user,step)=>{reservations++;return{data:{disposition:'new',turnId,projectId,baseRevision:0,callIndex:step.callIndex},error:null}},provider:async body=>{providerBodies.push(body);return providerBodies.length===1?tools(call):total===3&&providerBodies.length===2?tools(later):reply({assessment:'needs-user-review'})}}});
 const auth={getSession:async()=>({data:{session:{access_token:'aa.bb.cc'}},error:null}),getUser:async()=>({data:{user:{id:owner,role:'authenticated',is_anonymous:true}},error:null})};
 const service=createAgentService({auth} as any,{supabaseUrl:'https://example.supabase.co',supabasePublishableKey:'sb_publishable_synthetic'} as any,owner,async(url,init)=>{requests.push(JSON.parse(String(init?.body)));return handler(new Request(String(url),{...init,headers:{...Object.fromEntries(new Headers(init?.headers)),Origin:'http://localhost:8081'}}))});
 const result=await runAgentTurn({service,scope,...selected,task:first.task,turnId,signal:new AbortController().signal,current:()=>true,execute:async c=>{executed.push(c);return{call:c,result:evidence.result}},evidence:v=>shown.push(v)});
 expect(result).toEqual({assessment:'needs-user-review',evidenceIds:total===2?[call.id]:[call.id,later.id]});expect(requests).toHaveLength(total);expect(reservations).toBe(total);expect(providerBodies).toHaveLength(total);expect(executed).toHaveLength(total-1);expect(shown.map(v=>v.result.support)).toEqual(total===2?[687]:[687,687]);
 if(total===3){expect(providerBodies[2].tools).toBeUndefined();expect(providerBodies[2].response_format.json_schema.schema.required).toEqual(['assessment'])}
});
