// LABELXR-LOCAL-DATASET-WORKSPACE-v1
import type { World } from '@iwsdk/core';
import type { BundleSource } from '../data/bundle';
import { createReviewView } from '../xr/review-system';
import { mountDatasetPanel, type DatasetView } from '../ui/desktop';
import { ownScene, type SceneResource } from '../services/scene';
import { WorkspaceCleanupError, type WorkspaceResource, type WorkspaceContext } from './host';
import type { FrameViewSource } from '../xr/frame-view';
import type { ProjectsService } from '../ui/projects';
import { mountPrivateProjectsPanel } from '../ui/projects';
import { projectPreview, type OpenedProject } from './project-preview';
import { reviewFrameSource, reviewProposalFrameSource } from './review-workspace';
import type { ReviewSnapshot } from '../domain/review-snapshot';
import type { ReviewCommand } from '../domain/revision';
import type { ReviewPhase } from './store';
import type {SpatialReviewPort} from '../ui/spatial-review-port';
import {mountSpatialReview} from '../xr/spatial-review';
import { mountWorkspaceTools } from '../ui/workspace-tools';
import { mountXrEntry } from '../ui/xr-entry';
import { mountWorkspaceShell } from '../ui/workspace-shell';
import { createWorkspaceCache, type WorkspaceCache, type WorkspaceBookmark } from '../data/workspace-cache';
import { loadBundleBytes } from '../data/bundle';

export interface OwnedReviewWorkspace extends WorkspaceResource {
  selectFrame?(id: string): void;
  selectObject?(frameId: string, objectId?: string): void;
  spatial?: SpatialReviewPort;
  store?: { snapshot(): ReviewSnapshot | undefined };
}
export interface ReviewPresentation {
  present(snapshot: ReviewSnapshot): void;
  preview(snapshot: ReviewSnapshot, command: ReviewCommand | null): void;
  focus(frameId: string, objectId: string): void;
  phase(phase: ReviewPhase): void;
}

type DatasetWorld = SceneResource & Pick<World, 'createTransformEntity'> & Partial<Pick<World, 'launchXR' | 'xrSession' | 'sessionRequestPending'>>;
type WorldFactory = (container: HTMLElement) => Promise<DatasetWorld>;
interface WorkspaceAdapters {
  createView?: (world: DatasetWorld, source: FrameViewSource) => DatasetView;
  guestDemo?: (context: WorkspaceContext, signal: AbortSignal) => Promise<OpenedProject>;
  resetGuestDemo?: (context: WorkspaceContext, projectId:string|undefined, signal: AbortSignal) => Promise<OpenedProject>;
  projects?: (context: WorkspaceContext) => ProjectsService | Promise<ProjectsService>;
  review?: (root: HTMLElement, signal: AbortSignal, context: WorkspaceContext, project: OpenedProject, presentation: ReviewPresentation) => OwnedReviewWorkspace | Promise<OwnedReviewWorkspace>;
  load?: (bytes: Uint8Array, name: string) => Promise<BundleSource>;
  workspaceCache?: (context: WorkspaceContext) => WorkspaceCache;
}

