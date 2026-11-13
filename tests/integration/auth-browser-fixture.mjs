import {createAccountWorkspace, createChallenge, mountLoginPanel} from './auth-bridge.mjs';

const root = document.getElementById('account-container'), captcha = document.createElement('div');
const renders = [], removed = [], calls = [];
let identity = null, listener;
const port = {
  async readIdentity() { return {ok: true, user: identity}; },
  async requestCode(email) { calls.push({operation: 'requestCode', email}); return {ok: true}; },
  async verifyCode(email, code) { calls.push({operation: 'verifyCode', email, code}); if (code === '000000') return {ok: false}; identity = {id: '11111111-1111-4111-8111-111111111111', anonymous: false, email}; return {ok: true, userId: identity.id}; },
  async enterGuest() { calls.push({operation: 'enterGuest'}); identity = {id: '22222222-2222-4222-8222-222222222222', anonymous: true, email: null}; return {ok: true, userId: identity.id}; },
  async signOut() { calls.push({operation: 'signOut'}); identity = null; listener?.('SIGNED_OUT'); return {ok: true}; },
  listen(callback) { listener = callback; return () => { listener = null; }; }
};
const api = {
  render(host, options) {
    const id = 'fixture-widget-' + (renders.length + 1), frame = document.createElement('iframe');
    frame.title = 'Security widget footprint — synthetic fixture'; frame.dataset.fixtureWidget = id;
    frame.style.cssText = options.size === 'compact' ? 'display:block;width:150px;height:140px;border:0;' : 'display:block;width:100%;min-width:300px;height:65px;border:0;';
    frame.srcdoc = '<!doctype html><html><head><style>html,body{box-sizing:border-box;margin:0;width:100%;height:100%;background:#1b2c36;color:#b8c9d5;font:12px/1.5 system-ui}body{display:grid;place-items:center;border:1px solid #456172;border-radius:6px}p{text-align:center;margin:0;padding:8px}small{font-size:10px}</style></head><body><p>Security widget footprint<br><small>Synthetic fixture · no live verification</small></p></body></html>';
    host.append(frame); renders.push({id, options, frame}); return id;
  },
  remove(id) { removed.push(id); renders.find(r => r.id === id)?.frame.remove(); }
};
const workspace = createAccountWorkspace(port, () => {});
const challenge = createChallenge(captcha, 'synthetic_layout_site_key', async () => api);
const panel = mountLoginPanel(root, workspace.auth, challenge, {captchaElement: captcha});
await workspace.auth.restore();
window.labelxrAuth = {
  solve() { renders.at(-1).options.callback('synthetic-one-use-layout-token'); },
  expire() { renders.at(-1).options['expired-callback'](); },
  oldCallback() { renders[0].options.callback('synthetic-stale-layout-token'); },
  state() { return {phase: workspace.auth.getState().phase, kind: workspace.auth.getState().user?.kind ?? null, challenge: challenge.getState().status, calls: structuredClone(calls), sizes: renders.map(r => r.options.size), removed: [...removed], noTokenInDom: !document.body.textContent.includes('synthetic-one-use-layout-token')}; },
  dispose() { panel.dispose(); workspace.dispose(); }
};
