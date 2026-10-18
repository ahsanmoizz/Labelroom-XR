// LABELXR-EXPORT-CORE-v1
import { zipSync, type Zippable } from 'fflate';
import { loadBundleBytes, type BundleSource } from './bundle';
import { parseOpenLabelBytes } from './openlabel';
import { parseBoundedJsonBytes, type BundleManifest } from '../domain/schema';
import { LIMITS } from '../domain/limits';

/** Pure serialization boundary. The caller must obtain a server-acknowledged
 * revision before constructing this snapshot. saveState is a consistency guard,
 * not proof of permission, approval or persistence. No UI/storage integration yet.
 * audit/review are bounded JSON records for that same revision. Imported history
 * is retained separately and never becomes authorization or a current decision.
 */
export interface CommittedExportSnapshot {
  saveState: 'saved' | 'pending' | 'failed';
  revision: number;
  sourceBundleSha256: string;
  labels: Uint8Array;
  audit: Uint8Array;
  review: Uint8Array;
}
export class BundleExportError extends Error {
  readonly name = 'BundleExportError';
  constructor(readonly code: 'STATE' | 'INPUT' | 'SCOPE' | 'LIMIT', detail: string) { super(detail); }
}
const fail = (code: BundleExportError['code'], message: string): never => { throw new BundleExportError(code, message); };
const equal = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const x = a as Record<string, unknown>, y = b as Record<string, unknown>;
  const keys = Object.keys(x);
  return keys.length === Object.keys(y).length && keys.every(k => Object.prototype.hasOwnProperty.call(y, k) && equal(x[k], y[k]));
};
const copy = (value: Uint8Array, max: number): Uint8Array<ArrayBuffer> => {
  if (!(value instanceof Uint8Array) || !(value.buffer instanceof ArrayBuffer)) return fail('INPUT', 'Expected non-shared bytes.');
  if (value.byteLength > max) return fail('LIMIT', 'Export member exceeds its byte limit.');
  const result = new Uint8Array(value.byteLength); result.set(value); return result;
};
const jsonBytes = (value: unknown): Uint8Array<ArrayBuffer> => new TextEncoder().encode(JSON.stringify(value));
async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(v => v.toString(16).padStart(2, '0')).join('');
}
function record(bytes: Uint8Array, revision: number, name: string): Record<string, unknown> {
  const value = parseBoundedJsonBytes(bytes, name, LIMITS.maxAuditBytes, 32);
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (value as Record<string, unknown>).revision !== revision) fail('INPUT', name + ' must identify the exported revision.');
  // JSON.parse admits overflow such as 1e400. The loader also checks historical
  // metadata, but refuse here before allocating a compressed output.
  let nodes = 0;
  function finite(v: unknown): void {
    if (++nodes > 100_000 || (typeof v === 'number' && !Number.isFinite(v))) fail('INPUT', 'Invalid or excessive export history.');
    if (v && typeof v === 'object') for (const child of Object.values(v)) finite(child);
  }
  finite(value); return value as Record<string, unknown>;
}
/** Ensure only existing per-frame cuboid values or occurrences can change.
 * IDs, classes, attributes, timestamps, unknown metadata and other frames remain.
 * Approval semantics belong to the future revision service, not this serializer.
 */
function geometryOnly(original: Record<string, unknown>, revised: Record<string, unknown>): void {
  const baseline = structuredClone(original) as any;
  const output = revised as any;
  for (const [frameId, frame] of Object.entries(baseline.openlabel.frames) as [string, any][]) {
    const objects = frame.objects || {};
    const changed = output.openlabel.frames[frameId].objects || {};
    for (const id of Object.keys(changed)) if (!Object.prototype.hasOwnProperty.call(objects, id)) fail('SCOPE', 'Cannot introduce an object occurrence.');
    for (const id of Object.keys(objects)) {
      if (!Object.prototype.hasOwnProperty.call(changed, id)) delete objects[id];
      else objects[id].object_data.cuboid[0].val = changed[id].object_data.cuboid[0].val;
    }
  }
  if (!equal(baseline, revised)) fail('SCOPE', 'Export may change only cuboid values or remove a frame occurrence.');
}

