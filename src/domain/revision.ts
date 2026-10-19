// LABELXR-REVIEW-COMMAND-v1
import { z } from 'zod';
import { LIMITS } from './limits';
import { orientedBoxIoU } from './geometry';
import { manifestSchema, openLabelOccurrenceSchema, parseBoundedJsonBytes, type BundleManifest } from './schema';
import { parseOpenLabelBytes, type ParsedOpenLabel } from '../data/openlabel';

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const id = z.string().min(1).max(128).refine(v => v.trim().length > 0);
const revision = z.number().int().min(0).max(LIMITS.maxReviewRevisions);
const reasons = z.enum(['occlusion', 'valid-geometry', 'duplicate', 'other']);
const cuboid = z.array(z.number()).length(10).superRefine((v, ctx) => {
  if (!openLabelOccurrenceSchema.safeParse({ object_data: { cuboid: [{ name: 'bbox', val: v }] } }).success) {
    ctx.addIssue({ code: 'custom', message: 'Expected a bounded upright OpenLABEL cuboid.' });
  }
});
const common = { projectId: uuid, requestId: uuid, baseRevision: revision, frameId: id, objectId: id };
const issueSchema = z.strictObject({
  type: z.enum(['LOW_SUPPORT', 'DUPLICATE', 'DIMENSION_JUMP']), objectIds: z.array(id).min(1).max(2),
}).superRefine((v, ctx) => {
  if (v.objectIds.length !== (v.type === 'DUPLICATE' ? 2 : 1) || new Set(v.objectIds).size !== v.objectIds.length) {
    ctx.addIssue({ code: 'custom', message: 'Issue object IDs must be distinct and match its type.' });
  }
});
export const reviewCommandSchema = z.discriminatedUnion('operation', [
  z.strictObject({ ...common, operation: z.literal('updateCuboid'), before: cuboid, after: cuboid, reason: reasons }),
  z.strictObject({ ...common, operation: z.literal('keepIssue'), before: cuboid, issue: issueSchema, fingerprint: sha256, reason: reasons }),
  z.strictObject({ ...common, operation: z.literal('removeDuplicate'), before: cuboid, partnerId: id, partnerBefore: cuboid, confirmed: z.literal(true), reason: z.literal('duplicate') }),
  z.strictObject({ ...common, operation: z.literal('undo'), undoOf: uuid, reason: z.literal('other') }),
]);
export type ReviewCommand = z.infer<typeof reviewCommandSchema>;
const lastSchema = z.strictObject({
  projectId: uuid, requestId: uuid, revision: revision,
  operation: z.enum(['updateCuboid', 'keepIssue', 'removeDuplicate', 'undo']), frameId: id, objectId: id,
});
const receiptSchema = z.strictObject({
  projectId: uuid, sourceBundleSha256: sha256, requestId: uuid, payloadSha256: sha256, revision: revision,
});
/** Context and receipts must come from the authenticated service, not a client claim.
 * This module checks consistency only. It performs no authorization, persistence,
 * source-label edit, inverse edit, or save acknowledgement. SQL must repeat the checks.
 */
