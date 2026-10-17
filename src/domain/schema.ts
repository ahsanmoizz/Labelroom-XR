import { z } from 'zod';
import { LIMITS } from './limits';

// Manifest component only. Member bytes/hashes and OpenLABEL are checked by the
// future bundle loader; accepting this document alone does not accept a bundle.
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const text = (max: number) => z.string().min(1).max(max).refine(v => v.trim().length > 0);
const frameSchema = z.strictObject({
  id: text(128),
  timestamp: z.number(),
  pcd: z.string().regex(/^frames\/[0-9]{3}\.pcd$/),
  sha256,
  pointCount: z.number().int().min(1).max(LIMITS.maxPointsPerFrame),
});

export const manifestSchema = z.strictObject({
  schemaVersion: z.literal('1.0'),
  bundleId: z.string().regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/),
  source: z.strictObject({
    name: text(1024), kind: z.enum(['real', 'synthetic-test']),
    url: z.string().max(2048), licence: text(1024), attribution: text(4096), sha256,
  }),
  // This translation is in source-world coordinates, so the local +/-250m
  // point limit does not apply. Reject non-finite values without recentering.
  sourceOrigin: z.tuple([z.number(), z.number(), z.number()]),
  units: z.literal('meters'), coordinates: z.literal('x-y-ground-z-up'),
  frames: z.array(frameSchema).min(1).max(LIMITS.maxFrames),
  hashes: z.strictObject({
    'labels.openlabel.json': sha256, 'LICENSE.txt': sha256, 'ATTRIBUTION.txt': sha256,
    'audit.json': sha256.optional(), 'review.json': sha256.optional(),
  }),
}).superRefine((manifest, ctx) => {
  const ids = new Set<string>(), paths = new Set<string>();
  for (let i = 0; i < manifest.frames.length; i++) {
    const f = manifest.frames[i];
    if (ids.has(f.id)) ctx.addIssue({ code: 'custom', path: ['frames', i, 'id'], message: 'Frame ID must be unique.' });
    if (paths.has(f.pcd)) ctx.addIssue({ code: 'custom', path: ['frames', i, 'pcd'], message: 'Point member path must be unique.' });
    if (i > 0 && f.timestamp <= manifest.frames[i - 1].timestamp) {
      ctx.addIssue({ code: 'custom', path: ['frames', i, 'timestamp'], message: 'Frame timestamps must be strictly increasing.' });
    }
    ids.add(f.id); paths.add(f.pcd);
  }
  // A real source requires a usable provenance URL. Synthetic fixtures may
  // use the empty URL in the supplied example. This code never fetches URLs.
  const url = manifest.source.url;
  let valid = url === '' && manifest.source.kind === 'synthetic-test';
  if (url !== '' && url === url.trim()) {
    try { const u = new URL(url); valid = ['http:', 'https:'].includes(u.protocol) && u.hostname !== '' && u.username === '' && u.password === ''; }
    catch { valid = false; }
  }
  if (!valid) ctx.addIssue({ code: 'custom', path: ['source', 'url'], message: 'Expected an absolute HTTP(S) provenance URL without credentials; only synthetic-test may use an empty URL.' });
});

export type BundleManifest = z.infer<typeof manifestSchema>;
export type ManifestErrorCode = 'INPUT' | 'BYTE_LIMIT' | 'UTF8' | 'JSON' | 'SCHEMA';
export class ManifestParseError extends Error {
  readonly name = 'ManifestParseError';
  constructor(readonly code: ManifestErrorCode, readonly filePath: string,
    readonly field: string, readonly frameId: string | null, detail: string) {
    super(`${filePath} | ${field}: ${detail}`);
  }
}

// Scan bounded JSON text before parsing so duplicate properties cannot silently
// replace an earlier value. Decode key escapes before comparing within each
// object. JSON.parse remains the authority for all other JSON grammar rules.
function checkJsonKeys(text: string, filePath: string): void {
  const stack: Array<Set<string> | null> = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '{' || c === '[') {
      if (stack.length >= 16) throw new ManifestParseError('JSON', filePath, 'file', null, 'Manifest nesting exceeds 16 levels.');
      stack.push(c === '{' ? new Set() : null);
    } else if (c === '}' || c === ']') stack.pop();
    else if (c === '"') {
      const start = i++;
      while (i < text.length && text[i] !== '"') { if (text[i] === '\\') i++; i++; }
      if (i >= text.length) return; // The JSON parser reports the grammar error.
      let next = i + 1;
      while (next < text.length && /[\t\r\n ]/.test(text[next])) next++;
      const keys = stack[stack.length - 1];
      if (text[next] === ':' && keys) {
        let key: unknown;
        try { key = JSON.parse(text.slice(start, i + 1)); } catch { return; }
        if (typeof key === 'string') {
          if (keys.has(key)) throw new ManifestParseError('JSON', filePath, 'file', null, 'Duplicate JSON property in a manifest object.');
          keys.add(key);
        }
      }
    }
  }
}

/** Parse one bounded UTF-8 manifest; no coercion, source mutation or I/O. */
export function parseManifestBytes(input: Uint8Array, filePath = 'manifest.json'): BundleManifest {
  const fail = (code: ManifestErrorCode, field: string, detail: string): never => {
    throw new ManifestParseError(code, filePath, field, null, detail);
  };
  if (!(input instanceof Uint8Array) || !(input.buffer instanceof ArrayBuffer)) fail('INPUT', 'file', 'Expected non-shared Uint8Array bytes.');
  if (input.byteLength > LIMITS.maxManifestBytes) fail('BYTE_LIMIT', 'file', 'Manifest exceeds 128 KiB.');
  let value: unknown;
  try {
    // Canonical JSON is UTF-8 without a BOM. Fatal decoding refuses replacement
    // characters that could silently alter identifiers and provenance strings.
    if (input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf) fail('UTF8', 'file', 'UTF-8 BOM is not canonical JSON.');
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(input);
    checkJsonKeys(decoded, filePath);
    try { value = JSON.parse(decoded); } catch { fail('JSON', 'file', 'Invalid JSON document.'); }
  } catch (error) {
    if (error instanceof ManifestParseError) throw error;
    fail('UTF8', 'file', 'Invalid UTF-8 encoding.');
  }
  const result = manifestSchema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = issue.path.map((p, i) => typeof p === 'number' ? `[${p}]` : `${i > 0 ? '.' : ''}${String(p)}`).join('') || 'manifest';
    let frameId: string | null = null;
    if (issue.path[0] === 'frames' && typeof issue.path[1] === 'number' && value && typeof value === 'object' && 'frames' in value) {
      const frames = (value as { frames: unknown }).frames;
      const frame: unknown = Array.isArray(frames) ? frames[issue.path[1]] : null;
      if (frame && typeof frame === 'object' && 'id' in frame && typeof frame.id === 'string') frameId = frame.id.slice(0, 128);
    }
    throw new ManifestParseError('SCHEMA', filePath, field, frameId, issue.message.slice(0, 256));
  }
  return result.data;
}
