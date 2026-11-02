// LABELXR-PRIVATE-PROJECTS-PANEL-v1
import type { BundleSource } from '../data/bundle';
import { ProjectStoreError, type PrivateProject, type createProjectsService } from '../services/projects';
import type { OpenedProject } from '../app/project-preview';
export type ProjectsService = ReturnType<typeof createProjectsService>;
export interface ProjectsPanelOptions {
  service: ProjectsService;
  signal: AbortSignal;
  preview: { current(): BundleSource | undefined; available(): boolean; subscribe(listener: () => void): () => void; subscribeAvailability?(listener: () => void): () => void; show(result: OpenedProject): void; clear(): void };
  newId?: () => string;
}
/** The verified member workspace owns this panel; the service independently verifies every bearer and UID. */
export function mountPrivateProjectsPanel(root: HTMLElement, options: ProjectsPanelOptions) {
  const doc = root.ownerDocument, panel = doc.createElement('section'); panel.setAttribute('aria-label', 'Private projects'); panel.style.cssText = 'margin-top:16px;padding-top:12px;border-top:1px solid #527188';
  const heading = doc.createElement('h3'); heading.textContent = 'Private projects';
  const note = doc.createElement('p'); note.textContent = 'Keep up to three private projects. Saving uploads the original ZIP. Your local file stays unchanged.';
  const status = doc.createElement('p'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); status.textContent = 'Refresh to list your saved private projects.';
  const save = doc.createElement('button'); save.type = 'button'; save.textContent = 'Save dataset privately';
  const refresh = doc.createElement('button'); refresh.type = 'button'; refresh.textContent = 'Refresh projects';
  const controls = doc.createElement('div'); controls.style.cssText = 'display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px'; controls.append(save, refresh);
  const rows = doc.createElement('div'); panel.append(heading, note, controls, status, rows); root.append(panel);
  let closed = false, busy = false, presenting = false, generation = 0, loaded: string | undefined, armed: string | undefined;
  let pending: { id: string; hash: string } | undefined, active: AbortController | undefined, items: readonly PrivateProject[] = [];
  const pendingDeletes = new Map<string, PrivateProject>();
  const listeners: (() => void)[] = [], rowListeners: (() => void)[] = [];
  let rowButtons: HTMLButtonElement[] = [];
  const openRows = new Map<HTMLButtonElement, string>();
  function listen(element: HTMLElement, handler: () => void, bag = listeners) { element.addEventListener('click', handler); bag.push(() => element.removeEventListener('click', handler)); }
  function allowed() { return !closed && !options.signal.aborted && options.preview.available(); }
  function update() {
    save.disabled = !allowed() || busy || !options.preview.current() || !!loaded;
    refresh.disabled = !allowed() || busy;
    for (const button of rowButtons) button.disabled = !allowed() || busy || pendingDeletes.has(openRows.get(button) || '');
  }
  function render() {
    rowListeners.splice(0).forEach(close => close()); rows.replaceChildren(); rowButtons = []; openRows.clear();
    for (const project of items) {
      const row = doc.createElement('div'), label = doc.createElement('p'); row.style.cssText = 'margin-top:12px'; label.textContent = `Project ${project.id.slice(0, 8)} · revision ${project.current_revision}`;
      const open = doc.createElement('button'); open.type = 'button'; open.textContent = 'Open project'; open.setAttribute('aria-label', 'Open project ' + project.id);
      const remove = doc.createElement('button'); remove.type = 'button'; remove.textContent = armed === project.id ? 'Confirm deletion' : 'Delete project'; remove.setAttribute('aria-label', remove.textContent + ' ' + project.id);
      row.append(label, open, remove); rowButtons.push(open, remove); openRows.set(open, project.id);
      if (armed === project.id) { const warning = doc.createElement('p'); warning.textContent = 'Delete this private project and its saved versions?'; const cancel = doc.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel deletion'; row.append(warning, cancel); rowButtons.push(cancel); listen(cancel, () => { if (!allowed() || busy) return; armed = undefined; render(); }, rowListeners); }
      listen(open, () => { if (pendingDeletes.has(project.id)) return; void operation('open', async signal => { const result = await options.service.open(project.id, signal); if (result.project.id !== project.id || result.project.status !== 'ready') throw new Error('Project response differs.'); return () => { presenting = true; try { options.preview.show(result); } finally { presenting = false; } loaded = project.id; pending = undefined; status.textContent = `Opened project ${project.id.slice(0, 8)} at revision ${result.project.current_revision}.`; }; }); }, rowListeners);
      listen(remove, () => {
        if (!allowed() || busy) return;
        if (armed !== project.id) { armed = project.id; render(); return; }
        pendingDeletes.set(project.id, project);
        void operation('delete', async signal => { await options.service.remove(project.id, signal); return () => { pendingDeletes.delete(project.id); if (loaded === project.id) { presenting = true; try { options.preview.clear(); } finally { presenting = false; } loaded = undefined; pending = undefined; } items = items.filter(item => item.id !== project.id); armed = undefined; status.textContent = 'Private project deleted.'; render(); }; });
      }, rowListeners); rows.append(row);
    }
    update();
  }
  function failure(error: unknown, kind: string) {
    if (error instanceof ProjectStoreError && error.code === 'AUTH') return 'Sign in again before using private projects.';
    if (error instanceof ProjectStoreError && error.code === 'QUOTA') return 'Your three-project limit has been reached. Delete a project before saving another.';
    if (kind === 'save') return 'Save not confirmed. Retry this dataset with Save dataset privately. Refresh projects to check your account.';
    if (kind === 'delete') return 'Deletion not confirmed. Refresh projects and retry.';
    return 'Private projects are unavailable. Refresh to retry. Your local preview remains available.';
  }
  async function operation(kind: string, work: (signal: AbortSignal) => Promise<() => void>) {
    if (!allowed() || busy) return; busy = true; const at = generation, controller = new AbortController(); active = controller;
    status.textContent = kind === 'save' ? 'Saving private project…' : kind === 'open' ? 'Opening private project…' : kind === 'delete' ? 'Deleting private project…' : 'Loading private projects…'; update();
    try { const apply = await work(controller.signal); if (closed || options.signal.aborted || controller.signal.aborted || at !== generation) return; apply(); }
    catch (error) { if (!closed && !options.signal.aborted && !controller.signal.aborted && at === generation) status.textContent = failure(error, kind); }
    finally { if (!closed && active === controller) { active = undefined; busy = false; update(); } }
  }
  listen(refresh, () => { void operation('list', async signal => { const result = await options.service.list(signal); return () => { items = [...result.filter(item => !pendingDeletes.has(item.id)), ...pendingDeletes.values()]; armed = undefined; status.textContent = pendingDeletes.size ? 'Some deletions need confirmation. Use Delete project to retry them.' : result.length ? `${result.length} of 3 private projects.` : 'No saved private projects.'; render(); }; }); });
  listen(save, () => {
    if (!allowed() || busy || loaded) return; const source = options.preview.current(); if (!source) return;
    try { if (!pending || pending.hash !== source.bundleSha256) pending = { hash: source.bundleSha256, id: (options.newId || (() => crypto.randomUUID()))() }; }
    catch { status.textContent = 'Private saving is unavailable. Reload and retry.'; return; }
    const id = pending.id;
    void operation('save', async signal => { const bytes = source.getOriginalZipBytes(), result = await options.service.create(bytes, id, signal); if (result.id !== id || result.status !== 'ready' || result.source_hash !== source.bundleSha256 || result.source_bytes !== bytes.length) throw new Error('Save response differs.'); return () => { loaded = result.id; items = [result, ...items.filter(item => item.id !== result.id)]; status.textContent = `Saved project ${result.id.slice(0, 8)} privately.`; render(); }; });
  });
  const unsubscribe = options.preview.subscribe(() => { if (closed || presenting) return; generation++; active?.abort(); loaded = undefined; armed = undefined; const source = options.preview.current(); if (source && pending?.hash !== source.bundleSha256) pending = undefined; if (busy) status.textContent = 'Dataset changed. Private operation cancelled. Refresh projects to check any pending result.'; update(); });
  const unsubscribeAvailability = options.preview.subscribeAvailability?.(update);
  function dispose() { if (closed) return; closed = true; generation++; active?.abort(); active = undefined; unsubscribe(); unsubscribeAvailability?.(); options.signal.removeEventListener('abort', dispose); listeners.splice(0).forEach(close => close()); rowListeners.splice(0).forEach(close => close()); items = []; pendingDeletes.clear(); pending = undefined; loaded = undefined; armed = undefined; rows.replaceChildren(); panel.remove(); }
  options.signal.addEventListener('abort', dispose, { once: true }); if (options.signal.aborted) dispose(); else update();
  return { dispose };
}
