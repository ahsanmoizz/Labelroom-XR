// LABELXR-LOCAL-DATASET-PANEL-v1
import { loadBundleBytes, type BundleSource, type BundleFrame } from '../data/bundle';
import type { FrameViewSource } from '../xr/frame-view';
import type {Ray} from 'three';
import type {InspectionPort,InspectionState,InspectionPreferences,DepthView} from '../xr/inspection';
import {mountInspectionControls} from './inspection-controls';

export interface DatasetView extends Partial<InspectionPort> {
  readonly frameId?:string;
  pick?(ray:Ray):{frameId:string;objectId:string;distance:number}|undefined;
  select?(frameId:string,objectId:string):void;
  showFrame(id: string): unknown;
  setScale(scale: number): void;
  resetView(): void;
  dispose(): void;
}
export interface DatasetPanelOptions {
  createView(source: BundleSource, display?: FrameViewSource): DatasetView;
  privateProjects?: boolean;
  load?: (bytes: Uint8Array, name: string) => Promise<BundleSource>;
  preserveLocal?: (source: BundleSource) => Promise<void>;
}

/** Local preview only. Source data never becomes an approval or a saved decision. */
export function mountDatasetPanel(root: HTMLElement, options: DatasetPanelOptions) {
  const doc = root.ownerDocument, panel = doc.createElement('section');
  panel.setAttribute('aria-label', 'Local dataset preview'); panel.className='dataset-panel';
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
  const rights = doc.createElement('pre'); rights.setAttribute('aria-label', 'Dataset licence and attribution');
  const controlsRow=doc.createElement('div'); controlsRow.className='dataset-controls';
  controlsRow.append(previous,next,scaleLabel,reset);
  const terms=doc.createElement('details'), summary=doc.createElement('summary'); summary.textContent='Dataset licence and attribution';
  terms.append(summary,rights);
  panel.append(title, note, fileLabel, status, controlsRow, terms); root.append(panel);
  let closed = false, blocked = false, busy = false, ticket = 0, index = 0, reviewLocked = false;
  let source: BundleSource | undefined, view: DatasetView | undefined;
  let frames: readonly BundleFrame[] = [];
  const subscribers = new Set<() => void>(), availability = new Set<() => void>(), frameSubscribers = new Set<(id: string) => void>(), viewSubscribers = new Set<() => void>();
  const viewChanged = () => { for (const listener of [...viewSubscribers]) listener(); };
  function notify() { for (const listener of [...subscribers]) { try { listener(); } catch { blocked = true; } } }
  const listeners: (() => void)[] = [];
  const inspection=mountInspectionControls(panel,()=>!closed&&!blocked&&!busy&&view?.inspection&&view.setIsolation&&view.rotateView&&view.setDepthView?view as DatasetView&InspectionPort:undefined,()=>!reviewLocked,viewChanged);
  function listen(element: HTMLElement, event: string, handler: () => void) {
    element.addEventListener(event, handler); listeners.push(() => element.removeEventListener(event, handler));
  }
  function controls() {
    file.disabled = closed || blocked || reviewLocked;
    const disabled = closed || blocked || busy || reviewLocked || !source || !view;
    previous.disabled = disabled || index === 0;
    next.disabled = disabled || !source || index >= frames.length - 1;
    scale.disabled = disabled; reset.disabled = disabled;inspection.render();
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
      let recoverable = true;
      try { await options.preserveLocal?.(parsed); } catch { recoverable = false; }
      if (closed || id !== ticket) return;
      present(parsed);
      if (!recoverable) status.textContent += ' · Browser storage is unavailable; keep the original ZIP to reopen after refresh.';
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
    try { const n = Number(scale.value); if (!Number.isFinite(n) || n < 0.02 || n > 0.20) throw new Error('Scale'); view.setScale(n); viewChanged(); }
    catch { status.textContent = 'Display scale is unavailable.'; }
  });
  listen(reset, 'click', () => { if (closed || blocked || busy || !view) return; try { view.resetView(); scale.value = '0.02'; describe();inspection.render();viewChanged(); } catch { status.textContent = 'View could not be reset.'; } });
  controls();
  return { element: panel, current: () => closed || blocked || busy ? undefined : source, available: () => !closed && !blocked && !busy && !reviewLocked,
    viewState: () => {if(!source||!frames[index])return;const state=view?.inspection?.();return{frameId:frames[index].id,scale:Number(scale.value),...(state?{objectId:state.objectId||undefined,inspection:{isolated:state.isolated,rotationDegrees:state.rotationDegrees,depthView:state.depthView}}:{})};},
    restoreView(frameId: string, displayScale: number,preferences?:InspectionPreferences,objectId?:string) {
      if (closed || blocked || busy || !source || !view || !Number.isFinite(displayScale) || displayScale < .02 || displayScale > .20) return;
      const target = frames.findIndex(frame => frame.id === frameId);
      if (target >= 0) { view.showFrame(frameId); index = target; }
      view.setScale(displayScale); scale.value = String(displayScale);if(objectId)view.select?.(frameId,objectId);if(preferences&&view.inspection&&view.setDepthView&&view.rotateView&&view.setIsolation){view.rotateView(preferences.rotationDegrees-view.inspection().rotationDegrees);view.setDepthView(preferences.depthView);view.setIsolation(preferences.isolated&&view.inspection().canIsolate);}describe(); controls();
      viewChanged();
    },
    subscribe(listener: () => void) { subscribers.add(listener); return () => { subscribers.delete(listener); }; },
    subscribeAvailability(listener: () => void) { availability.add(listener); return () => { availability.delete(listener); }; },
    subscribeFrame(listener: (id: string) => void) { frameSubscribers.add(listener); return () => { frameSubscribers.delete(listener); }; },
    subscribeView(listener: () => void) { viewSubscribers.add(listener); return () => { viewSubscribers.delete(listener); }; },
    setReviewLocked(value: boolean) { if (closed || reviewLocked === value) return; reviewLocked = value; controls(); for (const fn of [...availability]) fn(); },
    pick:(ray:Ray)=>!closed&&!blocked&&!busy?view?.pick?.(ray):undefined,
    highlight:(frameId:string,objectId:string)=>{if(!closed&&!blocked&&!busy){view?.select?.(frameId,objectId);inspection.render();}},
    inspection:():InspectionState|undefined=>!closed&&!blocked&&!busy?view?.inspection?.():undefined,
    setIsolation:(enabled:boolean)=>{if(closed||blocked||busy||reviewLocked||!view?.setIsolation)return false;view.setIsolation(enabled);inspection.render();viewChanged();return true;},
    rotateView:(delta:number)=>{if(closed||blocked||busy||reviewLocked||!view?.rotateView)return false;view.rotateView(delta);inspection.render();viewChanged();return true;},
    setDepthView:(mode:DepthView)=>{if(closed||blocked||busy||reviewLocked||!view?.setDepthView)return false;view.setDepthView(mode);inspection.render();viewChanged();return true;},
    recenter:()=>{if(!closed&&!blocked&&!busy&&view){view.resetView();scale.value='0.02';describe();inspection.render();viewChanged()}},
    focusFrame(id: string,objectId?:string) { if (closed || blocked || busy || !source || !view) return; const target = frames.findIndex(f => f.id === id); if (target < 0) throw new Error('Unknown review frame.'); if(view.frameId!==id)view.showFrame(id);if(objectId)view.select?.(id,objectId); index = target; describe(); controls(); },
    replaceSaved(display: FrameViewSource, expectedSourceHash: string) {
      if (closed || blocked || busy || !source || !view || source.bundleSha256 !== expectedSourceHash || display.frames.length !== source.frames.length || display.frames.some((f, i) => f.id !== source!.frames[i].id || f.timestamp !== source!.frames[i].timestamp || f.pointCount !== source!.frames[i].pointCount)) throw new Error('Saved view source differs.');
      const frame = frames[index].id, displayScale = Number(scale.value),state=view.inspection?.(); present(source, display, ticket, false);
      const target = frames.findIndex(f => f.id === frame); if (target >= 0) { view!.showFrame(frame); index = target; } view!.setScale(displayScale); scale.value = String(displayScale);if(state&&view!.inspection){if(state.objectId)view!.select?.(frame,state.objectId);view!.rotateView?.(state.rotationDegrees);if(state.isolated&&view!.inspection().canIsolate)view!.setIsolation?.(true);view!.setDepthView?.(state.depthView);}describe(); controls();
    },
    show(parsed: BundleSource, display?: FrameViewSource) { ticket++; busy = false; present(parsed, display); },
    clear() { if (closed) return; ticket++; busy = false; const owned = view; view = undefined; source = undefined; frames = []; file.value = ''; rights.textContent = ''; status.textContent = 'No dataset loaded.'; try { owned?.dispose(); } catch { failCleanup(); throw new Error('Dataset cleanup failed.'); } notify(); controls(); },
    dispose() {
    if (closed) return; closed = true; ticket++; busy = false;
    const owned = view; view = undefined; source = undefined; file.value = ''; rights.textContent = ''; status.textContent = '';
    inspection.dispose();listeners.forEach(close => close()); subscribers.clear(); availability.clear(); frameSubscribers.clear(); viewSubscribers.clear(); panel.remove();
    owned?.dispose();
  } };
}
