// LABELXR-READONLY-REVIEW-VIEW-v1
import type { World } from '@iwsdk/core';
import { BufferAttribute, BufferGeometry, Group, LineBasicMaterial, LineSegments, Points, PointsMaterial, Sphere, Vector3 } from 'three';
import type { BundleSource } from '../data/bundle';
import { buildFrameView, clipViewBounds, tabletopPlacement } from './frame-view';
import { previewDistance } from './preview-fit';

/** An ECS-owned read-only view; this component performs no storage, network or label edits. */
export function createReviewView(world: Pick<World,'createTransformEntity'> & Partial<Pick<World,'camera'>>, source: BundleSource) {
  const bounds=clipViewBounds(source), maxPoints=Math.max(...source.frames.map(f=>f.pointCount)), maxBoxes=Math.max(...source.frames.map(f=>f.boxes.length));
  const pointPositions=new BufferAttribute(new Float32Array(maxPoints*3),3);
  const boxPositions=new BufferAttribute(new Float32Array(maxBoxes*72),3);
  const pointGeometry=new BufferGeometry(), boxGeometry=new BufferGeometry();
  pointGeometry.setAttribute('position',pointPositions); boxGeometry.setAttribute('position',boxPositions);
  const pointMaterial=new PointsMaterial({color:0xb9eaff,size:1.5,sizeAttenuation:false});
  const boxMaterial=new LineBasicMaterial({color:0x80e1d5});
  const points=new Points(pointGeometry,pointMaterial), boxes=new LineSegments(boxGeometry,boxMaterial), group=new Group();
  group.name='LabelRoom read-only dataset'; group.add(points,boxes);
  let entity: ReturnType<World['createTransformEntity']> | undefined, closed=false, current='';
  function requireOpen(){if(closed)throw new Error('Dataset view is closed.');}
  function place(scale=0.02) {
    requireOpen(); const placement=tabletopPlacement(bounds,scale);
    if (world.camera) {
      const camera=world.camera, distance=previewDistance(bounds,camera);
      camera.updateWorldMatrix(true,false);
      const focus=camera.getWorldPosition(new Vector3()).addScaledVector(camera.getWorldDirection(new Vector3()),distance);
      group.position.set(focus.x-scale*bounds.center[0],focus.y-scale*bounds.center[1],focus.z-scale*bounds.center[2]);
    } else group.position.set(...placement.position);
    group.scale.setScalar(scale);
  }
  function showFrame(id: string) {
    requireOpen(); const frame=buildFrameView(source,id);
    // Validate and build the replacement before touching the active frame.
    if(frame.positions.length>pointPositions.array.length || frame.boxEdges.length>boxPositions.array.length) throw new Error('Frame exceeds allocated capacity.');
    pointPositions.array.set(frame.positions); boxPositions.array.set(frame.boxEdges);
    pointPositions.needsUpdate=true; boxPositions.needsUpdate=true;
    pointGeometry.setDrawRange(0,frame.pointCount); boxGeometry.setDrawRange(0,frame.boxEdges.length/3);
    const sphere=new Sphere(new Vector3(...frame.bounds.center),frame.bounds.radius);
    pointGeometry.boundingSphere=sphere; boxGeometry.boundingSphere=sphere.clone(); current=id;
    return { frameId:id,pointCount:frame.pointCount,boxCount:frame.boxIds.length };
  }
  function dispose() {
    if(closed)return;closed=true;let failed=false;
    for(const close of [()=>entity?.dispose({disposeResources:false}),()=>group.removeFromParent(),()=>group.clear(),()=>pointGeometry.dispose(),()=>boxGeometry.dispose(),()=>pointMaterial.dispose(),()=>boxMaterial.dispose()]) {
      try{close()}catch{failed=true}
    }
    entity=undefined; current='';
    if(failed)throw new Error('Dataset view cleanup failed.');
  }
  try { place();showFrame(source.frames[0].id);entity=world.createTransformEntity(group,{persistent:false}); }
  catch(error) {try{dispose()}catch{/* All owned cleanup boundaries were attempted. */}throw error;}
  return {showFrame,setScale:place,resetView:()=>place(),dispose,
    get frameId(){return current},get object(){return group},get closed(){return closed},
    get clipBounds(){return {min:[...bounds.min],max:[...bounds.max],center:[...bounds.center],radius:bounds.radius}}};
}
