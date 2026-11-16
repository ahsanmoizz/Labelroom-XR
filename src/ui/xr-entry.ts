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
  const help = doc.createElement('dialog'), heading = doc.createElement('h2'), explanation = doc.createElement('p');
  const check = doc.createElement('button'), close = doc.createElement('button');
  help.className = 'xr-support-dialog'; heading.id = 'labelxr-xr-help-heading'; heading.textContent = 'Open your workspace in XR';
  help.setAttribute('aria-labelledby', heading.id); explanation.setAttribute('role', 'status');
  check.type = close.type = 'button'; check.textContent = 'Check XR availability'; close.textContent = 'Back to workspace';
  help.append(heading, explanation, check, close); section.append(help);
  let closed = false, supported = false, checking = true, requested = false, exiting = false, failed = false, active: XRSession | undefined;
  let observed: XRSystem | undefined, checkEpoch = 0;
  function guidance() {
    return failed ? 'Your browser did not open an XR session. Check that your headset is connected, its XR runtime is running, and this site has permission. Then check availability and choose Enter XR again. Your review is unchanged.'
      : checking ? 'Checking this browser for a connected XR device…'
      : supported ? 'XR is available. Close this message and choose Enter XR to allow the headset session. Your current dataset and review stay open.'
      : !win?.navigator.xr ? 'This browser does not expose WebXR. Open this same secure site in your headset browser, or use a WebXR-capable browser with a connected headset. Desktop review remains available.'
      : 'No immersive XR device is available to this browser. Open this same site in your headset browser, or connect your PC headset and start its XR runtime. A regular desktop window does not provide a headset session. Check availability after connecting; desktop review remains available.';
  }
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
    button.textContent = session ? 'Exit XR' : busy ? 'Opening XR…' : supported ? 'Enter XR' : 'XR setup';
    // Keep setup reachable on a desktop instead of showing a silently disabled Enter XR button.
    button.disabled = exiting || busy || (!session && !hasDataset());
    status.textContent = exiting ? 'Leaving XR…' : session ? 'XR session active. Use your browser or headset control to exit.' : busy ? 'Allow XR in your browser or headset to continue.' : failed ? 'XR did not open. Select XR setup or Enter XR to try again.' : !hasDataset() ? 'Open a dataset or the PandaSet demo to enter XR.' : !supported ? 'XR needs a compatible headset. Select XR setup for help.' : 'Enter XR when you are ready. Desktop review remains available.';
    button.title = status.textContent;
    explanation.textContent = guidance(); check.disabled = checking;
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
    if (!supported) {
      if (!help.open) help.showModal();
      void checkAvailability();
      return;
    }
    failed = false; requested = true; render();
    try { world.launchXR(); } catch { requested = false; failed = true; render(); if (!help.open) help.showModal(); }
  }
  button.addEventListener('click', enter);
  // Observe the SDK's public pending flag; keep the click's user activation synchronous.
  const timer = win?.setInterval(() => {
    if (requested && !world.sessionRequestPending) { requested = false; failed = !world.xrSession; if (failed && !help.open) help.showModal(); }
    render();
  }, 100);
  async function checkAvailability() {
    if (closed) return;
    const ticket = ++checkEpoch, xr = win?.navigator.xr;
    if (xr !== observed) { observed?.removeEventListener('devicechange', deviceChanged); observed = xr; observed?.addEventListener('devicechange', deviceChanged); }
    checking = true; render();
    try { const value = xr ? await xr.isSessionSupported('immersive-vr') : false; if (!closed && ticket === checkEpoch) supported = value; }
    catch { if (!closed && ticket === checkEpoch) supported = false; }
    finally { if (!closed && ticket === checkEpoch) { checking = false; render(); } }
  }
  function deviceChanged() { void checkAvailability(); }
  function visible() { if (doc.visibilityState === 'visible') void checkAvailability(); }
  function dismiss() { help.close(); button.focus(); }
  check.addEventListener('click', deviceChanged); close.addEventListener('click', dismiss);
  win?.addEventListener('focus', deviceChanged); doc.addEventListener('visibilitychange', visible);
  void checkAvailability();
  function dispose() {
    if (closed) return; closed = true;
    if (timer !== undefined) win?.clearInterval(timer);
    checkEpoch++; observed?.removeEventListener('devicechange', deviceChanged);
    win?.removeEventListener('focus', deviceChanged); doc.removeEventListener('visibilitychange', visible);
    check.removeEventListener('click', deviceChanged); close.removeEventListener('click', dismiss);
    if (help.open) help.close();
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
