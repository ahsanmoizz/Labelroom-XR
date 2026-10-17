import {
  DataJsonParseError, manifestSchema, openLabelFrameSchema, openLabelHeaderSchema,
  openLabelObjectSchema, openLabelOccurrenceSchema, parseBoundedJsonBytes,
  type BundleManifest,
} from '../domain/schema';
import { quaternionToYaw, type Box } from '../domain/geometry';
import { LIMITS } from '../domain/limits';

type JsonObject = Record<string, unknown>;
type JsonPath = Array<string | number>;
export interface LabelledBox { id: string; name?: string; type: string; box: Box; }
export interface OpenLabelFrame { id: string; timestamp: number; boxes: readonly LabelledBox[]; }
export interface ParsedOpenLabel {
  document: JsonObject;
  originalBytes: Uint8Array;
  frames: readonly OpenLabelFrame[];
}
export class OpenLabelParseError extends Error {
  readonly name = 'OpenLabelParseError';
  constructor(readonly code: string, readonly filePath: string, readonly field: string,
    readonly frameId: string | null, readonly objectId: string | null, detail: string) {
    super(`${filePath} | ${field}: ${detail}`);
  }
}
const record = (v: unknown): v is JsonObject => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (v: JsonObject, key: string) => Object.prototype.hasOwnProperty.call(v, key);
function location(p: JsonPath): string {
  return p.map((v, i) => typeof v === 'number' ? `[${v}]` : /^[A-Za-z_][A-Za-z_0-9]*$/.test(v) ? (i ? '.' : '') + v : `[${JSON.stringify(v)}]`).join('') || 'document';
}

