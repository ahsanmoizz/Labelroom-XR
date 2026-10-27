// LABELXR-FRAME-VIEW-v1
import type { BundleSource } from '../data/bundle';
import { toDisplay, type XYZ } from '../domain/coordinates';
import { isValidBox } from '../domain/geometry';
import { LIMITS } from '../domain/limits';

export interface ViewBounds { min: XYZ; max: XYZ; center: XYZ; radius: number }
export interface FrameView {
  id: string; pointCount: number; boxIds: readonly string[];
  positions: Float32Array; boxEdges: Float32Array; bounds: ViewBounds;
}
const edges = [[0,1],[0,2],[0,4],[1,3],[1,5],[2,3],[2,6],[3,7],[4,5],[4,6],[5,7],[6,7]] as const;
export function sourceBoxCorners(box: { readonly center: readonly number[]; readonly size: readonly number[]; readonly yaw: number }): readonly XYZ[] {
  if (box.center.length!==3 || box.size.length!==3 || !isValidBox({center:[box.center[0],box.center[1],box.center[2]],size:[box.size[0],box.size[1],box.size[2]],yaw:box.yaw})) throw new Error('Invalid source box.');
  const c = Math.cos(box.yaw), s = Math.sin(box.yaw);
  return Array.from({ length: 8 }, (_, i): XYZ => {
    const x = (i & 1 ? 1 : -1) * box.size[0] / 2;
    const y = (i & 2 ? 1 : -1) * box.size[1] / 2;
    return [box.center[0] + c*x - s*y, box.center[1] + s*x + c*y,
      box.center[2] + (i & 4 ? 1 : -1) * box.size[2] / 2];
  });
}
function boundedPoint(p: XYZ) {
  if (!p.every(Number.isFinite) || p.some(v => Math.abs(v) > LIMITS.maxCoordinateAbs)) {
    throw new Error('Invalid bounded source point.');
  }
}
function accumulator() {
  const min = [Infinity,Infinity,Infinity], max = [-Infinity,-Infinity,-Infinity];
  return {
    add(p: XYZ) { for (let i=0;i<3;i++) { min[i]=Math.min(min[i],p[i]); max[i]=Math.max(max[i],p[i]); } },
    finish(): ViewBounds {
      if (!min.every(Number.isFinite) || !max.every(Number.isFinite)) throw new Error('Empty view bounds.');
      const center = min.map((v,i)=>(v+max[i])/2) as [number,number,number];
      return { min: [...min] as [number,number,number], max: [...max] as [number,number,number], center,
        radius: Math.hypot(...max.map((v,i)=>v-center[i])) };
    }
  };
}
/** Produce display-only buffers. Local XYZ source metres and identities stay unchanged. */
export function buildFrameView(source: BundleSource, frameId: string): FrameView {
  const frame = source.frames.find(f=>f.id===frameId);
  if (!frame || !Number.isInteger(frame.pointCount) || frame.pointCount<1 || frame.pointCount>LIMITS.maxPointsPerFrame || frame.boxes.length>LIMITS.maxLabelsPerFrame) throw new Error('Unknown or invalid frame.');
  const points = source.getFramePoints(frameId);
  if (!(points instanceof Float32Array) || points.length!==frame.pointCount*3) throw new Error('Point count differs.');
  const positions = new Float32Array(points.length), boxEdges = new Float32Array(frame.boxes.length*72), bounds = accumulator();
  for(let i=0;i<points.length;i+=3) {
    const raw: XYZ=[points[i],points[i+1],points[i+2]]; boundedPoint(raw);
    const shown=toDisplay(raw); positions.set(shown,i); bounds.add(shown);
  }
  const ids=new Set<string>(); let offset=0;
  for(const labelled of frame.boxes) {
    if (!labelled.id || ids.has(labelled.id)) throw new Error('Invalid or duplicate box identity.'); ids.add(labelled.id);
    const corners=sourceBoxCorners(labelled.box).map(toDisplay);
    for(const corner of corners) bounds.add(corner);
    for(const [a,b]of edges) { boxEdges.set(corners[a],offset); boxEdges.set(corners[b],offset+3); offset+=6; }
  }
  return { id: frame.id, pointCount: frame.pointCount, boxIds: Object.freeze([...ids]), positions, boxEdges, bounds: bounds.finish() };
}
/** One clip-wide focus avoids a different recentering at every frame switch. */
export function clipViewBounds(source: BundleSource): ViewBounds {
  if(source.frames.length<1 || source.frames.length>LIMITS.maxFrames) throw new Error('Invalid clip frame count.');
  const total=accumulator();
  for(const frame of source.frames) { const {min,max}=buildFrameView(source,frame.id).bounds; total.add(min); total.add(max); }
  return total.finish();
}
export function tabletopPlacement(bounds: ViewBounds, scale=0.02, target: XYZ=[0,1.1,-1.5]) {
  if(!Number.isFinite(scale)||scale<0.02||scale>0.20||!target.every(Number.isFinite)||!bounds.center.every(Number.isFinite)) throw new Error('Invalid tabletop placement.');
  return { scale, position: target.map((v,i)=>v-scale*bounds.center[i]) as [number,number,number] };
}