export interface ReviewContext {
  projectId: string; sourceBundleSha256: string; revision: number;
  manifest: BundleManifest; labels: Uint8Array;
  lastMutation?: z.infer<typeof lastSchema>;
  priorRequest?: z.infer<typeof receiptSchema>;
}
type Frozen<T> = T extends object ? { readonly [K in keyof T]: Frozen<T[K]> } : T;
export type ValidatedReviewRequest = Frozen<{
  disposition: 'new' | 'replay'; command: ReviewCommand; payloadSha256: string;
  // A candidate revision is not a committed revision or a Saved state.
  candidateRevision?: number; committedRevision?: number; duplicateIoU?: number; issueFingerprint?: string;
}>;
export class ReviewCommandError extends Error {
  readonly name = 'ReviewCommandError';
  constructor(readonly code: 'CONTEXT' | 'COMMAND' | 'CONFLICT' | 'LIMIT' | 'BEFORE' | 'DUPLICATE' | 'FINGERPRINT' | 'UNDO' | 'REPLAY' | 'HASH', message: string) { super(message); }
}
function requireReview(ok: unknown, code: ReviewCommandError['code'], message: string): asserts ok {
  if (!ok) throw new ReviewCommandError(code, message);
}
function freeze<T>(v: T): Frozen<T> {
  if (v !== null && typeof v === 'object') { for (const child of Object.values(v)) freeze(child); Object.freeze(v); }
  return v as Frozen<T>;
}
function canonical(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v !== null && typeof v === 'object') {
    const r = v as Record<string, unknown>;
    return '{' + Object.keys(r).sort().map(k => JSON.stringify(k) + ':' + canonical(r[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}
async function hash(v: unknown): Promise<string> {
  try {
    const result = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(v)));
    return Array.from(new Uint8Array(result), b => b.toString(16).padStart(2, '0')).join('');
  } catch { throw new ReviewCommandError('HASH', 'SHA-256 is unavailable; no request accepted.'); }
}
function snapshot(context: ReviewContext) {
  // Zod creates independent copies; parse bytes synchronously before any await.
  const c = z.strictObject({ projectId: uuid, sourceBundleSha256: sha256, revision,
    lastMutation: lastSchema.optional(), priorRequest: receiptSchema.optional() }).parse({
    projectId: context.projectId, sourceBundleSha256: context.sourceBundleSha256, revision: context.revision,
    lastMutation: context.lastMutation, priorRequest: context.priorRequest,
  });
  const manifest = manifestSchema.parse(context.manifest);
  const labels = parseOpenLabelBytes(context.labels, manifest);
  return { ...c, manifest, labels };
}
type Snapshot = ReturnType<typeof snapshot>;
function readSnapshot(context: ReviewContext): Snapshot {
  try { return snapshot(context); } catch { throw new ReviewCommandError('CONTEXT', 'Expected a valid current project, revision, manifest and labels.'); }
}
function occurrence(labels: ParsedOpenLabel, frameId: string, objectId: string): number[] {
  // The bounded OpenLABEL reader already validated these own dictionary entries.
  const ol = labels.document.openlabel as { frames: Record<string, { objects?: Record<string, unknown> }> };
  const frame = ol.frames[frameId];
  const raw = frame?.objects && Object.prototype.hasOwnProperty.call(frame.objects, objectId) ? frame.objects[objectId] : undefined;
  requireReview(raw !== undefined, 'BEFORE', 'Selected object occurrence is missing.');
  return openLabelOccurrenceSchema.parse(raw).object_data.cuboid[0].val;
}
const equalValues = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((v, i) => v === b[i]);
function fingerprintInput(s: Snapshot, frameId: string, issue: z.infer<typeof issueSchema>) {
  requireReview(s.labels.frames.some(f => f.id === frameId), 'FINGERPRINT', 'Issue frame is missing.');
  const ids = [...issue.objectIds].sort();
  for (const objectId of ids) occurrence(s.labels, frameId, objectId);
  // Include the relevant tracks across all frames, so adjacent geometry/time/class
  // changes invalidate temporal keep decisions. Unrelated metadata does not.
  const tracks = s.labels.frames.map(f => [f.id, f.timestamp, ids.map(objectId => {
    const b = f.boxes.find(box => box.id === objectId);
    return [objectId, b ? [b.type, occurrence(s.labels, f.id, objectId)] : null];
  })]);
  return ['labelxr-issue-fingerprint/v1', s.projectId, s.sourceBundleSha256, issue.type, frameId, ids, tracks];
}
/** Fingerprint invalidation helper, not evidence that an issue was detected. */
export async function reviewIssueFingerprint(context: ReviewContext, frameId: string, issue: z.infer<typeof issueSchema>): Promise<string> {
  const s = readSnapshot(context);
  return hash(fingerprintInput(s, id.parse(frameId), issueSchema.parse(issue)));
}
export async function validateReviewCommand(bytes: Uint8Array, context: ReviewContext): Promise<ValidatedReviewRequest> {
  let command: ReviewCommand;
  try { command = reviewCommandSchema.parse(parseBoundedJsonBytes(bytes, 'review-command.json', 16_384, 8)); }
  catch { throw new ReviewCommandError('COMMAND', 'Expected one bounded, strict review command.'); }
  const s = readSnapshot(context);
  requireReview(command.projectId === s.projectId, 'CONTEXT', 'Command belongs to a different project.');
  const payloadSha256 = await hash(['labelxr-review-command/v1', s.sourceBundleSha256, command]);
  if (s.priorRequest) {
    const p = s.priorRequest;
    requireReview(p.projectId === s.projectId && p.sourceBundleSha256 === s.sourceBundleSha256 && p.requestId === command.requestId &&
      p.payloadSha256 === payloadSha256 && p.revision === command.baseRevision + 1 && p.revision <= s.revision,
    'REPLAY', 'Stored request receipt does not match the same payload and source.');
    return freeze({ disposition: 'replay', command, payloadSha256, committedRevision: p.revision });
  }
  requireReview(command.baseRevision === s.revision, 'CONFLICT', 'Base revision is stale; reload current state.');
  requireReview(s.revision < LIMITS.maxReviewRevisions, 'LIMIT', 'Review revision limit reached; read/export only.');
  const frame = s.labels.frames.find(f => f.id === command.frameId);
  requireReview(frame, 'BEFORE', 'Selected frame is missing.');
  const result: { duplicateIoU?: number; issueFingerprint?: string } = {};
  if (command.operation === 'undo') {
    const last = s.lastMutation;
    requireReview(last && last.projectId === s.projectId && last.revision === s.revision && last.requestId === command.undoOf &&
      last.requestId !== command.requestId && last.frameId === command.frameId && last.objectId === command.objectId && last.operation !== 'undo' && last.revision > 0,
    'UNDO', 'Only the latest committed decision can be undone once.');
  } else {
    requireReview(equalValues(occurrence(s.labels, command.frameId, command.objectId), command.before), 'BEFORE', 'Exact before geometry differs from current labels.');
    if (command.operation === 'updateCuboid') {
      requireReview(!equalValues(command.before, command.after), 'COMMAND', 'Geometry update is unchanged.');
    } else if (command.operation === 'removeDuplicate') {
      requireReview(command.partnerId !== command.objectId, 'DUPLICATE', 'Duplicate partner must be a different occurrence.');
      requireReview(equalValues(occurrence(s.labels, command.frameId, command.partnerId), command.partnerBefore), 'BEFORE', 'Exact partner geometry differs.');
      const target = frame.boxes.find(b => b.id === command.objectId)!, partner = frame.boxes.find(b => b.id === command.partnerId)!;
      requireReview(target.type === partner.type, 'DUPLICATE', 'Duplicate partner must have the same class.');
      result.duplicateIoU = orientedBoxIoU(target.box, partner.box);
      requireReview(result.duplicateIoU >= 0.90, 'DUPLICATE', 'Current oriented IoU is below 0.90.');
    } else {
      requireReview(command.issue.objectIds.includes(command.objectId), 'FINGERPRINT', 'Issue does not include selected object.');
      result.issueFingerprint = await hash(fingerprintInput(s, command.frameId, command.issue));
      requireReview(command.fingerprint === result.issueFingerprint, 'FINGERPRINT', 'Issue fingerprint is stale.');
    }
  }
  return freeze({ disposition: 'new', command, payloadSha256, candidateRevision: s.revision + 1, ...result });
}