/** Read the supported cuboid subset without changing source coordinates or metadata. */
export function parseOpenLabelBytes(input: Uint8Array, manifest: BundleManifest, filePath = 'labels.openlabel.json'): ParsedOpenLabel {
  const fail = (code: string, p: JsonPath, detail: string, frameId: string | null = null, objectId: string | null = null): never => {
    throw new OpenLabelParseError(code, filePath, location(p), frameId, objectId, detail);
  };
  let raw: unknown;
  try { raw = parseBoundedJsonBytes(input, filePath, LIMITS.maxLabelsJsonBytes, 32); }
  catch (e) {
    if (e instanceof DataJsonParseError) throw new OpenLabelParseError(e.code, filePath, 'file', null, null, e.detail);
    throw e;
  }
  // Bound unknown metadata too: keep finite JSON values and avoid huge node
  // graphs before the schemas project any fields. Nesting was capped at 32.
  let nodes = 0;
  function visit(v: unknown, p: JsonPath): void {
    if (++nodes > 100_000) fail('NODE_LIMIT', p, 'Label JSON exceeds 100000 nodes.');
    if (typeof v === 'number' && !Number.isFinite(v)) {
      const inFrame = p[0] === 'openlabel' && p[1] === 'frames';
      const inObjects = p[0] === 'openlabel' && (p[1] === 'objects' || (inFrame && p[3] === 'objects'));
      fail('NON_FINITE', p, 'Expected a finite JSON number.', inFrame ? String(p[2]) : null,
        inObjects ? String(p[inFrame ? 4 : 2]) : null);
    }
    if (Array.isArray(v)) {
      if (v.length > 100_000 - nodes) fail('NODE_LIMIT', p, 'Label JSON exceeds 100000 nodes.');
      for (let i = 0; i < v.length; i++) visit(v[i], [...p, i]);
    } else if (record(v)) for (const k of Object.keys(v)) visit(v[k], [...p, k]);
  }
  visit(raw, []);
  const header = openLabelHeaderSchema.safeParse(raw);
  if (!header.success) {
    const e = header.error.issues[0]; fail('SCHEMA', e.path.map(p => typeof p === 'symbol' ? String(p) : p), e.message.slice(0, 256));
  }
  if (!record(raw) || !record(raw.openlabel)) return fail('SCHEMA', ['openlabel'], 'Expected an OpenLABEL object.');
  const document = raw, ol = raw.openlabel;
  if (!record(manifest) || !Array.isArray(manifest.frames) || manifest.frames.length > LIMITS.maxFrames) {
    return fail('MANIFEST', ['manifest'], 'Expected a validated bounded manifest.');
  }
  const checkedManifest = manifestSchema.safeParse(manifest);
  if (!checkedManifest.success) return fail('MANIFEST', ['manifest'], 'Manifest does not satisfy the canonical contract.');
  const frames = ol.frames, globals = own(ol, 'objects') ? ol.objects : {};
  if (!record(frames)) return fail('SCHEMA', ['openlabel', 'frames'], 'Expected a frame dictionary.');
  if (!record(globals)) return fail('SCHEMA', ['openlabel', 'objects'], 'Expected a global object dictionary.');
  const globalIds = Object.keys(globals);
  if (globalIds.length > LIMITS.maxFrames * LIMITS.maxLabelsPerFrame) fail('GLOBAL_LIMIT', ['openlabel', 'objects'], 'More than 1000 global objects.');
  const metadata = new Map<string, { type: string; name?: string }>();
  for (const id of globalIds) {
    if (!id.trim() || id.length > 128) fail('SCHEMA', ['openlabel', 'objects', id], 'Object ID must contain 1..128 characters.');
    const value = openLabelObjectSchema.safeParse(globals[id]);
    if (!value.success) {
      const e = value.error.issues[0]; fail('SCHEMA', ['openlabel', 'objects', id, ...e.path.map(String)], e.message.slice(0, 256), null, id);
    } else metadata.set(id, value.data);
  }
  const wanted = checkedManifest.data.frames;
  const frameIds = Object.keys(frames);
  if (frameIds.length !== wanted.length || frameIds.some(id => !wanted.some(f => f.id === id))) {
    fail('FRAME_SET', ['openlabel', 'frames'], 'Frame IDs must exactly match the manifest.');
  }
  const result: OpenLabelFrame[] = [];
  for (const expected of wanted) {
    const id = expected.id, fp: JsonPath = ['openlabel', 'frames', id];
    if (!own(frames, id)) fail('FRAME_SET', fp, 'Manifest frame is missing.', id);
    const frame = frames[id], validFrame = openLabelFrameSchema.safeParse(frame);
    if (!validFrame.success) {
      const e = validFrame.error.issues[0]; return fail('SCHEMA', [...fp, ...e.path.map(String)], e.message.slice(0, 256), id);
    }
    if (validFrame.data.frame_properties.timestamp !== expected.timestamp) fail('TIMESTAMP', [...fp, 'frame_properties', 'timestamp'], 'Frame timestamp must exactly match the manifest.', id);
    if (!record(frame)) return fail('SCHEMA', fp, 'Expected a frame object.', id);
    const objects = own(frame, 'objects') ? frame.objects : {};
    if (!record(objects)) return fail('SCHEMA', [...fp, 'objects'], 'Expected a frame object dictionary.', id);
    const ids = Object.keys(objects);
    if (ids.length > LIMITS.maxLabelsPerFrame) fail('LABEL_LIMIT', [...fp, 'objects'], 'More than 100 labels in a frame.', id);
    const boxes: LabelledBox[] = [];
    for (const objectId of ids) {
      const op = [...fp, 'objects', objectId], global = metadata.get(objectId);
      if (!global || !own(globals, objectId)) return fail('OBJECT_REFERENCE', op, 'Frame object must reference global metadata.', id, objectId);
      const occurrence = openLabelOccurrenceSchema.safeParse(objects[objectId]);
      if (!occurrence.success) {
        const e = occurrence.error.issues[0]; return fail('SCHEMA', [...op, ...e.path.map(p => typeof p === 'symbol' ? String(p) : p)], e.message.slice(0, 256), id, objectId);
      }
      const v = occurrence.data.object_data.cuboid[0].val;
      const yaw = quaternionToYaw(v.slice(3, 7));
      boxes.push({ id: objectId, name: global.name, type: global.type,
        box: { center: [v[0], v[1], v[2]], size: [v[7], v[8], v[9]], yaw: Math.atan2(Math.sin(yaw), Math.cos(yaw)) } });
    }
    result.push({ id, timestamp: expected.timestamp, boxes });
  }
  return { document, originalBytes: new Uint8Array(input), frames: result };
}
