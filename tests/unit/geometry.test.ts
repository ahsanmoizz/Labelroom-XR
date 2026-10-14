import { describe, it, expect } from 'vitest';
import { toDisplay, fromDisplay } from '../../src/domain/coordinates';
import { containsPoint, isValidBox, yawToQuaternion, quaternionToYaw } from '../../src/domain/geometry';
import { LIMITS } from '../../src/domain/limits';
describe('GEO-01 source/display convention',()=>{
 it('maps Z up and preserves a source-coordinate round trip',()=>{expect(toDisplay([1,2,3])).toEqual([1,3,-2]);expect(fromDisplay(toDisplay([-2,4,9]))).toEqual([-2,4,9]);});
 it('keeps an asymmetric 90-degree box correct',()=>{const b={center:[0,0,0] as const,size:[4,2,2] as const,yaw:Math.PI/2};expect(containsPoint(b,[0,1.8,0])).toBe(true);expect(containsPoint(b,[1.8,0,0])).toBe(false);});
 it('includes a boundary and rejects invalid dimensions',()=>{expect(containsPoint({center:[0,0,0],size:[2,2,2],yaw:0},[1,1,1])).toBe(true);expect(isValidBox({center:[0,0,0],size:[0,2,2],yaw:0})).toBe(false);expect(isValidBox({center:[251,0,0],size:[2,2,2],yaw:0})).toBe(false);});
 it('handles xyzw and rejects pitch/roll rather than flattening it',()=>{expect(quaternionToYaw(yawToQuaternion(.9))).toBeCloseTo(.9);expect(()=>quaternionToYaw([.2,0,0,Math.sqrt(.96)])).toThrow();});
 it('uses the sealed data ceiling',()=>{expect(LIMITS.maxFrames).toBe(10);expect(LIMITS.maxPointsPerFrame).toBe(200000);});
});
