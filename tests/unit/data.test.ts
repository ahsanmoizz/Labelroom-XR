import assert from 'node:assert/strict';
import { beforeAll } from 'vitest';
import { exportBundleBytes } from '../../src/data/export';
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { unzipSync, zipSync } from 'fflate';
import { createHash } from 'node:crypto';
import { loadBundleBytes, BundleLoadError } from '../../src/data/bundle';
import { crc32, deflateRawSync } from 'node:zlib';
import { parseZipBytes, ZipParseError } from '../../src/data/zip';
import { parseOpenLabelBytes, OpenLabelParseError } from '../../src/data/openlabel';
import { parseManifestBytes, ManifestParseError } from '../../src/domain/schema';
import { parseCanonicalPcd, PcdParseError } from '../../src/data/pcd';

const exampleManifest = JSON.parse(readFileSync('contracts/manifest.example.json', 'utf8'));
const manifestBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const manifest = () => structuredClone(exampleManifest);
const exampleLabels = JSON.parse(readFileSync('contracts/labels.example.openlabel.json', 'utf8'));
const labels = () => structuredClone(exampleLabels);
function badLabels(value: unknown, code?: string, m = manifest()) {
  let caught: unknown;
  try { parseOpenLabelBytes(value instanceof Uint8Array ? value : manifestBytes(value), m, 'clip/labels.openlabel.json'); } catch (e) { caught = e; }
  expect(caught).toBeInstanceOf(OpenLabelParseError);
  const error = caught as OpenLabelParseError;
  if (code) expect(error.code).toBe(code);
  expect(error.filePath).toBe('clip/labels.openlabel.json'); expect(error.message).toContain(error.filePath);
  expect(error.field.length).toBeGreaterThan(0);
  return error;
}
const val = (l: ReturnType<typeof labels>) => l.openlabel.frames['0'].objects['object-01'].object_data.cuboid[0].val;

describe('DATA-01/02 OpenLABEL component (ZIP/member hashes and full data acceptance remain pending)', () => {
  it('reads the supplied fixture without changing bytes, source XYZ or original JSON', () => {
    const bytes = unzipSync(new Uint8Array(readFileSync('fixtures/contract-example.zip')))['labels.openlabel.json']; const before = bytes.slice();
    const r = parseOpenLabelBytes(bytes, manifest());
    expect(r.document).toEqual(exampleLabels); expect(r.originalBytes).toEqual(bytes); expect(bytes).toEqual(before);
    expect(r.frames[0].boxes[0]).toEqual({ id: 'object-01', name: 'object-01', type: 'Example', box: { center: [0, 0, 0.5], size: [2, 2, 2], yaw: 0 } });
    r.frames[0].boxes[0].box.center = [9, 9, 9]; r.originalBytes[0] = 0;
    expect(r.document).toEqual(exampleLabels); expect(bytes).toEqual(before);
    const nodeBuffer = Buffer.from(bytes), copy = parseOpenLabelBytes(nodeBuffer, manifest());
    copy.originalBytes[0] = 0;
    expect(nodeBuffer[0]).toBe(bytes[0]);
  });
  it('preserves unknown metadata, attributes, unrelated geometry, IDs and Unicode values', () => {
    const l = labels(); l.vendor = { text: 'unchanged ہنان', values: [true, null, { custom: 7 }] };
    l.openlabel.metadata.extra = { source: 'capture' }; l.openlabel.objects['object-01'].attributes = { quality: 'occluded' };
    l.openlabel.frames['0'].objects['object-01'].object_data.points2d = [{ name: 'unrelated', val: [1, 2] }];
    l.openlabel.frames['0'].frame_properties.extra = 'kept';
    const bytes = manifestBytes(l), r = parseOpenLabelBytes(bytes, manifest());
    expect(r.document).toEqual(l); expect(r.originalBytes).toEqual(bytes);
    expect(JSON.parse(JSON.stringify(r.document))).toEqual(l);
  });
  it('accepts zero labels with missing optional global/frame object dictionaries', () => {
    const l = labels(); delete l.openlabel.objects; delete l.openlabel.frames['0'].objects;
    const r = parseOpenLabelBytes(manifestBytes(l), manifest()); expect(r.frames[0].boxes).toEqual([]); expect(r.document).toEqual(l);
  });
  it('accepts all ten frames with 100 labels each and exactly 1000 global identities', () => {
    const l = labels(), m = manifest(), occurrence = structuredClone(l.openlabel.frames['0'].objects['object-01']);
    l.openlabel.objects = {}; l.openlabel.frames = {}; m.frames = [];
    for (let f = 0; f < 10; f++) {
      const id = String(f), objects: Record<string, unknown> = {};
      m.frames.push({ ...exampleManifest.frames[0], id, pcd: `frames/${id.padStart(3, '0')}.pcd`, timestamp: f / 10 });
      for (let o = 0; o < 100; o++) { const key = `object-${f}-${o}`; l.openlabel.objects[key] = { type: 'Vehicle' }; objects[key] = structuredClone(occurrence); }
      l.openlabel.frames[id] = { frame_properties: { timestamp: f / 10 }, objects };
    }
    const r = parseOpenLabelBytes(manifestBytes(l), m); expect(r.frames.length).toBe(10); expect(r.frames.every(f => f.boxes.length === 100)).toBe(true);
  });
  it('maps frame order from the manifest and matches arbitrary unique string IDs', () => {
    const l = labels(), m = manifest(); m.frames[0].id = 'later'; m.frames[0].timestamp = -2;
    m.frames.push({ ...m.frames[0], id: 'earlier', timestamp: -1, pcd: 'frames/001.pcd' });
    const f = structuredClone(l.openlabel.frames['0']); l.openlabel.frames = { earlier: { ...f, frame_properties: { timestamp: -1 } }, later: { ...f, frame_properties: { timestamp: -2 } } };
    expect(parseOpenLabelBytes(manifestBytes(l), m).frames.map(f => f.id)).toEqual(['later', 'earlier']);
  });
  it('preserves prototype-like object/frame IDs without prototype pollution', () => {
    const l = labels(), m = manifest(); m.frames[0].id = '__proto__';
    l.openlabel.objects = JSON.parse('{"constructor":{"type":"Car"},"__proto__":{"type":"Truck"}}');
    const occurrence = l.openlabel.frames['0'].objects['object-01'];
    const f = { frame_properties: { timestamp: 0 }, objects: JSON.parse('{}') };
    Object.defineProperty(f.objects, '__proto__', { value: occurrence, enumerable: true }); f.objects.constructor = occurrence;
    l.openlabel.frames = JSON.parse('{}'); Object.defineProperty(l.openlabel.frames, '__proto__', { value: f, enumerable: true });
    const r = parseOpenLabelBytes(manifestBytes(l), m); expect(r.frames[0].boxes.map(b => b.id)).toEqual(['__proto__', 'constructor']);
    expect(r.document).toEqual(l); expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });
  it.each([0, Math.PI / 2, -Math.PI / 2, Math.PI, -Math.PI, 0.75])('maps source-world yaw %s without display transform or sourceOrigin translation', yaw => {
    const l = labels(), m = manifest(); m.sourceOrigin = [1e6, -2e6, 300];
    val(l).splice(0, 10, 10, -20, 30, 0, 0, Math.sin(yaw / 2), Math.cos(yaw / 2), 4, 2, 1);
    const box = parseOpenLabelBytes(manifestBytes(l), m).frames[0].boxes[0].box;
    expect(box.center).toEqual([10, -20, 30]); expect(box.size).toEqual([4, 2, 1]);
    expect(Math.cos(box.yaw)).toBeCloseTo(Math.cos(yaw), 12); expect(Math.sin(box.yaw)).toBeCloseTo(Math.sin(yaw), 12);
  });
  it('accepts quaternion sign equivalence, exact geometry limits and an unaligned byte slice', () => {
    const l = labels(); val(l).splice(0, 10, 250, -250, 0, 0, 0, -Math.sin(0.4), -Math.cos(0.4), 0.05, 50, 2);
    const bytes = manifestBytes(l), backing = new Uint8Array(bytes.length + 5); backing.set(bytes, 3);
    const r = parseOpenLabelBytes(backing.subarray(3, 3 + bytes.length), manifest()); expect(r.frames[0].boxes[0].box.yaw).toBeCloseTo(0.8, 12);
  });
  it('requires exactly the manifest frame set and a valid bounded manifest', () => {
    for (const frames of [{}, { '1': labels().openlabel.frames['0'] }, { ...labels().openlabel.frames, extra: labels().openlabel.frames['0'] }]) { const l = labels(); l.openlabel.frames = frames; badLabels(l, 'FRAME_SET'); }
    const m = manifest(); m.frames[0].pointCount = 0; badLabels(labels(), 'MANIFEST', m);
    m.frames = new Array(11).fill(exampleManifest.frames[0]); badLabels(labels(), 'MANIFEST', m);
    expect(() => parseOpenLabelBytes(manifestBytes(labels()), null as unknown as typeof m)).toThrow(OpenLabelParseError);
  });
  it.each([undefined, null, '0', 0.1])('rejects missing, coerced or mismatching frame timestamp %s', timestamp => {
    const l = labels(); l.openlabel.frames['0'].frame_properties.timestamp = timestamp;
    const e = badLabels(l); expect(e.frameId).toBe('0'); expect(e.field).toContain('timestamp');
  });
  it('requires schema version 1.0.0 and valid global object metadata', () => {
    const l = labels(); l.openlabel.metadata.schema_version = '1.0'; badLabels(l, 'SCHEMA');
    for (const metadata of [{}, { type: '' }, { type: 1 }, { type: 'Car', name: 7 }]) {
      const x = labels(); x.openlabel.objects['object-01'] = metadata; const e = badLabels(x, 'SCHEMA'); expect(e.objectId).toBe('object-01');
    }
  });
  it('rejects inherited or nonexistent global references and invalid object dictionaries', () => {
    const l = labels(); delete l.openlabel.objects['object-01']; expect(badLabels(l, 'OBJECT_REFERENCE').objectId).toBe('object-01');
    for (const field of ['frames', 'objects']) { const x = labels(); x.openlabel[field] = []; badLabels(x, 'SCHEMA'); }
    const x = labels(); x.openlabel.frames['0'].objects = []; badLabels(x, 'SCHEMA');
    const y = labels(); y.openlabel.frames['0'].objects = { constructor: y.openlabel.frames['0'].objects['object-01'] }; badLabels(y, 'OBJECT_REFERENCE');
  });
  it('rejects 101 labels and more than 1000 global objects without hidden truncation', () => {
    const l = labels(), occurrence = structuredClone(l.openlabel.frames['0'].objects['object-01']); l.openlabel.objects = {}; l.openlabel.frames['0'].objects = {};
    for (let i = 0; i < 101; i++) { const id = `o-${i}`; l.openlabel.objects[id] = { type: 'Car' }; l.openlabel.frames['0'].objects[id] = occurrence; }
    badLabels(l, 'LABEL_LIMIT');
    l.openlabel.objects = Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [`o-${i}`, { type: 'Car' }])); badLabels(l, 'GLOBAL_LIMIT');
  });
  it.each([[], [{ name: 'other', val: [0, 0, 0, 0, 0, 0, 1, 2, 2, 2] }], [1], [null]].map(cuboid => ({ cuboid })))('rejects absent or unsupported bbox cuboids', ({ cuboid }) => {
    const l = labels(); l.openlabel.frames['0'].objects['object-01'].object_data.cuboid = cuboid; badLabels(l, 'SCHEMA');
  });
  it('rejects duplicate/ambiguous bbox entries and malformed value cardinality', () => {
    const l = labels(), c = l.openlabel.frames['0'].objects['object-01'].object_data.cuboid; c.push(structuredClone(c[0])); badLabels(l, 'SCHEMA');
    for (const n of [9, 11]) { const x = labels(); x.openlabel.frames['0'].objects['object-01'].object_data.cuboid[0].val = new Array(n).fill(1); badLabels(x, 'SCHEMA'); }
    const x = labels(); val(x)[0] = '0'; badLabels(x, 'SCHEMA');
  });
  it.each([[Math.sin(0.1), 0, 0, Math.cos(0.1)], [0, Math.sin(0.1), 0, Math.cos(0.1)], [0, 0, 0, 0], [0, 0, 0, 2]].map(q => ({ q })))('rejects pitch, roll or unnormalized xyzw $q', ({ q }) => {
    const l = labels(); val(l).splice(3, 4, ...q); const e = badLabels(l, 'SCHEMA'); expect(e.objectId).toBe('object-01'); expect(e.frameId).toBe('0'); expect(e.field).toContain('val[3]');
  });
  it.each([[0, 250.001], [2, -250.001], [7, 0.049], [8, 50.001], [9, 0]])('rejects coordinate or size limit violation %s', (index, value) => {
    const l = labels(); val(l)[index] = value; const e = badLabels(l, 'SCHEMA'); expect(e.field).toContain(`val[${index}]`);
  });
  it('rejects non-finite numbers in geometry, timestamps and unknown metadata without converting to null', () => {
    const json = JSON.stringify(labels());
    const a = badLabels(new TextEncoder().encode(json.replace('"val":[0,0,0.5', '"val":[1e400,0,0.5')), 'NON_FINITE'); expect(a.objectId).toBe('object-01');
    badLabels(new TextEncoder().encode(json.replace('"timestamp":0', '"timestamp":1e400')), 'NON_FINITE');
    badLabels(new TextEncoder().encode(json.slice(0, -1) + ',"unknown":1e400}'), 'NON_FINITE');
  });
  it('rejects malformed UTF-8, BOM, duplicate escaped keys, invalid JSON, shared bytes and invalid root', () => {
    badLabels(new Uint8Array([0xff]), 'UTF8'); badLabels(new Uint8Array([0xef, 0xbb, 0xbf, 123, 125]), 'UTF8');
    badLabels(new TextEncoder().encode('{"openlabel":{},"\\u006fpenlabel":{}}'), 'JSON');
    badLabels(new TextEncoder().encode('{'), 'JSON'); badLabels(new Uint8Array(new SharedArrayBuffer(1)), 'INPUT');
    for (const v of [null, [], 1, 'x']) badLabels(v, 'SCHEMA');
  });
  it('accepts exactly 2 MiB, rejects oversized bytes before parsing and bounds metadata depth/nodes', () => {
    const bytes = manifestBytes(labels()), padded = new Uint8Array(2 * 1024 * 1024).fill(32); padded.set(bytes);
    expect(parseOpenLabelBytes(padded, manifest()).frames[0].boxes.length).toBe(1);
    badLabels(new Uint8Array(2 * 1024 * 1024 + 1), 'BYTE_LIMIT');
    badLabels(new TextEncoder().encode('['.repeat(33) + '0' + ']'.repeat(33)), 'JSON');
    const l = labels(); l.unrelated = new Array(100001).fill(0); badLabels(l, 'NODE_LIMIT');
  });
});
function badManifest(value: unknown, field?: string, code = 'SCHEMA') {
  let caught: unknown;
  try { parseManifestBytes(value instanceof Uint8Array ? value : manifestBytes(value), 'clip/manifest.json'); } catch (e) { caught = e; }
  expect(caught).toBeInstanceOf(ManifestParseError);
  const error = caught as ManifestParseError;
  expect(error.code).toBe(code); expect(error.filePath).toBe('clip/manifest.json');
  expect(error.message).toContain('clip/manifest.json');
  if (field) expect(error.field).toBe(field);
  return error;
}

