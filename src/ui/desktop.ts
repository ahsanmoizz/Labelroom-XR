// LABELXR-LOCAL-DATASET-PANEL-v1
import { loadBundleBytes, type BundleSource } from '../data/bundle';

export interface DatasetView {
  showFrame(id: string): unknown;
  setScale(scale: number): void;
  resetView(): void;
  dispose(): void;
}
export interface DatasetPanelOptions {
  createView(source: BundleSource): DatasetView;
  load?: (bytes: Uint8Array, name: string) => Promise<BundleSource>;
}

/** Local preview only. Source data never becomes an approval or a saved decision. */
export function mountDatasetPanel(root: HTMLElement, options: DatasetPanelOptions) {
  const doc = root.ownerDocument, panel = doc.createElement('section');
  panel.setAttribute('aria-label', 'Local dataset preview');
  panel.style.cssText = 'position:absolute;top:1rem;left:1rem;max-width:min(26rem,calc(100% - 2rem));max-height:70%;overflow:auto;padding:1rem;background:#10212eee;color:#edf7ff;border:1px solid #527188;border-radius:12px;pointer-events:auto;font:14px system-ui;z-index:2';
  const title = doc.createElement('h2'); title.textContent = 'Local dataset preview';
  const note = doc.createElement('p'); note.textContent = 'Open a LabelRoom ZIP, up to 25 MiB. Source units are metres. This preview does not save reviews or upload data.';
  const fileLabel = doc.createElement('label'); fileLabel.textContent = 'Choose dataset ZIP ';
  const file = doc.createElement('input'); file.type = 'file'; file.accept = '.zip'; file.setAttribute('aria-label', 'Choose dataset ZIP'); fileLabel.append(file);
  const status = doc.createElement('p'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); status.textContent = 'No dataset loaded.';
  const previous = doc.createElement('button'); previous.type = 'button'; previous.textContent = 'Previous frame';
  const next = doc.createElement('button'); next.type = 'button'; next.textContent = 'Next frame';
  const scaleLabel = doc.createElement('label'); scaleLabel.textContent = ' Display scale ';
  const scale = doc.createElement('input'); scale.type = 'range'; scale.min = '0.02'; scale.max = '0.20'; scale.step = '0.01'; scale.value = '0.02'; scale.setAttribute('aria-label', 'Display scale'); scaleLabel.append(scale);
  const reset = doc.createElement('button'); reset.type = 'button'; reset.textContent = 'Reset view';
  const rights = doc.createElement('pre'); rights.setAttribute('aria-label', 'Dataset licence and attribution'); rights.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;font:12px system-ui';
  panel.append(title, note, fileLabel, status, previous, next, scaleLabel, reset, rights); root.append(panel);
  let closed = false, blocked = false, busy = false, ticket = 0, index = 0;
  let source: BundleSource | undefined, view: DatasetView | undefined;
  const listeners: (() => void)[] = [];
  function listen(element: HTMLElement, event: string, handler: () => void) {
    element.addEventListener(event, handler); listeners.push(() => element.removeEventListener(event, handler));
  }
  function controls() {
    file.disabled = closed || blocked;
    const disabled = closed || blocked || busy || !source || !view;
    previous.disabled = disabled || index === 0;
    next.disabled = disabled || !source || index >= source.frames.length - 1;
    scale.disabled = disabled; reset.disabled = disabled;
  }
  function describe() {
    if (!source) return;
    const f = source.frames[index];
    status.textContent = `Frame ${index + 1} / ${source.frames.length} (${f.id}) · ${f.pointCount} points · ${f.boxes.length} boxes`;
  }
  function failCleanup() { blocked = true; status.textContent = 'Dataset cleanup failed. Sign out and reload before continuing.'; controls(); }
  async function choose() {
    if (closed || blocked) return;
    const id = ++ticket, selected = Array.from(file.files || []); file.value = '';
    busy = false;
    if (selected.length === 0) { controls(); return; }
    const input = selected[0];
    if (selected.length !== 1 || !/\.zip$/i.test(input.name) || !Number.isSafeInteger(input.size) || input.size < 1 || input.size > 25 * 1024 * 1024) {
      status.textContent = 'Choose one ZIP between 1 byte and 25 MiB.'; controls(); return;
    }
    busy = true; status.textContent = 'Checking local dataset…'; controls();
    let replacement: DatasetView | undefined;
    try {
      const bytes = await input.arrayBuffer();
      if (closed || id !== ticket) return;
      if (bytes.byteLength !== input.size) throw new Error('File size changed.');
      const parsed = await (options.load || loadBundleBytes)(new Uint8Array(bytes), input.name);
      if (closed || id !== ticket) return;
      replacement = options.createView(parsed);
      if (closed || id !== ticket) { const stale = replacement; replacement = undefined; stale.dispose(); return; }
      const old = view; view = undefined;
      try { old?.dispose(); } catch { try { replacement.dispose(); } catch { /* Attempt every owned close. */ } replacement = undefined; source = undefined; rights.textContent = ''; failCleanup(); return; }
      view = replacement; replacement = undefined; source = parsed; index = 0; scale.value = '0.02';
      rights.textContent = parsed.licenceText + '\n\n' + parsed.attributionText; describe();
    } catch {
      if (replacement) { try { replacement.dispose(); } catch { if (!closed) failCleanup(); } }
      if (!closed && id === ticket && !blocked) status.textContent = 'Dataset could not be opened. Check the ZIP and try again.';
    } finally { if (!closed && id === ticket) { busy = false; controls(); } }
  }
  function move(delta: number) {
    if (closed || blocked || busy || !source || !view) return;
    const target = index + delta; if (target < 0 || target >= source.frames.length) return;
    try { view.showFrame(source.frames[target].id); index = target; describe(); }
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
  return { dispose() {
    if (closed) return; closed = true; ticket++; busy = false;
    const owned = view; view = undefined; source = undefined; file.value = ''; rights.textContent = ''; status.textContent = '';
    listeners.forEach(close => close()); panel.remove();
    owned?.dispose();
  } };
}
