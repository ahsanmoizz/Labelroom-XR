let nextToolsId = 0;

/** Visibility controls retain the mounted review, form values and scene resource. */
export function mountWorkspaceTools(root: HTMLElement, panel: HTMLElement, account?: HTMLElement, guest = false) {
  const doc = root.ownerDocument, id = ++nextToolsId;
  const panelId = panel.id, initiallyHidden = panel.hidden, accountInitiallyHidden = account?.hidden;
  panel.id = panel.id || `dataset-controls-${id}`;
  const toolbar = doc.createElement('nav'); toolbar.className = 'workspace-toolbar'; toolbar.setAttribute('aria-label', 'Workspace menus');
  const controls = doc.createElement('button'), accountButton = doc.createElement('button');
  const focus = doc.createElement('button'), guideButton = doc.createElement('button');
  for (const button of [controls, accountButton, focus, guideButton]) button.type = 'button';
  controls.setAttribute('aria-controls', panel.id);
  if (account) accountButton.setAttribute('aria-controls', account.id);
  accountButton.hidden = !account;
  guideButton.textContent = 'User guide'; guideButton.setAttribute('aria-haspopup', 'dialog');
  focus.setAttribute('aria-pressed', 'false');
  toolbar.append(controls, accountButton, focus, guideButton);
  const dialog = doc.createElement('dialog'); dialog.className = 'workspace-guide'; dialog.id = `workspace-guide-${id}`;
  dialog.setAttribute('aria-labelledby', `workspace-guide-title-${id}`);
  const header = doc.createElement('div'); header.className = 'workspace-guide-header';
  const heading = doc.createElement('h2'); heading.id = `workspace-guide-title-${id}`; heading.textContent = 'How to use LabelRoom XR';
  const close = doc.createElement('button'); close.type = 'button'; close.textContent = 'Close guide'; header.append(heading, close);
  const intro = doc.createElement('p'); intro.textContent = 'Hide menus to inspect the full scene. Your open review and typed values stay in place.';
  const steps = doc.createElement('ol'); steps.className = 'workspace-guide-steps';
  for (const [title, text] of [
    ['Open your data', guest ? 'In the controls panel, choose Open PandaSet demo. The sample has five frames and deliberately altered labels for review practice.' : 'Choose a LabelRoom ZIP for a local preview. To save reviews, use Save dataset privately, then open the saved project.'],
    ['Inspect a frame and object', 'Use Previous frame or Next frame, Display scale and Reset view. In Review saved labels, choose the review frame and object. Hide controls or use Focus scene when a menu covers a box.'],
    ['Check before deciding', 'Run automatic checks, then select an issue or inspect point support. These measurements identify potential issues; they are not verified label errors.'],
    ['Preview, then approve', 'Enter values in source metres and yaw in degrees, and choose a reason. Preview edit shows a proposal. Compare original helps you check it. Approve and save commits it; Reject preview leaves saved labels unchanged.'],
    ['Save and export your work', 'Wait for the saved revision confirmation. Export saved revision downloads that saved work. History and recovery offers last-edit undo and reload. Export before resetting the demo or signing out.']
  ]) {
    const item = doc.createElement('li'), label = doc.createElement('strong'), detail = doc.createElement('p');
    label.textContent = title; detail.textContent = text; item.append(label, detail); steps.append(item);
  }
  const more = doc.createElement('details'), summary = doc.createElement('summary'); summary.textContent = 'XR, AI and keyboard help';
  const xr = doc.createElement('p'); xr.textContent = 'Enter XR starts an immersive session when available. In XR, use the spatial review panel and deliberate hand selections. A desktop emulator has its own input controls; it does not reproduce physical tracking or headset performance.';
  const ai = doc.createElement('p'); ai.textContent = 'AI inspection is optional. It requires project consent and service availability. AI never saves edits; you still preview and approve every change.';
  const keyboard = doc.createElement('p'); keyboard.textContent = 'Use Tab to move between controls, Enter or Space to activate a button, and Escape to close this guide. Show controls and Show account remain available when their panels are hidden. Close review ends the review; Hide controls only hides its menu.';
  more.append(summary, xr, ai, keyboard);
  const links = doc.createElement('p'); links.className = 'account-links';
  for (const [text, href] of [['Detailed help', '/help.html'], ['Privacy and data', '/privacy.html']]) {
    const link = doc.createElement('a'); link.textContent = text; link.href = href; link.target = '_blank'; link.rel = 'noopener'; links.append(link);
  }
  dialog.append(header, intro, steps, more, links); root.append(toolbar, dialog);
  let closed = false, restore: { panel: boolean; account?: boolean } | undefined;
  function render() {
    controls.textContent = panel.hidden ? 'Show controls' : 'Hide controls'; controls.setAttribute('aria-expanded', String(!panel.hidden));
    accountButton.textContent = account?.hidden ? 'Show account' : 'Hide account'; accountButton.setAttribute('aria-expanded', String(!!account && !account.hidden));
    focus.textContent = restore ? 'Restore panels' : 'Focus scene'; focus.setAttribute('aria-pressed', String(!!restore));
  }
  function toggleControls() { if (closed) return; panel.hidden = !panel.hidden; restore = undefined; render(); controls.focus?.(); }
  function toggleAccount() { if (closed || !account) return; account.hidden = !account.hidden; restore = undefined; render(); accountButton.focus?.(); }
  function focusScene() {
    if (closed) return;
    if (restore) { panel.hidden = restore.panel; if (account) account.hidden = restore.account ?? false; restore = undefined; }
    else { restore = { panel: panel.hidden, account: account?.hidden }; panel.hidden = true; if (account) account.hidden = true; }
    render(); focus.focus?.();
  }
  function openGuide() { if (!closed && !dialog.open) dialog.showModal(); }
  function closeGuide() { if (dialog.open) dialog.close(); }
  function guideClosed() { if (!closed) guideButton.focus?.(); }
  controls.addEventListener('click', toggleControls); accountButton.addEventListener('click', toggleAccount);
  focus.addEventListener('click', focusScene); guideButton.addEventListener('click', openGuide);
  close.addEventListener('click', closeGuide); dialog.addEventListener('close', guideClosed);
  render();
  return { dispose() {
    if (closed) return; closed = true;
    controls.removeEventListener('click', toggleControls); accountButton.removeEventListener('click', toggleAccount);
    focus.removeEventListener('click', focusScene); guideButton.removeEventListener('click', openGuide);
    close.removeEventListener('click', closeGuide); dialog.removeEventListener('close', guideClosed);
    closeGuide(); toolbar.remove(); dialog.remove(); panel.hidden = initiallyHidden; panel.id = panelId;
    if (account) account.hidden = accountInitiallyHidden ?? false;
  } };
}
