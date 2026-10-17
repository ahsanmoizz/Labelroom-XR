import { LIMITS } from '../domain/limits';
import { DataJsonParseError, ManifestParseError, parseBoundedJsonBytes, parseManifestBytes, type BundleManifest } from '../domain/schema';
import { parseZipBytes, ZipParseError } from './zip';
import { parseCanonicalPcd, PcdParseError } from './pcd';
import { parseOpenLabelBytes, OpenLabelParseError, type LabelledBox } from './openlabel';

export type DeepReadonly<T> = T extends readonly (infer V)[] ? readonly DeepReadonly<V>[] : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
export type SourceJson = null | boolean | number | string | readonly SourceJson[] | { readonly [key: string]: SourceJson };
export interface BundleFrame {
  readonly id: string; readonly timestamp: number; readonly pcd: string; readonly pointCount: number;
  readonly boxes: readonly DeepReadonly<LabelledBox>[];
}
export interface BundleSource {
  /** SHA-256 of the exact uploaded ZIP bytes, distinct from manifest.source.sha256. */
  readonly bundleSha256: string;
  readonly manifest: DeepReadonly<BundleManifest>;
  readonly labelsDocument: DeepReadonly<Record<string, unknown>>;
  readonly frames: readonly BundleFrame[];
  readonly memberPaths: readonly string[];
  readonly memberHashes: Readonly<Record<string, string>>;
  readonly licenceText: string;
  readonly attributionText: string;
  /** Opaque imported history only; never active approval, revision or authorization state. */
  readonly historicalMetadata: Readonly<{ audit?: SourceJson; review?: SourceJson }>;
  getOriginalZipBytes(): Uint8Array;
  getMemberBytes(path: string): Uint8Array | undefined;
  getFramePoints(frameId: string): Float32Array;
}
export type BundleErrorCode = 'INPUT' | 'CRYPTO' | 'ZIP' | 'MANIFEST' | 'MEMBER_SET' | 'HASH' | 'RIGHTS' | 'PCD' | 'LABELS' | 'HISTORICAL_JSON' | 'FRAME';
export class BundleLoadError extends Error {
  readonly name = 'BundleLoadError';
  constructor(readonly code: BundleErrorCode, readonly filePath: string,
    readonly memberPath: string | null, readonly field: string,
    readonly frameId: string | null, readonly objectId: string | null,
    detail: string, readonly causeCode: string | null = null) {
    super(`${filePath}${memberPath === null ? '' : ' | ' + memberPath} | ${field}: ${detail}`);
  }
}
function freezeTree<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

