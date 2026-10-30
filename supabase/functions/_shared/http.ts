// LABELXR-SERVER-HTTP-v1
export const MAX_REQUEST_BYTES = 64 * 1024;
const MESSAGES = {
  configuration: [500, 'Server configuration is unavailable.'],
  origin: [403, 'This application origin is not allowed.'],
  method: [405, 'Use POST for this operation.'],
  preflight: [403, 'The requested headers are not allowed.'],
  contentType: [415, 'Send application/json with UTF-8 encoding.'],
  tooLarge: [413, 'The request exceeds 64 KiB.'],
  body: [400, 'The request must contain one valid JSON object.'],
  timeout: [408, 'The request body timed out.'],
  authentication: [401, 'Sign in again before continuing.'],
  authUnavailable: [503, 'Account verification is temporarily unavailable.'],
  member: [403, 'A permanent account is required for this operation.'],
  internal: [500, 'The operation could not be completed.'],
} as const;
export type ProblemCode = keyof typeof MESSAGES;
export class HttpProblem extends Error {
  readonly status: number;
  constructor(readonly code: ProblemCode) { super(MESSAGES[code][1]); this.status = MESSAGES[code][0]; }
}
export function approvedOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (value.length > 2048 || url.origin !== value || url.username || url.password ||
      !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw Error();
    return value;
  } catch { throw new HttpProblem('configuration'); }
}
function headers(request: Request, origin: string, id: string): Headers {
  const result = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'X-Request-Id': id, 'Vary': 'Origin' });
  if (request.headers.get('Origin') === origin) {
    result.set('Access-Control-Allow-Origin', origin);
    result.set('Access-Control-Expose-Headers', 'X-Request-Id');
  }
  return result;
}
export function problemResponse(request: Request, origin: string, id: string, error: unknown): Response {
  const code = error instanceof HttpProblem && Object.prototype.hasOwnProperty.call(MESSAGES, error.code) ? error.code : 'internal';
  return new Response(JSON.stringify({ error: { code, message: MESSAGES[code][1] }, requestId: id }),
    { status: MESSAGES[code][0], headers: headers(request, origin, id) });
}
export function jsonResponse(request: Request, origin: string, id: string, data: unknown): Response {
  const body = JSON.stringify({ data, requestId: id });
  if (new TextEncoder().encode(body).length > MAX_REQUEST_BYTES) throw new HttpProblem('internal');
  return new Response(body, { status: 200, headers: headers(request, origin, id) });
}
/** Browser-origin checks supplement authentication; they never establish identity. */
export function checkRequest(request: Request, origin: string, id: string): Response | null {
  approvedOrigin(origin);
  if (request.headers.get('Origin') !== origin) throw new HttpProblem('origin');
  if (request.method === 'OPTIONS') {
    if (request.headers.get('Access-Control-Request-Method') !== 'POST') throw new HttpProblem('method');
    const allowed = new Set(['authorization', 'apikey', 'content-type', 'x-client-info']);
    const requested = request.headers.get('Access-Control-Request-Headers') ?? '';
    if (requested.length > 512 || requested && requested.split(',').some(v => !allowed.has(v.trim().toLowerCase()))) throw new HttpProblem('preflight');
    const result = headers(request, origin, id); result.delete('Content-Type');
    result.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    result.set('Access-Control-Allow-Headers', 'authorization, apikey, content-type, x-client-info');
    return new Response(null, { status: 204, headers: result });
  }
  if (request.method !== 'POST') throw new HttpProblem('method');
  const mime = request.headers.get('Content-Type') ?? '';
  if (!/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/i.test(mime.trim())) throw new HttpProblem('contentType');
  return null;
}
export function requestDeadline(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) throw new HttpProblem('configuration');
  return value;
}
function validateJson(text: string): Record<string, unknown> {
  const stack: Array<Set<string> | null> = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '{' || c === '[') {
      if (stack.length >= 16) throw new HttpProblem('body');
      stack.push(c === '{' ? new Set() : null);
    } else if (c === '}' || c === ']') stack.pop();
    else if (c === '"') {
      const start = i++;
      while (i < text.length && text[i] !== '"') { if (text[i] === '\\') i++; i++; }
      let next = i + 1; while (next < text.length && /[\t\r\n ]/.test(text[next])) next++;
      const keys = stack[stack.length - 1];
      if (text[next] === ':' && keys) {
        const key: unknown = JSON.parse(text.slice(start, i + 1));
        if (typeof key !== 'string' || keys.has(key)) throw new HttpProblem('body');
        keys.add(key);
      }
    }
  }
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpProblem('body');
  function check(v: unknown): void {
    if (typeof v === 'number' && !Number.isFinite(v)) throw new HttpProblem('body');
    if (v && typeof v === 'object') for (const x of Object.values(v)) check(x);
  }
  check(value); return value as Record<string, unknown>;
}
/** Enforce actual streamed bytes even when Content-Length is absent or dishonest. */
export async function readJsonObject(request: Request, timeoutMs = 5000): Promise<Record<string, unknown>> {
  requestDeadline(timeoutMs);
  const length = request.headers.get('Content-Length');
  if (length !== null && (!/^\d{1,10}$/.test(length) || Number(length) > MAX_REQUEST_BYTES)) throw new HttpProblem(length && /^\d+$/.test(length) ? 'tooLarge' : 'body');
  if (request.signal.aborted || !request.body || request.bodyUsed || request.body.locked) throw new HttpProblem('body');
  const reader = request.body.getReader(), bytes = new Uint8Array(MAX_REQUEST_BYTES); let size = 0;
  const deadline = Date.now() + timeoutMs; let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    const stop = (code: 'body' | 'timeout') => { timedOut = code === 'timeout'; reject(new HttpProblem(code)); void reader.cancel().catch(() => {}); };
    abort = () => stop('body'); request.signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => stop('timeout'), timeoutMs);
  });
  try {
    for (;;) {
      const item = await Promise.race([reader.read(), cancelled]);
      if (timedOut || Date.now() >= deadline) throw new HttpProblem('timeout');
      if (request.signal.aborted) throw new HttpProblem('body');
      if (item.done) break;
      if (!(item.value instanceof Uint8Array) || !(item.value.buffer instanceof ArrayBuffer)) throw new HttpProblem('body');
      size += item.value.byteLength;
      if (size > MAX_REQUEST_BYTES) throw new HttpProblem('tooLarge');
      bytes.set(item.value, size - item.value.length);
    }
    if (length !== null && size !== Number(length)) throw new HttpProblem('body');
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) throw new HttpProblem('body');
    return validateJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)));
  } catch (error) {
    void reader.cancel().catch(() => {});
    if (error instanceof HttpProblem) throw error;
    throw new HttpProblem('body');
  } finally {
    clearTimeout(timer); if (abort) request.signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}
