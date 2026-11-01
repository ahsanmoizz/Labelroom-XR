// LABELXR-PROJECT-PREVIEW-v1
import type { BundleFrame, DeepReadonly } from '../data/bundle';
import { parseOpenLabelBytes } from '../data/openlabel';
import { manifestSchema } from '../domain/schema';
import type { createProjectsService } from '../services/projects';
import type { FrameViewSource } from '../xr/frame-view';
export type OpenedProject = Awaited<ReturnType<ReturnType<typeof createProjectsService>['open']>>;
function frozen<T>(value: T): DeepReadonly<T> { if (value && typeof value === 'object') { for (const child of Object.values(value)) frozen(child); Object.freeze(value); } return value as DeepReadonly<T>; }
/** Display the validated current labels while preserving immutable original ZIP, source labels and points. */
export function projectPreview(result: OpenedProject): FrameViewSource {
  const { original, project } = result;
  if (project.status !== 'ready' || project.source_hash !== original.bundleSha256 || project.source_bytes !== original.getOriginalZipBytes().length) throw new Error('Project source differs.');
  const labels = parseOpenLabelBytes(new TextEncoder().encode(JSON.stringify(result.labels.document)), manifestSchema.parse(original.manifest));
  if (labels.frames.length !== original.frames.length) throw new Error('Project frames differ.');
  const frames: BundleFrame[] = original.frames.map((frame, i) => {
    const current = labels.frames[i];
    if (frame.id !== current.id || frame.timestamp !== current.timestamp) throw new Error('Project frame identity differs.');
    return { ...frame, boxes: current.boxes };
  });
  return Object.freeze({ frames: frozen(frames), getFramePoints: (id: string) => original.getFramePoints(id) });
}