/** Validate one complete bundle, with no storage, network or project-state side effects. */
export async function loadBundleBytes(input: Uint8Array, filePath = 'bundle.lrx.zip'): Promise<BundleSource> {
  const fail = (code: BundleErrorCode, member: string | null, field: string, detail: string,
    frame: string | null = null, object: string | null = null, cause: string | null = null): never => {
    throw new BundleLoadError(code, filePath, member, field, frame, object, detail, cause);
  };
  if (!(input instanceof Uint8Array) || !(input.buffer instanceof ArrayBuffer)) fail('INPUT', null, 'file', 'Expected non-shared Uint8Array bytes.');
  if (input.byteLength > LIMITS.maxCompressedBytes) fail('INPUT', null, 'file', 'ZIP exceeds 25 MiB compressed.');
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof subtle.digest !== 'function') fail('CRYPTO', null, 'SHA-256', 'Web Crypto SHA-256 is unavailable.');
  // Copy before the first await. Buffer.slice() would retain mutable caller memory.
  const original = new Uint8Array(input);
  const digest = async (bytes: Uint8Array, member: string | null): Promise<string> => {
    try {
      const hash = await subtle.digest('SHA-256', new Uint8Array(bytes).buffer);
      if (!(hash instanceof ArrayBuffer) || hash.byteLength !== 32) return fail('CRYPTO', member, 'SHA-256', 'Unexpected SHA-256 result.');
      return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
    } catch (e) {
      if (e instanceof BundleLoadError) throw e;
      return fail('CRYPTO', member, 'SHA-256', 'SHA-256 calculation failed.');
    }
  };
  let members: ReadonlyMap<string, Uint8Array>;
  try { members = await parseZipBytes(original, filePath); }
  catch (e) {
    if (e instanceof ZipParseError) return fail('ZIP', e.memberPath, 'archive', e.message, null, null, e.code);
    throw e;
  }
  let manifest: BundleManifest;
  try { manifest = parseManifestBytes(members.get('manifest.json')!); }
  catch (e) {
    if (e instanceof ManifestParseError) return fail('MANIFEST', e.filePath, e.field, e.message, e.frameId, null, e.code);
    throw e;
  }
  const wanted = new Map<string, { hash: string; frame: string | null }>();
  for (const frame of manifest.frames) wanted.set(frame.pcd, { hash: frame.sha256, frame: frame.id });
  for (const [name, hash] of Object.entries(manifest.hashes)) if (hash !== undefined) wanted.set(name, { hash, frame: null });
  for (const [name, expected] of wanted) if (!members.has(name)) fail('MEMBER_SET', name, 'manifest', 'Declared member is missing.', expected.frame);
  for (const name of members.keys()) if (name !== 'manifest.json' && !wanted.has(name)) fail('MEMBER_SET', name, 'manifest', 'Member is not declared by the manifest.');

  // Finish every member hash check before parsing any points, labels, rights or history.
  const hashes: Record<string, string> = {};
  for (const [name, expected] of wanted) {
    const actual = await digest(members.get(name)!, name);
    if (actual !== expected.hash) fail('HASH', name, 'sha256', 'Member SHA-256 differs from the manifest.', expected.frame);
    hashes[name] = actual;
  }
  hashes['manifest.json'] = await digest(members.get('manifest.json')!, 'manifest.json');
  const rights = (name: string): string => {
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(members.get(name)!); }
    catch { return fail('RIGHTS', name, 'text', 'Rights text must be valid UTF-8.'); }
    if (!text.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) fail('RIGHTS', name, 'text', 'Expected nonempty licence/attribution text without control bytes.');
    return text;
  };
  const licenceText = rights('LICENSE.txt'), attributionText = rights('ATTRIBUTION.txt');
  const historical: { audit?: SourceJson; review?: SourceJson } = {};
  for (const [member, key] of [['audit.json', 'audit'], ['review.json', 'review']] as const) {
    if (!members.has(member)) continue;
    let value: unknown;
    try { value = parseBoundedJsonBytes(members.get(member)!, member, LIMITS.maxAuditBytes, 32); }
    catch (e) {
      if (e instanceof DataJsonParseError) return fail('HISTORICAL_JSON', member, 'document', e.message, null, null, e.code);
      throw e;
    }
    let nodes = 0;
    const check = (v: unknown): void => {
      if (++nodes > 100_000) fail('HISTORICAL_JSON', member, 'document', 'Imported history exceeds 100000 nodes.');
      if (typeof v === 'number' && !Number.isFinite(v)) fail('HISTORICAL_JSON', member, 'document', 'Imported history contains a non-finite number.');
      if (Array.isArray(v) && v.length > 100_000 - nodes) fail('HISTORICAL_JSON', member, 'document', 'Imported history exceeds 100000 nodes.');
      if (v !== null && typeof v === 'object') for (const child of Object.values(v)) check(child);
    };
    check(value); historical[key] = value as SourceJson;
  }
  const points = new Map<string, Float32Array>();
  for (const frame of manifest.frames) {
    try { points.set(frame.id, parseCanonicalPcd(members.get(frame.pcd)!, frame.pcd, frame.pointCount)); }
    catch (e) {
      if (e instanceof PcdParseError) return fail('PCD', frame.pcd, e.field, e.message, frame.id, null, e.code);
      throw e;
    }
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  let labels: ReturnType<typeof parseOpenLabelBytes>;
  try { labels = parseOpenLabelBytes(members.get('labels.openlabel.json')!, manifest); }
  catch (e) {
    if (e instanceof OpenLabelParseError) return fail('LABELS', e.filePath, e.field, e.message, e.frameId, e.objectId, e.code);
    throw e;
  }
  const frames: BundleFrame[] = manifest.frames.map((frame, i) => ({
    id: frame.id, timestamp: frame.timestamp, pcd: frame.pcd, pointCount: frame.pointCount, boxes: labels.frames[i].boxes,
  }));
  const bundleSha256 = await digest(original, null);
  return Object.freeze({
    bundleSha256, manifest: freezeTree(manifest), labelsDocument: freezeTree(labels.document),
    frames: freezeTree(frames), memberPaths: Object.freeze([...members.keys()].sort()),
    memberHashes: Object.freeze(hashes), licenceText, attributionText, historicalMetadata: freezeTree(historical),
    getOriginalZipBytes: () => new Uint8Array(original),
    getMemberBytes: (path: string) => { const bytes = members.get(path); return bytes === undefined ? undefined : new Uint8Array(bytes); },
    getFramePoints: (id: string) => {
      const xyz = points.get(id);
      if (!xyz) return fail('FRAME', null, 'frameId', 'Frame ID is not in this bundle.', id);
      return new Float32Array(xyz);
    },
  });
}
