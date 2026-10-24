// LABELXR-SCENE-LIFETIME-v1
import { WorkspaceCleanupError, type WorkspaceResource } from '../app/host.js';

export interface SceneResource {
  exitXR(): void;
  destroy(): void;
  renderer: { dispose(): void; domElement: { remove(): void } };
}
export type SceneFactory = (container: HTMLElement) => Promise<SceneResource>;

/** Release each teardown boundary even when another one fails. No scene is reused. */
export function ownScene(world: SceneResource): WorkspaceResource {
  let closed = false;
  return { dispose() {
    if (closed) return; closed = true; let failed = false;
    for (const close of [() => world.exitXR(), () => world.destroy(),
      () => world.renderer.dispose(), () => world.renderer.domElement.remove()]) {
      try { close(); } catch { failed = true; }
    }
    if (failed) throw new WorkspaceCleanupError();
  } };
}
export function createSceneLoader(load: () => Promise<SceneFactory>) {
  return async (container: HTMLElement, signal: AbortSignal): Promise<WorkspaceResource> => {
    if (signal.aborted) throw new Error('Workspace opening was cancelled.');
    const create = await load();
    if (signal.aborted) throw new Error('Workspace opening was cancelled.');
    const owned = ownScene(await create(container));
    if (signal.aborted) { owned.dispose(); throw new Error('Workspace opening was cancelled.'); }
    return owned;
  };
}
