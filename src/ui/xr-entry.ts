import type { World } from '@iwsdk/core';

type XrWorld = Pick<World, 'launchXR' | 'xrSession' | 'sessionRequestPending'>;

/** Account-owned manual entry. No offered sessions or automatic request on reload. */
export function mountXrEntry(root: HTMLElement, world: XrWorld, signal: AbortSignal, hasDataset: () => boolean) {
  const doc = root.ownerDocument, win = doc.defaultView;
  const section = doc.createElement('section'), button = doc.createElement('button'), status = doc.createElement('p');
  section.className = 'workspace-xr-entry'; section.setAttribute('aria-label', 'XR session');
  button.type = 'button'; button.textContent = 'Enter XR'; button.disabled = true;
  status.id = 'labelxr-xr-status'; status.setAttribute('role', 'status'); status.textContent = 'Checking XR availability…';
  button.setAttribute('aria-describedby', status.id);
  section.append(button, status); root.append(section);
  let closed = false, supported = false, requested = false, exiting = false, failed = false, active: XRSession | undefined;
  const xr = win?.navigator.xr;
  function render() {
    if (closed) return;
    const session = world.xrSession;
    if (session && session !== active) {
      active?.removeEventListener('end', onEnd); active = session; active.addEventListener('end', onEnd);
      requested = false;
      // A permission request may finish after account teardown has started.
      if (signal.aborted) { void session.end().catch(() => {}); return; }
    }
    const busy = requested || world.sessionRequestPending;
    button.textContent = session ? 'Exit XR' : busy ? 'Opening XR…' : 'Enter XR';
    button.disabled = exiting || busy || (!session && (!supported || !hasDataset()));
    status.textContent = exiting ? 'Leaving XR…' : session ? 'XR session active. Use your browser or headset control to exit.' : busy ? 'Allow XR in your browser or headset to continue.' : failed ? 'XR did not open. Try again when your headset is ready.' : !supported ? 'XR is unavailable in this browser. Desktop review is ready.' : !hasDataset() ? 'Open a dataset or the PandaSet demo to enter XR.' : 'Enter XR when you are ready. Desktop review remains available.';
    button.title = status.textContent;
  }
  function onEnd() { active?.removeEventListener('end', onEnd); active = undefined; exiting = false; render(); }
  function enter() {
    if (closed || signal.aborted || button.disabled) return;
    const session = world.xrSession;
    if (session) {
      exiting = true; render();
      void session.end().catch(() => { if (!closed) { exiting = false; render(); status.textContent = 'XR did not close. Use your browser or headset exit control.'; } });
      return;
    }
    failed = false; requested = true; render();
    try { world.launchXR(); } catch { requested = false; render(); status.textContent = 'XR could not start. Try again when your headset is ready.'; }
  }
  button.addEventListener('click', enter);
  // Observe the SDK's public pending flag; keep the click's user activation synchronous.
  const timer = win?.setInterval(() => {
    if (requested && !world.sessionRequestPending) { requested = false; failed = !world.xrSession; }
    render();
  }, 100);
  if (xr) void xr.isSessionSupported('immersive-vr').then(value => { if (!closed) { supported = value; render(); } }).catch(() => { if (!closed) render(); });
  else render();
  function dispose() {
    if (closed) return; closed = true;
    if (timer !== undefined) win?.clearInterval(timer);
    button.removeEventListener('click', enter); active?.removeEventListener('end', onEnd); section.remove();
    const session = world.xrSession;
    if (session) void session.end().catch(() => {});
    // launchXR() completes internally. If teardown wins the request, retire its late session.
    if (world.sessionRequestPending && win) {
      const pending = win.setInterval(() => {
        const late = world.xrSession;
        if (late) void late.end().catch(() => {});
        if (!world.sessionRequestPending) win.clearInterval(pending);
      }, 50);
    }
    signal.removeEventListener('abort', dispose);
  }
  signal.addEventListener('abort', dispose, {once: true});
  if (signal.aborted) dispose();
  return { dispose, refresh: render };
}
