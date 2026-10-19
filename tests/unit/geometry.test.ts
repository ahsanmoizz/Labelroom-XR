import { describe, it, expect } from 'vitest';
import { toDisplay, fromDisplay } from '../../src/domain/coordinates';
import { containsPoint, isValidBox, yawToQuaternion, quaternionToYaw, orientedBoxIoU, orientedBoxIntersectionVolume, type Box } from '../../src/domain/geometry';
import { LIMITS } from '../../src/domain/limits';
describe('GEO-01 source/display convention',()=>{
 it('maps Z up and preserves a source-coordinate round trip',()=>{expect(toDisplay([1,2,3])).toEqual([1,3,-2]);expect(fromDisplay(toDisplay([-2,4,9]))).toEqual([-2,4,9]);});
 it('keeps an asymmetric 90-degree box correct',()=>{const b={center:[0,0,0] as const,size:[4,2,2] as const,yaw:Math.PI/2};expect(containsPoint(b,[0,1.8,0])).toBe(true);expect(containsPoint(b,[1.8,0,0])).toBe(false);});
 it('includes a boundary and rejects invalid dimensions',()=>{expect(containsPoint({center:[0,0,0],size:[2,2,2],yaw:0},[1,1,1])).toBe(true);expect(isValidBox({center:[0,0,0],size:[0,2,2],yaw:0})).toBe(false);expect(isValidBox({center:[251,0,0],size:[2,2,2],yaw:0})).toBe(false);});
 it('handles xyzw and rejects pitch/roll rather than flattening it',()=>{expect(quaternionToYaw(yawToQuaternion(.9))).toBeCloseTo(.9);expect(()=>quaternionToYaw([.2,0,0,Math.sqrt(.96)])).toThrow();});
 it('uses the sealed data ceiling',()=>{expect(LIMITS.maxFrames).toBe(10);expect(LIMITS.maxPointsPerFrame).toBe(200000);});
});

