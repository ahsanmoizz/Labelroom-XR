// LABELXR-AI-PROTOCOL-v1
import{z}from'zod';
export const AI_SCHEMA='labelxr-ai/v1' as const;
const id=z.string().min(1).max(128).refine(s=>!!s.trim()&&!/https?:\/\/|sb_secret_|gsk_|Bearer\s/i.test(s)),uuid=z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/),hash=z.string().regex(/^[a-f0-9]{64}$/),n=z.number().finite(),count=z.number().int().min(0).max(200000),size=z.tuple([n.positive().max(500),n.positive().max(500),n.positive().max(500)]),vector=z.tuple([n,n,n]);
export const scopeSchema=z.strictObject({projectId:uuid,sourceBundleSha256:hash,revision:z.number().int().min(0).max(300)});
export type AiScope=z.infer<typeof scopeSchema>;
export const toolCallSchema=z.discriminatedUnion('name',[
 z.strictObject({id:id,name:z.literal('listIssues'),args:z.strictObject({frameId:id,cursor:z.number().int().min(0).max(5150),limit:z.number().int().min(1).max(10)})}),
 z.strictObject({id:id,name:z.literal('inspectBoxSupport'),args:z.strictObject({frameId:id,objectId:id})}),
 z.strictObject({id:id,name:z.literal('compareTrack'),args:z.strictObject({frameId:id,objectId:id})}),
 z.strictObject({id:id,name:z.literal('proposeFit'),args:z.strictObject({frameId:id,objectId:id})}),
 z.strictObject({id:id,name:z.literal('focusObject'),args:z.strictObject({frameId:id,objectId:id})})
]);
export type AiToolCall=z.infer<typeof toolCallSchema>;
export const toolNames=['listIssues','inspectBoxSupport','compareTrack','proposeFit','focusObject']as const;
const box=z.strictObject({center:vector,size,yaw:n.min(-Math.PI).max(Math.PI)});
const fitSchema=z.strictObject({safe:z.boolean(),reason:z.enum(['OK','SPARSE','OCCLUDED','BOUNDS','UNCHANGED']),objectId:id,original:box,candidate:box.optional(),originalSupport:count,candidateSupport:count,eligiblePoints:count,robustPoints:count,centerMovementM:n.min(0).max(.5),yawDeltaDegrees:n.min(-15).max(15),sizeRatios:z.tuple([n.min(.8).max(1.2),n.min(.8).max(1.2),n.min(.8).max(1.2)])}).superRefine((f,c)=>{if(f.safe?f.reason!=='OK'||!f.candidate||f.eligiblePoints<20||f.robustPoints<Math.ceil(f.eligiblePoints*.8)||f.candidateSupport<f.robustPoints:f.reason==='OK'||!!f.candidate||f.candidateSupport!==0||f.robustPoints!==0||f.centerMovementM!==0||f.yawDeltaDegrees!==0)c.addIssue({code:'custom',message:'Fit evidence differs'});});
const issue=z.strictObject({key:id.max(1024),type:z.enum(['LOW_SUPPORT','DUPLICATE','DIMENSION_JUMP']),frameId:id,objectIds:z.array(id).min(1).max(2),severity:n.min(0).max(1000),evidence:z.union([z.strictObject({support:z.number().int().min(0).max(4),pointCount:count}),z.strictObject({iou:n.min(.9).max(1)}),z.strictObject({previousFrameId:id,dtSeconds:n.positive().max(1),sizeRatios:z.array(n.positive()).length(3)})])});
export function validateToolResult(call:AiToolCall,value:unknown):unknown{
 if(JSON.stringify(value).length>12000)throw Error('Tool output limit');
 if(call.name==='inspectBoxSupport'){const r=z.strictObject({objectId:id,support:count,pointCount:count}).parse(value);if(r.objectId!==call.args.objectId||r.support>r.pointCount)throw Error('Support scope');return r;}
 if(call.name==='compareTrack'){const r=z.strictObject({objectId:id,frames:z.array(z.strictObject({frameId:id,timestamp:n,present:z.boolean(),size:size.nullable()})).min(1).max(3)}).parse(value);if(r.objectId!==call.args.objectId||r.frames.some(f=>f.present!==(f.size!==null)))throw Error('Track scope');return r;}
 if(call.name==='proposeFit'){const r=fitSchema.parse(value);if(r.objectId!==call.args.objectId)throw Error('Fit scope');return r;}
 if(call.name==='focusObject')return z.strictObject({focused:z.literal(true),frameId:z.literal(call.args.frameId),objectId:z.literal(call.args.objectId)}).parse(value);
 const r=z.strictObject({total:z.number().int().min(0).max(5150),cursor:z.number().int().min(0).max(5150),next:z.number().int().min(0).max(5150).nullable(),issues:z.array(issue).max(10)}).parse(value);if(r.cursor!==call.args.cursor||r.issues.length>call.args.limit||r.issues.some(i=>i.frameId!==call.args.frameId)||r.next!==(r.cursor+r.issues.length<r.total?r.cursor+r.issues.length:null))throw Error('Issue scope');return r;
}
export const evidenceSchema=z.strictObject({call:toolCallSchema,result:z.unknown()}).transform(v=>({...v,result:validateToolResult(v.call,v.result)}));
export type AiEvidence=z.infer<typeof evidenceSchema>;
export const roundSchema=z.strictObject({calls:z.array(toolCallSchema).min(1).max(8),results:z.array(evidenceSchema).min(1).max(8)}).superRefine((r,c)=>{if(r.calls.length!==r.results.length||r.calls.some((t,i)=>JSON.stringify(t)!==JSON.stringify(r.results[i].call)))c.addIssue({code:'custom',message:'Transcript order differs'});});
export const stepSchema=scopeSchema.extend({schema:z.literal(AI_SCHEMA),operation:z.literal('step'),turnId:uuid,callIndex:z.number().int().min(1).max(3),frameId:id,objectId:id,task:z.string().trim().min(1).max(1000).refine(s=>!/https?:\/\/|sb_secret_|gsk_|Bearer\s/i.test(s)),rounds:z.array(roundSchema).max(2)}).superRefine((r,c)=>{const calls=r.rounds.flatMap(r=>r.calls);if(r.rounds.length!==r.callIndex-1||calls.length>8||new Set(calls.map(c=>c.id)).size!==calls.length)c.addIssue({code:'custom',message:'Turn limit orduplicate tool call'});});
export const requestSchema=z.union([stepSchema,scopeSchema.extend({schema:z.literal(AI_SCHEMA),operation:z.literal('context')}),scopeSchema.extend({schema:z.literal(AI_SCHEMA),operation:z.literal('consent'),enabled:z.boolean()})]);
export type AiRequest=z.infer<typeof requestSchema>;export type AiStep=z.infer<typeof stepSchema>;
export const assessmentSchema=z.strictObject({assessment:z.enum(['review-measurements','cannot-suggest-safely','no-change-recommended','needs-user-review']),evidenceIds:z.array(id).min(1).max(8)});
export type AiAssessment=z.infer<typeof assessmentSchema>;
export const responseSchema=z.union([scopeSchema.extend({kind:z.literal('context'),consent:z.boolean(),enabled:z.boolean()}),scopeSchema.extend({kind:z.literal('tools'),turnId:uuid,callIndex:z.number().int().min(1).max(3),calls:z.array(toolCallSchema).min(1).max(8)}),scopeSchema.extend({kind:z.literal('final'),turnId:uuid,callIndex:z.number().int().min(1).max(3),answer:assessmentSchema})]);
export type AiResponse=z.infer<typeof responseSchema>;
export function sameAiScope(a:AiScope,b:AiScope){return a.projectId===b.projectId&&a.sourceBundleSha256===b.sourceBundleSha256&&a.revision===b.revision;}
