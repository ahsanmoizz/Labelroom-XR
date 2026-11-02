// LABELXR-REVIEW-SNAPSHOT-v1
import {z} from 'zod';
import {parseReviewEnvelopeBytes} from './review-envelope';
import type {BundleSource,DeepReadonly} from '../data/bundle';
import {parseOpenLabelBytes} from '../data/openlabel';
import {manifestSchema,parseBoundedJsonBytes} from './schema';
import {LIMITS} from './limits';
import type {ReviewCommand,ReviewContext} from './revision';
import type {CommittedExportSnapshot} from '../data/export';
export const reviewUuid=z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
export const reviewHash=z.string().regex(/^[0-9a-f]{64}$/);
export const reviewScopeSchema=z.strictObject({ownerId:reviewUuid,projectId:reviewUuid,sourceBundleSha256:reviewHash});
export type ReviewScope=Readonly<z.infer<typeof reviewScopeSchema>>;
export const reviewHeadSchema=z.strictObject({id:reviewUuid,owner_id:reviewUuid,status:z.literal('ready'),source_hash:reviewHash,source_bytes:z.number().int().min(1).max(LIMITS.maxCompressedBytes),current_revision:z.number().int().min(0).max(300)});
const id=z.string().min(1).max(128).refine(v=>!!v.trim());
const mutationSchema=z.strictObject({id:reviewUuid,request_id:reviewUuid,project_id:reviewUuid,revision:z.number().int().min(1).max(300),owner_id:reviewUuid,operation:z.enum(['updateCuboid','keepIssue','removeDuplicate','undo']),frame_id:id,object_id:id,partner_id:id.nullable(),reason:z.enum(['occlusion','valid-geometry','duplicate','other']),payload_hash:reviewHash,undo_of:reviewUuid.nullable(),created_at:z.string().max(64).refine(v=>Number.isFinite(Date.parse(v)))});
export type ReviewMutation=Readonly<z.infer<typeof mutationSchema>>;
const encoded=(v:unknown)=>new TextEncoder().encode(JSON.stringify(v));
function freeze<T>(v:T):DeepReadonly<T>{if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v)}return v as DeepReadonly<T>}
function equal(a:unknown,b:unknown):boolean {if(a===b)return true;if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;const x=a as Record<string,unknown>,y=b as Record<string,unknown>,keys=Object.keys(x);return keys.length===Object.keys(y).length&&keys.every(k=>Object.prototype.hasOwnProperty.call(y,k)&&equal(x[k],y[k]))}
function geometryScope(original:Record<string,unknown>,revised:Record<string,unknown>){
 const baseline=structuredClone(original) as {openlabel:{frames:Record<string,{objects?:Record<string,{object_data:{cuboid:{val:unknown}[]}}>}>}},out=revised as typeof baseline;
 for(const[id,frame]of Object.entries(baseline.openlabel.frames)){for(const object of Object.keys(frame.objects??{})){const item=out.openlabel.frames[id]?.objects?.[object];if(!item)delete frame.objects![object];else frame.objects![object].object_data.cuboid[0].val=item.object_data.cuboid[0].val}}
 if(!equal(baseline,revised))throw Error('Saved labels changed source metadata or introduced occurrences.');
}
export interface ReviewSnapshot extends ReviewScope {
 readonly revision:number;readonly original:BundleSource;readonly labelsDocument:DeepReadonly<Record<string,unknown>>;
 readonly frames:DeepReadonly<ReturnType<typeof parseOpenLabelBytes>['frames']>;readonly mutations:readonly ReviewMutation[];
 contextFor(command?:Pick<ReviewCommand,'requestId'>):ReviewContext;
 exportState(audit:Uint8Array):CommittedExportSnapshot;
}
/** Consistency validation only. The caller-scoped service supplies authorization and rereads the head. */
export function validateReviewSnapshot(scopeInput:ReviewScope,original:BundleSource,projectInput:unknown,versionInput:unknown,mutationInput:unknown):ReviewSnapshot {
 const scope=reviewScopeSchema.parse(scopeInput),head=reviewHeadSchema.parse(projectInput),manifest=manifestSchema.parse(original.manifest);
 if(head.id!==scope.projectId||head.owner_id!==scope.ownerId||head.source_hash!==scope.sourceBundleSha256||original.bundleSha256!==scope.sourceBundleSha256||head.source_bytes!==original.getOriginalZipBytes().length)throw Error('Snapshot source identity differs.');
 const raw=encoded(versionInput);if(raw.length>6*1024*1024)throw Error('Version exceeds limit.');
 const version=z.strictObject({project_id:reviewUuid,revision:z.number().int().min(0).max(300),label_doc:z.record(z.string(),z.unknown()),review_verdicts:z.record(z.string(),z.unknown())}).parse(parseReviewEnvelopeBytes(raw,'saved-version.json',6*1024*1024,32));
 if(version.project_id!==head.id||version.revision!==head.current_revision)throw Error('Saved version differs.');
 const labels=parseOpenLabelBytes(encoded(version.label_doc),manifest),verdictBytes=encoded(version.review_verdicts);
 parseBoundedJsonBytes(verdictBytes,'review-verdicts.json',LIMITS.maxAuditBytes,32);
 geometryScope(original.labelsDocument as Record<string,unknown>,labels.document);if(head.current_revision===0&&(!equal(original.labelsDocument,labels.document)||Object.keys(version.review_verdicts).length))throw Error('Revision zero differs from source.');
 const auditBytes=encoded(mutationInput),mutations=z.array(mutationSchema).max(300).parse(parseBoundedJsonBytes(auditBytes,'review-history.json',LIMITS.maxAuditBytes,16));
 if(mutations.length!==head.current_revision||new Set(mutations.map(m=>m.id)).size!==mutations.length||new Set(mutations.map(m=>m.request_id)).size!==mutations.length)throw Error('Review history is incomplete.');
 for(const[mIndex,m]of mutations.entries()){
  if(m.project_id!==head.id||m.owner_id!==scope.ownerId||m.revision!==mIndex+1||!original.frames.some(f=>f.id===m.frame_id&&f.boxes.some(b=>b.id===m.object_id)))throw Error('Review history identity differs.');
  if(m.operation==='undo'){const previous=mutations[mIndex-1];if(!previous||previous.operation==='undo'||m.undo_of!==previous.id||m.reason!=='other'||m.frame_id!==previous.frame_id||m.object_id!==previous.object_id)throw Error('Undo history differs.')}
  else if(m.undo_of!==null)throw Error('Unexpected undo reference.');
  if(m.operation==='removeDuplicate'){if(!m.partner_id||m.partner_id===m.object_id||m.reason!=='duplicate'||!original.frames.some(f=>f.id===m.frame_id&&f.boxes.some(b=>b.id===m.partner_id)))throw Error('Duplicate history differs.')}
  else if(m.partner_id!==null)throw Error('Unexpected duplicate partner.');
 }
 const document=freeze(labels.document),verdicts=freeze(version.review_verdicts),history=freeze(mutations),frames=freeze(labels.frames),last=mutations[mutations.length-1],revision=head.current_revision;
 const lastMutation=last?Object.freeze({projectId:head.id,requestId:last.request_id,revision:last.revision,operation:last.operation,frameId:last.frame_id,objectId:last.object_id}):undefined;
 return Object.freeze({...scope,revision,original,labelsDocument:document,frames,mutations:history,
  contextFor(command?:Pick<ReviewCommand,'requestId'>){const prior=command?history.find(m=>m.request_id===command.requestId):undefined;return{projectId:head.id,sourceBundleSha256:scope.sourceBundleSha256,revision,manifest:manifestSchema.parse(manifest),labels:encoded(document),...(lastMutation?{lastMutation:{...lastMutation}}:{}),...(prior?{priorRequest:{projectId:head.id,sourceBundleSha256:scope.sourceBundleSha256,requestId:prior.request_id,payloadSha256:prior.payload_hash,revision:prior.revision}}:{})}},
  exportState(audit:Uint8Array):CommittedExportSnapshot {
   const parsed=parseReviewEnvelopeBytes(audit,'saved-audit.json',LIMITS.maxAuditBytes,32) as {schema?:unknown;projectId?:unknown;sourceBundleSha256?:unknown;revision?:unknown;mutations?:unknown};
   if(!parsed||Object.keys(parsed).some(k=>!['schema','projectId','sourceBundleSha256','revision','mutations'].includes(k))||parsed.schema!=='labelxr-review-audit/v1'||parsed.projectId!==head.id||parsed.sourceBundleSha256!==scope.sourceBundleSha256||parsed.revision!==revision||!Array.isArray(parsed.mutations)||parsed.mutations.length!==history.length)throw Error('Export audit scope differs.');
   parsed.mutations.forEach((value,index)=>{if(!value||typeof value!=='object'||!Object.prototype.hasOwnProperty.call(value,'before_doc')||!Object.prototype.hasOwnProperty.call(value,'after_doc'))throw Error('Full export audit is required.');const{before_doc,after_doc,...metadata}=value as Record<string,unknown>;if(!equal(metadata,history[index]))throw Error('Export audit history differs.');});
   return{saveState:'saved',revision,sourceBundleSha256:scope.sourceBundleSha256,labels:encoded(document),audit:new Uint8Array(audit),review:encoded({schema:'labelxr-review-verdicts/v1',projectId:head.id,revision,verdicts})};
  },
 });
}
