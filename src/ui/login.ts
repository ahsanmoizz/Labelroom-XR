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
  card.className = 'account-card';
  const layout = element('div'); layout.className = 'account-entry-layout';
  const restoring = element('section'); restoring.className = 'account-restoring'; restoring.setAttribute('aria-label', 'Restoring workspace');
  const restoringTitle = element('h1', 'Restoring your workspace…');
  const restoringText = element('p', 'Checking your saved session. Your workspace will open automatically.'); restoringText.setAttribute('role', 'status');
  restoring.append(restoringTitle, restoringText);
  const hero = element('section'); hero.className = 'entry-story'; hero.setAttribute('aria-label', 'About LabelRoom XR');
  const eyebrow = element('p', 'A clearer view of your 3D labels'); eyebrow.className = 'entry-eyebrow';
  const headline = element('h1', 'Inspect the detail.\nKeep every decision.');
  const description = element('p', 'Review labels against the scan. Preview your changes, save a revision, and export your work.'); description.className = 'entry-description';
  const scene = element('img'); scene.src = '/review-scene.svg'; scene.alt = ''; scene.width = 600; scene.height = 310; scene.className = 'entry-scene';
  const steps = element('ol'); steps.className = 'entry-steps';
  for (const [heading, detail] of [['Inspect', 'Compare boxes, points and nearby frames.'], ['Decide', 'Preview each change before approving it.'], ['Export', 'Keep the source data and review history.']]) { const row = element('li'), strong = element('strong', heading), text = element('span', detail); row.append(strong, text); steps.append(row); }
  hero.append(eyebrow, headline, description, scene, steps);
  const brand = element('div'); brand.className = 'account-brand';
  const mark = element('img'); mark.src = '/brand-mark.svg'; mark.alt = ''; mark.width = 42; mark.height = 42;
  const wordmark = element('span', 'LabelRoom XR'); wordmark.className = 'brand-wordmark';
  const brandDetail = element('small', 'Spatial label review'); const brandText = element('div'); brandText.append(wordmark, brandDetail); brand.append(mark, brandText);
  const title = element('h2', 'Open your review workspace');
  const intro = element('p', 'Sign in or create an account with an email code.');
  const emailForm = element('form'), emailLabel = element('label', 'Email address'), email = element('input');
  email.type = 'email'; email.autocomplete = 'email'; email.maxLength = 254; email.required = true; email.name = 'email';
  email.placeholder = 'you@example.com';
  const emailHint = element('p', 'No password required.'); emailHint.className = 'account-hint';
  const send = element('button', 'Send code'); send.type = 'submit'; emailLabel.appendChild(email); emailForm.append(emailLabel, emailHint);
  const codeForm = element('form'), codeLabel = element('label', 'Email code'), code = element('input');
  code.type = 'text'; code.inputMode = 'numeric'; code.autocomplete = 'one-time-code'; code.pattern = '[0-9]{6,10}'; code.maxLength = 10; code.required = true; code.name = 'code';
  const verify = element('button', 'Verify code'); verify.type = 'submit'; codeLabel.appendChild(code); codeForm.append(codeLabel, verify);
  const security = element('p'), retry = element('button', 'Retry security check'); retry.type = 'button';
  const securitySection = element('section'); securitySection.className = 'account-security'; securitySection.setAttribute('aria-label', 'Browser security check');
  options.captchaElement.className = 'captcha-host'; security.className = 'security-status'; security.setAttribute('role', 'status'); security.setAttribute('aria-live', 'polite');
  securitySection.append(options.captchaElement, security, retry); emailForm.append(securitySection, send);
  const divider = element('p', 'or explore the sample'); divider.className = 'account-divider';
  const guest = element('button', 'Enter demo'); guest.type = 'button';
  const notice = element('p', 'Demo access lasts 24 hours. Export your work before signing out; signing out ends this browser’s guest access. Sign out before switching to a permanent account.');
  const out = element('button', 'Sign out'); out.type = 'button';
  const status = element('p'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const error = element('p'); error.setAttribute('role', 'alert'); error.style.color = '#ffd5c2';
  send.className = verify.className = 'button-primary'; guest.className = 'button-secondary account-demo'; notice.className = 'account-demo-note'; status.className = 'account-status'; error.className = 'account-error';
  const support=element('p'); support.className='account-links';
  for(const [label,path] of [['Help','/help.html'],['Privacy and data','/privacy.html']]){const link=element('a',label);link.href=path;link.target='_blank';link.rel='noopener';support.append(link);}
  card.append(brand, title, intro, emailForm, codeForm, divider, guest, notice, out, status, error, support); layout.append(hero, card); root.replaceChildren(restoring, layout);
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
    const checking = state.phase === 'checking-session';
    layout.hidden = checking; restoring.hidden = !checking;
    card.setAttribute('data-connected', signed ? 'true' : 'false'); root.setAttribute('data-account-state', checking ? 'restoring' : signed ? 'connected' : 'entry'); hero.hidden = signed; divider.hidden = signed;
    title.textContent=signed?'Account':'Open your review workspace'; intro.hidden=signed;
    notice.hidden=signed && state.user?.kind!=='guest';
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
    // Initial restoration never mounts a provider widget or exposes entry actions.
    if (state.phase === 'signed-out' && prior !== state.phase && challenge.getState().status === 'idle') void challenge.start();
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
  const stopClock = every(render, 1000); render();
  return { dispose() {
    if (disposed) return; disposed = true; email.value = ''; code.value = '';
    stopClock(); unsubAuth(); unsubChallenge();
    emailForm.removeEventListener('submit', submitEmail); codeForm.removeEventListener('submit', submitCode);
    guest.removeEventListener('click', enter); out.removeEventListener('click', leave); retry.removeEventListener('click', reset);
    try { challenge.dispose(); } finally { root.replaceChildren(); }
  } };
}
