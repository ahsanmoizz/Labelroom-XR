// LABELXR-LOCAL-DATASET-WORKSPACE-v1
import type { World } from '@iwsdk/core';
import type { BundleSource } from '../data/bundle';
import { createReviewView } from '../xr/review-system';
import { mountDatasetPanel, type DatasetView } from '../ui/desktop';
import { ownScene, type SceneResource } from '../services/scene';
import { WorkspaceCleanupError, type WorkspaceResource } from './host';

type DatasetWorld = SceneResource & Pick<World, 'createTransformEntity'>;
type WorldFactory = (container: HTMLElement) => Promise<DatasetWorld>;
interface WorkspaceAdapters {
  createView?: (world: DatasetWorld, source: BundleSource) => DatasetView;
  load?: (bytes: Uint8Array, name: string) => Promise<BundleSource>;
}

/** The account host owns this resource and retires the local dataset before its world. */
export function createDatasetWorkspace(load: () => Promise<WorldFactory>, adapters: WorkspaceAdapters = {}) {
  return async (container: HTMLElement, signal: AbortSignal): Promise<WorkspaceResource> => {
    if (signal.aborted) throw new Error('Workspace opening was cancelled.');
    const doc = container.ownerDocument, scene = doc.createElement('div'), overlay = doc.createElement('div');
    scene.style.cssText = 'width:100%;height:100%';
    overlay.style.cssText = 'position:absolute;inset:0;pointer-events:none';
    container.style.position = 'relative'; container.append(scene, overlay);
    let closed = false, cleanupFailed = false;
    let worldOwner: WorkspaceResource | undefined, panel: ReturnType<typeof mountDatasetPanel> | undefined;
    function dispose() {
      if (closed) { if (cleanupFailed) throw new WorkspaceCleanupError(); return; }
      closed = true; signal.removeEventListener('abort', onAbort);
      const p = panel, w = worldOwner; panel = undefined; worldOwner = undefined;
      for (const close of [() => p?.dispose(), () => w?.dispose(), () => overlay.remove(), () => scene.remove()]) {
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
      panel = mountDatasetPanel(overlay, { createView: source => (adapters.createView || createReviewView)(world, source), load: adapters.load });
      return { dispose };
    } catch (error) {
      try { dispose(); } catch { throw new WorkspaceCleanupError(); }
      throw error;
    }
  };
}