// LABELXR-ORIENTED-IOU-TESTS-v1
describe('GEO-02 upright oriented overlap component; SQL and review integration pending',()=>{
 const box=(center:Box['center']=[0,0,0],size:Box['size']=[2,2,2],yaw=0):Box=>({center,size,yaw});
 it('identical boxes have unit IoU and eight cubic metres',()=>{expect(orientedBoxIoU(box(),box())).toBe(1);expect(orientedBoxIntersectionVolume(box(),box())).toBe(8);});
 it('disjoint horizontal boxes have no overlap',()=>expect(orientedBoxIoU(box(),box([3,0,0]))).toBe(0));
 it('face contact has zero volume',()=>expect(orientedBoxIntersectionVolume(box(),box([2,0,0]))).toBe(0));
 it('edge contact has zero volume',()=>expect(orientedBoxIoU(box(),box([2,2,0]))).toBe(0));
 it('vertex contact has zero volume',()=>expect(orientedBoxIoU(box(),box([2,2,2]))).toBe(0));
 it('axis overlap is analytically one third',()=>{expect(orientedBoxIntersectionVolume(box(),box([1,0,0]))).toBe(4);expect(orientedBoxIoU(box(),box([1,0,0]))).toBeCloseTo(1/3,12);});
 it('contained cube is one eighth of the larger volume',()=>expect(orientedBoxIoU(box(),box([0,0,0],[1,1,1]))).toBeCloseTo(1/8,12));
 it('height overlap contributes to volume',()=>{expect(orientedBoxIntersectionVolume(box(),box([0,0,1]))).toBe(4);expect(orientedBoxIoU(box(),box([0,0,1]))).toBeCloseTo(1/3,12);});
 it('height contact has zero volume',()=>expect(orientedBoxIoU(box(),box([0,0,2]))).toBe(0));
 it('a vertical gap has zero volume',()=>expect(orientedBoxIoU(box(),box([0,0,2.000001]))).toBe(0));
 it('perpendicular 4 by 1 boxes cross with IoU one seventh',()=>{const a=box([0,0,0],[4,1,2]);const b=box([0,0,0],[4,1,2],Math.PI/2);expect(orientedBoxIntersectionVolume(a,b)).toBeCloseTo(2,12);expect(orientedBoxIoU(a,b)).toBeCloseTo(1/7,12);});
 it('a 45 degree square intersection matches the analytic octagon',()=>expect(orientedBoxIoU(box(),box([0,0,0],[2,2,2],Math.PI/4))).toBeCloseTo(Math.SQRT1_2,12));
 it('a half turn preserves the oriented cuboid',()=>expect(orientedBoxIoU(box([0,0,0],[4,1,2]),box([0,0,0],[4,1,2],Math.PI))).toBeCloseTo(1,12));
 it('swapped sides and a quarter turn describe the same rectangle',()=>expect(orientedBoxIoU(box([0,0,0],[4,1,2]),box([0,0,0],[1,4,2],Math.PI/2))).toBeCloseTo(1,12));
 it('does not expand a near-disjoint gap by epsilon',()=>expect(orientedBoxIoU(box(),box([2+1e-9,0,0]))).toBe(0));
 it('retains a positive thin overlap instead of rounding it to zero',()=>expect(orientedBoxIntersectionVolume(box(),box([2-1e-8,0,0]))).toBeGreaterThan(0));
 it('resolves the exact analytic duplicate threshold',()=>expect(orientedBoxIoU(box(),box([2/19,0,0]))).toBeCloseTo(.9,12));
 it('keeps the value below threshold below 0.90',()=>expect(orientedBoxIoU(box(),box([.106,0,0]))).toBeLessThan(.9));
 it('keeps the value above threshold above 0.90',()=>expect(orientedBoxIoU(box(),box([.105,0,0]))).toBeGreaterThan(.9));
 it('accepts the minimum valid box sizes',()=>expect(orientedBoxIoU(box([0,0,0],[.05,.05,.05]),box([0,0,0],[.05,.05,.05],.2))).toBeGreaterThan(0));
 it('accepts maximum dimensions and boundary centres',()=>expect(orientedBoxIoU(box([250,-250,250],[50,50,50],.3),box([250,-250,250],[50,50,50],.3))).toBeCloseTo(1,12));
 it('translation preserves the overlap far from the origin',()=>{const a=box([0,0,0],[4,1,2],.3),b=box([.2,.1,.4],[3,2,1],-.6);const move=(v:Box)=>box([v.center[0]+240,v.center[1]-240,v.center[2]+240],v.size,v.yaw);expect(orientedBoxIoU(move(a),move(b))).toBeCloseTo(orientedBoxIoU(a,b),11);});
 it('common rotation preserves overlap',()=>{const a=box([.1,.4,0],[4,1,2],.3),b=box([.3,.2,.4],[3,2,1],-.6),r=.731;const turn=(v:Box)=>box([Math.cos(r)*v.center[0]-Math.sin(r)*v.center[1],Math.sin(r)*v.center[0]+Math.cos(r)*v.center[1],v.center[2]],v.size,v.yaw+r);expect(orientedBoxIoU(turn(a),turn(b))).toBeCloseTo(orientedBoxIoU(a,b),12);});
 it('uniform scaling preserves IoU and cubes the volume',()=>{const a=box([.1,.4,0],[4,1,2],.3),b=box([.3,.2,.4],[3,2,1],-.6);const scale=(v:Box)=>box(v.center.map(x=>x*2) as unknown as Box['center'],v.size.map(x=>x*2) as unknown as Box['size'],v.yaw);expect(orientedBoxIoU(scale(a),scale(b))).toBeCloseTo(orientedBoxIoU(a,b),12);expect(orientedBoxIntersectionVolume(scale(a),scale(b))).toBeCloseTo(8*orientedBoxIntersectionVolume(a,b),10);});
 it('is symmetric and bounded across deterministic offset and yaw vectors',()=>{for(let i=0;i<40;i++){const a=box([0,0,0],[4,1,2],i*.17),b=box([Math.sin(i)*2,Math.cos(i),i%3*.4],[2,3,1],-i*.31);const x=orientedBoxIoU(a,b);expect(x).toBeGreaterThanOrEqual(0);expect(x).toBeLessThanOrEqual(1);expect(x).toBeCloseTo(orientedBoxIoU(b,a),11);}});
 it('does not mutate frozen input tuples',()=>{const a=Object.freeze({center:Object.freeze([0,0,0] as const),size:Object.freeze([4,1,2] as const),yaw:.2});const b=Object.freeze({center:Object.freeze([1,0,0] as const),size:Object.freeze([4,2,2] as const),yaw:-.2});const before=JSON.stringify([a,b]);orientedBoxIoU(a,b);expect(JSON.stringify([a,b])).toBe(before);});
 for(const [name,b] of [['zero size',box([0,0,0],[0,2,2])],['negative size',box([0,0,0],[-1,2,2])],['size below minimum',box([0,0,0],[.049,2,2])],['size above maximum',box([0,0,0],[50.01,2,2])],['out of range centre',box([250.01,0,0])],['NaN centre',box([NaN,0,0])],['infinite size',box([0,0,0],[2,Infinity,2])],['nonfinite yaw',box([0,0,0],[2,2,2],NaN)],['short centre',{center:[0,0],size:[2,2,2],yaw:0}],['missing box',null]] as const){
  it('rejects '+name+' in either argument',()=>{for(const fn of [orientedBoxIoU,orientedBoxIntersectionVolume]){expect(()=>fn(b as unknown as Box,box())).toThrow();expect(()=>fn(box(),b as unknown as Box)).toThrow();}});
 }
});