/** Serialize an explicitly supplied committed snapshot, retaining every point
 * member and rights byte. Returns bytes; no download, network or state mutation.
 */
export async function exportBundleBytes(source: BundleSource, snapshot: CommittedExportSnapshot): Promise<Uint8Array<ArrayBuffer>> {
  if (!snapshot || snapshot.saveState !== 'saved') fail('STATE', 'Wait for the acknowledged save before exporting.');
  if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 || snapshot.revision > LIMITS.maxReviewRevisions) fail('STATE', 'Invalid committed revision.');
  const revision = snapshot.revision, sourceHash = snapshot.sourceBundleSha256;
  if (typeof sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(sourceHash) || sourceHash !== source.bundleSha256) fail('STATE', 'Snapshot source identity differs.');
  // Freeze input bytes before the first await, including Node Buffer views.
  const labels = copy(snapshot.labels, LIMITS.maxLabelsJsonBytes);
  const audit = record(copy(snapshot.audit, LIMITS.maxAuditBytes), revision, 'audit.json');
  const review = record(copy(snapshot.review, LIMITS.maxAuditBytes), revision, 'review.json');
  const original = copy(source.getOriginalZipBytes(), LIMITS.maxCompressedBytes);
  if (await sha256(original) !== sourceHash) fail('STATE', 'Original source bytes differ.');
  const baseline = await loadBundleBytes(original, 'export-source.lrx.zip');
  const manifest: BundleManifest = structuredClone(baseline.manifest) as BundleManifest;
  const parsed = parseOpenLabelBytes(labels, manifest);
  geometryOnly(baseline.labelsDocument as Record<string, unknown>, parsed.document);
  const auditBytes = jsonBytes({ schema: 'labelxr-export-history/v1', sourceBundleSha256: sourceHash, revision,
    importedHistory: baseline.historicalMetadata.audit ?? null, current: audit });
  const reviewBytes = jsonBytes({ schema: 'labelxr-export-review/v1', sourceBundleSha256: sourceHash, revision,
    importedHistory: baseline.historicalMetadata.review ?? null, current: review });
  if (auditBytes.length > LIMITS.maxAuditBytes || reviewBytes.length > LIMITS.maxAuditBytes) fail('LIMIT', 'Combined export history exceeds its limit.');
  // Parse wrapped histories before compression so depth/node limits stay fixed.
  record(auditBytes, revision, 'audit.json'); record(reviewBytes, revision, 'review.json');
  const members = new Map<string, Uint8Array<ArrayBuffer>>();
  for (const name of baseline.memberPaths) {
    if (name === 'manifest.json') continue;
    const bytes = baseline.getMemberBytes(name);
    if (!bytes) fail('INPUT', 'Original member is missing.');
    members.set(name, copy(bytes!, LIMITS.maxExpandedBytes));
  }
  members.set('labels.openlabel.json', labels); members.set('audit.json', auditBytes); members.set('review.json', reviewBytes);
  manifest.hashes['labels.openlabel.json'] = await sha256(labels);
  manifest.hashes['audit.json'] = await sha256(auditBytes); manifest.hashes['review.json'] = await sha256(reviewBytes);
  members.set('manifest.json', jsonBytes(manifest));
  if (members.size > LIMITS.maxZipMembers || [...members.values()].reduce((n, b) => n + b.length, 0) > LIMITS.maxExpandedBytes) fail('LIMIT', 'Export exceeds member or expanded-byte limits.');
  const entries: Zippable = Object.create(null);
  for (const name of [...members.keys()].sort()) entries[name] = [members.get(name)!, { level: 6, mtime: new Date(1980, 0, 1) }];
  const zip = copy(zipSync(entries), LIMITS.maxCompressedBytes);
  // Use the actual import path to verify hashes, geometry and format again.
  await loadBundleBytes(zip, 'exported.lrx.zip');
  return zip;
}
