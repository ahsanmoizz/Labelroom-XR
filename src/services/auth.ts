// LABELXR-AUTH-SERVICE-v1
import type { SupabaseClient } from '@supabase/supabase-js';

export type AuthIssue = 'not-ready' | 'busy' | 'cooldown' | 'invalid-email' | 'invalid-captcha' |
  'invalid-code' | 'code-required' | 'already-signed-in' | 'session-unavailable' |
  'request-failed' | 'code-rejected' | 'signout-failed' | 'cancelled' | 'disposed' | 'privacy-reset-failed';
export type AuthPhase = 'checking-session' | 'signed-out' | 'sending-code' | 'awaiting-code' |
  'verifying-code' | 'entering-demo' | 'signed-in' | 'signing-out' | 'blocked' | 'disposed';
export interface AuthIdentity { readonly id: string; readonly anonymous: boolean; readonly email: string | null }
export interface AuthResult { readonly ok: boolean; readonly issue: AuthIssue | null }
export interface AuthState {
  readonly phase: AuthPhase;
  readonly user: Readonly<{ id: string; kind: 'guest' | 'member' }> | null;
  readonly issue: AuthIssue | null;
  readonly resendAfterSeconds: number;
}
type Attempt = Readonly<{ ok: boolean; sessionPresent?: boolean; userId?: string | null }>;
export interface AuthPort {
  readIdentity(): Promise<Readonly<{ ok: boolean; user: AuthIdentity | null }>>;
  requestCode(email: string, captchaToken: string): Promise<Attempt>;
  verifyCode(email: string, token: string): Promise<Attempt>;
  enterGuest(captchaToken: string): Promise<Attempt>;
  signOut(): Promise<Readonly<{ ok: boolean }>>;
  listen(callback: (event: string) => void): () => void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const emailValue = (v: unknown): string | null => typeof v === 'string' && v.length <= 254 &&
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(v.trim())
  ? v.trim().toLowerCase() : null;
const captchaValue = (v: unknown): v is string => typeof v === 'string' && v.length > 0 &&
  v.length <= 2048 && !/\s|[\x00-\x1f\x7f]/.test(v);
const validIdentity = (v: AuthIdentity | null): v is AuthIdentity => v !== null && UUID.test(v.id) &&
  typeof v.anonymous === 'boolean' && (v.anonymous || emailValue(v.email) !== null);
const answer = (issue: AuthIssue | null): AuthResult => Object.freeze({ ok: issue === null, issue });

/** Only presence is read from local session storage. Identity always comes from getUser(). */
export function createSupabaseAuthPort(client: SupabaseClient): AuthPort {
  const noSession = async () => {
    const { data, error } = await client.auth.getSession();
    return { ok: error === null, present: data.session !== null };
  };
  const candidate = (data: { user: { id: string } | null; session: { user: { id: string } } | null }, error: unknown): Attempt =>
    ({ ok: error === null && data.user !== null && data.session !== null && data.user.id === data.session.user.id,
      userId: data.user?.id ?? null });
  return {
    async readIdentity() {
      const { data: local, error: localError } = await client.auth.getSession();
      if (localError) return { ok: false, user: null };
      if (!local.session) return { ok: true, user: null };
      const { data, error } = await client.auth.getUser();
      const user = data.user;
      if (error || !user || user.id !== local.session.user.id || typeof user.is_anonymous !== 'boolean') {
        return { ok: false, user: null };
      }
      return { ok: true, user: { id: user.id, anonymous: user.is_anonymous, email: user.email ?? null } };
    },
    async requestCode(email, captchaToken) {
      const gate = await noSession();
      if (!gate.ok || gate.present) return { ok: false, sessionPresent: gate.present };
      const { error } = await client.auth.signInWithOtp({ email, options: { captchaToken, shouldCreateUser: true } });
      return { ok: error === null };
    },
    async verifyCode(email, token) {
      const gate = await noSession();
      if (!gate.ok || gate.present) return { ok: false, sessionPresent: gate.present };
      const { data, error } = await client.auth.verifyOtp({ email, token, type: 'email' });
      return candidate(data, error);
    },
    async enterGuest(captchaToken) {
      const gate = await noSession();
      if (!gate.ok || gate.present) return { ok: false, sessionPresent: gate.present };
      const { data, error } = await client.auth.signInAnonymously({ options: { captchaToken } });
      return candidate(data, error);
    },
    async signOut() { const { error } = await client.auth.signOut({ scope: 'local' }); return { ok: error === null }; },
    listen(callback) {
      const { data } = client.auth.onAuthStateChange(event => callback(event));
      return () => data.subscription.unsubscribe();
    }
  };
}

/** Session state is a UI gate. Server authorization must independently verify each request. */
export function createAuthService(port: AuthPort, dependencies: {
  clearPrivateData: () => void;
  now?: () => number;
  defer?: (callback: () => void) => void;
}) {
  const now = dependencies.now ?? Date.now;
  const defer = dependencies.defer ?? (callback => { setTimeout(callback, 0); });
  const listeners = new Set<(state: AuthState) => void>();
  let phase: AuthPhase = 'checking-session', issue: AuthIssue | null = null;
  let user: AuthState['user'] = null, pendingEmail: string | null = null;
  let generation = 0, identityRevision = 0, initialized = false, disposed = false, blocked = false, lockedOut = false;
  let active: Promise<AuthResult> | null = null, logout: Promise<AuthResult> | null = null;
  let lastTime = 0, resendAt = 0, refreshWanted = false, scheduled = false;
  let unsubscribe: (() => void) | undefined;
  function time() { try { const value = now(); if (Number.isFinite(value)) lastTime = Math.max(lastTime, value); } catch { /* Cooldown never moves backwards. */ } return lastTime; }
  function getState(): AuthState {
    return Object.freeze({ phase, user, issue, resendAfterSeconds: Math.max(0, Math.ceil((resendAt - time()) / 1000)) });
  }
  function emit() { const state = getState(); for (const listener of [...listeners]) { try { listener(state); } catch { /* Observers cannot change auth state. */ } } }
  function set(next: AuthPhase, reason: AuthIssue | null = null) { if (blocked && next !== 'disposed') return; phase = next; issue = reason; emit(); }
  function clear() {
    user = null;
    try { dependencies.clearPrivateData(); return true; }
    catch { blocked = true; phase = 'blocked'; issue = 'privacy-reset-failed'; emit(); return false; }
  }
  function guard(allowUninitialized = false): AuthIssue | null {
    if (disposed) return 'disposed'; if (blocked) return issue ?? 'privacy-reset-failed';
    if (active || logout) return 'busy'; if (!allowUninitialized && !initialized) return 'not-ready';
    return null;
  }
  function current(epoch: number) { return !disposed && !blocked && generation === epoch; }
  function scheduleRefresh() {
    if (scheduled || !refreshWanted || disposed || blocked || lockedOut) return;
    scheduled = true;
    try { defer(() => {
      scheduled = false;
      if (!refreshWanted || disposed || blocked || lockedOut || active || logout) return;
      refreshWanted = false;
      void restore();
    }); } catch { scheduled = false; refreshWanted = false; if (clear()) set('signed-out', 'session-unavailable'); }
  }
  function run(work: (epoch: number) => Promise<AuthResult>): Promise<AuthResult> {
    const epoch = generation;
    // Reserve active before invoking SDK/user callbacks, including reentrant listeners.
    const task = Promise.resolve().then(() => current(epoch) ? work(epoch) : answer(disposed ? 'disposed' : 'cancelled')).catch(() => {
      if (!current(epoch)) return answer(disposed ? 'disposed' : blocked ? 'privacy-reset-failed' : 'cancelled');
      if (clear()) set('signed-out', 'request-failed');
      return answer(blocked ? 'privacy-reset-failed' : 'request-failed');
    });
    active = task;
    void task.finally(() => { if (active === task) active = null; scheduleRefresh(); });
    return task;
  }
  async function read(epoch: number, expected?: { id: string; anonymous: boolean; email?: string }): Promise<AuthResult> {
    const revision = identityRevision;
    refreshWanted = false;
    let response: Awaited<ReturnType<AuthPort['readIdentity']>>;
    try { response = await port.readIdentity(); } catch { response = { ok: false, user: null }; }
    if (!current(epoch)) return answer(disposed ? 'disposed' : 'cancelled');
    if (revision !== identityRevision) { if (clear()) set('checking-session'); return answer('cancelled'); }
    if (!response.ok || (response.user !== null && !validIdentity(response.user))) {
      if (clear()) set('signed-out', 'session-unavailable'); return answer(blocked ? 'privacy-reset-failed' : 'session-unavailable');
    }
    if (!response.user) {
      if (clear()) set('signed-out', expected ? 'session-unavailable' : null);
      return answer(blocked ? 'privacy-reset-failed' : expected ? 'session-unavailable' : null);
    }
    if (expected && (response.user.id !== expected.id || response.user.anonymous !== expected.anonymous ||
      (expected.email !== undefined && emailValue(response.user.email) !== expected.email))) {
      if (clear()) set('signed-out', 'session-unavailable'); return answer(blocked ? 'privacy-reset-failed' : 'session-unavailable');
    }
    if (!clear()) return answer('privacy-reset-failed');
    if (!current(epoch) || revision !== identityRevision) return answer(disposed ? 'disposed' : 'cancelled');
    user = Object.freeze({ id: response.user.id, kind: response.user.anonymous ? 'guest' : 'member' });
    set('signed-in'); return answer(current(epoch) && revision === identityRevision ? null : 'cancelled');
  }
  function restore(): Promise<AuthResult> {
    const stop = guard(true); if (stop) return Promise.resolve(answer(stop));
    if (lockedOut) return Promise.resolve(answer(issue === 'signout-failed' ? 'signout-failed' : null));
    return run(async epoch => {
      if (!clear()) return answer('privacy-reset-failed');
      set('checking-session'); initialized = true;
      return read(epoch);
    });
  }
  function requestCode(email: unknown, captchaToken: unknown): Promise<AuthResult> {
    const stop = guard(); if (stop) return Promise.resolve(answer(stop));
    if (user) return Promise.resolve(answer('already-signed-in'));
    const normalized = emailValue(email);
    if (!normalized) return Promise.resolve(answer('invalid-email'));
    if (!captchaValue(captchaToken)) return Promise.resolve(answer('invalid-captcha'));
    if (time() < resendAt) return Promise.resolve(answer('cooldown'));
    lockedOut = false;
    return run(async epoch => {
      pendingEmail = null; resendAt = time() + 60000;
      if (!clear()) return answer('privacy-reset-failed'); set('sending-code');
      let result: Attempt; try { result = await port.requestCode(normalized, captchaToken); } catch { result = { ok: false }; }
      if (!current(epoch)) return answer(disposed ? 'disposed' : 'cancelled');
      if (!result.ok) { set('signed-out', result.sessionPresent ? 'already-signed-in' : 'request-failed'); return answer(result.sessionPresent ? 'already-signed-in' : 'request-failed'); }
      pendingEmail = normalized; set('awaiting-code'); return answer(null);
    });
  }
  function verifyCode(token: unknown): Promise<AuthResult> {
    const stop = guard(); if (stop) return Promise.resolve(answer(stop));
    if (user) return Promise.resolve(answer('already-signed-in'));
    if (!pendingEmail) return Promise.resolve(answer('code-required'));
    if (typeof token !== 'string' || !/^[0-9]{6,10}$/.test(token)) return Promise.resolve(answer('invalid-code'));
    const email = pendingEmail;
    return run(async epoch => {
      if (!clear()) return answer('privacy-reset-failed'); set('verifying-code');
      let result: Attempt; try { result = await port.verifyCode(email, token); } catch { result = { ok: false }; }
      if (!current(epoch)) return answer(disposed ? 'disposed' : 'cancelled');
      if (!result.ok || !result.userId || !UUID.test(result.userId)) {
        set('awaiting-code', result.sessionPresent ? 'already-signed-in' : 'code-rejected');
        return answer(result.sessionPresent ? 'already-signed-in' : 'code-rejected');
      }
      pendingEmail = null; return read(epoch, { id: result.userId, anonymous: false, email });
    });
  }
  function enterGuest(captchaToken: unknown): Promise<AuthResult> {
    const stop = guard(); if (stop) return Promise.resolve(answer(stop));
    if (user) return Promise.resolve(answer('already-signed-in'));
    if (!captchaValue(captchaToken)) return Promise.resolve(answer('invalid-captcha'));
    lockedOut = false;
    return run(async epoch => {
      pendingEmail = null; if (!clear()) return answer('privacy-reset-failed'); set('entering-demo');
      let result: Attempt; try { result = await port.enterGuest(captchaToken); } catch { result = { ok: false }; }
      if (!current(epoch)) return answer(disposed ? 'disposed' : 'cancelled');
      if (!result.ok || !result.userId || !UUID.test(result.userId)) {
        set('signed-out', result.sessionPresent ? 'already-signed-in' : 'request-failed'); return answer(result.sessionPresent ? 'already-signed-in' : 'request-failed');
      }
      return read(epoch, { id: result.userId, anonymous: true });
    });
  }
  function signOut(): Promise<AuthResult> {
    if (disposed) return Promise.resolve(answer('disposed'));
    if (logout) return logout;
    // Wait for an in-flight login before the SDK logout so a late login cannot restore it.
    generation++; lockedOut = true; refreshWanted = false; pendingEmail = null;
    const waiting = active;
    const task = Promise.resolve().then(async () => {
      if (waiting) await waiting;
      let ok = false; try { ok = (await port.signOut()).ok; } catch { /* Fixed error below. */ }
      if (disposed) return answer('disposed');
      initialized = true; if (!blocked) set('signed-out', ok ? null : 'signout-failed');
      return answer(blocked ? 'privacy-reset-failed' : ok ? null : 'signout-failed');
    });
    logout = task;
    clear(); if (!blocked) set('signing-out');
    void task.finally(() => { if (logout === task) logout = null; });
    return task;
  }
  function onEvent(event: string) {
    if (disposed || blocked) return;
    if (event === 'INITIAL_SESSION') return; // restore() establishes the first verified state.
    if (event === 'SIGNED_OUT') { generation++; identityRevision++; pendingEmail = null; refreshWanted = false; initialized = true; if (clear() && !logout) set('signed-out'); return; }
    if (!['SIGNED_IN', 'TOKEN_REFRESHED', 'USER_UPDATED', 'PASSWORD_RECOVERY', 'MFA_CHALLENGE_VERIFIED'].includes(event) || lockedOut) return;
    // The SDK callback stays synchronous. getSession/getUser run in a later task.
    identityRevision++; if (!clear()) return;
    if (!active && !logout) { generation++; set('checking-session'); }
    refreshWanted = true; scheduleRefresh();
  }
  clear();
  if (!blocked) { try { unsubscribe = port.listen(onEvent); if (typeof unsubscribe !== 'function') throw new Error('Listener unavailable.'); } catch { blocked = true; phase = 'blocked'; issue = 'session-unavailable'; } }
  return {
    getState, restore, requestCode, verifyCode, enterGuest, signOut,
    subscribe(listener: (state: AuthState) => void) {
      if (disposed) return () => {};
      listeners.add(listener); try { listener(getState()); } catch { /* Observer isolation. */ }
      return () => { listeners.delete(listener); };
    },
    dispose() {
      if (disposed) return;
      disposed = true; generation++; refreshWanted = false; pendingEmail = null;
      clear(); phase = 'disposed'; issue = null;
      try { unsubscribe?.(); } catch { /* No raw SDK errors. */ }
      emit(); listeners.clear();
    }
  };
}
