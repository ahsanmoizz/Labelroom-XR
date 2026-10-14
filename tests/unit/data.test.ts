import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { unzipSync } from 'fflate';
import { parseCanonicalPcd, PcdParseError } from '../../src/data/pcd';

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
