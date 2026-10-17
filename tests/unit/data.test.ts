import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { unzipSync } from 'fflate';
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
