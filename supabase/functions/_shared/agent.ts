// LABELXR-AI-ENDPOINT-v1
import{z}from'zod';import{AI_SCHEMA,requestSchema,responseSchema,toolCallSchema,assessmentSchema,roundSchema,type AiStep,type AiToolCall,type AiScope}from'../../../src/ai/protocol.ts';
import{requireVerifiedUser,type AuthenticationClient,type VerifiedIdentity}from'./auth.ts';import{approvedOrigin,checkRequest,readJsonObject,jsonResponse,problemResponse,HttpProblem}from'./http.ts';import{agentPrompt}from'../agent/prompt.ts';
const id=z.string().min(1).max(128).refine(s=>!!s.trim()&&!/https?:\/\/|sb_secret_|gsk_/i.test(s)),finite=z.number().finite();
export const aiContextSchema=z.strictObject({projectId:z.string().uuid(),sourceBundleSha256:z.string().regex(/^[a-f0-9]{64}$/),revision:z.number().int().min(0).max(300),consent:z.boolean(),frames:z.array(z.strictObject({id,timestamp:finite,pointCount:z.number().int().min(0).max(200000),objects:z.array(z.strictObject({id,box:z.array(finite).length(10)})).max(100)})).min(1).max(10)});
export type AiContext=z.infer<typeof aiContextSchema>;
const messages={disabled:[503,'AI assistance is disabled or not configured.'],consent:[403,'Enable project AI consent before requesting assistance.'],conflict:[409,'The saved project changed. Reload before requesting AI.'],budget:[429,'The AI budget is exhausted. Manual review remains available.'],replay:[409,'This provider reservation was already used or interrupted. It will not be sent again.'],input:[400,'The AI request or tool evidence is invalid.'],provider:[503,'The model request failed or timed out. No edit was applied.'],response:[502,'The model returned an unsupported or ungrounded response.'],unavailable:[503,'AI project context is unavailable.']}as const;
export const responseReasons=['provider-envelope','finish-length','finish-content-filter','finish-reason','tool-limit','tool-json','tool-schema','tool-target','tool-duplicate','final-json','final-schema','final-evidence'] as const;
export type ResponseReason=typeof responseReasons[number];
const providerAssessmentSchema=z.strictObject({assessment:assessmentSchema.shape.assessment});
/** Provenance is application-owned: use only the exact completed, validated transcript. */
function completedEvidenceIds(step:AiStep,context:AiContext){
 const ids:string[]=[];
 for(const round of step.rounds){
  let parsed:ReturnType<typeof roundSchema.safeParse>;try{parsed=roundSchema.safeParse(round)}catch{throw new AgentProblem('response','final-evidence')}if(!parsed.success)throw new AgentProblem('response','final-evidence');
  for(const result of parsed.data.results){try{knownCall(result.call,context)}catch{throw new AgentProblem('response','final-evidence')}ids.push(result.call.id);}
 }
 if(ids.length<1||ids.length>8||new Set(ids).size!==ids.length)throw new AgentProblem('response','final-evidence');return ids;
}
export const providerReasons=['rate-limit','credentials','request-rejected','upstream-unavailable','timeout','network','invalid-response'] as const;
const providerDiagnosticSchema=z.strictObject({reason:z.enum(providerReasons),httpStatus:z.number().int().min(400).max(599).optional(),retryAfterSeconds:z.number().int().min(0).max(3600).optional(),rateLimitTokens:z.number().int().min(1).max(1000000000).optional(),remainingTokens:z.number().int().min(0).max(1000000000).optional(),code:z.enum(['rate_limit_exceeded','tokens','requests','tool_use_failed','invalid_request_error','invalid_api_key','model_not_found']).optional()});
export type ProviderDiagnostic=z.infer<typeof providerDiagnosticSchema>;
export class AgentProblem extends Error{readonly providerDiagnostic?:ProviderDiagnostic;constructor(readonly code:keyof typeof messages,readonly responseReason?:ResponseReason,diagnostic?:ProviderDiagnostic){super(messages[code][1]);const parsed=providerDiagnosticSchema.safeParse(diagnostic);if(code==='provider'&&parsed.success)this.providerDiagnostic=parsed.data;}get status(){return messages[this.code][0]}}
export interface AgentPort{context(token:string,identity:VerifiedIdentity,scope:AiScope,consent:boolean|null,signal:AbortSignal):Promise<unknown>;reserve(identity:VerifiedIdentity,step:AiStep,signal:AbortSignal):Promise<{data:unknown;error:{code?:string}|null}>;provider(body:unknown,signal:AbortSignal):Promise<unknown>}
function scopeEqual(a:AiScope,b:AiScope){return a.projectId===b.projectId&&a.sourceBundleSha256===b.sourceBundleSha256&&a.revision===b.revision;}
export function knownCall(call:AiToolCall,context:AiContext){const f=context.frames.find(f=>f.id===call.args.frameId);if(!f||call.name!=='listIssues'&&!f.objects.some(o=>o.id===call.args.objectId))throw new AgentProblem('input');}
export function toolsDefinition(){return(['listIssues','inspectBoxSupport','compareTrack','proposeFit','focusObject']as const).map(name=>({type:'function',function:{name,description:name==='proposeFit'?'Measure a bounded fit; never changes or saves labels.':name==='focusObject'?'Focus an existing object; never edits labels.':'Inspect measured existing-label evidence.',parameters:{type:'object',properties:{frameId:{type:'string',maxLength:128},...(name==='listIssues'?{cursor:{type:'integer',minimum:0,maximum:5150},limit:{type:'integer',minimum:1,maximum:10}}:{objectId:{type:'string',maxLength:128}})},required:name==='listIssues'?['frameId','cursor','limit']:['frameId','objectId'],additionalProperties:false}}}));}
export function providerRequest(step:AiStep,context:AiContext){
 const frame=context.frames.find(f=>f.id===step.frameId);if(!frame?.objects.some(o=>o.id===step.objectId))throw new AgentProblem('input');
 const messages:unknown[]=[{role:'system',content:agentPrompt},{role:'user',content:JSON.stringify({task:step.task,scope:{projectId:step.projectId,sourceBundleSha256:step.sourceBundleSha256,revision:step.revision},selected:{frameId:step.frameId,objectId:step.objectId},availableFrames:context.frames.map(f=>({frameId:f.id}))})}];
 for(const round of step.rounds){round.calls.forEach(c=>knownCall(c,context));messages.push({role:'assistant',content:null,tool_calls:round.calls.map(c=>({id:c.id,type:'function',function:{name:c.name,arguments:JSON.stringify(c.args)}}))});for(const r of round.results)messages.push({role:'tool',tool_call_id:r.call.id,name:r.call.name,content:JSON.stringify({scope:{projectId:step.projectId,sourceBundleSha256:step.sourceBundleSha256,revision:step.revision,frameId:r.call.args.frameId},measurement:r.result})});}
 const used=step.rounds.reduce((n,r)=>n+r.calls.length,0),finalOnly=step.callIndex===3||used>=8;
 const completed=step.rounds.flatMap(r=>r.results),ids=completed.map(r=>r.call.id);
 if(finalOnly&&ids.length===0)throw new AgentProblem('input');
 const finalMessages=[{role:'system',content:agentPrompt},{role:'user',content:JSON.stringify({task:step.task,scope:{projectId:step.projectId,sourceBundleSha256:step.sourceBundleSha256,revision:step.revision},selected:{frameId:step.frameId,objectId:step.objectId},completedEvidence:completed})}];
 const body={model:'openai/gpt-oss-20b',temperature:0,max_completion_tokens:700,reasoning_effort:'low',stream:false,
  parallel_tool_calls:finalOnly?undefined:false,tool_choice:finalOnly?undefined:'auto',tools:finalOnly?undefined:toolsDefinition(),
  response_format:finalOnly?{type:'json_schema',json_schema:{name:'labelxr_assessment',strict:true,schema:{type:'object',properties:{assessment:{type:'string',enum:['review-measurements','cannot-suggest-safely','no-change-recommended','needs-user-review']}},required:['assessment'],additionalProperties:false}}}:undefined,
  messages:finalOnly?finalMessages:messages};
 if(JSON.stringify(body).length>60000)throw new AgentProblem('input');return body;
}
export function parseProvider(value:unknown,step:AiStep,context:AiContext){
 const envelope=z.object({choices:z.array(z.object({finish_reason:z.string(),message:z.object({content:z.string().nullable().optional(),tool_calls:z.array(z.object({id,type:z.literal('function'),function:z.strictObject({name:z.string(),arguments:z.string().max(2000)})}).strict()).max(8).optional()})})).length(1)}).safeParse(value);
 if(!envelope.success)throw new AgentProblem('response','provider-envelope');
 const choice=envelope.data.choices[0],calls=choice.message.tool_calls??[],scope={projectId:step.projectId,sourceBundleSha256:step.sourceBundleSha256,revision:step.revision,turnId:step.turnId,callIndex:step.callIndex},prior=step.rounds.flatMap(r=>r.calls);
 const finishFailure=()=>new AgentProblem('response',choice.finish_reason==='length'?'finish-length':choice.finish_reason==='content_filter'?'finish-content-filter':'finish-reason');
 if(calls.length){
  if(choice.finish_reason!=='tool_calls')throw finishFailure();
  if(step.callIndex===3||prior.length+calls.length>8)throw new AgentProblem('response','tool-limit');
  const result=calls.map(c=>{let args:unknown;try{args=JSON.parse(c.function.arguments)}catch{throw new AgentProblem('response','tool-json')}
   const parsed=toolCallSchema.safeParse({id:c.id,name:c.function.name,args});if(!parsed.success)throw new AgentProblem('response','tool-schema');
   try{knownCall(parsed.data,context)}catch{throw new AgentProblem('response','tool-target')}return parsed.data;});
  if(new Set([...prior,...result].map(c=>c.id)).size!==prior.length+result.length)throw new AgentProblem('response','tool-duplicate');
  return responseSchema.parse({...scope,kind:'tools',calls:result});
 }
 if(choice.finish_reason!=='stop'||typeof choice.message.content!=='string')throw finishFailure();
 let content:unknown;try{content=JSON.parse(choice.message.content)}catch{throw new AgentProblem('response','final-json')}
 const compact=providerAssessmentSchema.safeParse(content),legacy=assessmentSchema.safeParse(content);
 if(!compact.success&&!legacy.success)throw new AgentProblem('response','final-schema');
 const evidenceIds=completedEvidenceIds(step,context);
 // Retain strict rejection for older provider replies that explicitly claim a bad citation.
 if(legacy.success&&(new Set(legacy.data.evidenceIds).size!==legacy.data.evidenceIds.length||legacy.data.evidenceIds.some(id=>!evidenceIds.includes(id))))throw new AgentProblem('response','final-evidence');
 const assessment=compact.success?compact.data.assessment:legacy.success?legacy.data.assessment:undefined;
 return responseSchema.parse({...scope,kind:'final',answer:{assessment,evidenceIds}});
}
/** A verified caller can consent and inspect only their current saved project. There is no edit capability. */
export function createAgentHandler(options:{origin:string;client:AuthenticationClient;port:AgentPort;enabled:boolean}){
 const origin=approvedOrigin(options.origin);return async(request:Request)=>{const rid=crypto.randomUUID();try{const preflight=checkRequest(request,origin,rid);if(preflight)return preflight;const raw=await readJsonObject(request),identity=await requireVerifiedUser(request,options.client),token=request.headers.get('Authorization')!.slice(7);let input:ReturnType<typeof requestSchema.parse>;try{input=requestSchema.parse(raw)}catch{throw new AgentProblem('input')}
 const scope={projectId:input.projectId,sourceBundleSha256:input.sourceBundleSha256,revision:input.revision},context=aiContextSchema.parse(await options.port.context(token,identity,scope,input.operation==='consent'?input.enabled:null,request.signal));if(!scopeEqual(scope,context))throw new AgentProblem('conflict');
 if(input.operation!=='step')return jsonResponse(request,origin,rid,responseSchema.parse({...scope,kind:'context',consent:context.consent,enabled:options.enabled}));if(!options.enabled)throw new AgentProblem('disabled');if(!context.consent)throw new AgentProblem('consent');const body=providerRequest(input,context);if(request.signal.aborted)throw new AgentProblem('provider');const permit=await options.port.reserve(identity,input,request.signal);if(permit.error)throw new AgentProblem(permit.error.code==='23514'?'budget':['PT409','40001'].includes(permit.error.code??'')?'conflict':permit.error.code==='42501'?'consent':'unavailable');const p=z.object({disposition:z.enum(['new','replay']),turnId:z.literal(input.turnId),projectId:z.literal(input.projectId),baseRevision:z.literal(input.revision),callIndex:z.literal(input.callIndex)}).parse(permit.data);if(p.disposition!=='new')throw new AgentProblem('replay');
 const fresh=aiContextSchema.parse(await options.port.context(token,identity,scope,null,request.signal));if(!scopeEqual(scope,fresh))throw new AgentProblem('conflict');if(!fresh.consent)throw new AgentProblem('consent');let response:unknown;try{response=await options.port.provider(body,request.signal)}catch(error){throw error instanceof AgentProblem&&error.code==='provider'?error:new AgentProblem('provider',undefined,{reason:'network'})}if(request.signal.aborted)throw new AgentProblem('provider');let out:unknown;try{out=parseProvider(response,input,fresh)}catch(error){throw error instanceof AgentProblem&&error.code==='response'?error:new AgentProblem('response','provider-envelope')}return jsonResponse(request,origin,rid,out);
 }catch(error){if(error instanceof AgentProblem){const base=jsonResponse(request,origin,rid,null);return new Response(JSON.stringify({error:{code:'ai_'+error.code,message:error.message},requestId:rid,...(error.code==='response'&&error.responseReason?{diagnostic:{reason:error.responseReason}}:error.code==='provider'&&error.providerDiagnostic?{diagnostic:error.providerDiagnostic}:{})}),{status:error.status,headers:base.headers});}return problemResponse(request,origin,rid,error instanceof HttpProblem?error:new HttpProblem('projectUnavailable'));}};
}
