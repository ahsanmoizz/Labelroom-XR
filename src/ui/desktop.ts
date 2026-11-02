// LABELXR-LOCAL-DATASET-PANEL-v1
import { loadBundleBytes, type BundleSource, type BundleFrame } from '../data/bundle';
import type { FrameViewSource } from '../xr/frame-view';

export interface DatasetView {
  showFrame(id: string): unknown;
  setScale(scale: number): void;
  resetView(): void;
  dispose(): void;
}
export interface DatasetPanelOptions {
  createView(source: BundleSource, display?: FrameViewSource): DatasetView;
  privateProjects?: boolean;
  load?: (bytes: Uint8Array, name: string) => Promise<BundleSource>;
}

/** Local preview only. Source data never becomes an approval or a saved decision. */
export function mountDatasetPanel(root: HTMLElement, options: DatasetPanelOptions) {
  const doc = root.ownerDocument, panel = doc.createElement('section');
  panel.setAttribute('aria-label', 'Local dataset preview'); panel.className='dataset-panel';
  panel.style.cssText = 'position:absolute;top:1rem;right:1rem;width:22rem;max-width:calc(100% - 2rem);max-height:calc(100% - 2rem);overflow:auto;padding:1rem;background:#10212eee;color:#edf7ff;border:1px solid #527188;border-radius:12px;pointer-events:auto;font:14px system-ui;z-index:2';
  const title = doc.createElement('h2'); title.textContent = 'Local dataset preview';
  const note = doc.createElement('p'); note.textContent = options.privateProjects ? 'Open a LabelRoom ZIP, up to 25 MiB. Source units are metres. Preview is local; use Save dataset privately to upload to your account. Open a saved project to review its current revision.' : 'Open a LabelRoom ZIP, up to 25 MiB. Source units are metres. This preview does not save reviews or upload data.';
  const fileLabel = doc.createElement('label'); fileLabel.textContent = 'Choose dataset ZIP ';
  const file = doc.createElement('input'); file.type = 'file'; file.accept = '.zip'; file.setAttribute('aria-label', 'Choose dataset ZIP'); fileLabel.append(file);
  const status = doc.createElement('p'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); status.textContent = 'No dataset loaded.';
  const previous = doc.createElement('button'); previous.type = 'button'; previous.textContent = 'Previous frame';
  const next = doc.createElement('button'); next.type = 'button'; next.textContent = 'Next frame';
  const scaleLabel = doc.createElement('label'); scaleLabel.textContent = ' Display scale ';
  const scale = doc.createElement('input'); scale.type = 'range'; scale.min = '0.02'; scale.max = '0.20'; scale.step = '0.01'; scale.value = '0.02'; scale.setAttribute('aria-label', 'Display scale'); scaleLabel.append(scale);
  const reset = doc.createElement('button'); reset.type = 'button'; reset.textContent = 'Reset view';
  const rights = doc.createElement('pre'); rights.setAttribute('aria-label', 'Dataset licence and attribution'); rights.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;font:12px system-ui';
  const controlsRow=doc.createElement('div'); controlsRow.className='dataset-controls';
  controlsRow.style.cssText='display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px';
  scaleLabel.style.cssText='grid-column:1/-1;display:grid;gap:6px'; scale.style.width='100%';
  file.style.cssText='display:block;width:100%;max-width:100%;margin-top:6px';
  controlsRow.append(previous,next,scaleLabel,reset);
  const terms=doc.createElement('details'), summary=doc.createElement('summary'); summary.textContent='Dataset licence and attribution';
  terms.append(summary,rights); terms.style.marginTop='12px';
  panel.append(title, note, fileLabel, status, controlsRow, terms); root.append(panel);
  let closed = false, blocked = false, busy = false, ticket = 0, index = 0, reviewLocked = false;
  let source: BundleSource | undefined, view: DatasetView | undefined;
  let frames: readonly BundleFrame[] = [];
  const subscribers = new Set<() => void>(), availability = new Set<() => void>(), frameSubscribers = new Set<(id: string) => void>();
  function notify() { for (const listener of [...subscribers]) { try { listener(); } catch { blocked = true; } } }
  const listeners: (() => void)[] = [];
  function listen(element: HTMLElement, event: string, handler: () => void) {
    element.addEventListener(event, handler); listeners.push(() => element.removeEventListener(event, handler));
  }
  function controls() {
    file.disabled = closed || blocked || reviewLocked;
    const disabled = closed || blocked || busy || reviewLocked || !source || !view;
    previous.disabled = disabled || index === 0;
    next.disabled = disabled || !source || index >= frames.length - 1;
    scale.disabled = disabled; reset.disabled = disabled;
  }
  function describe() {
    if (!source) return;
    const f = frames[index];
    status.textContent = `Frame ${index + 1} / ${frames.length} (${f.id}) · ${f.pointCount} points · ${f.boxes.length} boxes`;
  }
  function failCleanup() { blocked = true; status.textContent = 'Dataset cleanup failed. Sign out and reload before continuing.'; notify(); controls(); }
  function present(parsed: BundleSource, display?: FrameViewSource, at = ticket, announce = true) {
    if (closed || blocked) throw new Error('Dataset preview is unavailable.');
    const replacement = options.createView(parsed, display);
    if (closed || at !== ticket) { replacement.dispose(); throw new Error('Dataset preview was cancelled.'); }
    const old = view; view = undefined;
    try { old?.dispose(); } catch { try { replacement.dispose(); } catch { /* Attempt all owned cleanup. */ } source = undefined; frames = []; rights.textContent = ''; failCleanup(); throw new Error('Dataset cleanup failed.'); }
    view = replacement; source = parsed; frames = display?.frames || parsed.frames; index = 0; scale.value = '0.02';
    rights.textContent = parsed.licenceText + '\n\n' + parsed.attributionText; describe(); if (announce) notify(); controls();
  }
  async function choose() {
    if (closed || blocked || reviewLocked) return;
    const id = ++ticket, selected = Array.from(file.files || []); file.value = '';
    busy = false;
    if (selected.length === 0) { controls(); return; }
    const input = selected[0];
    if (selected.length !== 1 || !/\.zip$/i.test(input.name) || !Number.isSafeInteger(input.size) || input.size < 1 || input.size > 25 * 1024 * 1024) {
      status.textContent = 'Choose one ZIP between 1 byte and 25 MiB.'; controls(); return;
    }
    busy = true; status.textContent = 'Checking local dataset…'; notify(); controls();
    let replacement: DatasetView | undefined;
    try {
      const bytes = await input.arrayBuffer();
      if (closed || id !== ticket) return;
      if (bytes.byteLength !== input.size) throw new Error('File size changed.');
      const parsed = await (options.load || loadBundleBytes)(new Uint8Array(bytes), input.name);
      if (closed || id !== ticket) return;
      present(parsed);
    } catch {
      if (replacement) { try { replacement.dispose(); } catch { if (!closed) failCleanup(); } }
      if (!closed && id === ticket && !blocked) status.textContent = 'Dataset could not be opened. Check the ZIP and try again.';
    } finally { if (!closed && id === ticket) { busy = false; notify(); controls(); } }
  }
  function move(delta: number) {
    if (closed || blocked || busy || reviewLocked || !source || !view) return;
    const target = index + delta; if (target < 0 || target >= frames.length) return;
    try { view.showFrame(frames[target].id); index = target; describe(); for (const fn of [...frameSubscribers]) fn(frames[index].id); }
    catch { status.textContent = 'Frame could not be displayed. The previous frame remains selected.'; }
    controls();
  }
  listen(file, 'change', () => { void choose(); });
  listen(previous, 'click', () => move(-1)); listen(next, 'click', () => move(1));
  listen(scale, 'input', () => {
    if (closed || blocked || busy || !view) return;
    try { const n = Number(scale.value); if (!Number.isFinite(n) || n < 0.02 || n > 0.20) throw new Error('Scale'); view.setScale(n); }
    catch { status.textContent = 'Display scale is unavailable.'; }
  });
  listen(reset, 'click', () => { if (closed || blocked || busy || !view) return; try { view.resetView(); scale.value = '0.02'; describe(); } catch { status.textContent = 'View could not be reset.'; } });
  controls();
  return { element: panel, current: () => closed || blocked || busy ? undefined : source, available: () => !closed && !blocked && !busy && !reviewLocked,
    subscribe(listener: () => void) { subscribers.add(listener); return () => { subscribers.delete(listener); }; },
    subscribeAvailability(listener: () => void) { availability.add(listener); return () => { availability.delete(listener); }; },
    subscribeFrame(listener: (id: string) => void) { frameSubscribers.add(listener); return () => { frameSubscribers.delete(listener); }; },
    setReviewLocked(value: boolean) { if (closed || reviewLocked === value) return; reviewLocked = value; controls(); for (const fn of [...availability]) fn(); },
    focusFrame(id: string) { if (closed || blocked || busy || !source || !view) return; const target = frames.findIndex(f => f.id === id); if (target < 0) throw new Error('Unknown review frame.'); view.showFrame(id); index = target; describe(); controls(); },
    replaceSaved(display: FrameViewSource, expectedSourceHash: string) {
      if (closed || blocked || busy || !source || !view || source.bundleSha256 !== expectedSourceHash || display.frames.length !== source.frames.length || display.frames.some((f, i) => f.id !== source!.frames[i].id || f.timestamp !== source!.frames[i].timestamp || f.pointCount !== source!.frames[i].pointCount)) throw new Error('Saved view source differs.');
      const frame = frames[index].id, displayScale = Number(scale.value); present(source, display, ticket, false);
      const target = frames.findIndex(f => f.id === frame); if (target >= 0) { view!.showFrame(frame); index = target; } view!.setScale(displayScale); scale.value = String(displayScale); describe(); controls();
    },
    show(parsed: BundleSource, display?: FrameViewSource) { ticket++; busy = false; present(parsed, display); },
    clear() { if (closed) return; ticket++; busy = false; const owned = view; view = undefined; source = undefined; frames = []; file.value = ''; rights.textContent = ''; status.textContent = 'No dataset loaded.'; try { owned?.dispose(); } catch { failCleanup(); throw new Error('Dataset cleanup failed.'); } notify(); controls(); },
    dispose() {
    if (closed) return; closed = true; ticket++; busy = false;
    const owned = view; view = undefined; source = undefined; file.value = ''; rights.textContent = ''; status.textContent = '';
    listeners.forEach(close => close()); subscribers.clear(); availability.clear(); frameSubscribers.clear(); panel.remove();
    owned?.dispose();
  } };
}
