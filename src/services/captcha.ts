// LABELXR-CAPTCHA-ADAPTER-v1
export interface TurnstileApi {
  render(element: HTMLElement, options: {
    sitekey: string; callback: (token: string) => void;
    'expired-callback': () => void; 'timeout-callback': () => void;
    'error-callback': () => void; 'unsupported-callback': () => void;
    'response-field': false; retry: 'never'; 'refresh-expired': 'manual';
    theme: 'auto'; size: 'flexible';
  }): string | undefined;
  remove(id: string): void;
}
export type ChallengeStatus = 'idle' | 'loading' | 'waiting' | 'ready' | 'expired' | 'error' | 'disposed';
export interface Challenge {
  getState(): Readonly<{ status: ChallengeStatus }>;
  subscribe(callback: () => void): () => void;
  start(): Promise<void>; reset(): Promise<void>; pause(): void; takeToken(): string | null; dispose(): void;
}
const loads = new WeakMap<Document, Promise<TurnstileApi>>();
/** Fixed official URL, one cached load per document; caller chooses when to load. */
export function loadTurnstile(win: Window): Promise<TurnstileApi> {
  const doc = win.document;
  const cached = loads.get(doc); if (cached) return cached;
  const api = () => (win as unknown as { turnstile?: TurnstileApi }).turnstile;
  const valid = (v: TurnstileApi | undefined): v is TurnstileApi => !!v && typeof v.render === 'function' && typeof v.remove === 'function';
  const task = Promise.resolve().then(() => {
    const existing = api(); if (valid(existing)) return existing;
    return new Promise<TurnstileApi>((resolve, reject) => {
      const script = doc.createElement('script'); let finished = false;
      const end = (ok: boolean) => {
        if (finished) return; finished = true; win.clearTimeout(timer);
        script.onload = null; script.onerror = null;
        const value = api();
        if (ok && valid(value)) resolve(value);
        else { script.remove(); reject(new Error('Security check could not load. Reload to retry.')); }
      };
      const timer = win.setTimeout(() => end(false), 15000);
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true; script.defer = true;
      script.onload = () => end(true); script.onerror = () => end(false);
      try { doc.head.appendChild(script); } catch { end(false); }
    });
  });
  loads.set(doc, task); return task;
}
/** Tokens are memory-only, one-use, and locally expire before the provider limit. */
export function createChallenge(element: HTMLElement, sitekey: string, load: () => Promise<TurnstileApi>, now = Date.now): Challenge {
  if (!/^[A-Za-z0-9_-]{3,100}$/.test(sitekey)) throw new Error('Invalid security-check configuration.');
  let status: ChallengeStatus = 'idle', token: string | null = null, issued = 0, last = 0;
  let api: TurnstileApi | undefined, id: string | undefined, generation = 0, disposed = false, accepting = false;
  const listeners = new Set<() => void>();
  function time() { try { const n = now(); if (!Number.isFinite(n)) return Infinity; last = Math.max(last, n); return last; } catch { return Infinity; } }
  function notify() { for (const f of [...listeners]) { try { f(); } catch { /* Observer isolation. */ } } }
  function expire() { if (token && time() - issued >= 240000) { token = null; accepting = false; status = 'expired'; } }
  async function reset() {
    if (disposed) return;
    const epoch = ++generation; token = null; accepting = false; status = 'loading';
    const old = id; id = undefined;
    try {
      try { if (old !== undefined) api?.remove(old); } finally { element.replaceChildren(); }
      notify(); const loaded = await load();
      if (disposed || epoch !== generation) return;
      api = loaded; status = 'waiting'; accepting = true;
      const stop = (next: 'expired' | 'error') => { if (disposed || epoch !== generation) return; accepting = false; token = null; status = next; notify(); };
      const widget = loaded.render(element, {
        sitekey, 'response-field': false, retry: 'never', 'refresh-expired': 'manual', theme: 'auto', size: 'flexible',
        callback(value) {
          if (disposed || epoch !== generation || !accepting) return;
          if (typeof value !== 'string' || !value.length || value.length > 2048 || /[\s\x00-\x1f\x7f]/.test(value)) { stop('error'); return; }
          token = value; issued = time(); if (!Number.isFinite(issued)) { stop('error'); return; } status = 'ready'; notify();
        },
        'expired-callback': () => stop('expired'), 'timeout-callback': () => stop('expired'),
        'error-callback': () => stop('error'), 'unsupported-callback': () => stop('error')
      });
      if (typeof widget !== 'string' || !widget) throw new Error('Security check unavailable.');
      if (disposed || epoch !== generation) { loaded.remove(widget); return; }
      id = widget; notify();
    } catch { if (!disposed && epoch === generation) { accepting = false; token = null; status = 'error'; notify(); } }
  }
  return {
    start: reset, reset,
    pause() { if (disposed) return; generation++; token = null; accepting = false; const old = id; id = undefined; try { if (old !== undefined) api?.remove(old); } catch { /* Revoke local state even when provider cleanup fails. */ } finally { element.replaceChildren(); status = 'idle'; notify(); } },
    getState() { expire(); return Object.freeze({ status }); },
    subscribe(f) { if (disposed) return () => {}; listeners.add(f); return () => { listeners.delete(f); }; },
    takeToken() { expire(); const value = token; token = null; if (value) { accepting = false; if (!disposed) status = 'waiting'; notify(); } return value; },
    dispose() { if (disposed) return; disposed = true; generation++; token = null; accepting = false; status = 'disposed'; try { if (id !== undefined) api?.remove(id); } catch { /* Always clear the owned container below. */ } finally { id = undefined; element.replaceChildren(); notify(); listeners.clear(); } }
  };
}
