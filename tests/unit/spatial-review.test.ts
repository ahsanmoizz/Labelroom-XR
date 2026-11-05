// LABELXR-SPATIAL-REVIEW-TESTS-v1
import {describe,it,expect} from 'vitest';
import {Matrix4,Ray,Vector3} from 'three';
import {createHandIntentGate,type HandEnvironment} from '../../src/xr/hand-gate';
import {pickReviewBox} from '../../src/xr/box-picking';
import type {BundleFrame} from '../../src/data/bundle';
const tracked:HandEnvironment={visible:true,viewerTracked:true,left:{tracked:true,open:true},right:{tracked:true,open:true}};
function running(){const g=createHandIntentGate();g.sample(tracked);expect(g.begin('left','resume','r7')).toBe(true);expect(g.end('left','resume','r7')).toBe('resume');g.sample(tracked);return g}
describe('native hand intent interlock',()=>{
 it('starts paused and cannot approve before explicit resume',()=>{const g=createHandIntentGate();g.sample(tracked);expect(g.begin('left','action:approve','r7')).toBe(false);expect(g.state().paused).toBe(true)});
 it('one matching pinch returns one intent only',()=>{const g=running();expect(g.begin('left','action:approve','r7')).toBe(true);expect(g.end('left','action:approve','r7')).toBe('action:approve');expect(g.end('left','action:approve','r7')).toBeUndefined()});
 it('does not fire on press, a changed target or changed review context',()=>{const g=running();expect(g.begin('left','action:approve','r7')).toBe(true);expect(g.end('left','action:reject','r7')).toBeUndefined();g.sample(tracked);g.begin('left','action:approve','r7');expect(g.end('left','action:approve','r8')).toBeUndefined()});
 it('requires an observed open hand after loss',()=>{const g=running();g.pause();g.sample({...tracked,left:{tracked:true,open:false},right:{tracked:true,open:false}});expect(g.begin('left','resume','r7')).toBe(false);g.sample(tracked);expect(g.begin('left','resume','r7')).toBe(true)});
 it.each(['left','right']as const)('loss of %s cancels held approval and requires explicit resume',hand=>{const g=running();g.begin(hand,'action:approve','r7');g.sample({...tracked,[hand]:{tracked:false,open:false}});g.sample(tracked);expect(g.end(hand,'action:approve','r7')).toBeUndefined();expect(g.state().paused).toBe(true);expect(g.begin(hand,'action:approve','r7')).toBe(false)});
 it.each([{visible:false},{viewerTracked:false}])('hidden or lost viewer cancels and stays paused on return: %o',change=>{const g=running();g.begin('right','action:approve','r7');g.sample({...tracked,...change});g.sample(tracked);expect(g.end('right','action:approve','r7')).toBeUndefined();expect(g.state().paused).toBe(true)});
 it('serializes simultaneous hands so they cannot duplicate a save',()=>{const g=running();expect(g.begin('left','action:approve','r7')).toBe(true);expect(g.begin('right','action:approve','r7')).toBe(false);expect(g.end('right','action:approve','r7')).toBeUndefined();expect(g.end('left','action:approve','r7')).toBe('action:approve')});
 it('manual pause invalidates a gesture and disposal is terminal',()=>{const g=running();g.begin('left','action:approve','r7');g.pause();expect(g.end('left','action:approve','r7')).toBeUndefined();g.dispose();g.sample(tracked);expect(g.begin('left','resume','r7')).toBe(false);expect(g.state().closed).toBe(true)});
});
const frame={id:'0',boxes:[{id:'box-a',box:{center:[0,0,1],size:[4,2,2],yaw:0}},{id:'box-b',box:{center:[0,8,1],size:[4,2,2],yaw:0}}]} as unknown as BundleFrame;
describe('oriented hand box selection',()=>{
 it('chooses the nearest displayed occurrence without changing input',()=>{const before=JSON.stringify(frame),r=new Ray(new Vector3(0,1,5),new Vector3(0,0,-1));expect(pickReviewBox(r,new Matrix4(),frame)?.objectId).toBe('box-a');expect(JSON.stringify(frame)).toBe(before)});
 it('returns no target for a miss or a target beyond five metres',()=>{expect(pickReviewBox(new Ray(new Vector3(20,1,3),new Vector3(0,0,-1)),new Matrix4(),frame)).toBeUndefined();expect(pickReviewBox(new Ray(new Vector3(0,1,8),new Vector3(0,0,-1)),new Matrix4(),frame)).toBeUndefined()});
 it.each([0.02,0.1,0.2])('accounts for tabletop scale %s and world rotation',scale=>{const matrix=new Matrix4().makeRotationY(Math.PI/3).scale(new Vector3(scale,scale,scale)).setPosition(0.2,1.1,-1),target=new Vector3(0,1,0).applyMatrix4(matrix),origin=target.clone().add(new Vector3(0,0,0.6));expect(pickReviewBox(new Ray(origin,target.clone().sub(origin).normalize()),matrix,frame)?.objectId).toBe('box-a')});
 it('uses oriented geometry rather than an axis-aligned enclosure',()=>{const rotated={...frame,boxes:[{...frame.boxes[0],box:{center:[0,0,1],size:[4,0.2,2],yaw:Math.PI/4}}]}as unknown as BundleFrame;expect(pickReviewBox(new Ray(new Vector3(1,4,1),new Vector3(0,-1,0)),new Matrix4(),rotated)).toBeUndefined()});
});