describe('DATA-01/02 manifest component (member hashes and full bundle gates remain pending)', () => {
  it('accepts supplied contract and committed fixture manifest, preserving values and bytes', () => {
    const bytes = unzipSync(new Uint8Array(readFileSync('fixtures/contract-example.zip')))['manifest.json'];
    const before = bytes.slice(); expect(parseManifestBytes(bytes)).toEqual(exampleManifest); expect(bytes).toEqual(before);
    const result = parseManifestBytes(manifestBytes(exampleManifest)); result.frames[0].id = 'changed';
    expect(exampleManifest.frames[0].id).toBe('0');
  });
  it('accepts real source provenance, negative seconds, world translation and optional export hashes', () => {
    const m = manifest(); m.source.kind = 'real'; m.source.url = 'https://example.org/dataset';
    m.sourceOrigin = [1000000.25, -2000000, 3]; m.frames[0].timestamp = -1.5;
    m.hashes['audit.json'] = 'a'.repeat(64); m.hashes['review.json'] = 'b'.repeat(64);
    expect(parseManifestBytes(manifestBytes(m))).toEqual(m);
  });
  it('accepts exact frame/point/manifest byte ceilings and subarray offsets', () => {
    const m = manifest(); m.frames = Array.from({ length: 10 }, (_, i) => ({ ...m.frames[0], id: String(i), timestamp: i / 10, pcd: `frames/${String(i).padStart(3, '0')}.pcd`, pointCount: 200000 }));
    const json = manifestBytes(m); const bytes = new Uint8Array(128 * 1024).fill(32); bytes.set(json);
    const backing = new Uint8Array(bytes.length + 7); backing.set(bytes, 3);
    expect(parseManifestBytes(backing.subarray(3, 3 + bytes.length))).toEqual(m);
  });
  it.each(['schemaVersion', 'units', 'coordinates', 'bundleId'])('rejects unsupported %s', key => {
    const m = manifest(); m[key] = 'unsupported'; badManifest(m, key);
  });
  it.each(['labels.openlabel.json', 'LICENSE.txt', 'ATTRIBUTION.txt'])('requires member hash %s', key => {
    const m = manifest(); delete m.hashes[key]; badManifest(m, `hashes.${key}`);
  });
  it.each(['A'.repeat(64), '0'.repeat(63), 'g'.repeat(64), 123])('rejects malformed SHA-256 %s', hash => {
    for (const where of ['source', 'frame', 'member']) {
      const m = manifest(); if (where === 'source') m.source.sha256 = hash;
      else if (where === 'frame') m.frames[0].sha256 = hash; else m.hashes['LICENSE.txt'] = hash;
      badManifest(m);
    }
  });
  it.each([0, -1, 1.5, 200001, '8', null])('refuses invalid point count %s without coercion', n => {
    const m = manifest(); m.frames[0].pointCount = n; badManifest(m, 'frames[0].pointCount');
  });
  it('rejects zero/eleven frames, non-string IDs, duplicate IDs and point paths with frame location', () => {
    for (const n of [0, 11]) { const m = manifest(); m.frames = Array.from({ length: n }, () => m.frames[0]); badManifest(m, 'frames'); }
    const m = manifest(); m.frames[0].id = 0; badManifest(m, 'frames[0].id');
    const d = manifest(); d.frames.push({ ...d.frames[0], pcd: 'frames/001.pcd', timestamp: 1 });
    expect(badManifest(d, 'frames[1].id').frameId).toBe('0');
    d.frames[1].id = 'one'; d.frames[1].pcd = d.frames[0].pcd; badManifest(d, 'frames[1].pcd');
  });
  it.each([0, -1, '1', null])('rejects non-increasing or coerced timestamp %s', n => {
    const m = manifest(); m.frames.push({ ...m.frames[0], id: '1', pcd: 'frames/001.pcd', timestamp: n });
    badManifest(m, 'frames[1].timestamp');
  });
  it('rejects overflowing JSON numbers in timestamps and sourceOrigin', () => {
    const json = JSON.stringify(manifest());
    badManifest(new TextEncoder().encode(json.replace('"timestamp":0', '"timestamp":1e400')), 'frames[0].timestamp');
    badManifest(new TextEncoder().encode(json.replace('"sourceOrigin":[0,0,0]', '"sourceOrigin":[0,1e400,0]')), 'sourceOrigin[1]');
  });
  it.each(['../000.pcd', '/frames/000.pcd', 'C:\\frames\\000.pcd', 'frames/000.zip', 'frames/00.pcd', 'frames/000.PCD'])('rejects noncanonical point path %s', p => {
    const m = manifest(); m.frames[0].pcd = p; badManifest(m, 'frames[0].pcd');
  });
  it('requires finite three-number sourceOrigin and meaningful licence/source fields', () => {
    for (const origin of [[1, 2], [1, 2, 3, 4], [1, '2', 3], [1, null, 3]]) { const m = manifest(); m.sourceOrigin = origin; badManifest(m); }
    for (const key of ['name', 'licence', 'attribution']) { const m = manifest(); m.source[key] = ' '; badManifest(m, `source.${key}`); }
    const m = manifest(); m.source.kind = 'unknown'; badManifest(m, 'source.kind');
  });
  it.each(['', 'javascript:alert(1)', 'file:///x', 'https://user:password@example.org/x', ' https://example.org/x'])('rejects real provenance URL %s', url => {
    const m = manifest(); m.source.kind = 'real'; m.source.url = url; badManifest(m, 'source.url');
  });
  it('rejects unknown manifest/source/frame/hash fields rather than silently dropping them', () => {
    for (const where of ['root', 'source', 'frame', 'hashes']) {
      const m = manifest(); const obj = where === 'root' ? m : where === 'frame' ? m.frames[0] : m[where]; obj.unexpected = 1; badManifest(m);
    }
  });
  it('rejects invalid UTF-8, BOM, malformed JSON, non-object JSON and shared memory', () => {
    badManifest(new Uint8Array([0xff]), 'file', 'UTF8');
    const good = manifestBytes(manifest()); const bom = new Uint8Array(good.length + 3); bom.set([0xef, 0xbb, 0xbf]); bom.set(good, 3); badManifest(bom, 'file', 'UTF8');
    for (const raw of ['', '{', '{"x":NaN}', '{"x":Infinity}']) badManifest(new TextEncoder().encode(raw), 'file', 'JSON');
    for (const raw of [null, [], 7, 'string']) badManifest(raw);
    badManifest(new Uint8Array(new SharedArrayBuffer(8)), 'file', 'INPUT');
    expect(() => parseManifestBytes(null as unknown as Uint8Array)).toThrow(ManifestParseError);
  });
  it('rejects oversized bytes before JSON parsing and bounds text fields without truncation', () => {
    badManifest(new Uint8Array(128 * 1024 + 1), 'file', 'BYTE_LIMIT');
    for (const [key, limit] of [['name', 1024], ['url', 2048], ['licence', 1024], ['attribution', 4096]] as const) {
      const m = manifest(); m.source[key] = 'x'.repeat(limit + 1); badManifest(m, `source.${key}`);
    }
    const m = manifest(); m.frames[0].id = 'x'.repeat(129); badManifest(m, 'frames[0].id');
  });
  it('rejects duplicate JSON keys, including equivalent escaped spellings and nested objects', () => {
    const json = JSON.stringify(manifest());
    for (const raw of [json.replace('"units":"meters"', '"units":"meters","units":"meters"'),
      json.replace('"units":"meters"', '"units":"meters","\\u0075nits":"meters"'),
      json.replace('"pointCount":8', '"pointCount":8,"pointCount":9')]) badManifest(new TextEncoder().encode(raw), 'file', 'JSON');
  });
  it('keeps key sets separate and ignores JSON-like punctuation inside strings', () => {
    const m = manifest(); m.source.attribution = 'braces { } and \\"units\\": and ] [';
    m.frames.push({ ...m.frames[0], id: '1', timestamp: 1, pcd: 'frames/001.pcd' });
    expect(parseManifestBytes(manifestBytes(m))).toEqual(m);
  });
  it('rejects excessive JSON nesting before building a parsed object graph', () => {
    badManifest(new TextEncoder().encode('['.repeat(17) + '0' + ']'.repeat(17)), 'file', 'JSON');
  });
});

