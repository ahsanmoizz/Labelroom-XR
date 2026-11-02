// LABELXR-REVIEW-ACK-v1
import {z} from 'zod';
import type {ReviewCommand} from './revision';
type CommandIdentity=Pick<ReviewCommand,'projectId'|'requestId'|'baseRevision'|'operation'|'frameId'|'objectId'>;
const uuid=z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const hash=z.string().regex(/^[0-9a-f]{64}$/);
export const reviewAcknowledgementSchema=z.strictObject({
 projectId:uuid,sourceBundleSha256:hash,requestId:uuid,payloadSha256:hash,
 revision:z.number().int().min(1).max(300),mutationId:uuid,
 operation:z.enum(['updateCuboid','keepIssue','removeDuplicate','undo']),
 frameId:z.string().min(1).max(128),objectId:z.string().min(1).max(128),
});
export type ReviewAcknowledgement=Readonly<z.infer<typeof reviewAcknowledgementSchema>>;
function bound(value:unknown,command:CommandIdentity):ReviewAcknowledgement {
 const a=reviewAcknowledgementSchema.parse(value);
 if(a.projectId!==command.projectId||a.requestId!==command.requestId||a.revision!==command.baseRevision+1||
    a.operation!==command.operation||a.frameId!==command.frameId||a.objectId!==command.objectId)throw Error('Review acknowledgement identity differs.');
 return Object.freeze(a);
}
/** SQL returns snapshots too;the HTTP acknowledgement exposes only bounded metadata. */
export function selectReviewAcknowledgement(value:unknown,command:CommandIdentity):ReviewAcknowledgement {
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Expected review acknowledgement.');
 const v=value as Record<string,unknown>;
 return bound(Object.fromEntries(Object.keys(reviewAcknowledgementSchema.shape).map(k=>[k,v[k]])),command);
}
/** This proves an acknowledged version;the store must separately load/apply its labels. */
export function verifyReviewAcknowledgement(value:unknown,command:CommandIdentity,sourceHash:string,payloadHash:string):ReviewAcknowledgement {
 const a=bound(value,command);
 if(a.sourceBundleSha256!==hash.parse(sourceHash)||a.payloadSha256!==hash.parse(payloadHash))throw Error('Review acknowledgement source/payload differs.');
 return a;
}
