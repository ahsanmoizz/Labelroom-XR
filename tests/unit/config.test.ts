// LABELXR-PUBLIC-CONFIG-TESTS-v1
import { describe, expect, it, vi } from 'vitest';
import { validatePublicConfig } from '../../src/app/config';

const valid = () => ({
  VITE_SUPABASE_URL: 'https://project-ref.supabase.co',
  VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_synthetic_public_config_fixture',
  VITE_TURNSTILE_SITE_KEY: '0x4AAAAAAASyntheticSiteKey',
  VITE_APP_ORIGIN: 'https://labelroom.example',
});
function rejected(input: unknown, mode: 'production' | 'development' = 'production') {
  const result = validatePublicConfig(input, mode);
  expect(result.status).toBe('setup-required');
  if (result.status !== 'setup-required') throw Error('Expected setup issues.');
  expect(result.issues.length).toBeGreaterThan(0);
  expect(result).not.toHaveProperty('config');
  return result;
}
describe('public configuration component', () => {
  it('validates public settings without claiming live credentials or authentication', () => {
    const result = validatePublicConfig(valid()); expect(result.status).toBe('valid');
    expect(result).not.toHaveProperty('backendReady'); expect(result).not.toHaveProperty('authenticated');
  });
  it('normalizes HTTPS origins and supports a configured custom Supabase domain', () => {
    const result = validatePublicConfig({ ...valid(), VITE_SUPABASE_URL: 'https://DB.Example:443/', VITE_APP_ORIGIN: 'https://LABELROOM.example/' });
    expect(result.status === 'valid' && result.config.supabaseUrl).toBe('https://db.example');
    expect(result.status === 'valid' && result.config.appOrigin).toBe('https://labelroom.example');
  });
  for (const field of Object.keys(valid())) it(`reports missing ${field} without defaults`, () => {
    const input: Record<string, unknown> = valid(); delete input[field];
    expect(rejected(input).issues).toContainEqual({ field, code: 'missing' });
  });
  for (const value of [null, undefined, [], 'env', 42, new Date(0)]) it(`rejects invalid environment ${value instanceof Date ? 'Date instance' : String(value)}`, () => { rejected(value); });
  for (const value of [null, 12, false, [], {}, ' sb_publishable_public', 'sb_publishable_public ']) it(`rejects invalid key input ${JSON.stringify(value)}`, () => {
    rejected({ ...valid(), VITE_SUPABASE_PUBLISHABLE_KEY: value });
  });
  for (const value of ['sb_secret_PRIVATE', 'eyJPRIVATE.JWT.VALUE', 'gsk_PRIVATE', 'sk-PRIVATE', 'service_role', 'postgres://user:password@db/private']) {
    it(`does not return a private token of category ${value.split(/[_:.\/]/)[0]}`, () => {
      const result = rejected({ ...valid(), VITE_SUPABASE_PUBLISHABLE_KEY: value });
      expect(result.issues).toContainEqual({ field: 'VITE_SUPABASE_PUBLISHABLE_KEY', code: 'private-value' });
      expect(JSON.stringify(result)).not.toContain(value);
    });
  }
  for (const value of ['http://project.supabase.co', 'http://localhost:54321', 'ftp://project.supabase.co', 'javascript:alert(1)', 'https://user:password@db.example', 'https://db.example/auth/v1', 'https://db.example/?secret=PRIVATE', 'https://db.example/#PRIVATE', 'https://db.example/?', 'https://db.example/#', 'https:\\db.example', 'https://db.example\n', 'https://YOUR_PROJECT_REF.supabase.co']) {
    it(`rejects Supabase endpoint shape ${JSON.stringify(value)}`, () => { rejected({ ...valid(), VITE_SUPABASE_URL: value }); });
  }
  for (const value of ['YOUR_PUBLIC_PUBLISHABLE_KEY', 'sb_publishable_', 'sb_publishable_PUBLIC.dot', 'sb_publishable_<KEY>', 'x'.repeat(513)]) {
    it(`rejects placeholder or invalid publishable key shape ${value.length}`, () => { rejected({ ...valid(), VITE_SUPABASE_PUBLISHABLE_KEY: value }); });
  }
  for (const value of ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://[::1]:5173']) it(`allows explicit local development origin ${value}`, () => {
    const input = { ...valid(), VITE_APP_ORIGIN: value }; expect(validatePublicConfig(input, 'development').status).toBe('valid'); rejected(input);
  });
  for (const value of ['http://example.com', 'http://localhost.evil.example', 'https://app.example/path', 'https://user@labelroom.example', 'https://app.example?x=1', 'https://app.example#x']) it(`rejects non-origin app configuration ${value}`, () => {
    rejected({ ...valid(), VITE_APP_ORIGIN: value }, 'development');
  });
  for (const value of ['1x00000000000000000000AA', '2x00000000000000000000AB', '1x00000000000000000000BB', '2x00000000000000000000BB']) it(`restricts documented CAPTCHA test sitekey ${value} to development`, () => {
    const input = { ...valid(), VITE_TURNSTILE_SITE_KEY: value }; expect(validatePublicConfig(input, 'development').status).toBe('valid');
    expect(rejected(input).issues).toContainEqual({ field: 'VITE_TURNSTILE_SITE_KEY', code: 'test-key' });
  });
  for (const value of ['', 'YOUR_PUBLIC_SITE_KEY', '<SITE_KEY>', 'bad key', 'x'.repeat(201)]) it(`rejects missing/invalid CAPTCHA setting ${value.length}`, () => {
    rejected({ ...valid(), VITE_TURNSTILE_SITE_KEY: value });
  });
  for (const field of ['VITE_GROQ_API_KEY', 'VITE_SUPABASE_SERVICE_ROLE_KEY', 'VITE_TURNSTILE_SECRET', 'VITE_DATABASE_URL']) it(`refuses populated private public-prefixed field ${field}`, () => {
    const result = rejected({ ...valid(), [field]: 'PRIVATE_SENTINEL' });
    expect(result.issues).toContainEqual({ field: 'PUBLIC_ENVIRONMENT', code: 'private-value' }); expect(JSON.stringify(result)).not.toContain('PRIVATE_SENTINEL');
  });
  it('refuses a private token in an unrelated public-prefixed field', () => { rejected({ ...valid(), VITE_UNRELATED: 'sb_secret_PRIVATE_SENTINEL' }); });
  it('refuses a non-string value assigned to a private public-prefixed field', () => { rejected({ ...valid(), VITE_GROQ_API_KEY: 123 }); });
  it('allows an empty private public-prefixed field without supplying a value', () => { expect(validatePublicConfig({ ...valid(), VITE_GROQ_API_KEY: '' }).status).toBe('valid'); });
  it('does not expose server-only inputs in its public configuration result', () => {
    const result = validatePublicConfig({ ...valid(), GROQ_API_KEY: 'PRIVATE_SENTINEL' });
    expect(result.status).toBe('valid'); expect(JSON.stringify(result)).not.toContain('PRIVATE_SENTINEL');
  });
  it('does not execute an accessor for a required setting', () => {
    const input = valid(), getter = vi.fn(() => { throw Error('PRIVATE_SENTINEL'); });
    Object.defineProperty(input, 'VITE_SUPABASE_URL', { get: getter }); rejected(input); expect(getter).not.toHaveBeenCalled();
  });
  it('does not execute an accessor for an extra public setting', () => {
    const input = valid(), getter = vi.fn(() => { throw Error('PRIVATE_SENTINEL'); });
    Object.defineProperty(input, 'VITE_EXTRA', { enumerable: true, get: getter }); rejected(input); expect(getter).not.toHaveBeenCalled();
  });
  it('does not inherit settings', () => { rejected(Object.create(valid())); });
  it('accepts an explicit null-prototype environment', () => { expect(validatePublicConfig(Object.assign(Object.create(null), valid())).status).toBe('valid'); });
  it('bounds an oversized environment', () => { const input: Record<string, unknown> = valid(); for (let i = 0; i < 101; i++) input[`EXTRA_${i}`] = ''; rejected(input); });
  it('catches failed descriptor inspection without including exception text', () => {
    const input = new Proxy(valid(), { ownKeys() { throw Error('PRIVATE_SENTINEL'); } }); expect(JSON.stringify(rejected(input))).not.toContain('PRIVATE_SENTINEL');
  });
  it('refuses an invalid runtime mode instead of weakening production checks', () => { expect(validatePublicConfig(valid(), 'other' as 'production').status).toBe('setup-required'); });
  it('leaves input unchanged and freezes valid and setup results', () => {
    const input = Object.freeze(valid()), result = validatePublicConfig(input), bad = rejected({});
    expect(input).toEqual(valid()); expect(Object.isFrozen(result)).toBe(true); expect(result.status === 'valid' && Object.isFrozen(result.config)).toBe(true);
    expect(Object.isFrozen(bad)).toBe(true); expect(Object.isFrozen(bad.issues)).toBe(true); expect(bad.issues.every(Object.isFrozen)).toBe(true);
  });
  it('performs no fetch or console logging', () => {
    const fetch = vi.fn(() => { throw Error('Network must not run.'); }); const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal('fetch', fetch); try { validatePublicConfig(valid()); rejected({}); expect(fetch).not.toHaveBeenCalled(); expect(logs).not.toHaveBeenCalled(); }
    finally { vi.unstubAllGlobals(); logs.mockRestore(); }
  });
});
