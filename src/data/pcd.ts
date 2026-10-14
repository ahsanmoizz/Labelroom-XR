import { LIMITS } from '../domain/limits';

// Canonical files use ten ASCII header rows; comments/whitespace are bounded too.
const MAX_HEADER_BYTES = 16 * 1024;
const HEADER_KEYS = ['VERSION', 'FIELDS', 'SIZE', 'TYPE', 'COUNT', 'WIDTH',
  'HEIGHT', 'VIEWPOINT', 'POINTS', 'DATA'] as const;

export type PcdErrorCode = 'INPUT' | 'HEADER_LIMIT' | 'HEADER_FORMAT' |
  'UNSUPPORTED_LAYOUT' | 'POINT_LIMIT' | 'POINT_COUNT' | 'PAYLOAD_SIZE' |
  'NON_FINITE' | 'COORDINATE_LIMIT';

export class PcdParseError extends Error {
  constructor(
    public readonly code: PcdErrorCode,
    public readonly filePath: string,
    public readonly field: string,
    public readonly byteOffset: number,
    detail: string,
  ) {
    super(`${filePath}: ${field} at byte ${byteOffset}: ${detail}`);
    this.name = 'PcdParseError';
  }
}

/** Read only the sealed binary little-endian XYZ subset. No display transform.
 * The result owns its memory; changing it never changes the original file bytes.
 * expectedPointCount lets the bundle loader compare the manifest before allocation.
 */
export function parseCanonicalPcd(
  input: Uint8Array, filePath: string, expectedPointCount?: number,
): Float32Array {
  const fail = (code: PcdErrorCode, field: string, offset: number, detail: string): never => {
    throw new PcdParseError(code, filePath, field, offset, detail);
  };
  if (!(input instanceof Uint8Array) || !(input.buffer instanceof ArrayBuffer)) {
    fail('INPUT', 'file', 0, 'Expected non-shared Uint8Array bytes.');
  }
  if (expectedPointCount !== undefined && (!Number.isSafeInteger(expectedPointCount) ||
      expectedPointCount < 0 || expectedPointCount > LIMITS.maxPointsPerFrame)) {
    fail('POINT_COUNT', 'manifest.pointCount', 0, 'Expected a bounded integer point count.');
  }
  if (input.byteLength > MAX_HEADER_BYTES + LIMITS.maxPointsPerFrame * 12) {
    fail('POINT_LIMIT', 'file', 0, 'File exceeds the canonical frame byte ceiling.');
  }

  const rows = new Map<string, { value: string; offset: number }>();
  let cursor = 0;
  while (rows.size < HEADER_KEYS.length) {
    const start = cursor;
    while (cursor < input.length && cursor < MAX_HEADER_BYTES && input[cursor] !== 10) {
      const byte = input[cursor];
      if (byte !== 9 && byte !== 13 && (byte < 32 || byte > 126)) {
        fail('HEADER_FORMAT', 'header', cursor, 'Header must be ASCII text.');
      }
      cursor++;
    }
    if (cursor >= MAX_HEADER_BYTES) {
      fail('HEADER_LIMIT', 'header', cursor, 'Header exceeds 16 KiB.');
    }
    if (cursor >= input.length) {
      fail('HEADER_FORMAT', 'header', cursor, 'Missing newline-terminated DATA binary row.');
    }
    // Decode the bounded row only; binary payload bytes are never decoded as text.
    let line = '';
    for (let i = start; i < cursor; i++) line += String.fromCharCode(input[i]);
    cursor++;
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line.includes('\r')) fail('HEADER_FORMAT', 'header', start, 'Unexpected carriage return.');
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/[ \t]+/);
    const key = parts.shift()!;
    if (rows.has(key)) fail('HEADER_FORMAT', key, start, 'Duplicate header row.');
    if (key !== HEADER_KEYS[rows.size]) {
      fail('HEADER_FORMAT', key, start, `Expected ${HEADER_KEYS[rows.size]} in canonical header order.`);
    }
    rows.set(key, { value: parts.join(' '), offset: start });
  }
  const row = (key: string) => rows.get(key)!;
  const exact = (key: string, value: string) => {
    if (row(key).value !== value) {
      fail('UNSUPPORTED_LAYOUT', key, row(key).offset, `Only ${key} ${value} is supported.`);
    }
  };
  if (!['0.7', '.7'].includes(row('VERSION').value)) {
    fail('UNSUPPORTED_LAYOUT', 'VERSION', row('VERSION').offset, 'Only PCD version 0.7 is supported.');
  }
  exact('FIELDS', 'x y z'); exact('SIZE', '4 4 4'); exact('TYPE', 'F F F');
  exact('COUNT', '1 1 1'); exact('HEIGHT', '1');
  exact('VIEWPOINT', '0 0 0 1 0 0 0'); exact('DATA', 'binary');
  const count = (key: string) => {
    const value = row(key).value;
    if (!/^[0-9]+$/.test(value)) fail('POINT_COUNT', key, row(key).offset, 'Expected a nonnegative decimal integer.');
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number > LIMITS.maxPointsPerFrame) {
      fail('POINT_LIMIT', key, row(key).offset, `Maximum ${LIMITS.maxPointsPerFrame} points per frame.`);
    }
    return number;
  };
  const points = count('POINTS');
  if (count('WIDTH') !== points) fail('POINT_COUNT', 'WIDTH', row('WIDTH').offset, 'WIDTH must equal POINTS.');
  if (expectedPointCount !== undefined && expectedPointCount !== points) {
    fail('POINT_COUNT', 'manifest.pointCount', row('POINTS').offset, 'Manifest and PCD point counts differ.');
  }
  if (input.byteLength - cursor !== points * 12) {
    fail('PAYLOAD_SIZE', 'DATA', cursor, `Expected exactly ${points * 12} payload bytes.`);
  }
  const view = new DataView(input.buffer, input.byteOffset + cursor, points * 12);
  // Validate before allocating the output array; reject rather than dropping points.
  for (let i = 0; i < points * 3; i++) {
    const value = view.getFloat32(i * 4, true);
    const field = `point[${Math.floor(i / 3)}].${['x', 'y', 'z'][i % 3]}`;
    if (!Number.isFinite(value)) fail('NON_FINITE', field, cursor + i * 4, 'Coordinate must be finite.');
    if (Math.abs(value) > LIMITS.maxCoordinateAbs) {
      fail('COORDINATE_LIMIT', field, cursor + i * 4, `Coordinate must be within +/-${LIMITS.maxCoordinateAbs} metres.`);
    }
  }
  const xyz = new Float32Array(points * 3);
  for (let i = 0; i < xyz.length; i++) xyz[i] = view.getFloat32(i * 4, true);
  return xyz;
}
