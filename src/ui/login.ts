// LABELXR-LOGIN-PANEL-v1
import type { createAuthService, AuthIssue } from '../services/auth.js';
import type { Challenge } from '../services/captcha.js';

type Account = ReturnType<typeof createAuthService>;
const feedback: Record<AuthIssue, string> = {
  'not-ready': 'Checking your session. Please wait.', busy: 'Please wait for the current request.',
  cooldown: 'Wait before requesting another code.', 'invalid-email': 'Enter a valid email address.',
  'invalid-captcha': 'Complete the security check.', 'invalid-code': 'Enter the 6 to 10 digit code from your email.',
  'code-required': 'Request an email code first.', 'already-signed-in': 'Sign out before changing account type.',
  'session-unavailable': 'Your session could not be verified. Reload to retry.',
  'request-failed': 'The request failed. Check the security check and try again.',
  'code-rejected': 'That code was not accepted. Check it or request a new code.',
  'signout-failed': 'Sign-out was not confirmed. Private views are closed. Reload to retry.',
  cancelled: 'The account changed. Try again.', disposed: 'This account view is closed.',
  'privacy-reset-failed': 'Private views could not be cleared. Reload before continuing.'
};
/** Host calls auth.restore() explicitly after mounting and owns all private resources. */
export function mountLoginPanel(root: HTMLElement, auth: Account, challenge: Challenge, options: {
  captchaElement: HTMLElement;
  every?: (callback: () => void, milliseconds: number) => () => void;
}) {
  const doc = root.ownerDocument;
  if (options.captchaElement.ownerDocument !== doc || options.captchaElement === root) throw new Error('Security-check container differs.');
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '') => { const node = doc.createElement(tag); node.textContent = text; return node; };
  const card = element('section'); card.setAttribute('aria-label', 'Account');
  card.style.cssText = 'box-sizing:border-box;max-width:460px;width:100%;padding:24px;margin:16px auto;background:#101b2c;color:#edf3ff;border:1px solid #33435c;border-radius:16px;font:16px/1.5 system-ui,sans-serif';
  const title = element('h2', 'Open your review workspace');
  const intro = element('p', 'Sign in with an email code, or enter a temporary demo.');
  const emailForm = element('form'), emailLabel = element('label', 'Email address'), email = element('input');
  email.type = 'email'; email.autocomplete = 'email'; email.maxLength = 254; email.required = true; email.name = 'email';
  const send = element('button', 'Send code'); send.type = 'submit'; emailLabel.appendChild(email); emailForm.append(emailLabel, send);
  const codeForm = element('form'), codeLabel = element('label', 'Email code'), code = element('input');
  code.type = 'text'; code.inputMode = 'numeric'; code.autocomplete = 'one-time-code'; code.pattern = '[0-9]{6,10}'; code.maxLength = 10; code.required = true; code.name = 'code';
  const verify = element('button', 'Verify code'); verify.type = 'submit'; codeLabel.appendChild(code); codeForm.append(codeLabel, verify);
  const security = element('p'), retry = element('button', 'Retry security check'); retry.type = 'button';
  const guest = element('button', 'Enter demo'); guest.type = 'button';
  const notice = element('p', 'Demo data resets when you sign out. Sign out before switching to a permanent account.');
  const out = element('button', 'Sign out'); out.type = 'button';
  const status = element('p'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const error = element('p'); error.setAttribute('role', 'alert'); error.style.color = '#ffd5c2';
  for (const input of [email, code]) input.style.cssText = 'box-sizing:border-box;display:block;width:100%;padding:12px;margin:6px 0 12px;border:1px solid #65748c;border-radius:8px;background:#fff;color:#101b2c;font:inherit';
  for (const button of [send, verify, guest, retry, out]) button.style.cssText = 'min-height:44px;padding:10px 16px;margin:4px 8px 4px 0;border:1px solid #849dc4;border-radius:8px;font:inherit;cursor:pointer';
  card.append(title, intro, emailForm, codeForm, options.captchaElement, security, retry, guest, notice, out, status, error); root.replaceChildren(card);
  let disposed = false, pending = false, localError = '';
  let previousPhase: ReturnType<Account['getState']>['phase'] | null = null;
  function render() {
    if (disposed) return;
    const state = auth.getState();
    const prior = previousPhase; previousPhase = state.phase;
    if (state.phase !== prior && (state.user || ['blocked', 'disposed'].includes(state.phase))) { localError = ''; challenge.pause(); }
    if (state.phase === 'signed-out' && prior !== state.phase) {
      email.value = ''; code.value = '';
      if (prior !== null && challenge.getState().status === 'idle') void challenge.reset();
    }
    const captcha = challenge.getState().status;
    const signed = state.user !== null, awaiting = state.phase === 'awaiting-code' || state.phase === 'verifying-code';
    title.textContent=signed?'Account':'Open your review workspace'; intro.hidden=signed;
    notice.hidden=signed && state.user?.kind!=='guest';
    card.style.padding=signed?'12px':'24px'; card.style.margin=signed?'0':'16px auto';
    const busy = pending || !['signed-out', 'awaiting-code', 'signed-in'].includes(state.phase);
    card.setAttribute('aria-busy', busy ? 'true' : 'false');
    emailForm.hidden = signed; codeForm.hidden = signed || !awaiting;
    email.readOnly = awaiting; email.disabled = busy; code.disabled = busy;
    send.textContent = state.resendAfterSeconds ? `Send again in ${state.resendAfterSeconds}s` : awaiting ? 'Resend code' : 'Send code';
    send.disabled = busy || signed || state.resendAfterSeconds > 0 || captcha !== 'ready';
    verify.disabled = busy || !awaiting; guest.hidden = signed; guest.disabled = busy || signed || captcha !== 'ready';
    out.hidden = !signed && state.issue !== 'signout-failed'; out.disabled = pending || state.phase === 'signing-out';
    retry.hidden = signed || !['error', 'expired'].includes(captcha); retry.disabled = busy;
    options.captchaElement.hidden = signed; security.hidden = signed; security.textContent = captcha === 'ready' ? 'Security check complete.' : captcha === 'error' ? 'Security check unavailable. Retry or reload.' : captcha === 'expired' ? 'Security check expired. Retry to continue.' : 'Complete the security check to request a code or enter the demo.';
    status.textContent = signed ? state.user?.kind === 'guest' ? 'Demo session connected.' : 'Account connected.' : awaiting ? 'Enter the code sent to your email.' : busy ? 'Checking your account…' : 'You are signed out.';
    error.textContent = localError || (state.issue ? feedback[state.issue] : '');
    if (signed || ['signing-out', 'blocked', 'disposed'].includes(state.phase)) { email.value = ''; code.value = ''; }
  }
  async function command(action: 'send' | 'verify' | 'guest' | 'out') {
    if (disposed || pending) return;
    pending = true; localError = ''; render(); let consumed = false;
    try {
      let result;
      if (action === 'send' || action === 'guest') {
        const token = challenge.takeToken();
        if (!token) { localError = feedback['invalid-captcha']; return; }
        consumed = true;
        result = await (action === 'send' ? auth.requestCode(email.value, token) : auth.enterGuest(token));
      } else if (action === 'verify') { const token = code.value; code.value = ''; result = await auth.verifyCode(token); }
      else { email.value = ''; code.value = ''; result = await auth.signOut(); }
      if (!disposed && !result.ok && result.issue) localError = feedback[result.issue];
    } catch { if (!disposed) localError = 'The account request could not finish. Reload to retry.'; }
    finally { if (!disposed) { pending = false; if (consumed && !auth.getState().user && !['blocked', 'disposed'].includes(auth.getState().phase)) void challenge.reset(); render(); } }
  }
  const submitEmail = (event: Event) => { event.preventDefault(); void command('send'); };
  const submitCode = (event: Event) => { event.preventDefault(); void command('verify'); };
  const enter = () => { void command('guest'); }, leave = () => { void command('out'); };
  const reset = () => { if (!disposed && !pending) { localError = ''; void challenge.reset(); } };
  emailForm.addEventListener('submit', submitEmail); codeForm.addEventListener('submit', submitCode);
  guest.addEventListener('click', enter); out.addEventListener('click', leave); retry.addEventListener('click', reset);
  const unsubAuth = auth.subscribe(render), unsubChallenge = challenge.subscribe(render);
  const every = options.every ?? ((callback, milliseconds) => { const id = setInterval(callback, milliseconds); return () => clearInterval(id); });
  const stopClock = every(render, 1000); render(); if (!auth.getState().user && !['blocked', 'disposed'].includes(auth.getState().phase)) void challenge.start();
  return { dispose() {
    if (disposed) return; disposed = true; email.value = ''; code.value = '';
    stopClock(); unsubAuth(); unsubChallenge();
    emailForm.removeEventListener('submit', submitEmail); codeForm.removeEventListener('submit', submitCode);
    guest.removeEventListener('click', enter); out.removeEventListener('click', leave); retry.removeEventListener('click', reset);
    try { challenge.dispose(); } finally { root.replaceChildren(); }
  } };
}
