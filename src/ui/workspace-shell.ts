import type { BundleSource } from '../data/bundle';
import type { ReviewSnapshot } from '../domain/review-snapshot';

type Tab = 'dataset' | 'review' | 'checks' | 'history' | 'ai';
interface Options {
  container: HTMLElement; scene: HTMLElement; overlay: HTMLElement; panel: HTMLElement;
  toolbar: HTMLElement; account?: HTMLElement; guest: boolean;
  source(): BundleSource | undefined; snapshot(): ReviewSnapshot | undefined;
  world: { camera?: { aspect: number; updateProjectionMatrix(): void };
    xrSession?: unknown; renderer: { setSize?(width: number, height: number, updateStyle?: boolean): void;
      xr?: { isPresenting?: boolean; addEventListener?(type: string, fn: () => void): void; removeEventListener?(type: string, fn: () => void): void } } };
}
let sequence = 0;

/** Presentation only: retain the original mounted controls, stores and listeners. */
export function mountWorkspaceShell(options: Options) {
  const { container, scene, overlay, panel, toolbar, account } = options;
  const doc = container.ownerDocument, win = doc.defaultView;
  // Basic controls remain usable in non-browser DOM hosts without observers.
  if (!win?.MutationObserver || !win.ResizeObserver) return undefined;
  const id = ++sequence, oldClass = overlay.className, oldPosition = container.style.position;
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, name: string, text = '') => {
    const el = doc.createElement(tag); el.className = name; el.textContent = text; return el;
  };
  const text = (el: HTMLElement, value: string) => { if (el.textContent !== value) el.textContent = value; };
  const header = make('header', 'workbench-header'), brand = make('div', 'workbench-brand');
  const mark = doc.createElement('img'); mark.src = '/brand-mark.svg'; mark.alt = ''; mark.width = mark.height = 32;
  brand.append(mark, make('strong', '', 'LabelRoom XR'), make('span', 'workbench-subtitle', 'Spatial label review'));
  const session = make('span', 'workbench-session', options.guest ? 'Guest session' : 'Member workspace');
  const headerActions = make('div', 'workbench-header-actions'); headerActions.append(session); header.append(brand, headerActions);
  const stage = make('section', 'workbench-stage'); stage.setAttribute('aria-label', 'Dataset scene');
  const hud = make('div', 'workbench-scene-heading'), heading = make('h2', '', 'Open a dataset');
  const badge = make('span', 'workbench-badge', 'PREVIEW'), facts = make('p', 'workbench-scene-facts', 'Choose a ZIP or open your private demo.');
  const issues = make('span', 'workbench-issues'); issues.hidden = true;
  const selected = make('span', 'workbench-selected'); selected.hidden = true;
  const titleRow = make('div', 'workbench-scene-title'); titleRow.append(heading, badge); hud.append(titleRow, facts, issues, selected);
  const viewport = make('div', 'workbench-viewport'); viewport.append(scene);
  const dock = make('div', 'workbench-dock'); dock.setAttribute('aria-label', 'Frame and view controls');
  const datasetControls = panel.querySelector<HTMLElement>('.dataset-controls');
  const scale = datasetControls?.querySelector<HTMLInputElement>('[aria-label="Display scale"]');
  const scaleLabel = scale?.parentElement;
  [...(datasetControls?.querySelectorAll('button') ?? [])].find(b => b.textContent === 'Reset view')?.classList.add('workbench-reset-view');
  const frame = make('span', 'workbench-frame', 'No frame loaded');
  if (datasetControls) { datasetControls.insertBefore(frame, datasetControls.children[1] ?? null); dock.append(datasetControls); }
  stage.append(hud, viewport, dock);
  const footer = make('footer', 'workbench-status'), mode = make('span', '', 'Dataset preview');
  const revision = make('span', '', 'No saved review open'), aiState = make('span', '', 'AI consent off');
  footer.append(mode, revision, aiState);
  const tabs = make('div', 'inspector-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Workspace inspector');
  const datasetPane = make('section', 'inspector-pane'); datasetPane.dataset.pane = 'dataset';
  const buttons = new Map<Tab, HTMLButtonElement>(), panes = new Map<Tab, HTMLElement>([['dataset', datasetPane]]);
  let active: Tab = 'dataset', review: HTMLElement | undefined, wasProposed = false, closed = false, scheduled = 0;
  const datasetStatus = Array.from(panel.children).find(el => el.matches('p[role="status"]')) as HTMLElement | undefined;
  function identifyPane(name: Tab, pane: HTMLElement) {
    pane.id = `workbench-${id}-${name}`; pane.setAttribute('role', 'tabpanel'); pane.setAttribute('aria-labelledby', `workbench-tab-${id}-${name}`);
    pane.dataset.pane = name; panes.set(name, pane);
  }
  identifyPane('dataset', datasetPane);
  function show(name: Tab, focus = false) {
    if (closed || buttons.get(name)?.disabled) return;
    active = name; panel.dataset.activeTab = name;
    for (const [key, button] of buttons) {
      const chosen = key === name;
      if (button.getAttribute('aria-selected') !== String(chosen)) button.setAttribute('aria-selected', String(chosen));
      button.tabIndex = chosen ? 0 : -1;
      const pane = panes.get(key); if (pane && pane.hidden === chosen) pane.hidden = !chosen;
    }
    if (focus) buttons.get(name)?.focus({ preventScroll: true });
  }
  for (const [name, label] of [['dataset', 'Dataset'], ['review', 'Review'], ['checks', 'Checks'], ['history', 'History'], ['ai', 'AI']] as const) {
    const button = make('button', 'inspector-tab', label); button.type = 'button'; button.id = `workbench-tab-${id}-${name}`;
    button.setAttribute('role', 'tab'); button.setAttribute('aria-controls', `workbench-${id}-${name}`);
    button.addEventListener('click', () => show(name)); buttons.set(name, button); tabs.append(button);
  }
  function keyboard(event: KeyboardEvent) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const available = [...buttons].filter(([, b]) => !b.disabled), index = available.findIndex(([, b]) => b === doc.activeElement);
    if (index < 0) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? available.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + available.length) % available.length;
    show(available[next][0], true);
  }
  tabs.addEventListener('keydown', keyboard);
  panel.prepend(tabs, datasetPane);
  container.setAttribute('data-workbench', 'true'); container.style.position = 'fixed'; overlay.className = 'workspace-overlay workspace-shell';
  overlay.prepend(header, toolbar, stage); overlay.append(footer);
  if (account) {
    account.setAttribute('data-workbench-account', 'true');
    // The existing account toggle remains the only visibility controller.
    if (!account.hidden) [...toolbar.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Hide account')?.click();
  }
  const xr = toolbar.querySelector<HTMLElement>('.workspace-xr-entry'); if (xr) headerActions.append(xr);
  const paths = ['M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z', 'M20 21v-2a7 7 0 0 0-14 0v2M17 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0', 'M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5M8 12h8M12 8v8', 'M9 9a3 3 0 1 1 4 3c-1 0-1 1-1 2M12 18h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0'];
  const railIcons = new Map<HTMLButtonElement, SVGSVGElement>();
  [...toolbar.querySelectorAll<HTMLButtonElement>(':scope > button')].forEach((button, index) => {
    const icon = doc.createElementNS('http://www.w3.org/2000/svg', 'svg'); icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('aria-hidden', 'true'); icon.setAttribute('class', 'workbench-rail-icon');
    const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', paths[index] ?? paths[0]); icon.append(path); button.prepend(icon); railIcons.set(button, icon);
  });
  function classify(el: HTMLElement): Tab {
    if (el.matches('[aria-label="Automatic label checks"]')) return 'checks';
    if (el.matches('.ai-panel')) return 'ai';
    if (el.matches('[aria-label="Typed edit recovery"]')) return 'review';
    return 'review';
  }
  function arrangeReview(found: HTMLElement) {
    const changed = found !== review; review = found;
    if (changed) {
      for (const key of ['review', 'checks', 'history', 'ai'] as const) {
        const pane = make('section', 'inspector-pane'); identifyPane(key, pane); found.append(pane);
      }
    }
    for (const child of Array.from(found.children) as HTMLElement[]) {
      if (child.dataset.pane) continue;
      if (child.matches('.review-actions')) {
        for (const group of Array.from(child.children) as HTMLElement[]) {
          const history = ['History and recovery', 'Download and local recovery'].includes(group.getAttribute('aria-label') ?? '');
          (history ? panes.get('history')! : panes.get('review')!).append(group);
        }
        child.remove();
      } else panes.get(classify(child))!.append(child);
    }
    const body = panes.get('review')!, selectionFields = body.querySelector<HTMLElement>('.review-selection');
    if (selectionFields && selectionFields.children.length > 2) {
      const reasons = make('div', 'review-selection workbench-review-reasons');
      reasons.append(...Array.from(selectionFields.children).slice(2));
      body.insertBefore(reasons, body.querySelector('.review-action-group'));
    }
    const close = Array.from(panel.querySelectorAll<HTMLButtonElement>('button')).find(b => b.textContent === 'Close review');
    if (close && close.parentElement !== panes.get('review')) { close.classList.add('workbench-close-review'); panes.get('review')!.append(close); }
    for (const [name, button] of buttons) { const disabled = name !== 'dataset' && !panes.get(name)?.querySelector('button,input,select'); if (button.disabled !== disabled) button.disabled = disabled; }
    if (changed) show('review');
  }
  function sync() {
    if (closed) return;
    for (const [button, icon] of railIcons) if (icon.parentElement !== button) button.prepend(icon);
    const found = panel.querySelector<HTMLElement>('.review-panel');
    if (found) arrangeReview(found);
    else if (review) {
      review = undefined; wasProposed = false;
      for (const name of ['review', 'checks', 'history', 'ai'] as const) panes.delete(name);
      for (const [name, button] of buttons) button.disabled = name !== 'dataset';
      show('dataset');
    }
    for (const child of Array.from(panel.children) as HTMLElement[]) {
      if (child === tabs || child === datasetPane || child === found || child.contains(found ?? null)) continue;
      datasetPane.append(child);
    }
    const snapshot = options.snapshot(), source = options.source();
    const name = source?.manifest.source.name;
    text(heading, name ? (/pandaset/i.test(name) ? 'PandaSet' : name) : 'Open a dataset');
    text(badge, snapshot ? options.guest ? 'PRIVATE DEMO' : 'PRIVATE PROJECT' : 'PREVIEW');
    const info = datasetStatus?.textContent?.match(/^Frame (\d+) \/ (\d+) \(([^)]+)\) · (\d+) points · (\d+) boxes$/);
    text(facts, info ? `Frame ${info[1]} / ${info[2]} · ${info[3]}   ·   ${Number(info[4]).toLocaleString()} points · ${info[5]} boxes` : source ? 'Dataset loaded · see Dataset for its status.' : 'Choose a ZIP or open your private demo.');
    text(frame, info ? `Frame ${info[1]} of ${info[2]} · ${info[3]}` : 'No frame loaded');
    const issueStatus = found?.querySelector<HTMLElement>('[aria-label="Automatic label checks"] [role="status"]')?.textContent;
    const count = issueStatus?.match(/^(\d+) potential issue/); issues.hidden = !count;
    if (count) text(issues, `${count[1]} potential issues`);
    const selection = found?.querySelector<HTMLSelectElement>('[aria-label="Review object"]');
    const selectedName = selection?.selectedOptions[0]?.textContent; selected.hidden = !selectedName;
    if (selectedName) text(selected, selectedName);
    text(mode, snapshot ? options.guest ? 'Private guest demo' : 'Private project' : source ? 'Local dataset preview' : 'No dataset loaded');
    text(revision, snapshot ? `Saved revision ${snapshot.revision}` : 'No saved review open');
    const consent = found?.querySelector<HTMLInputElement>('[aria-label="Allow AI inspection for this project"]');
    text(aiState, consent?.checked ? 'AI consent selected' : 'AI consent off');
    const proposed = [...(found?.querySelectorAll<HTMLButtonElement>('button') ?? [])].some(b => b.textContent === 'Approve and save' && !b.disabled);
    if (proposed && !wasProposed) show('review', true); wasProposed = proposed;
    if (scale && scaleLabel) {
      let output = scaleLabel.querySelector<HTMLOutputElement>('output');
      if (!output) { output = make('output', 'workbench-scale-value'); output.setAttribute('aria-label', 'Current display scale'); scaleLabel.append(output); }
      text(output, scale.value);
    }
    show(active);
  }
  function activated(event: Event) {
    const target = (event.target as Element | null)?.closest('button');
    if (target?.closest('[aria-label="Automatic label checks"]') && target.textContent === 'Select issue') win!.queueMicrotask(() => show('review', true));
  }
  panel.addEventListener('click', activated); panel.addEventListener('input', sync); panel.addEventListener('change', sync);
  const observer = new win.MutationObserver(sync);
  observer.observe(panel, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'disabled'] });
  observer.observe(toolbar, { childList: true, subtree: true });
  function resize() {
    if (closed) return;
    const target = win!.matchMedia('(max-width: 900px)').matches ? datasetPane : datasetControls;
    if (target && scaleLabel && scaleLabel.parentElement !== target) target.append(scaleLabel);
    if (options.world.xrSession || options.world.renderer.xr?.isPresenting) return;
    const { width, height } = viewport.getBoundingClientRect(); if (width < 1 || height < 1) return;
    options.world.renderer.setSize?.(Math.round(width), Math.round(height), false);
    if (options.world.camera) { options.world.camera.aspect = width / height; options.world.camera.updateProjectionMatrix(); }
  }
  function queueResize() { win!.cancelAnimationFrame(scheduled); scheduled = win!.requestAnimationFrame(resize); }
  const sizing = new win.ResizeObserver(queueResize); sizing.observe(viewport);
  win.addEventListener('resize', queueResize); options.world.renderer.xr?.addEventListener?.('sessionend', queueResize);
  const guide = toolbar.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]');
  const guideText = overlay.querySelector<HTMLElement>('.workspace-guide > p');
  if (guideText) text(guideText, 'Choose Dataset, Review, Checks, History or AI in the inspector. Hide controls or use Focus scene for a larger view. Switching sections keeps your review and typed values in place.');
  if (guide) guide.title = 'How to use LabelRoom XR';
  for (const [name, button] of buttons) button.disabled = name !== 'dataset';
  sync(); queueResize();
  return { refresh: sync, show,
    dispose() {
      if (closed) return; closed = true; observer.disconnect(); sizing.disconnect(); win.cancelAnimationFrame(scheduled);
      win.removeEventListener('resize', queueResize); options.world.renderer.xr?.removeEventListener?.('sessionend', queueResize);
      panel.removeEventListener('click', activated); panel.removeEventListener('input', sync); panel.removeEventListener('change', sync); tabs.removeEventListener('keydown', keyboard);
      account?.removeAttribute('data-workbench-account'); container.removeAttribute('data-workbench'); container.style.position = oldPosition;
      for (const el of [header, stage, footer, tabs]) el.remove(); overlay.className = oldClass;
    }
  };
}
