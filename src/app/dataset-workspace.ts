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

export interface OwnedReviewWorkspace extends WorkspaceResource {
  selectFrame?(id: string): void;
  spatial?: SpatialReviewPort;
  store?: { snapshot(): ReviewSnapshot | undefined };
}
export interface ReviewPresentation {
  present(snapshot: ReviewSnapshot): void;
  preview(snapshot: ReviewSnapshot, command: ReviewCommand | null): void;
  focus(frameId: string, objectId: string): void;
  phase(phase: ReviewPhase): void;
}

type DatasetWorld = SceneResource & Pick<World, 'createTransformEntity'>;
type WorldFactory = (container: HTMLElement) => Promise<DatasetWorld>;
interface WorkspaceAdapters {
  createView?: (world: DatasetWorld, source: FrameViewSource) => DatasetView;
  projects?: (context: WorkspaceContext) => ProjectsService | Promise<ProjectsService>;
  review?: (root: HTMLElement, signal: AbortSignal, context: WorkspaceContext, project: OpenedProject, presentation: ReviewPresentation) => OwnedReviewWorkspace | Promise<OwnedReviewWorkspace>;
  load?: (bytes: Uint8Array, name: string) => Promise<BundleSource>;
}

/** The account host owns this resource and retires the local dataset before its world. */
export function createDatasetWorkspace(load: () => Promise<WorldFactory>, adapters: WorkspaceAdapters = {}) {
  return async (container: HTMLElement, signal: AbortSignal, context?: WorkspaceContext): Promise<WorkspaceResource> => {
    if (signal.aborted) throw new Error('Workspace opening was cancelled.');
    const doc = container.ownerDocument, scene = doc.createElement('div'), overlay = doc.createElement('div');
    scene.style.cssText = 'width:100%;height:100%';
    overlay.style.cssText = 'position:absolute;inset:0;pointer-events:none';
    container.style.position = 'relative'; container.append(scene, overlay);
    let closed = false, cleanupFailed = false;
    let worldOwner: WorkspaceResource | undefined, panel: ReturnType<typeof mountDatasetPanel> | undefined;
    let projects: ReturnType<typeof mountPrivateProjectsPanel> | undefined;
    let spatial: WorkspaceResource | undefined;
    let review: OwnedReviewWorkspace | undefined, reviewController: AbortController | undefined;
    let reviewClose: HTMLButtonElement | undefined, reviewNotice: HTMLElement | undefined;
    let reviewEpoch = 0, presenting = false, unsubscribeDataset: (() => void) | undefined, unsubscribeFrame: (() => void) | undefined;
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
      for (const close of [() => { unsubscribeDataset?.(); unsubscribeFrame?.(); closeReview(); }, () => privateProjects?.dispose(), () => p?.dispose(), () => w?.dispose(), () => overlay.remove(), () => scene.remove()]) {
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
      panel = mountDatasetPanel(overlay, { createView: (source, display) => (adapters.createView || createReviewView)(world, display || source), load: adapters.load, privateProjects: context?.user.kind === 'member' && !!adapters.projects });
      if (context?.user.kind === 'member' && adapters.projects) {
        const service = await adapters.projects(context);
        if (closed || signal.aborted) throw new Error('Workspace opening was cancelled.');
        const preview = panel;
        function startReview(result: OpenedProject) {
          closeReview();
          if (!adapters.review || !context || closed || signal.aborted) return;
          const token = ++reviewEpoch, controller = new AbortController(); reviewController = controller;
          const active = () => !closed && !signal.aborted && !controller.signal.aborted && token === reviewEpoch;
          const close = doc.createElement('button'), notice = doc.createElement('p'); close.type = 'button'; close.textContent = 'Close review'; notice.setAttribute('role', 'status'); notice.textContent = 'Opening saved review…';
          reviewClose = close; reviewNotice = notice; preview.element.append(close, notice); preview.setReviewLocked(true);
          close.addEventListener('click', () => { if (!active()) return; try { closeReview(true); } catch { cleanupFailed = true; } });
          const presentation: ReviewPresentation = {
            present(snapshot) { if (active()) preview.replaceSaved(reviewFrameSource(snapshot), result.original.bundleSha256); },
            preview(snapshot, command) { if (active()) preview.replaceSaved(command ? reviewProposalFrameSource(snapshot, command) : reviewFrameSource(snapshot), result.original.bundleSha256); },
            focus(frameId,objectId) { if (active()) preview.focusFrame(frameId,objectId); },
            phase(phase) { if (active()) preview.setReviewLocked(phase !== 'ready'); }
          };
          void Promise.resolve().then(() => adapters.review!(preview.element, controller.signal, context, result, presentation)).then(opened => {
            if (!active()) { try { opened.dispose(); } catch { cleanupFailed = true; } return; }
            review = opened; if(opened.spatial)spatial=mountSpatialReview(world,opened.spatial,preview,doc,controller.signal); notice.remove(); reviewNotice = undefined;
          }).catch(() => { if (active()) { preview.setReviewLocked(false); notice.textContent = 'Review controls are unavailable. Close review, then reopen the project to retry.'; } });
        }
        projects = mountPrivateProjectsPanel(preview.element, { service, signal, preview: {
          current: preview.current, available: preview.available, subscribe: preview.subscribe, subscribeAvailability: preview.subscribeAvailability,
          clear() { closeReview(); preview.clear(); },
          show(result) { presenting = true; try { closeReview(); preview.show(result.original, projectPreview(result)); startReview(result); } finally { presenting = false; } }
        } });
        unsubscribeDataset = preview.subscribe(() => { if (!presenting) closeReview(); });
        unsubscribeFrame = preview.subscribeFrame(id => review?.selectFrame?.(id));
      }
      return { dispose };
    } catch (error) {
      try { dispose(); } catch { throw new WorkspaceCleanupError(); }
      throw error;
    }
  };
}
