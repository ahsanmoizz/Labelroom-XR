// LABELXR-APPLICATION-HOST-v1
import { validatePublicConfig, type PublicAppConfig, type PublicConfigMode } from './config.js';
import { createAccountWorkspace } from './private-scope.js';
import type { AuthPort, AuthState } from '../services/auth.js';
import type { Challenge } from '../services/captcha.js';
import { mountLoginPanel } from '../ui/login.js';
import { renderStartup } from '../ui/setup.js';

export interface WorkspaceResource { dispose(): void }
export class WorkspaceCleanupError extends Error {
  constructor() { super('Workspace could not be cleared.'); }
}
export type HostOutcome = 'ready' | 'setup-required' | 'origin-mismatch' | 'connection-failed' | 'disposed';
export interface HostDependencies {
  statusRoot: HTMLElement;
  accountRoot: HTMLElement;
  privateRoot: HTMLElement;
  connect(config: Readonly<PublicAppConfig>): Promise<AuthPort>;
  challenge(container: HTMLElement, siteKey: string): Challenge;
  openWorkspace(container: HTMLElement, signal: AbortSignal): Promise<WorkspaceResource>;
  reload(): void;
  every?: (callback: () => void, milliseconds: number) => () => void;
}

/** Own the page's account panel and one verified-identity workspace at a time. */
export function createApplicationHost(dependencies: HostDependencies) {
  const { statusRoot, accountRoot, privateRoot } = dependencies;
  const roots = [statusRoot, accountRoot, privateRoot], doc = statusRoot.ownerDocument;
  if (new Set(roots).size !== 3 || roots.some(r => r.ownerDocument !== doc || roots.some(p => p !== r && p.contains(r)))) {
    throw new Error('Application containers differ.');
  }
  let disposed = false, fatal = false, identity: string | null = null;
  let account: ReturnType<typeof createAccountWorkspace> | undefined;
  let panel: ReturnType<typeof mountLoginPanel> | undefined;
  let unsubscribe: (() => void) | undefined, challenge: Challenge | undefined;
  let pending: Promise<HostOutcome> | undefined, queue: Promise<void> = Promise.resolve();
  privateRoot.hidden = true; accountRoot.hidden = true; privateRoot.replaceChildren();
  function clearPrivateView() { identity = null; privateRoot.hidden = true; privateRoot.replaceChildren(); }
  function hideStatus() { statusRoot.hidden = true; statusRoot.replaceChildren(); }
  function failure(title: string, message: string) {
    if (disposed) return;
    const card = doc.createElement('section'); card.className = 'setup-card';
    const heading = doc.createElement('h1'); heading.textContent = title;
    const text = doc.createElement('p'); text.setAttribute('role', 'alert'); text.textContent = message;
    const reload = doc.createElement('button'); reload.type = 'button'; reload.textContent = 'Reload application';
    reload.addEventListener('click', dependencies.reload); card.append(heading, text, reload);
    statusRoot.hidden = false; statusRoot.replaceChildren(card);
  }
  function closeAfterFailure() {
    fatal = true; clearPrivateView();
    try { panel?.dispose(); } catch { /* Continue to close the account service. */ }
    try { account?.dispose(); } catch { /* All scope callbacks were attempted. */ }
    failure('Workspace could not be cleared', 'Private views are closed. Reload before continuing.');
  }
  function authChanged(state: AuthState) {
    if (disposed || fatal) return;
    if (state.phase === 'blocked') { closeAfterFailure(); return; }
    if (!state.user || state.phase !== 'signed-in') { if (identity !== null) clearPrivateView(); hideStatus(); return; }
    const key = state.user.id + ':' + state.user.kind;
    if (identity === key || !account) return;
    identity = key;
    const scope = account.scope, ticket = scope.ticket(), controller = new AbortController();
    const frame = doc.createElement('div'); frame.className = 'workspace-scene';
    frame.style.cssText = 'width:100%;height:100%;visibility:hidden';
    const loading = doc.createElement('p'); loading.className = 'workspace-loading';
    loading.textContent = 'Opening your workspace…'; loading.setAttribute('role', 'status');
    privateRoot.replaceChildren(frame, loading); privateRoot.hidden = false;
    let resource: WorkspaceResource | undefined;
    try {
      scope.own(() => {
        controller.abort(); frame.remove(); loading.remove();
        const owned = resource; resource = undefined; owned?.dispose();
      });
    } catch { closeAfterFailure(); return; }
    // A new world waits for any cancelled world's creation/late cleanup to settle.
    queue = queue.then(async () => {
      if (disposed || fatal || !ticket.current() || controller.signal.aborted) return;
      let opened: WorkspaceResource;
      try { opened = await dependencies.openWorkspace(frame, controller.signal); }
      catch (error) {
        if (error instanceof WorkspaceCleanupError && !disposed) { closeAfterFailure(); return; }
        if (!disposed && !fatal && ticket.current() && !controller.signal.aborted) {
          fatal = true; clearPrivateView();
          failure('Workspace could not start', 'Reload to try again. Your account controls remain available.');
        }
        return;
      }
      if (disposed || fatal || !ticket.current() || controller.signal.aborted) {
        try { opened.dispose(); } catch { if (!disposed) closeAfterFailure(); }
        return;
      }
      resource = opened; loading.remove(); frame.style.visibility = 'visible'; hideStatus();
    }).catch(() => { if (!disposed) closeAfterFailure(); });
  }
  function start(environment: unknown, mode: PublicConfigMode, pageOrigin: string): Promise<HostOutcome> {
    if (disposed) return Promise.resolve('disposed');
    if (pending) return pending;
    pending = Promise.resolve().then(async (): Promise<HostOutcome> => {
      if (disposed) return 'disposed';
      const settings = validatePublicConfig(environment, mode);
      statusRoot.hidden = false;
      if (settings.status === 'setup-required') { renderStartup(statusRoot, settings, dependencies.reload); return 'setup-required'; }
      if (pageOrigin !== settings.config.appOrigin) { renderStartup(statusRoot, { status: 'origin-mismatch' }, dependencies.reload); return 'origin-mismatch'; }
      renderStartup(statusRoot, { status: 'connecting' }, dependencies.reload);
      let port: AuthPort;
      try { port = await dependencies.connect(settings.config); }
      catch { if (disposed) return 'disposed'; renderStartup(statusRoot, { status: 'connection-failed' }, dependencies.reload); return 'connection-failed'; }
      if (disposed) return 'disposed';
      try {
        account = createAccountWorkspace(port, clearPrivateView);
        const captchaElement = doc.createElement('div');
        challenge = dependencies.challenge(captchaElement, settings.config.turnstileSiteKey);
        panel = mountLoginPanel(accountRoot, account.auth, challenge, { captchaElement, every: dependencies.every });
        accountRoot.hidden = false;
        unsubscribe = account.auth.subscribe(authChanged);
        hideStatus();
        await account.auth.restore();
        return disposed ? 'disposed' : 'ready';
      } catch {
        if (!disposed) closeAfterFailure();
        return disposed ? 'disposed' : 'connection-failed';
      }
    });
    return pending;
  }
  return {
    start,
    dispose() {
      if (disposed) return; disposed = true; unsubscribe?.();
      try { panel?.dispose(); } catch { /* Close every owned part even on failure. */ }
      try { challenge?.dispose(); } catch { /* Idempotent for a mounted panel. */ }
      try { account?.dispose(); } catch { /* Private view still closes below. */ }
      clearPrivateView(); accountRoot.replaceChildren(); accountRoot.hidden = true; hideStatus();
    }
  };
}
