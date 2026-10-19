import type { XYZ } from './coordinates';
import { LIMITS } from './limits';
export interface Box { center: XYZ; size: XYZ; yaw: number; }
export function isValidBox(b: Box): boolean {
 return [...b.center,...b.size,b.yaw].every(Number.isFinite) && b.center.every(v=>Math.abs(v)<=LIMITS.maxCoordinateAbs) && b.size.every(v=>v>=LIMITS.minBoxSize && v<=LIMITS.maxBoxSize);
}
export function containsPoint(b: Box, p: XYZ): boolean {
 const dx=p[0]-b.center[0], dy=p[1]-b.center[1], dz=p[2]-b.center[2];
 const c=Math.cos(b.yaw), s=Math.sin(b.yaw);
 return Math.abs(c*dx+s*dy)<=b.size[0]/2+1e-6 && Math.abs(-s*dx+c*dy)<=b.size[1]/2+1e-6 && Math.abs(dz)<=b.size[2]/2+1e-6;
}
export function yawToQuaternion(yaw: number): readonly [number,number,number,number] {
 return [0,0,Math.sin(yaw/2),Math.cos(yaw/2)];
}
export function quaternionToYaw(q: readonly number[]): number {
 if(q.length!==4 || !q.every(Number.isFinite) || Math.abs(Math.hypot(...q)-1)>1e-4 || Math.abs(q[0])>1e-4 || Math.abs(q[1])>1e-4) throw new Error('Only normalized upright yaw cuboids are supported.');
 return 2*Math.atan2(q[2],q[3]);
}

// LABELXR-ORIENTED-IOU-v1
// Source metres, Z up, upright yaw boxes. This measurement is not a review
// decision. Duplicate removal still requires matching classes, different IDs,
// explicit confirmation, ownership and a server-side revision check.
type XY = readonly [number, number];
const OVERLAP_EPSILON = 1e-6;
function checkedOverlapBox(b: Box): void {
 if (!b || !Array.isArray(b.center) || b.center.length !== 3 ||
     !Array.isArray(b.size) || b.size.length !== 3 || !isValidBox(b)) {
  throw new Error('Overlap requires finite bounded upright boxes with positive dimensions.');
 }
}
function overlapVolume(a: Box, b: Box): number {
 const dz = b.center[2] - a.center[2];
 const height = Math.max(0, Math.min(a.size[2]/2, dz+b.size[2]/2) - Math.max(-a.size[2]/2, dz-b.size[2]/2));
 if (height === 0) return 0;
 // Work relative to A's centre and axes. Small polygons near the origin avoid
 // cancellation in the shoelace sum when world coordinates are near +/-250m.
 const ca=Math.cos(a.yaw), sa=Math.sin(a.yaw), cb=Math.cos(b.yaw), sb=Math.sin(b.yaw);
 const dx=b.center[0]-a.center[0], dy=b.center[1]-a.center[1];
 let polygon: XY[] = ([[-1,-1],[1,-1],[1,1],[-1,1]] as const).map(([sx,sy])=>{
  const x=dx+cb*sx*b.size[0]/2-sb*sy*b.size[1]/2;
  const y=dy+sb*sx*b.size[0]/2+cb*sy*b.size[1]/2;
  return [ca*x+sa*y, -sa*x+ca*y] as XY;
 });
 // Sutherland-Hodgman against A's four half-planes. A zero signed distance
 // is inside. Never expand a box by epsilon: that could cross the 0.90 gate.
 for (const [axis,sign,half] of [[0,1,a.size[0]/2],[0,-1,a.size[0]/2],[1,1,a.size[1]/2],[1,-1,a.size[1]/2]] as const) {
  if (polygon.length === 0) return 0;
  const next: XY[]=[];
  let previous=polygon[polygon.length-1], dp=half-sign*previous[axis];
  for (const current of polygon) {
   const dc=half-sign*current[axis];
   if ((dp>=0)!==(dc>=0)) {
    const t=dp/(dp-dc);
    // Opposite signed distances guarantee a nonzero denominator and t in [0,1].
    const crossing: [number,number]=[previous[0]+t*(current[0]-previous[0]),previous[1]+t*(current[1]-previous[1])];
    crossing[axis]=sign*half;
    next.push(crossing);
   }
   if (dc>=0) next.push(current);
   previous=current;dp=dc;
  }
  polygon=next;
 }
 if (polygon.length<3) return 0;
 let twiceArea=0;
 for(let i=0;i<polygon.length;i++) {
  const p=polygon[i],q=polygon[(i+1)%polygon.length];twiceArea+=p[0]*q[1]-p[1]*q[0];
 }
 const volume=Math.abs(twiceArea)/2*height;
 const ceiling=Math.min(a.size[0]*a.size[1]*a.size[2],b.size[0]*b.size[1]*b.size[2]);
 if (!Number.isFinite(volume) || volume>ceiling+OVERLAP_EPSILON) throw new Error('Overlap numerical bounds failed.');
 return Math.min(ceiling,Math.max(0,volume));
}
/** Oriented intersection volume in cubic metres; touching surfaces have zero volume. */
export function orientedBoxIntersectionVolume(a: Box, b: Box): number {
 checkedOverlapBox(a);checkedOverlapBox(b);return overlapVolume(a,b);
}
/** Exact upright polygon/height overlap, not an axis-aligned bounding-box proxy. */
export function orientedBoxIoU(a: Box, b: Box): number {
 checkedOverlapBox(a);checkedOverlapBox(b);
 const intersection=overlapVolume(a,b);
 const union=a.size[0]*a.size[1]*a.size[2]+b.size[0]*b.size[1]*b.size[2]-intersection;
 return Math.min(1,Math.max(0,intersection/union));
}
