// LABELXR-PREVIEW-FIT-v1
import type { ViewBounds } from './frame-view';

/** Fit the clip's bounding sphere at the default scale; the scale slider remains zoom. */
export function previewDistance(bounds: ViewBounds, camera: { fov: number; aspect: number; near: number; far: number }, scale = 0.02): number {
  if (![bounds.radius, camera.fov, camera.aspect, camera.near, camera.far, scale].every(Number.isFinite) ||
      bounds.radius < 0 || camera.fov <= 0 || camera.fov >= 179 || camera.aspect <= 0 ||
      camera.near <= 0 || camera.far <= camera.near || scale <= 0) throw new Error('Invalid preview frustum.');
  const vertical = camera.fov * Math.PI / 360;
  const horizontal = Math.atan(Math.tan(vertical) * camera.aspect);
  const radius = Math.max(bounds.radius * scale, 0.000001);
  const distance = Math.max(1, radius / Math.sin(Math.min(vertical, horizontal)) * 1.15, camera.near + radius * 1.1);
  if (distance + radius >= camera.far) throw new Error('Preview exceeds the camera range.');
  return distance;
}