// Independent test writer: fixed header + DataView bytes, no parser helpers.
function file(xyz: number[] = [1.25, -2.5, 3.75], edit: (header: string) => string = h => h) {
  const n = xyz.length / 3;
  const header = edit(`VERSION 0.7\nFIELDS x y z\nSIZE 4 4 4\nTYPE F F F\nCOUNT 1 1 1\nWIDTH ${n}\nHEIGHT 1\nVIEWPOINT 0 0 0 1 0 0 0\nPOINTS ${n}\nDATA binary\n`);
  const text = new TextEncoder().encode(header);
  const bytes = new Uint8Array(text.length + xyz.length * 4);
  bytes.set(text);
  const view = new DataView(bytes.buffer);
  xyz.forEach((v, i) => view.setFloat32(text.length + i * 4, v, true));
  return bytes;
}
function rejects(bytes: Uint8Array, code: string, field?: string, expected?: number) {
  let caught: unknown;
  try { parseCanonicalPcd(bytes, 'frames/007.pcd', expected); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(PcdParseError);
  const error = caught as PcdParseError;
  expect(error.code).toBe(code); expect(error.filePath).toBe('frames/007.pcd');
  if (field) expect(error.field).toBe(field);
  expect(error.message).toContain('frames/007.pcd');
  expect(error.byteOffset).toBeGreaterThanOrEqual(0);
  return error;
}

describe('DATA-01/02 canonical PCD parser component (full bundle gates remain pending)', () => {
  it('reads the committed eight-point fixture and preserves its source bytes', () => {
    const archive = readFileSync('fixtures/contract-example.zip');
    const input = unzipSync(new Uint8Array(archive))['frames/000.pcd'];
    const before = input.slice();
    expect(Array.from(parseCanonicalPcd(input, 'frames/000.pcd', 8))).toEqual([
      -0.5, -0.5, 0, -0.5, -0.5, 1, -0.5, 0.5, 0, -0.5, 0.5, 1,
      0.5, -0.5, 0, 0.5, -0.5, 1, 0.5, 0.5, 0, 0.5, 0.5, 1,
    ]);
    expect(input).toEqual(before);
  });
  it('reads independent little-endian bytes without changing XYZ or sharing output memory', () => {
    const input = file([1.25, -2.5, -0, 0.125, 10, -11]); const before = input.slice();
    const xyz = parseCanonicalPcd(input, 'a.pcd', 2);
    expect(Array.from(xyz)).toEqual([1.25, -2.5, -0, 0.125, 10, -11]);
    expect(Object.is(xyz[2], -0)).toBe(true); xyz[0] = 99; expect(input).toEqual(before);
  });
  it('honours an unaligned subarray offset and CRLF/comments/whitespace', () => {
    const input = file(undefined, h => '# comment\r\n\r\n' + h.replace('FIELDS x y z', 'FIELDS\tx  y\tz').replace(/\n/g, '\r\n'));
    const backing = new Uint8Array(input.length + 8); backing.set(input, 3);
    expect(Array.from(parseCanonicalPcd(backing.subarray(3, 3 + input.length), 'a.pcd'))).toEqual([1.25, -2.5, 3.75]);
  });
  it('accepts exactly the point and coordinate ceilings, and an empty canonical frame', () => {
    const points = new Array(200_000 * 3).fill(0); points[0] = 250; points[1] = -250;
    expect(parseCanonicalPcd(file(points), 'large.pcd', 200_000).length).toBe(600_000);
    expect(parseCanonicalPcd(file([]), 'empty.pcd', 0).length).toBe(0);
  });
  it.each(['FIELDS x y z rgb', 'FIELDS z y x', 'SIZE 8 8 8', 'TYPE I F F', 'COUNT 1 2 1',
    'HEIGHT 2', 'VIEWPOINT 1 0 0 1 0 0 0', 'DATA ascii', 'DATA binary_compressed', 'VERSION 0.6'])(
    'rejects unsupported layout %s', replacement => {
      const key = replacement.split(' ')[0];
      rejects(file(undefined, h => h.replace(new RegExp(`^${key} .*`, 'm'), replacement)), 'UNSUPPORTED_LAYOUT', key);
    });
  it.each(['-1', '1.5', '1e0', 'NaN', ''])('rejects invalid counts %s', value => {
    rejects(file(undefined, h => h.replace('POINTS 1', 'POINTS ' + value)), 'POINT_COUNT', 'POINTS');
  });
  it('rejects 200001 and unsafe counts before allocating by the advertised count', () => {
    for (const n of ['200001', '9007199254740992']) {
      rejects(file(undefined, h => h.replace('POINTS 1', 'POINTS ' + n)), 'POINT_LIMIT', 'POINTS');
    }
    rejects(file(undefined, h => h.replace('WIDTH 1', 'WIDTH 200001')), 'POINT_LIMIT', 'WIDTH');
  });
  it('rejects mismatching width or manifest counts and invalid manifest count values', () => {
    rejects(file(undefined, h => h.replace('WIDTH 1', 'WIDTH 0')), 'POINT_COUNT', 'WIDTH');
    rejects(file(), 'POINT_COUNT', 'manifest.pointCount', 2);
    for (const n of [-1, 1.5, NaN, Infinity, 200001]) rejects(file(), 'POINT_COUNT', 'manifest.pointCount', n);
  });
  it('rejects truncated and extra payloads without trimming or dropping points', () => {
    const input = file(); rejects(input.subarray(0, input.length - 1), 'PAYLOAD_SIZE', 'DATA');
    const extra = new Uint8Array(input.length + 1); extra.set(input); rejects(extra, 'PAYLOAD_SIZE', 'DATA');
  });
  it.each([NaN, Infinity, -Infinity])('rejects non-finite %s with point/axis and byte location', value => {
    const input = file([0, 0, 0, 1, value, 3]); const before = input.slice();
    const error = rejects(input, 'NON_FINITE', 'point[1].y');
    expect(error.byteOffset).toBe(input.length - 8); expect(input).toEqual(before);
  });
  it.each([250.01, -250.01])('rejects out-of-bounds coordinates %s', value => {
    rejects(file([0, 0, value]), 'COORDINATE_LIMIT', 'point[0].z');
  });
  it('rejects duplicate, missing, reordered and unknown header rows', () => {
    for (const edit of [
      (h: string) => h.replace('SIZE 4 4 4', 'FIELDS x y z\nSIZE 4 4 4'),
      (h: string) => h.replace('COUNT 1 1 1\n', ''),
      (h: string) => h.replace('SIZE 4 4 4\nTYPE F F F', 'TYPE F F F\nSIZE 4 4 4'),
      (h: string) => h.replace('HEIGHT 1', 'ENDIAN little\nHEIGHT 1'),
    ]) rejects(file(undefined, edit), 'HEADER_FORMAT');
  });
  it('bounds header scanning and rejects malformed ASCII/newlines and oversized files', () => {
    rejects(new Uint8Array(16 * 1024).fill(32), 'HEADER_LIMIT', 'header');
    const nonAscii = file(); nonAscii[0] = 255; rejects(nonAscii, 'HEADER_FORMAT', 'header');
    rejects(new TextEncoder().encode('VERSION 0.7'), 'HEADER_FORMAT', 'header');
    rejects(file(undefined, h => h.replace('FIELDS x y z', 'FIELDS x\ry z')), 'HEADER_FORMAT', 'header');
    rejects(new Uint8Array(16 * 1024 + 200_000 * 12 + 1), 'POINT_LIMIT', 'file');
  });
  it('rejects mutable shared backing memory', () => {
    rejects(new Uint8Array(new SharedArrayBuffer(1)), 'INPUT', 'file');
  });
});

// ZIP fixtures use Node's independent raw-deflate/CRC implementation. Tiny
// declared-size records exercise large limits without allocating a ZIP bomb.
type ZipFixtureEntry = { name: string; data?: Uint8Array; method?: number; flags?: number; size?: number; attributes?: number; extra?: Uint8Array; descriptor?: 'signed' | 'unsigned' };
function rawZip(items: ZipFixtureEntry[], comment = new Uint8Array(), reverseDirectory = false): Uint8Array {
  const locals: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const e of items) {
    const name = Buffer.from(e.name), data = Buffer.from(e.data ?? [1, 2, 3]), method = e.method ?? 8;
    const compressed = method === 0 ? data : deflateRawSync(data), crc = crc32(data), size = e.size ?? data.length;
    const flags = (e.flags ?? 0) | (e.descriptor ? 8 : 0), extra = Buffer.from(e.extra ?? []);
    const local = Buffer.alloc(30 + name.length + extra.length);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8);
    if (!e.descriptor) { local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(size, 22); }
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(extra.length, 28); name.copy(local, 30); extra.copy(local, 30 + name.length);
    const descriptor = Buffer.alloc(e.descriptor === 'signed' ? 16 : e.descriptor ? 12 : 0);
    if (descriptor.length) { const p = e.descriptor === 'signed' ? 4 : 0; if (p) descriptor.writeUInt32LE(0x08074b50); descriptor.writeUInt32LE(crc, p); descriptor.writeUInt32LE(compressed.length, p + 4); descriptor.writeUInt32LE(size, p + 8); }
    const c = Buffer.alloc(46 + name.length + extra.length);
    c.writeUInt32LE(0x02014b50); c.writeUInt16LE(0x0314, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(flags, 8); c.writeUInt16LE(method, 10);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(compressed.length, 20); c.writeUInt32LE(size, 24); c.writeUInt16LE(name.length, 28); c.writeUInt16LE(extra.length, 30);
    c.writeUInt32LE(e.attributes ?? (0o100644 << 16) >>> 0, 38); c.writeUInt32LE(offset, 42); name.copy(c, 46); extra.copy(c, 46 + name.length);
    locals.push(local, compressed, descriptor); central.push(c); offset += local.length + compressed.length + descriptor.length;
  }
  const directory = Buffer.concat(reverseDirectory ? central.reverse() : central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(items.length, 8); end.writeUInt16LE(items.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(comment.length, 20);
  return new Uint8Array(Buffer.concat([...locals, directory, end, comment]));
}
const zipEntries = (): ZipFixtureEntry[] => ['manifest.json', 'labels.openlabel.json', 'LICENSE.txt', 'ATTRIBUTION.txt', 'frames/000.pcd'].map(name => ({ name }));
const zipView = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const zipCentral = (b: Uint8Array) => zipView(b).getUint32(b.length - 6, true);
async function badZip(bytes: unknown, code?: string) {
  let error: unknown;
  try { await parseZipBytes(bytes as Uint8Array, 'upload/input.lrx.zip'); } catch (e) { error = e; }
  expect(error).toBeInstanceOf(ZipParseError);
  const caught = error as ZipParseError;
  if (code) expect(caught.code).toBe(code);
  expect(caught.filePath).toBe('upload/input.lrx.zip'); expect(caught.message).toContain(caught.filePath);
  return caught;
}
describe('DATA-02 ZIP component (bundle hashes and browser/Quest acceptance remain pending)', () => {
  it('extracts every exact member byte from the supplied synthetic contract fixture', async () => {
    const input = new Uint8Array(readFileSync('fixtures/contract-example.zip')), expected = unzipSync(input), actual = await parseZipBytes(input);
    expect([...actual.keys()].sort()).toEqual(Object.keys(expected).sort());
    for (const [name, bytes] of actual) expect(bytes).toEqual(expected[name]);
  });
  it.each([0, 8])('reads stored/deflate method %i with binary bytes preserved', async method => {
    const entries = zipEntries().map(e => ({ ...e, method, data: new Uint8Array([0, 255, 13, 10, 80, 75, 3, 4]) }));
    const result = await parseZipBytes(rawZip(entries)); expect(result.size).toBe(5);
    for (const bytes of result.values()) expect(bytes).toEqual(entries[0].data);
  });
  it.each(['signed', 'unsigned'] as const)('accepts matching %s ZIP32 data descriptors', async descriptor => {
    const result = await parseZipBytes(rawZip(zipEntries().map(e => ({ ...e, descriptor })))); expect(result.size).toBe(5);
  });
  it('supports different central-directory order, ASCII UTF-8 flag, comments and bounded harmless extra metadata', async () => {
    const extra = new Uint8Array([0x55, 0x54, 1, 0, 0]), entries = zipEntries().map(e => ({ ...e, flags: 0x800, extra }));
    const result = await parseZipBytes(rawZip(entries, new TextEncoder().encode('comment PK'), true)); expect(result.size).toBe(5);
  });
  it('accepts optional audit/review as raw untrusted bytes', async () => {
    const entries = [...zipEntries(), { name: 'audit.json' }, { name: 'review.json' }];
    const result = await parseZipBytes(rawZip(entries)); expect(result.get('audit.json')).toEqual(new Uint8Array([1, 2, 3]));
  });
  it('owns Buffer/view input and returns independent member byte arrays across yields', async () => {
    const input = Buffer.from(rawZip(zipEntries())), copy = Buffer.from(input), promise = parseZipBytes(input); input.fill(0);
    const result = await promise; expect(input).not.toEqual(copy); result.get('LICENSE.txt')![0] = 0;
    expect(result.get('ATTRIBUTION.txt')![0]).toBe(1);
    const padded = new Uint8Array(copy.length + 10); padded.set(copy, 5); expect((await parseZipBytes(padded.subarray(5, 5 + copy.length))).size).toBe(5);
  });
  it('yields to the event loop during a larger stored member before publishing a complete map', async () => {
    const entries = zipEntries(); entries[0] = { name: 'manifest.json', method: 0, data: new Uint8Array(128 * 1024) };
    let settled = false; const promise = parseZipBytes(rawZip(entries)).then(r => { settled = true; return r; });
    await new Promise<void>(resolve => setTimeout(resolve, 0)); expect(settled).toBe(false); expect((await promise).size).toBe(5);
  });
  it.each([null, {}, new Uint16Array(4), new Uint8Array(new SharedArrayBuffer(8))])('rejects non-byte/shared input %#', async input => { await badZip(input, 'INPUT'); });
  it('rejects above 25 MiB before copying or scanning the input', async () => { await badZip(new Uint8Array(25 * 1024 * 1024 + 1), 'COMPRESSED_LIMIT'); });
  it.each([0, 1, 4, 21])('rejects a truncated %i-byte archive', async size => { await badZip(new Uint8Array(size), 'FORMAT'); });
  it('rejects empty archives and excessive directory counts', async () => {
    await badZip(rawZip([]), 'MEMBER_LIMIT'); const b = rawZip(zipEntries()), v = zipView(b); v.setUint16(b.length - 14, 21, true); v.setUint16(b.length - 12, 21, true); await badZip(b, 'MEMBER_LIMIT');
  });
  it.each(['../manifest.json', '/manifest.json', 'C:/manifest.json', 'frames\\000.pcd', 'frames/../000.pcd', 'frames//000.pcd', 'frames/000.pcd.zip', 'MANIFEST.json', 'frames/', 'payload.zip', 'manifest.json\u0000', 'labels.ہ.json', 'frames/00.pcd'])('rejects unsafe or unknown path %s', async name => { const entries = zipEntries(); entries[0].name = name; await badZip(rawZip(entries), 'PATH'); });
  it('rejects duplicate exact paths and mismatched local names', async () => {
    await badZip(rawZip([...zipEntries(), zipEntries()[0]]), 'PATH');
    const b = rawZip(zipEntries()); b[30] = 77; await badZip(b, 'PATH');
  });
  it.each([0o120777, 0o040755, 0o020600])('rejects non-regular Unix type %i', async mode => {
    const e = zipEntries(); e[0].attributes = (mode << 16) >>> 0; await badZip(rawZip(e), 'UNSUPPORTED');
  });
  it('rejects DOS directory and volume-label attributes', async () => {
    for (const attributes of [0x10, 8]) { const e = zipEntries(); e[0].attributes = attributes; await badZip(rawZip(e), 'UNSUPPORTED'); }
  });
  it.each([1, 0x40, 0x2000, 0x100])('rejects encryption or unsupported general-purpose flag %i', async flags => { const e = zipEntries(); e[0].flags = flags; await badZip(rawZip(e), 'UNSUPPORTED'); });
  it('rejects unsupported compression and stored-method compression flags', async () => {
    const e = zipEntries(); e[0].method = 99; await badZip(rawZip(e), 'UNSUPPORTED'); e[0].method = 0; e[0].flags = 2; await badZip(rawZip(e), 'UNSUPPORTED');
  });
  it.each([0x0001, 0x0017, 0x7075, 0x6375, 0x9901])('rejects ZIP64, name override or encryption extra field %i', async id => {
    const e = zipEntries(), extra = new Uint8Array(4); zipView(extra).setUint16(0, id, true); e[0].extra = extra; await badZip(rawZip(e), 'UNSUPPORTED');
  });
  it('rejects malformed extra fields and unsupported required versions', async () => {
    const e = zipEntries(); e[0].extra = new Uint8Array([1, 2, 9, 0]); await badZip(rawZip(e), 'FORMAT');
    const b = rawZip(zipEntries()); zipView(b).setUint16(zipCentral(b) + 6, 45, true); await badZip(b, 'UNSUPPORTED');
  });
  it('rejects multi-disk EOCD and per-member start disks', async () => {
    const a = rawZip(zipEntries()); zipView(a).setUint16(a.length - 18, 1, true); await badZip(a, 'UNSUPPORTED');
    const b = rawZip(zipEntries()); zipView(b).setUint16(zipCentral(b) + 34, 1, true); await badZip(b, 'UNSUPPORTED');
  });
  it('rejects ZIP64 sentinel sizes and EOCD counts', async () => {
    const a = rawZip(zipEntries()); zipView(a).setUint32(zipCentral(a) + 20, 0xffffffff, true); await badZip(a, 'UNSUPPORTED');
    const b = rawZip(zipEntries()); zipView(b).setUint16(b.length - 14, 65535, true); zipView(b).setUint16(b.length - 12, 65535, true); await badZip(b, 'UNSUPPORTED');
  });
  it.each([['manifest.json', 128 * 1024 + 1], ['labels.openlabel.json', 2 * 1024 * 1024 + 1], ['LICENSE.txt', 64 * 1024 + 1], ['ATTRIBUTION.txt', 64 * 1024 + 1], ['audit.json', 2 * 1024 * 1024 + 1], ['review.json', 2 * 1024 * 1024 + 1], ['frames/000.pcd', 16384 + 200000 * 12 + 1]] as const)('rejects declared member ceiling %s with tiny payloads', async (name, size) => { await badZip(rawZip([{ name, size }]), 'EXPANDED_LIMIT'); });
  it('rejects declared total expansion above 40 MiB using only tiny payloads', async () => {
    const entries = Array.from({ length: 20 }, (_, i) => ({ name: `frames/${String(i).padStart(3, '0')}.pcd`, size: 16384 + 200000 * 12 })); await badZip(rawZip(entries), 'EXPANDED_LIMIT');
  });
  it('checks actual streamed output instead of trusting the declared small size', async () => {
    const e = zipEntries(); e[2] = { name: 'LICENSE.txt', size: 1, data: new Uint8Array(70 * 1024) }; await badZip(rawZip(e), 'EXPANDED_LIMIT');
    e[2] = { name: 'LICENSE.txt', size: 1, data: new Uint8Array(1024) }; await badZip(rawZip(e), 'SIZE');
  });
  it('rejects short expanded size and stored-size inconsistency', async () => {
    const e = zipEntries(); e[0].size = 4; await badZip(rawZip(e), 'SIZE'); e[0].method = 0; await badZip(rawZip(e), 'SIZE');
  });
  it('rejects CRC drift and invalid raw deflate', async () => {
    const a = rawZip(zipEntries().map(e => ({ ...e, method: 0 }))); a[30 + 'manifest.json'.length] ^= 1; const error = await badZip(a, 'CRC'); expect(error.memberPath).toBe('manifest.json');
    const b = rawZip(zipEntries()); b[30 + 'manifest.json'.length] = 7; await badZip(b, 'DEFLATE');
  });
  it('rejects local/central size, flags and method disagreements', async () => {
    for (const [offset, value] of [[18, 999], [6, 1], [8, 0]]) { const b = rawZip(zipEntries()); zipView(b).setUint16(offset, value, true); await badZip(b); }
  });
  it('rejects data-descriptor drift and nonzero descriptor local sizes', async () => {
    const e = zipEntries().map(e => ({ ...e, descriptor: 'signed' as const })), a = rawZip(e), v = zipView(a), c = zipCentral(a), dataEnd = 30 + 'manifest.json'.length + v.getUint32(c + 20, true);
    v.setUint32(dataEnd + 8, 123, true); await badZip(a, 'SIZE');
    const b = rawZip(e); zipView(b).setUint32(14, 123, true); await badZip(b, 'FORMAT');
  });
  it('rejects out-of-range payload offsets, overlapping entries and directory count drift', async () => {
    const a = rawZip(zipEntries()); zipView(a).setUint32(zipCentral(a) + 42, a.length, true); await badZip(a, 'FORMAT');
    const b = rawZip(zipEntries()), c = zipCentral(b), second = c + 46 + 'manifest.json'.length; zipView(b).setUint32(second + 42, 0, true); await badZip(b);
    const d = rawZip(zipEntries()); zipView(d).setUint16(d.length - 14, 4, true); zipView(d).setUint16(d.length - 12, 4, true); await badZip(d, 'FORMAT');
  });
  it('rejects prefixed executables, appended payload and hidden local file areas', async () => {
    const b = rawZip(zipEntries()); await badZip(new Uint8Array(Buffer.concat([Buffer.from('MZ'), b])), 'FORMAT'); await badZip(new Uint8Array(Buffer.concat([b, Buffer.from('hidden')])), 'FORMAT');
    const a = rawZip(zipEntries()), c = zipCentral(a); zipView(a).setUint32(c + 42, 1, true); await badZip(a, 'FORMAT');
  });
  it('rejects missing mandatory members and an eleventh frame before inflation', async () => {
    for (const name of zipEntries().map(e => e.name)) await badZip(rawZip(zipEntries().filter(e => e.name !== name)), 'MISSING');
    const e = [...zipEntries(), ...Array.from({ length: 10 }, (_, i) => ({ name: `frames/${String(i + 1).padStart(3, '0')}.pcd` }))]; await badZip(rawZip(e), 'MEMBER_LIMIT');
  });
});

// Integration fixtures recompute ZIP CRC and declared member hashes using
// independent Node crypto, so hash failures are distinct from archive corruption.
const memberSha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const bundleMembers = () => unzipSync(new Uint8Array(readFileSync('fixtures/contract-example.zip')));
function bundleZip(members = bundleMembers(), refresh = true): Uint8Array {
  if (refresh) {
    const manifest = JSON.parse(new TextDecoder().decode(members['manifest.json']));
    for (const frame of manifest.frames) if (members[frame.pcd]) frame.sha256 = memberSha(members[frame.pcd]);
    for (const name of Object.keys(manifest.hashes)) if (members[name]) manifest.hashes[name] = memberSha(members[name]);
    members['manifest.json'] = manifestBytes(manifest);
  }
  return zipSync(members, { level: 6 });
}
function changeBundleManifest(members: ReturnType<typeof bundleMembers>, change: (m: any) => void) {
  const m = JSON.parse(new TextDecoder().decode(members['manifest.json'])); change(m); members['manifest.json'] = manifestBytes(m);
}
async function badBundle(input: unknown, code?: string) {
  let caught: unknown;
  try { await loadBundleBytes(input as Uint8Array, 'upload/clip.lrx.zip'); } catch (e) { caught = e; }
  expect(caught).toBeInstanceOf(BundleLoadError); const error = caught as BundleLoadError;
  if (code) expect(error.code).toBe(code);
  expect(error.filePath).toBe('upload/clip.lrx.zip'); expect(error.message).toContain(error.filePath);
  return error;
}
describe('DATA-01/02 bundle integration component (real data and browser/Quest acceptance remain pending)', () => {
  it('loads the supplied bundle with exact original ZIP/member hashes, geometry and provenance', async () => {
    const input = new Uint8Array(readFileSync('fixtures/contract-example.zip')), result = await loadBundleBytes(input), members = bundleMembers();
    expect(result.bundleSha256).toBe(memberSha(input)); expect(result.manifest).toEqual(exampleManifest);
    expect(result.manifest.source.sha256).not.toBe(result.bundleSha256);
    expect(result.labelsDocument).toEqual(exampleLabels); expect(result.frames).toHaveLength(1);
    expect(result.frames[0]).toMatchObject({ id: '0', timestamp: 0, pointCount: 8, pcd: 'frames/000.pcd' });
    expect(result.frames[0].boxes[0].box).toEqual({ center: [0, 0, 0.5], size: [2, 2, 2], yaw: 0 });
    expect(result.getFramePoints('0')).toEqual(parseCanonicalPcd(members['frames/000.pcd'], 'frames/000.pcd', 8));
    expect(result.memberPaths).toEqual(Object.keys(members).sort());
    for (const name of result.memberPaths) { expect(result.getMemberBytes(name)).toEqual(members[name]); expect(result.memberHashes[name]).toBe(memberSha(members[name])); }
    expect(result.licenceText.trim()).not.toBe(''); expect(result.attributionText.trim()).not.toBe(''); expect(result.historicalMetadata).toEqual({});
    expect(result.getOriginalZipBytes()).toEqual(input);
  });
  it('owns mutable Buffer/view input across asynchronous extraction and hashing', async () => {
    const input = Buffer.from(bundleZip()), original = new Uint8Array(input), pending = loadBundleBytes(input); input.fill(0);
    const r = await pending; expect(r.getOriginalZipBytes()).toEqual(original); expect(r.bundleSha256).toBe(memberSha(original));
    const padded = new Uint8Array(original.length + 12); padded.set(original, 6); expect((await loadBundleBytes(padded.subarray(6, 6 + original.length))).bundleSha256).toBe(memberSha(original));
  });
  it('keeps original ZIP, member bytes and source point buffers behind independent copy accessors', async () => {
    const r = await loadBundleBytes(bundleZip()), zip = r.getOriginalZipBytes(), member = r.getMemberBytes('frames/000.pcd')!, xyz = r.getFramePoints('0');
    const oldZip = zip.slice(), oldMember = member.slice(), oldPoints = xyz.slice(); zip.fill(0); member.fill(0); xyz.fill(123);
    expect(r.getOriginalZipBytes()).toEqual(oldZip); expect(r.getMemberBytes('frames/000.pcd')).toEqual(oldMember); expect(r.getFramePoints('0')).toEqual(oldPoints);
    expect(r.getMemberBytes('../secret')).toBeUndefined(); expect(r.getMemberBytes('__proto__')).toBeUndefined(); expect(r.getMemberBytes('constructor')).toBeUndefined();
    expect(() => r.getFramePoints('missing')).toThrowError(BundleLoadError);
  });
  it('deep-freezes manifest, nested unknown labels, normalized boxes and public metadata', async () => {
    const members = bundleMembers(), l = labels(); l.extra = { nested: [{ arbitrary: 'kept' }] }; members['labels.openlabel.json'] = manifestBytes(l);
    const r = await loadBundleBytes(bundleZip(members));
    for (const value of [r, r.manifest, r.manifest.frames, r.manifest.sourceOrigin, r.labelsDocument, r.frames, r.frames[0], r.frames[0].boxes[0], r.frames[0].boxes[0].box.center, r.memberPaths, r.memberHashes, r.historicalMetadata]) expect(Object.isFrozen(value)).toBe(true);
    expect(() => { (r.manifest.frames[0] as any).pointCount = 0; }).toThrow();
    expect(() => { (r.labelsDocument.extra as any).nested[0].arbitrary = 'changed'; }).toThrow();
    expect(() => { (r.frames[0].boxes[0].box.center as any)[0] = 99; }).toThrow();
    expect(() => { (r as any).getOriginalZipBytes = () => new Uint8Array(); }).toThrow();
    expect(r.labelsDocument).toEqual(l);
  });
  it('preserves unknown JSON, Unicode and prototype-like IDs as ordinary source data', async () => {
    const members = bundleMembers(), l = labels();
    l.openlabel.objects = JSON.parse('{"__proto__":{"type":"Vehicle","attributes":{"text":"ہنان"}}}');
    const frame = l.openlabel.frames['0']; frame.objects = JSON.parse('{"__proto__":'+JSON.stringify(frame.objects['object-01'])+'}');
    l.openlabel.frames = JSON.parse('{"constructor":'+JSON.stringify(frame)+'}'); members['labels.openlabel.json'] = manifestBytes(l);
    changeBundleManifest(members, m => { m.frames[0].id = 'constructor'; });
    const r = await loadBundleBytes(bundleZip(members)); expect(r.frames[0].id).toBe('constructor'); expect(r.frames[0].boxes[0].id).toBe('__proto__');
    expect(r.labelsDocument).toEqual(l); expect(({} as any).type).toBeUndefined(); expect(r.getFramePoints('constructor').length).toBe(24);
  });
  it('retains source coordinates, large sourceOrigin and signed yaw without display transforms', async () => {
    const members = bundleMembers(), l = labels(); val(l).splice(0, 7, 12, -7, 4, 0, 0, Math.sin(-0.7 / 2), Math.cos(-0.7 / 2));
    members['labels.openlabel.json'] = manifestBytes(l); changeBundleManifest(members, m => { m.sourceOrigin = [1000000, -2000000, 3000000]; });
    const r = await loadBundleBytes(bundleZip(members)); expect(r.manifest.sourceOrigin).toEqual([1000000, -2000000, 3000000]);
    expect(r.frames[0].boxes[0].box.center).toEqual([12, -7, 4]); expect(r.frames[0].boxes[0].box.yaw).toBeCloseTo(-0.7, 12);
    expect(r.getFramePoints('0')).toEqual(parseCanonicalPcd(members['frames/000.pcd'], 'frame', 8));
  });
  it('supports ten manifest-ordered frames and zero labels without inferring IDs or timestamps', async () => {
    const members = bundleMembers(), l = labels(), first = structuredClone(l.openlabel.frames['0']); delete first.objects;
    l.openlabel.objects = {}; l.openlabel.frames = {};
    changeBundleManifest(members, m => {
      m.frames = Array.from({ length: 10 }, (_, i) => ({ ...m.frames[0], id: `frame-${9 - i}`, timestamp: -10 + i / 3, pcd: `frames/${String(i).padStart(3, '0')}.pcd` }));
      for (const f of m.frames) { members[f.pcd] = members['frames/000.pcd'].slice(); l.openlabel.frames[f.id] = { ...first, frame_properties: { timestamp: f.timestamp } }; }
    });
    members['labels.openlabel.json'] = manifestBytes(l); const r = await loadBundleBytes(bundleZip(members));
    expect(r.frames.map(f => f.id)).toEqual(Array.from({ length: 10 }, (_, i) => `frame-${9 - i}`)); expect(r.frames.every(f => f.boxes.length === 0)).toBe(true);
  });
  it('accepts a real-source declaration with nonempty rights text without fetching provenance URLs', async () => {
    const members = bundleMembers(); changeBundleManifest(members, m => { m.source.kind = 'real'; m.source.url = 'https://example.invalid/recorded-capture'; m.source.name = 'Independent source-shaped fixture'; });
    const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network use'));
    try { const r = await loadBundleBytes(bundleZip(members)); expect(r.manifest.source.kind).toBe('real'); expect(fetcher).not.toHaveBeenCalled(); } finally { fetcher.mockRestore(); }
  });
  it('keeps optional audit/review as deeply frozen untrusted historical metadata only', async () => {
    const members = bundleMembers(), audit = { approved: true, administrator: true, records: [{ previousRevision: 99 }] }, review = { base_revision: 300, verdicts: ['pretend-saved'], aiConsent: true };
    members['audit.json'] = manifestBytes(audit); members['review.json'] = manifestBytes(review); changeBundleManifest(members, m => { m.hashes['audit.json'] = '0'.repeat(64); m.hashes['review.json'] = '0'.repeat(64); });
    const r = await loadBundleBytes(bundleZip(members)); expect(r.historicalMetadata).toEqual({ audit, review });
    expect((r as any).approved).toBeUndefined(); expect((r as any).currentRevision).toBeUndefined(); expect((r as any).aiConsent).toBeUndefined();
    expect(Object.isFrozen((r.historicalMetadata.audit as any).records[0])).toBe(true);
    expect(r.getMemberBytes('audit.json')).toEqual(members['audit.json']);
  });
  it.each([null, {}, new Uint16Array(3), new Uint8Array(new SharedArrayBuffer(3))])('rejects non-byte/shared bundle input %#', async input => { await badBundle(input, 'INPUT'); });
  it('rejects above the compressed ceiling before decoding or hashing', async () => { await badBundle(new Uint8Array(25 * 1024 * 1024 + 1), 'INPUT'); });
  it('fails closed when Web Crypto is unavailable or rejects SHA-256', async () => {
    const original = globalThis.crypto;
    for (const crypto of [undefined, { subtle: { digest: async () => { throw Error('refused'); } } }, { subtle: { digest: async () => new ArrayBuffer(31) } }]) {
      vi.stubGlobal('crypto', crypto); try { await badBundle(bundleZip(), 'CRYPTO'); } finally { vi.stubGlobal('crypto', original); }
    }
    vi.unstubAllGlobals();
  });
  it('wraps invalid ZIP errors with archive and member context', async () => {
    const e = await badBundle(new Uint8Array([1, 2, 3]), 'ZIP'); expect(e.causeCode).toBe('FORMAT'); expect(e.memberPath).toBeNull();
    const members = bundleMembers(); members['../outside'] = new Uint8Array([1]); const p = await badBundle(bundleZip(members), 'ZIP'); expect(p.causeCode).toBe('PATH'); expect(p.memberPath).toBe('../outside');
  });
  it('rejects malformed manifest JSON and missing licence declarations with field context', async () => {
    const members = bundleMembers(); members['manifest.json'] = new TextEncoder().encode('{'); const malformed = await badBundle(bundleZip(members, false), 'MANIFEST'); expect(malformed.memberPath).toBe('manifest.json'); expect(malformed.causeCode).toBe('JSON');
    const other = bundleMembers(); changeBundleManifest(other, m => { delete m.source.licence; }); const e = await badBundle(bundleZip(other), 'MANIFEST'); expect(e.field).toBe('source.licence');
  });
  it.each(['frames/001.pcd', 'audit.json', 'review.json'])('rejects undeclared member %s', async name => {
    const members = bundleMembers(); members[name] = members['frames/000.pcd']; const e = await badBundle(bundleZip(members), 'MEMBER_SET'); expect(e.memberPath).toBe(name);
  });
  it.each(['audit.json', 'review.json'])('rejects declared but missing optional member %s', async name => {
    const members = bundleMembers(); changeBundleManifest(members, m => { m.hashes[name] = '0'.repeat(64); }); const e = await badBundle(bundleZip(members), 'MEMBER_SET'); expect(e.memberPath).toBe(name);
  });
  it('rejects a missing declared frame before reading point content', async () => {
    const members = bundleMembers(); changeBundleManifest(members, m => { m.frames.push({ ...m.frames[0], id: 'other', timestamp: 1, pcd: 'frames/001.pcd' }); }); const e = await badBundle(bundleZip(members), 'MEMBER_SET'); expect(e.frameId).toBe('other'); expect(e.memberPath).toBe('frames/001.pcd');
  });
  it.each(['frames/000.pcd', 'labels.openlabel.json', 'LICENSE.txt', 'ATTRIBUTION.txt'])('rejects a stale SHA-256 for %s despite valid ZIP CRC', async name => {
    const members = bundleMembers(); members[name] = new Uint8Array([...members[name], 32]); const e = await badBundle(bundleZip(members, false), 'HASH'); expect(e.memberPath).toBe(name); expect(e.field).toBe('sha256'); if (name.endsWith('.pcd')) expect(e.frameId).toBe('0');
  });
  it('verifies every declared member hash before attempting even validly hashed malformed labels', async () => {
    const members = bundleMembers(); members['labels.openlabel.json'] = new TextEncoder().encode('{'); const zip = bundleZip(members); const values = unzipSync(zip); values['LICENSE.txt'] = new TextEncoder().encode('changed rights');
    const e = await badBundle(bundleZip(values, false), 'HASH'); expect(e.memberPath).toBe('LICENSE.txt');
  });
  it.each(['LICENSE.txt', 'ATTRIBUTION.txt'])('rejects empty/whitespace, invalid UTF-8 and NUL in verified rights member %s', async name => {
    for (const bytes of [new Uint8Array(), new TextEncoder().encode(' \r\n\t'), new Uint8Array([0xff]), new Uint8Array([65, 0, 66])]) {
      const members = bundleMembers(); members[name] = bytes; const e = await badBundle(bundleZip(members), 'RIGHTS'); expect(e.memberPath).toBe(name);
    }
  });
  it('preserves valid Unicode/BOM rights byte identity while decoding readable text', async () => {
    const members = bundleMembers(); members['LICENSE.txt'] = new TextEncoder().encode('\ufeffMIT\r\nحقوق'); members['ATTRIBUTION.txt'] = new TextEncoder().encode('هنا\tAuthor\n');
    const r = await loadBundleBytes(bundleZip(members)); expect(r.licenceText).toBe('MIT\r\nحقوق'); expect(r.getMemberBytes('LICENSE.txt')).toEqual(members['LICENSE.txt']);
  });
  it('rejects malformed PCD and count disagreement with frame/file/field context after hash verification', async () => {
    const members = bundleMembers(); members['frames/000.pcd'] = new Uint8Array([1, 2, 3]); const e = await badBundle(bundleZip(members), 'PCD'); expect(e.frameId).toBe('0'); expect(e.memberPath).toBe('frames/000.pcd');
    const other = bundleMembers(); changeBundleManifest(other, m => { m.frames[0].pointCount = 9; }); const count = await badBundle(bundleZip(other), 'PCD'); expect(count.causeCode).toBe('POINT_COUNT'); expect(count.field).toBe('manifest.pointCount');
  });
  it('rejects verified non-finite PCD coordinates instead of returning a partial source', async () => {
    const members = bundleMembers(), bytes = members['frames/000.pcd']; new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setFloat32(bytes.length - 4, NaN, true);
    const e = await badBundle(bundleZip(members), 'PCD'); expect(e.causeCode).toBe('NON_FINITE'); expect(e.field).toContain('point[');
  });
  it('rejects verified label frame/timestamp/reference mismatches with original context', async () => {
    for (const change of [(l: any) => { l.openlabel.frames['0'].frame_properties.timestamp = 1; }, (l: any) => { delete l.openlabel.objects['object-01']; }, (l: any) => { l.openlabel.frames.extra = l.openlabel.frames['0']; }]) {
      const members = bundleMembers(), l = labels(); change(l); members['labels.openlabel.json'] = manifestBytes(l); const e = await badBundle(bundleZip(members), 'LABELS'); expect(e.memberPath).toBe('labels.openlabel.json');
    }
  });
  it('rejects verified pitched label geometry with frame/object/field context', async () => {
    const members = bundleMembers(), l = labels(); val(l).splice(3, 4, Math.sin(0.1), 0, 0, Math.cos(0.1)); members['labels.openlabel.json'] = manifestBytes(l);
    const e = await badBundle(bundleZip(members), 'LABELS'); expect(e.frameId).toBe('0'); expect(e.objectId).toBe('object-01'); expect(e.field).toContain('cuboid');
  });
  it.each(['audit.json', 'review.json'])('requires matching hash for historical member %s before parsing it', async name => {
    const members = bundleMembers(); members[name] = new TextEncoder().encode('{'); changeBundleManifest(members, m => { m.hashes[name] = '0'.repeat(64); }); const e = await badBundle(bundleZip(members, false), 'HASH'); expect(e.memberPath).toBe(name);
  });
  it.each(['{', '{"x":1,"x":2}', '{"x":1e400}', '['.repeat(33)+'0'+']'.repeat(33)])('rejects malformed/non-finite/duplicate/deep verified history %#', async text => {
    const members = bundleMembers(); members['audit.json'] = new TextEncoder().encode(text); changeBundleManifest(members, m => { m.hashes['audit.json'] = '0'.repeat(64); }); const e = await badBundle(bundleZip(members), 'HISTORICAL_JSON'); expect(e.memberPath).toBe('audit.json');
  });
  it('caps verified history nodes using a small bounded JSON payload', async () => {
    const members = bundleMembers(); members['review.json'] = manifestBytes(Array(100001).fill(0)); changeBundleManifest(members, m => { m.hashes['review.json'] = '0'.repeat(64); }); await badBundle(bundleZip(members), 'HISTORICAL_JSON');
  });
  it('does not self-validate source dataset digest as the uploaded bundle hash', async () => {
    const members = bundleMembers(); changeBundleManifest(members, m => { m.source.sha256 = 'a'.repeat(64); }); const zip = bundleZip(members), r = await loadBundleBytes(zip);
    expect(r.manifest.source.sha256).toBe('a'.repeat(64)); expect(r.bundleSha256).toBe(memberSha(zip)); expect(r.memberHashes['manifest.json']).toBe(memberSha(members['manifest.json']));
  });
});

// LABELXR-EXPORT-TESTS-v1
describe('EXPORT-01 serializer component; approval/save and browser integration pending', () => {
  let source: Awaited<ReturnType<typeof loadBundleBytes>>;
  beforeAll(async () => { source = await loadBundleBytes(new Uint8Array(readFileSync('fixtures/contract-example.zip'))); });
  const enc = (x: unknown) => new TextEncoder().encode(JSON.stringify(x));
const snap=(s: Awaited<ReturnType<typeof loadBundleBytes>>,labels=s.getMemberBytes('labels.openlabel.json'))=>({saveState:'saved',revision:1,sourceBundleSha256:s.bundleSha256,labels,audit:enc({revision:1,decisions:[]}),review:enc({revision:1,issues:[]})});
const test = (name: string, fn: () => unknown | Promise<unknown>) => it(name, fn);
const reject=(s: Awaited<ReturnType<typeof loadBundleBytes>>,x: any)=>assert.rejects(exportBundleBytes(s,x));
test('untouched labels, points and source identity survive export',async()=>{const out=await loadBundleBytes(await exportBundleBytes(source,snap(source)));assert.deepEqual(out.labelsDocument,source.labelsDocument);assert.equal(out.manifest.source.sha256,source.manifest.source.sha256);for(const f of source.frames)assert.deepEqual(out.getMemberBytes(f.pcd),source.getMemberBytes(f.pcd));});
for(const state of ['pending','failed',undefined])test('refuse save state '+state,()=>reject(source,{...snap(source),saveState:state}));
for(const revision of [-1,301,1.5,NaN])test('refuse revision '+revision,()=>reject(source,{...snap(source),revision}));
test('refuse wrong source hash',()=>reject(source,{...snap(source),sourceBundleSha256:'0'.repeat(64)}));
test('refuse mismatched audit revision',()=>reject(source,{...snap(source),audit:enc({revision:2})}));
test('refuse mismatched review revision',()=>reject(source,{...snap(source),review:enc({revision:2})}));
test('refuse duplicate JSON history keys',()=>reject(source,{...snap(source),audit:new TextEncoder().encode('{"revision":1,"revision":1}')}));
test('refuse nonfinite history',()=>reject(source,{...snap(source),audit:new TextEncoder().encode('{"revision":1,"value":1e400}')}));
test('refuse oversized labels',()=>reject(source,{...snap(source),labels:new Uint8Array(2*1024*1024+1)}));
test('refuse shared input',()=>reject(source,{...snap(source),labels:new Uint8Array(new SharedArrayBuffer(10))}));
const pristine=(): any=>structuredClone(source.labelsDocument);
const frameId='0', objectId='object-01';
const occurrence=(d: any)=>d.openlabel.frames[frameId].objects[objectId];
const edits: Array<[string,(d: any)=>void]>=[['class',d=>d.openlabel.objects[objectId].type='changed'],['global metadata',d=>d.openlabel.metadata.newUnknown='changed'],['frame metadata',d=>d.openlabel.frames[frameId].newUnknown=true],['cuboid metadata',d=>occurrence(d).object_data.cuboid[0].newUnknown='changed'],['object addition',d=>d.openlabel.frames[frameId].objects.new=structuredClone(occurrence(d))],['timestamp',d=>d.openlabel.frames[frameId].frame_properties.timestamp+=1],['invalid geometry',d=>occurrence(d).object_data.cuboid[0].val[7]=0],['invalid quaternion',d=>occurrence(d).object_data.cuboid[0].val[3]=0.5]];
for(const [name,change] of edits)test('refuse '+name,()=>{const d=pristine();change(d);return reject(source,snap(source,enc(d)));});
test('one occurrence removal retains global metadata',async()=>{const d=pristine();delete d.openlabel.frames[frameId].objects[objectId];const out=await loadBundleBytes(await exportBundleBytes(source,snap(source,enc(d))));assert.deepEqual(out.labelsDocument,d);assert.deepEqual(out.labelsDocument.openlabel.objects,source.labelsDocument.openlabel.objects);});
test('mutation during await cannot change the captured snapshot',async()=>{const x=snap(source),original=Buffer.from(x.labels),pending=exportBundleBytes(source,x);x.labels.fill(0);x.revision=20;const out=await loadBundleBytes(await pending);assert.deepEqual(Buffer.from(out.getMemberBytes('labels.openlabel.json')),original);assert.equal(out.historicalMetadata.audit.revision,1);});
test('historical audit and review stay historical on reexport',async()=>{const first=await loadBundleBytes(await exportBundleBytes(source,snap(source)));const again=await loadBundleBytes(await exportBundleBytes(first,snap(first)));assert.deepEqual(again.historicalMetadata.audit.importedHistory,first.historicalMetadata.audit);assert.deepEqual(again.historicalMetadata.review.importedHistory,first.historicalMetadata.review);});
test('forged source getters cannot substitute another archive',async()=>reject({...source,getOriginalZipBytes:()=>new Uint8Array([1,2,3])},snap(source)));
test('deterministic export for same snapshot',async()=>assert.deepEqual(await exportBundleBytes(source,snap(source)),await exportBundleBytes(source,snap(source))));

it('preserves Unicode, unknown attributes and sourceOrigin while changing geometry', async()=>{
 const members=bundleMembers(), l=labels();
 l.vendor={text:'ہنان',values:[true,null,{x:7}]};l.openlabel.objects['object-01'].attributes={state:'occluded'};
 l.openlabel.frames['0'].objects['object-01'].object_data.points2d=[{name:'unrelated',val:[1,2]}];
 members['labels.openlabel.json']=enc(l);changeBundleManifest(members,m=>{m.sourceOrigin=[10000,-20000,300];});
 const original=await loadBundleBytes(bundleZip(members)), d=structuredClone(l);val(d)[0]=0.1;
 const result=await loadBundleBytes(await exportBundleBytes(original,snap(original,enc(d))));
 expect(result.labelsDocument).toEqual(d);expect(result.manifest.sourceOrigin).toEqual([10000,-20000,300]);
 expect(original.labelsDocument).toEqual(l);expect(result.getMemberBytes('frames/000.pcd')).toEqual(original.getMemberBytes('frames/000.pcd'));
});
it('preserves prototype-like frame and object IDs without pollution during export', async()=>{
 const members=bundleMembers(),l=labels(),f=l.openlabel.frames['0'],occurrence=structuredClone(f.objects['object-01']);
 l.openlabel.objects=JSON.parse('{"__proto__":{"type":"Example"}}');
 f.objects=JSON.parse('{}');Object.defineProperty(f.objects,'__proto__',{value:occurrence,enumerable:true});
 l.openlabel.frames=JSON.parse('{}');Object.defineProperty(l.openlabel.frames,'__proto__',{value:f,enumerable:true});
 members['labels.openlabel.json']=enc(l);changeBundleManifest(members,m=>{m.frames[0].id='__proto__';});
 const original=await loadBundleBytes(bundleZip(members)),d=structuredClone(l);d.openlabel.frames['__proto__'].objects['__proto__'].object_data.cuboid[0].val[0]=0.1;
 const result=await loadBundleBytes(await exportBundleBytes(original,snap(original,enc(d))));
 expect(result.labelsDocument).toEqual(d);expect(Object.getPrototypeOf({})).toBe(Object.prototype);
});

});
