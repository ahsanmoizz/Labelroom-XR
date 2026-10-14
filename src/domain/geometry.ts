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
