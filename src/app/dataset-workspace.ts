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
import { projectPreview } from './project-preview';

type DatasetWorld = SceneResource & Pick<World, 'createTransformEntity'>;
type WorldFactory = (container: HTMLElement) => Promise<DatasetWorld>;
interface WorkspaceAdapters {
  createView?: (world: DatasetWorld, source: FrameViewSource) => DatasetView;
  projects?: (context: WorkspaceContext) => ProjectsService | Promise<ProjectsService>;
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
    function dispose() {
      if (closed) { if (cleanupFailed) throw new WorkspaceCleanupError(); return; }
      closed = true; signal.removeEventListener('abort', onAbort);
      const p = panel, w = worldOwner, privateProjects = projects; panel = undefined; worldOwner = undefined; projects = undefined;
      for (const close of [() => privateProjects?.dispose(), () => p?.dispose(), () => w?.dispose(), () => overlay.remove(), () => scene.remove()]) {
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
        projects = mountPrivateProjectsPanel(preview.element, { service, signal, preview: {
          current: preview.current, available: preview.available, subscribe: preview.subscribe, clear: preview.clear,
          show(result) { preview.show(result.original, projectPreview(result)); }
        } });
      }
      return { dispose };
    } catch (error) {
      try { dispose(); } catch { throw new WorkspaceCleanupError(); }
      throw error;
    }
  };
}
