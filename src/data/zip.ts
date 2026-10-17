import { Inflate } from 'fflate';
import { LIMITS } from '../domain/limits';

export type ZipErrorCode = 'INPUT' | 'COMPRESSED_LIMIT' | 'EXPANDED_LIMIT' | 'MEMBER_LIMIT' | 'PATH' | 'FORMAT' | 'UNSUPPORTED' | 'SIZE' | 'CRC' | 'DEFLATE' | 'MISSING';
export class ZipParseError extends Error {
  readonly name = 'ZipParseError';
  constructor(readonly code: ZipErrorCode, readonly filePath: string,
    readonly memberPath: string | null, detail: string) {
    super(`${filePath}${memberPath === null ? '' : ' | ' + memberPath}: ${detail}`);
  }
}
type Entry = { name: string; method: number; crc: number; compressed: number; size: number; local: number; start: number; end: number; cap: number };
const ROOT_NAMES = ['manifest.json', 'labels.openlabel.json', 'LICENSE.txt', 'ATTRIBUTION.txt'];
const INPUT_CHUNK = 1024; // Bound each synchronous inflater call before its output callback.
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let value = i;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  CRC_TABLE[i] = value >>> 0;
}

/** ZIP32 stored/deflate member bytes only. Manifest hashes and semantics belong to the bundle loader. */
export async function parseZipBytes(input: Uint8Array, filePath = 'bundle.lrx.zip'): Promise<ReadonlyMap<string, Uint8Array>> {
  const fail = (code: ZipErrorCode, member: string | null, detail: string): never => { throw new ZipParseError(code, filePath, member, detail); };
  if (!(input instanceof Uint8Array) || !(input.buffer instanceof ArrayBuffer)) fail('INPUT', null, 'Expected non-shared Uint8Array bytes.');
  if (input.byteLength > LIMITS.maxCompressedBytes) fail('COMPRESSED_LIMIT', null, 'ZIP exceeds 25 MiB compressed.');
  // Own the input across asynchronous yields, including when input is a Node Buffer.
  const bytes = new Uint8Array(input), view = new DataView(bytes.buffer);
  const range = (offset: number, count: number, member: string | null = null): void => {
    if (!Number.isSafeInteger(offset) || offset < 0 || count < 0 || offset + count > bytes.length) fail('FORMAT', member, 'Truncated or invalid ZIP range.');
  };
  const u16 = (p: number) => { range(p, 2); return view.getUint16(p, true); };
  const u32 = (p: number) => { range(p, 4); return view.getUint32(p, true); };
  // EOCD must end exactly at the input boundary; comments are supported, trailing payloads are not.
  let eocd = -1;
  for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 22 - 65535); p--) {
    if (u32(p) === 0x06054b50 && p + 22 + u16(p + 20) === bytes.length) { eocd = p; break; }
  }
  if (eocd < 0) fail('FORMAT', null, 'ZIP end directory is missing or truncated.');
  if (u16(eocd + 4) !== 0 || u16(eocd + 6) !== 0 || u16(eocd + 8) !== u16(eocd + 10)) fail('UNSUPPORTED', null, 'Multi-disk ZIP is unsupported.');
  const count = u16(eocd + 10), directorySize = u32(eocd + 12), directory = u32(eocd + 16);
  if (count === 65535 || directorySize === 0xffffffff || directory === 0xffffffff) fail('UNSUPPORTED', null, 'ZIP64 is unsupported.');
  if (count < 1 || count > LIMITS.maxZipMembers) fail('MEMBER_LIMIT', null, 'Expected 1..20 ZIP entries.');
  if (directory + directorySize !== eocd) fail('FORMAT', null, 'Directory range, ZIP64 records or hidden trailing records differ.');
  range(directory, directorySize);
  const extra = (p: number, length: number, member: string) => {
    const end = p + length; range(p, length, member);
    while (p < end) {
      if (p + 4 > end) fail('FORMAT', member, 'Malformed ZIP extra field.');
      const id = u16(p), n = u16(p + 2); p += 4;
      if (p + n > end) fail('FORMAT', member, 'Truncated ZIP extra field.');
      // These can override sizes, names or encryption semantics in other readers.
      if ([0x0001, 0x0017, 0x7075, 0x6375, 0x9901].includes(id)) fail('UNSUPPORTED', member, 'ZIP64, alternate names or encryption extra fields are unsupported.');
      p += n;
    }
  };
  const entries: Entry[] = [], names = new Set<string>();
  let p = directory, declaredTotal = 0;
  for (let i = 0; i < count; i++) {
    range(p, 46);
    if (p + 46 > eocd || u32(p) !== 0x02014b50) fail('FORMAT', null, 'Central directory entry differs.');
    const flags = u16(p + 8), method = u16(p + 10), crc = u32(p + 16), compressed = u32(p + 20), size = u32(p + 24);
    const nameLength = u16(p + 28), extraLength = u16(p + 30), commentLength = u16(p + 32), local = u32(p + 42);
    const next = p + 46 + nameLength + extraLength + commentLength;
    if (next > eocd || nameLength < 1 || nameLength > 128) fail('FORMAT', null, 'Directory name or metadata length differs.');
    // Only ASCII contract names are meaningful. This also rejects NUL, backslash and ambiguous encodings.
    let name = '';
    for (const c of bytes.subarray(p + 46, p + 46 + nameLength)) {
      if (c < 0x20 || c > 0x7e) fail('PATH', null, 'Expected an ASCII contract member path.');
      name += String.fromCharCode(c);
    }
    let cap: number;
    if (name === 'manifest.json') cap = LIMITS.maxManifestBytes;
    else if (name === 'labels.openlabel.json') cap = LIMITS.maxLabelsJsonBytes;
    else if (name === 'LICENSE.txt' || name === 'ATTRIBUTION.txt') cap = LIMITS.maxLicenceBytes;
    else if (name === 'audit.json' || name === 'review.json') cap = LIMITS.maxAuditBytes;
    else if (/^frames\/[0-9]{3}\.pcd$/.test(name)) cap = 16 * 1024 + LIMITS.maxPointsPerFrame * 12;
    else return fail('PATH', name, 'Member is outside the exact bundle path allowlist.');
    if (names.has(name)) fail('PATH', name, 'Duplicate member name.');
    names.add(name);
    if (u16(p + 6) > 20 || (method !== 0 && method !== 8) || (flags & ~0x080e) !== 0 || (method === 0 && (flags & 6) !== 0)) fail('UNSUPPORTED', name, 'Unsupported version, compression or general-purpose flags.');
    if (u16(p + 34) !== 0 || compressed === 0xffffffff || size === 0xffffffff || local === 0xffffffff) fail('UNSUPPORTED', name, 'Multi-disk or ZIP64 member is unsupported.');
    const attributes = u32(p + 38), kind = (attributes >>> 16) & 0xf000;
    if ((attributes & 0x18) !== 0 || (kind !== 0 && kind !== 0x8000)) fail('UNSUPPORTED', name, 'Only regular file members are supported; no symlinks or directories.');
    extra(p + 46 + nameLength, extraLength, name);
    if (size > cap) fail('EXPANDED_LIMIT', name, 'Declared member size exceeds its byte limit.');
    declaredTotal += size;
    if (declaredTotal > LIMITS.maxExpandedBytes) fail('EXPANDED_LIMIT', name, 'Declared ZIP expansion exceeds 40 MiB.');
    if (method === 0 && compressed !== size) fail('SIZE', name, 'Stored member sizes differ.');
    range(local, 30, name);
    if (u32(local) !== 0x04034b50 || u16(local + 4) !== u16(p + 6) || u16(local + 6) !== flags || u16(local + 8) !== method || u16(local + 26) !== nameLength) fail('FORMAT', name, 'Local and central headers differ.');
    const localExtra = u16(local + 28), data = local + 30 + nameLength + localExtra;
    range(local + 30, nameLength + localExtra, name);
    for (let j = 0; j < nameLength; j++) if (bytes[local + 30 + j] !== bytes[p + 46 + j]) fail('PATH', name, 'Local and central member names differ.');
    extra(local + 30 + nameLength, localExtra, name);
    let end = data + compressed;
    if (local >= directory || end > directory) fail('FORMAT', name, 'Member payload escapes the file area.');
    if (flags & 8) {
      if (u32(local + 14) !== 0 || u32(local + 18) !== 0 || u32(local + 22) !== 0) fail('FORMAT', name, 'Data-descriptor local sizes must be zero.');
      const descriptor = end + (u32(end) === 0x08074b50 ? 4 : 0);
      range(descriptor, 12, name);
      if (u32(descriptor) !== crc || u32(descriptor + 4) !== compressed || u32(descriptor + 8) !== size) fail('SIZE', name, 'Data descriptor differs from the directory.');
      end = descriptor + 12;
      if (end > directory) fail('FORMAT', name, 'Data descriptor escapes the file area.');
    } else if (u32(local + 14) !== crc || u32(local + 18) !== compressed || u32(local + 22) !== size) fail('SIZE', name, 'Local CRC or sizes differ from the directory.');
    entries.push({ name, method, crc, compressed, size, local, start: data, end, cap });
    p = next;
  }
  if (p !== eocd) fail('FORMAT', null, 'Central entry count or directory size differs.');
  // Require a single contiguous local-file area: no overlapping entries, prefixed executables or hidden files.
  const ordered = [...entries].sort((a, b) => a.local - b.local);
  let prior = 0;
  for (const e of ordered) {
    if (e.local !== prior) fail('FORMAT', e.name, 'Local entries overlap or leave unlisted bytes.');
    prior = e.end;
  }
  if (prior !== directory) fail('FORMAT', null, 'Unlisted bytes precede the directory.');
  if (ROOT_NAMES.some(name => !names.has(name)) || !entries.some(e => e.name.startsWith('frames/'))) fail('MISSING', null, 'Required manifest, labels, rights text or point member is missing.');
  if (entries.filter(e => e.name.startsWith('frames/')).length > LIMITS.maxFrames) fail('MEMBER_LIMIT', null, 'ZIP contains more than ten point members.');

  const members = new Map<string, Uint8Array>();
  let expanded = 0, sinceYield = 0;
  for (const e of ordered) {
    const chunks: Uint8Array[] = []; let actual = 0, crc = 0xffffffff, finished = false;
    const accept = (chunk: Uint8Array, final: boolean) => {
      actual += chunk.length; expanded += chunk.length;
      if (actual > e.cap || expanded > LIMITS.maxExpandedBytes) fail('EXPANDED_LIMIT', e.name, 'Actual streamed expansion exceeds its byte limit.');
      if (actual > e.size) fail('SIZE', e.name, 'Stream expands beyond its declared member size.');
      for (const c of chunk) crc = CRC_TABLE[(crc ^ c) & 255] ^ (crc >>> 8);
      if (chunk.length) chunks.push(new Uint8Array(chunk));
      finished = final;
    };
    const inflater = e.method === 8 ? new Inflate(accept) : null;
    try {
      if (e.compressed === 0) { if (inflater) inflater.push(new Uint8Array(), true); else accept(new Uint8Array(), true); }
      for (let offset = 0; offset < e.compressed; offset += INPUT_CHUNK) {
        const length = Math.min(INPUT_CHUNK, e.compressed - offset), final = offset + length === e.compressed;
        const chunk = bytes.subarray(e.start + offset, e.start + offset + length);
        if (inflater) inflater.push(chunk, final); else accept(chunk, final);
        sinceYield += length;
        if (sinceYield >= 64 * 1024) { sinceYield = 0; await new Promise<void>(resolve => setTimeout(resolve, 0)); }
      }
    } catch (error) {
      if (error instanceof ZipParseError) throw error;
      return fail('DEFLATE', e.name, 'Invalid or truncated compressed member.');
    }
    if (!finished || actual !== e.size) fail('SIZE', e.name, 'Final expanded member size differs.');
    if (((crc ^ 0xffffffff) >>> 0) !== e.crc) fail('CRC', e.name, 'Member CRC-32 differs.');
    const result = new Uint8Array(actual); let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
    members.set(e.name, result);
    // Also yield between highly compressed members; no map escapes until every member passes.
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  return members;
}
