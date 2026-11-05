// LABELXR-HAND-BOX-PICKING-v1
import {Box3,Matrix4,Ray,Vector3} from 'three';
import type {BundleFrame} from '../data/bundle';
/** Exact oriented-box selection in source metres, after undoing the display transform. */
export function createReviewBoxPicker(frame:BundleFrame) {
  const boxes=frame.boxes.map(item=>{const half=new Vector3(...item.box.size).multiplyScalar(0.5);return{id:item.id,center:new Vector3(...item.box.center),rotation:new Matrix4().makeRotationZ(item.box.yaw),inverse:new Matrix4().makeRotationZ(-item.box.yaw),bounds:new Box3(half.clone().negate(),half)}});
  const inverse=new Matrix4(),display=new Ray(),source=new Ray(),local=new Ray(),point=new Vector3(),world=new Vector3();
  return (worldRay:Ray,displayMatrix:Matrix4)=>{
    display.copy(worldRay).applyMatrix4(inverse.copy(displayMatrix).invert());
    source.origin.set(display.origin.x,-display.origin.z,display.origin.y);source.direction.set(display.direction.x,-display.direction.z,display.direction.y);
    let objectId:string|undefined,nearest=Infinity;
    for(const box of boxes){
      local.copy(source);local.origin.sub(box.center).applyMatrix4(box.inverse);local.direction.transformDirection(box.inverse);
      if(!local.intersectBox(box.bounds,point))continue;
      point.applyMatrix4(box.rotation).add(box.center);world.set(point.x,point.z,-point.y).applyMatrix4(displayMatrix);
      const distance=world.distanceTo(worldRay.origin);if(Number.isFinite(distance)&&distance<=5&&distance<nearest){objectId=box.id;nearest=distance}
    }
    return objectId?{frameId:frame.id,objectId,distance:nearest}:undefined;
  };
}
export function pickReviewBox(worldRay:Ray,displayMatrix:Matrix4,frame:BundleFrame){return createReviewBoxPicker(frame)(worldRay,displayMatrix)}