/** The account host owns this resource and retires the local dataset before its world. */
export function createDatasetWorkspace(load: () => Promise<WorldFactory>, adapters: WorkspaceAdapters = {}) {
  return async (container: HTMLElement, signal: AbortSignal, context?: WorkspaceContext): Promise<WorkspaceResource> => {
    if (signal.aborted) throw new Error('Workspace opening was cancelled.');
    const doc = container.ownerDocument, scene = doc.createElement('div'), overlay = doc.createElement('div');
    scene.className = 'workspace-scene';
    overlay.className = 'workspace-overlay';
    container.style.position = 'relative'; container.append(scene, overlay);
    let closed = false, cleanupFailed = false;
    let worldOwner: WorkspaceResource | undefined, panel: ReturnType<typeof mountDatasetPanel> | undefined;
    let projects: ReturnType<typeof mountPrivateProjectsPanel> | undefined;
    let menus: ReturnType<typeof mountWorkspaceTools> | undefined;
    let xrEntry: ReturnType<typeof mountXrEntry> | undefined;
    let shell: ReturnType<typeof mountWorkspaceShell>;
    let spatial: WorkspaceResource | undefined;
    let review: OwnedReviewWorkspace | undefined, reviewController: AbortController | undefined;
    let reviewClose: HTMLButtonElement | undefined, reviewNotice: HTMLElement | undefined;
    let reviewEpoch = 0, presenting = false, unsubscribeDataset: (() => void) | undefined, unsubscribeFrame: (() => void) | undefined, unsubscribeView: (() => void) | undefined;
    let cache: WorkspaceCache | undefined, bookmark: WorkspaceBookmark | undefined, restoring = false, localHash: string | undefined, rememberedSource: BundleSource | undefined;
    let pendingSelection: WorkspaceBookmark | undefined;
    const resumeStatus = doc.createElement('p'); resumeStatus.setAttribute('role', 'status'); resumeStatus.setAttribute('aria-label', 'Workspace recovery');
    const retryResume = doc.createElement('button'); retryResume.type = 'button'; retryResume.textContent = 'Retry reopening workspace'; retryResume.hidden = true;
    const closeDataset = doc.createElement('button'); closeDataset.type = 'button'; closeDataset.textContent = 'Close dataset'; closeDataset.disabled = true;
    const remember = () => {
      if (!cache || !bookmark || restoring || pendingSelection || closed) return;
      const view = panel?.viewState(); if (view) bookmark = { ...bookmark, ...view };
      try { cache.write(bookmark); resumeStatus.textContent = 'This workspace reopens after refresh. Saved revisions stay on the server; typed drafts stay on this device.'; }
      catch { resumeStatus.textContent = 'Browser storage is unavailable. Export saved work and keep the source ZIP before leaving this page.'; }
    };
    if (context) try {
      cache = adapters.workspaceCache?.(context) ?? (doc.defaultView ? createWorkspaceCache({backend: context.config.supabaseUrl, ownerId: context.user.id, kind: context.user.kind}, doc.defaultView.localStorage, doc.defaultView.indexedDB) : undefined);
    } catch { resumeStatus.textContent = 'Browser storage is unavailable. Export saved work before leaving this page.'; }
    function closeReview(restore = false) {
      const snapshot = review?.store?.snapshot(); reviewEpoch++;
      const sp=spatial,owned=review,controller=reviewController;spatial=undefined;review=undefined;reviewController=undefined;
      let failed=false;
      for(const close of [()=>sp?.dispose(),()=>controller?.abort(),()=>owned?.dispose(),()=>{reviewClose?.remove();reviewNotice?.remove();reviewClose=undefined;reviewNotice=undefined},()=>{if(restore&&snapshot&&panel?.current()?.bundleSha256===snapshot.sourceBundleSha256)panel.replaceSaved(reviewFrameSource(snapshot),snapshot.sourceBundleSha256)},()=>panel?.setReviewLocked(false)])try{close()}catch{failed=true}
      if(failed)throw new WorkspaceCleanupError();
    }

    function dispose() {
      if (closed) { if (cleanupFailed) throw new WorkspaceCleanupError(); return; }
      closed = true; signal.removeEventListener('abort', onAbort);
      const p = panel, w = worldOwner, privateProjects = projects; panel = undefined; worldOwner = undefined; projects = undefined;
      for (const close of [() => shell?.dispose(), () => xrEntry?.dispose(), () => menus?.dispose(), () => { unsubscribeDataset?.(); unsubscribeFrame?.(); unsubscribeView?.(); closeReview(); }, () => privateProjects?.dispose(), () => p?.dispose(), () => w?.dispose(), () => overlay.remove(), () => scene.remove()]) {
        try { close(); } catch { cleanupFailed = true; }
      }
      if (cleanupFailed) throw new WorkspaceCleanupError();
    }
    // Abort dispatch cannot surface a thrown listener error; the owner's dispose call carries it.
    function onAbort() { try { dispose(); } catch { cleanupFailed = true; } }
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const create = await load();
      if (closed || signal.aborted) throw new Error('Workspace opening was cancelled.');
      const world = await create(scene), owned = ownScene(world);
      if (closed || signal.aborted) { try { owned.dispose(); } catch { cleanupFailed = true; } if (cleanupFailed) throw new WorkspaceCleanupError(); throw new Error('Workspace opening was cancelled.'); }
      worldOwner = owned;
      panel = mountDatasetPanel(overlay, { createView: (source, display) => (adapters.createView || createReviewView)(world, display || source), load: adapters.load, privateProjects: context?.user.kind === 'member' && !!adapters.projects,
        preserveLocal: cache ? async source => { await cache!.saveLocal(source.getOriginalZipBytes()); localHash = source.bundleSha256; } : undefined });
      panel.element.append(resumeStatus, retryResume, closeDataset);
      menus = mountWorkspaceTools(overlay, panel.element, doc.getElementById?.('account-container') || undefined, context?.user.kind === 'guest');
      const preview = panel;
      if (context && typeof world.launchXR === 'function') xrEntry = mountXrEntry(menus.element, world as Parameters<typeof mountXrEntry>[1], signal, () => !!preview.current());
      shell = mountWorkspaceShell({container, scene, overlay, panel: preview.element, toolbar: menus.element,
        account: doc.getElementById?.('account-container') || undefined, guest: context?.user.kind === 'guest',
        source: preview.current, snapshot: () => review?.store?.snapshot(), world: world as unknown as Parameters<typeof mountWorkspaceShell>[0]['world']});
      function startReview(result: OpenedProject, restore?: WorkspaceBookmark) {
        closeReview();
        if (!adapters.review || !context || closed || signal.aborted) return;
        const token = ++reviewEpoch, controller = new AbortController(); reviewController = controller;
        pendingSelection = restore;
        const active = () => !closed && !signal.aborted && !controller.signal.aborted && token === reviewEpoch;
        const close = doc.createElement('button'), notice = doc.createElement('p'); close.type = 'button'; close.textContent = 'Close review'; notice.setAttribute('role', 'status'); notice.textContent = 'Opening saved review…';
        reviewClose = close; reviewNotice = notice; preview.element.append(close, notice); preview.setReviewLocked(true);
        close.addEventListener('click', () => { if (!active()) return; try { closeReview(true); pendingSelection = undefined; if(bookmark)bookmark = {...bookmark,reviewOpen:false}; remember(); } catch { cleanupFailed = true; } });
        function restoreSelection() {
          if (!active() || !pendingSelection || !review?.store?.snapshot()) return;
          const selected = pendingSelection;
          queueMicrotask(() => {
            if (!active() || pendingSelection !== selected) return;
            pendingSelection = undefined;
            review?.selectObject?.(selected.frameId, selected.objectId);
            preview.restoreView(selected.frameId, selected.scale,selected.inspection,selected.objectId);
            if (bookmark) bookmark = { ...bookmark, frameId: selected.frameId, objectId: selected.objectId, scale: selected.scale };
            remember();
          });
        }
        const presentation: ReviewPresentation = {
          present(snapshot) { if (active()) { preview.replaceSaved(reviewFrameSource(snapshot), result.original.bundleSha256); restoreSelection(); } },
          preview(snapshot, command) { if (active()) preview.replaceSaved(command ? reviewProposalFrameSource(snapshot, command) : reviewFrameSource(snapshot), result.original.bundleSha256); },
          focus(frameId,objectId) { if (active()) { preview.focusFrame(frameId,objectId); if(bookmark&&!pendingSelection){bookmark={...bookmark,frameId,objectId};remember();} } },
          phase(phase) { if (active()) { preview.setReviewLocked(phase !== 'ready'); closeDataset.disabled = phase !== 'ready'; } }
        };
        void Promise.resolve().then(() => adapters.review!(preview.element, controller.signal, context, result, presentation)).then(opened => {
          if (!active()) { try { opened.dispose(); } catch { cleanupFailed = true; } return; }
          review = opened; if(opened.spatial)spatial=mountSpatialReview(world,opened.spatial,preview,doc,controller.signal); notice.remove(); reviewNotice = undefined; restoreSelection();
        }).catch(() => { if (active()) { preview.setReviewLocked(false); notice.textContent = 'Review controls are unavailable. Close review, then reopen the project to retry.'; } });
      }
      unsubscribeDataset = preview.subscribe(() => {
        xrEntry?.refresh();
        if (!presenting) {
          closeReview(); pendingSelection = undefined;
          const source = preview.current();
          if (source && source !== rememberedSource) { rememberedSource=source;bookmark = {schema:'labelxr-open-workspace/v1',kind:'local',sourceHash:source.bundleSha256,reviewOpen:false,frameId:source.frames[0].id,scale:.02}; if(cache&&localHash!==source.bundleSha256){try{cache.clear()}catch{};resumeStatus.textContent='Local preview could not be preserved. Keep its original ZIP before refreshing.';}else remember(); }
          else if(source&&bookmark){bookmark={...bookmark,reviewOpen:false};remember();}
        }
        closeDataset.disabled = !preview.current();
      });
      unsubscribeFrame = preview.subscribeFrame(id => { review?.selectFrame?.(id); if(bookmark)bookmark={...bookmark,frameId:id,objectId:undefined}; remember(); });
      unsubscribeView = preview.subscribeView(remember);
      closeDataset.addEventListener('click', () => { if (closed || restoring || closeDataset.disabled) return; closeReview(); pendingSelection=undefined;bookmark=undefined;try{cache?.clear()}catch{};preview.clear();resumeStatus.textContent='Dataset closed. Saved server revisions and typed recovery drafts are retained.';retryResume.hidden=true; });
      function showSaved(result: OpenedProject, restore?: WorkspaceBookmark) {
        rememberedSource=result.original;
        bookmark = {schema:'labelxr-open-workspace/v1',kind:'saved',sourceHash:result.original.bundleSha256,projectId:result.project.id,reviewOpen:restore?.reviewOpen??true,frameId:restore?.frameId??result.original.frames[0].id,objectId:restore?.objectId,scale:restore?.scale??.02,inspection:restore?.inspection};
        presenting=true;
        try { closeReview(); preview.show(result.original,projectPreview(result)); if(bookmark.reviewOpen)startReview(result,restore); else preview.restoreView(bookmark.frameId,bookmark.scale,bookmark.inspection,bookmark.objectId); }
        finally { presenting=false; }
        if (restore && context?.user.kind==='member') projects?.reopened(result.project);
        closeDataset.disabled=false; remember();
      }
      let savedProjects: Promise<ProjectsService> | undefined;
      const projectsService = () => savedProjects ??= Promise.resolve(adapters.projects!(context!));
      let guestProjectId:string|undefined;
      const openGuestDemo = adapters.guestDemo;
      if (context?.user.kind === 'guest' && openGuestDemo) {
        const preview = panel, guest = context;
        const section = doc.createElement('section'), title = doc.createElement('h3');
        const open = doc.createElement('button'), status = doc.createElement('p');
        const reset=doc.createElement('button'),confirmReset=doc.createElement('button'),cancelReset=doc.createElement('button');
        reset.type=confirmReset.type=cancelReset.type='button';reset.textContent='Reset demo';confirmReset.textContent='Confirm reset and discard demo edits';cancelReset.textContent='Keep my demo';
        reset.hidden=!adapters.resetGuestDemo;confirmReset.hidden=cancelReset.hidden=true;
        title.textContent = 'Private guest demo';
        const disclosure=doc.createElement('p');disclosure.textContent='Real licensed PandaSet points with three deliberately altered labels for this demo. Review suggestions are uncertain; every edit needs your approval.';
        open.type = 'button'; open.textContent = 'Open PandaSet demo';
        status.setAttribute('role', 'status');
        status.textContent = 'Open the sample for this guest session. Access expires after 24 hours.';
        const actions=doc.createElement('div');actions.className='action-grid guest-demo-actions';
        open.className='button-primary';reset.className=confirmReset.className='button-caution';
        actions.append(open,reset,confirmReset,cancelReset);
        section.append(title, disclosure, actions, status); preview.element.append(section);
        reset.addEventListener('click',()=>{if(!reset.disabled){confirmReset.hidden=cancelReset.hidden=false;status.textContent='Reset deletes this demo and its saved decisions, then opens a fresh sample. Export first if you want to keep your work.';}});
        cancelReset.addEventListener('click',()=>{confirmReset.hidden=cancelReset.hidden=true;status.textContent='Your demo is unchanged.';});
        async function showDemo(resetting=false) {
          if (!openGuestDemo || closed || signal.aborted || open.disabled || restoring) return;
          open.disabled = reset.disabled = true;confirmReset.hidden=cancelReset.hidden=true;
          closeReview();
          if(resetting){bookmark=undefined;pendingSelection=undefined;try{cache?.clear()}catch{};preview.clear();}
          preview.setReviewLocked(true);
          status.textContent = resetting?'Resetting your demo…':'Opening private demo…';
          try {
            const result = resetting&&adapters.resetGuestDemo?await adapters.resetGuestDemo(guest,guestProjectId,signal):await openGuestDemo(guest, signal);
            if (closed || signal.aborted) return;
            showSaved(result);
            guestProjectId=result.project.id;
            status.textContent = 'Private demo loaded at revision ' + result.project.current_revision + '.';
          } catch {
            if (!closed && !signal.aborted) status.textContent = resetting?'Reset did not finish. Open the demo first if it is still active, or retry Reset demo after an interrupted reset.':'The private demo could not be opened. Retry, or use Reset demo if its 24-hour access expired.';
          } finally {
            if (!closed && !signal.aborted) { if(!reviewController)preview.setReviewLocked(false); open.disabled = reset.disabled = false; }
          }
        }
        open.addEventListener('click', () => { void showDemo(); });
        confirmReset.addEventListener('click',()=>{if(!open.disabled)void showDemo(true);});
      }
      if (context?.user.kind === 'member' && adapters.projects) {
        const service = await projectsService();
        if (closed || signal.aborted) throw new Error('Workspace opening was cancelled.');
        const preview = panel;
        projects = mountPrivateProjectsPanel(preview.element, { service, signal, preview: {
          current: preview.current, available: preview.available, subscribe: preview.subscribe, subscribeAvailability: preview.subscribeAvailability,
          clear() { closeReview(); pendingSelection=undefined;bookmark=undefined;cache?.clear();preview.clear(); },
          show(result) { showSaved(result); }
        } });
      }
      async function resumeWorkspace() {
        if (!cache || restoring || closed || signal.aborted) return;
        let stored: WorkspaceBookmark | undefined;
        try { stored=cache.read(); } catch { resumeStatus.textContent='The workspace bookmark could not be read. Open the saved project normally; server revisions and recovery drafts are unchanged.'; return; }
        if (!stored) return;
        restoring=true; retryResume.hidden=true; closeDataset.disabled=true; preview.setReviewLocked(true);
        resumeStatus.textContent='Reopening your previous workspace from its verified source…';
        try {
          if (stored.kind==='saved') {
            if(!context||!adapters.projects||!stored.projectId)throw Error('Saved workspace is unavailable.');
            const result=await (await projectsService()).open(stored.projectId,signal);
            if(closed||signal.aborted)return;
            if(result.project.owner_id!==context.user.id||result.original.bundleSha256!==stored.sourceHash)throw Error('Saved source changed.');
            guestProjectId=context.user.kind==='guest'?result.project.id:undefined;
            showSaved(result,stored);
          } else {
            const bytes=await cache.loadLocal();
            const source=await (adapters.load||loadBundleBytes)(bytes,'restored-preview.zip');
            if(closed||signal.aborted)return;
            if(source.bundleSha256!==stored.sourceHash)throw Error('Local source changed.');
            localHash=source.bundleSha256;presenting=true;
            try{bookmark=stored;rememberedSource=source;preview.show(source);preview.restoreView(stored.frameId,stored.scale,stored.inspection,stored.objectId);}finally{presenting=false;}
          }
          resumeStatus.textContent='Previous workspace reopened. Saved revisions and local typed recovery are preserved.';
        } catch {
          if(!closed&&!signal.aborted){resumeStatus.textContent='The previous workspace could not be reopened. Check your connection and retry. No demo was created or reset, and no saved decision was changed. Expired guest access cannot be extended by refresh.';retryResume.hidden=false;}
        } finally { restoring=false; if(!closed&&!signal.aborted){if(!reviewController)preview.setReviewLocked(false);closeDataset.disabled=!preview.current();} }
      }
      retryResume.addEventListener('click',()=>{void resumeWorkspace()});
      void resumeWorkspace();
      return { dispose, forget() { bookmark=undefined;pendingSelection=undefined;cache?.clear(); } };
    } catch (error) {
      try { dispose(); } catch { throw new WorkspaceCleanupError(); }
      throw error;
    }
  };
}
