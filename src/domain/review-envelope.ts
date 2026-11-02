// LABELXR-REVIEW-ENVELOPE-v1
// HTTP envelope cap only. Individual label/verdict/audit documents retain their2MiB limits.
import {DataJsonParseError,type ManifestErrorCode} from './schema';
function checkJsonKeys(text: string, filePath: string, maxDepth: number): void {
  const stack: Array<Set<string> | null> = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '{' || c === '[') {
      if (stack.length >= maxDepth) throw new DataJsonParseError('JSON', filePath, 'Document nesting exceeds its limit.');
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
          if (keys.has(key)) throw new DataJsonParseError('JSON', filePath, 'Duplicate JSON property in an object.');
          keys.add(key);
        }
      }
    }
  }
}

export function parseReviewEnvelopeBytes(input: Uint8Array, filePath: string, maxBytes: number, maxDepth = 16): unknown {
  const fail = (code: ManifestErrorCode, detail: string): never => { throw new DataJsonParseError(code, filePath, detail); };
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 6 * 1024 * 1024 ||
      !Number.isSafeInteger(maxDepth) || maxDepth < 1 || maxDepth > 32) fail('INPUT', 'Invalid parser bounds.');
  if (!(input instanceof Uint8Array) || !(input.buffer instanceof ArrayBuffer)) fail('INPUT', 'Expected non-shared Uint8Array bytes.');
  if (input.byteLength > maxBytes) fail('BYTE_LIMIT', 'JSON document exceeds its byte limit.');
  let decoded: string;
  try {
    if (input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf) fail('UTF8', 'UTF-8 BOM is not canonical JSON.');
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(input);
  } catch (error) {
    if (error instanceof DataJsonParseError) throw error;
    return fail('UTF8', 'Invalid UTF-8 encoding.');
  }
  checkJsonKeys(decoded, filePath, maxDepth);
  try { return JSON.parse(decoded,(_key,value)=>{if(typeof value==='number'&&!Number.isFinite(value))fail('JSON','Non-finite JSON number.');return value}); } catch { return fail('JSON', 'Invalid JSON document.'); }
}

