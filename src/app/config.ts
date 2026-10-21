// LABELXR-PUBLIC-CONFIG-v1
export type PublicConfigMode = 'development' | 'production';
export type PublicConfigField = 'VITE_SUPABASE_URL' | 'VITE_SUPABASE_PUBLISHABLE_KEY' |
  'VITE_TURNSTILE_SITE_KEY' | 'VITE_APP_ORIGIN' | 'PUBLIC_ENVIRONMENT';
export type PublicConfigIssueCode = 'missing' | 'invalid' | 'private-value' | 'test-key';
export interface PublicConfigIssue {
  readonly field: PublicConfigField;
  readonly code: PublicConfigIssueCode;
}
export interface PublicAppConfig {
  readonly supabaseUrl: string;
  readonly supabasePublishableKey: string;
  readonly turnstileSiteKey: string;
  readonly appOrigin: string;
}
export type PublicConfigResult =
  { readonly status: 'valid'; readonly config: Readonly<PublicAppConfig> } |
  { readonly status: 'setup-required'; readonly issues: readonly PublicConfigIssue[] };

const FIELDS = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_PUBLISHABLE_KEY',
  'VITE_TURNSTILE_SITE_KEY', 'VITE_APP_ORIGIN'] as const;
const TEST_SITE_KEYS = new Set(['1x00000000000000000000AA', '2x00000000000000000000AB',
  '1x00000000000000000000BB', '2x00000000000000000000BB']);
const PRIVATE_NAME = /^VITE_.*(?:SECRET|PASSWORD|SERVICE_ROLE|PRIVATE|GROQ|OPENAI|ANTHROPIC|ACCESS_TOKEN|DATABASE_URL)(?:_|$)/i;
const PRIVATE_VALUE = /^(?:sb_secret_|eyJ|gsk_|sk-|service_role\b|postgres(?:ql)?:\/\/)/i;
const PLACEHOLDER = /(?:YOUR_|REPLACE_|CHANGEME|<|>)/i;

function setup(issues: PublicConfigIssue[]): PublicConfigResult {
  return Object.freeze({ status: 'setup-required', issues: Object.freeze(issues.map(x => Object.freeze(x))) });
}

function origin(value: string, developmentApp: boolean): string | null {
  if (value.length > 2048 || /[\s\u0000-\u001f\u007f\\?#]/u.test(value) || PLACEHOLDER.test(value)) return null;
  try {
    const url = new URL(value);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(developmentApp && url.protocol === 'http:' && loopback)) return null;
    if (!url.hostname || url.username || url.password || url.pathname !== '/') return null;
    return url.origin;
  } catch { return null; }
}

/** Syntax validation only: no environment reads, provider requests, storage or authentication. */
export function validatePublicConfig(input: unknown, mode: PublicConfigMode = 'production'): PublicConfigResult {
  if (mode !== 'development' && mode !== 'production') return setup([{ field: 'PUBLIC_ENVIRONMENT', code: 'invalid' }]);
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return setup([{ field: 'PUBLIC_ENVIRONMENT', code: 'invalid' }]);
  }
  let descriptors: PropertyDescriptorMap;
  try {
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== null && prototype !== Object.prototype) return setup([{ field: 'PUBLIC_ENVIRONMENT', code: 'invalid' }]);
    descriptors = Object.getOwnPropertyDescriptors(input);
    if (Object.keys(descriptors).length > 100) return setup([{ field: 'PUBLIC_ENVIRONMENT', code: 'invalid' }]);
  } catch { return setup([{ field: 'PUBLIC_ENVIRONMENT', code: 'invalid' }]); }
  const issues: PublicConfigIssue[] = [], values: Partial<Record<typeof FIELDS[number], string>> = {};
  for (const field of FIELDS) {
    const descriptor = descriptors[field];
    if (!descriptor || ('value' in descriptor && (descriptor.value === undefined || descriptor.value === ''))) {
      issues.push({ field, code: 'missing' });
    } else if (!('value' in descriptor) || typeof descriptor.value !== 'string' || descriptor.value !== descriptor.value.trim()) {
      issues.push({ field, code: 'invalid' });
    } else if (PRIVATE_VALUE.test(descriptor.value)) issues.push({ field, code: 'private-value' });
    else values[field] = descriptor.value;
  }
  for (const [field, descriptor] of Object.entries(descriptors)) {
    if (!field.startsWith('VITE_') || FIELDS.some(x => x === field)) continue;
    if (!('value' in descriptor) || (PRIVATE_NAME.test(field) && descriptor.value !== undefined && descriptor.value !== '') ||
        (typeof descriptor.value === 'string' && PRIVATE_VALUE.test(descriptor.value))) {
      issues.push({ field: 'PUBLIC_ENVIRONMENT', code: 'private-value' });
      break;
    }
  }
  const supabaseUrl = values.VITE_SUPABASE_URL === undefined ? null : origin(values.VITE_SUPABASE_URL, false);
  const appOrigin = values.VITE_APP_ORIGIN === undefined ? null : origin(values.VITE_APP_ORIGIN, mode === 'development');
  if (values.VITE_SUPABASE_URL !== undefined && supabaseUrl === null) issues.push({ field: 'VITE_SUPABASE_URL', code: 'invalid' });
  if (values.VITE_APP_ORIGIN !== undefined && appOrigin === null) issues.push({ field: 'VITE_APP_ORIGIN', code: 'invalid' });
  const key = values.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (key !== undefined && (key.length > 512 || !/^sb_publishable_[A-Za-z0-9_-]+$/.test(key) || PLACEHOLDER.test(key))) {
    issues.push({ field: 'VITE_SUPABASE_PUBLISHABLE_KEY', code: 'invalid' });
  }
  const siteKey = values.VITE_TURNSTILE_SITE_KEY;
  if (siteKey !== undefined) {
    if (siteKey.length > 200 || !/^[A-Za-z0-9_-]+$/.test(siteKey) || PLACEHOLDER.test(siteKey)) {
      issues.push({ field: 'VITE_TURNSTILE_SITE_KEY', code: 'invalid' });
    } else if (mode === 'production' && TEST_SITE_KEYS.has(siteKey)) issues.push({ field: 'VITE_TURNSTILE_SITE_KEY', code: 'test-key' });
  }
  if (issues.length || supabaseUrl === null || appOrigin === null || key === undefined || siteKey === undefined) return setup(issues);
  return Object.freeze({ status: 'valid', config: Object.freeze({ supabaseUrl, supabasePublishableKey: key, turnstileSiteKey: siteKey, appOrigin }) });
}
