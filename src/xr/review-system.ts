// LABELXR-READONLY-REVIEW-VIEW-v1
import type { World } from '@iwsdk/core';
import { BufferAttribute, BufferGeometry, Group, LineBasicMaterial, LineSegments, Points, PointsMaterial, Sphere, Vector3, Ray } from 'three';
import type { FrameViewSource } from './frame-view';
import {createReviewBoxPicker} from './box-picking';
import { buildFrameView, clipViewBounds, tabletopPlacement } from './frame-view';
import { previewDistance } from './preview-fit';

/** An ECS-owned read-only view; this component performs no storage, network or label edits. */
export function createReviewView(world: Pick<World,'createTransformEntity'> & Partial<Pick<World,'camera'>>, source: FrameViewSource) {
  const bounds=clipViewBounds(source), maxPoints=Math.max(...source.frames.map(f=>f.pointCount)), maxBoxes=Math.max(...source.frames.map(f=>f.boxes.length));
  const pointPositions=new BufferAttribute(new Float32Array(maxPoints*3),3);
  const boxPositions=new BufferAttribute(new Float32Array(maxBoxes*72),3);
  const pointGeometry=new BufferGeometry(), boxGeometry=new BufferGeometry();
  pointGeometry.setAttribute('position',pointPositions); boxGeometry.setAttribute('position',boxPositions);
  const selectedPositions=new BufferAttribute(new Float32Array(72),3),selectedGeometry=new BufferGeometry();selectedGeometry.setAttribute('position',selectedPositions);selectedGeometry.setDrawRange(0,0);
  const selectedMaterial=new LineBasicMaterial({color:0x90e3cc,depthTest:false}),selectedLines=new LineSegments(selectedGeometry,selectedMaterial);selectedLines.renderOrder=2;
  const pointMaterial=new PointsMaterial({color:0xdcebf1,size:1.5,sizeAttenuation:false});
  const boxMaterial=new LineBasicMaterial({color:0x4d9b8c});
  const points=new Points(pointGeometry,pointMaterial), boxes=new LineSegments(boxGeometry,boxMaterial), group=new Group();
  group.name='LabelRoom read-only dataset'; group.add(points,boxes,selectedLines);
  let entity: ReturnType<World['createTransformEntity']> | undefined, closed=false, current='', selected='';
  let picker:ReturnType<typeof createReviewBoxPicker>|undefined;
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
    pointGeometry.boundingSphere=sphere; boxGeometry.boundingSphere=sphere.clone();selectedGeometry.boundingSphere=sphere.clone(); current=id;picker=createReviewBoxPicker(source.frames.find(f=>f.id===id)!);selected='';selectedGeometry.setDrawRange(0,0);
    return { frameId:id,pointCount:frame.pointCount,boxCount:frame.boxIds.length };
  }
  function dispose() {
    if(closed)return;closed=true;let failed=false;
    for(const close of [()=>entity?.dispose({disposeResources:false}),()=>group.removeFromParent(),()=>group.clear(),()=>pointGeometry.dispose(),()=>boxGeometry.dispose(),()=>pointMaterial.dispose(),()=>boxMaterial.dispose(),()=>selectedGeometry.dispose(),()=>selectedMaterial.dispose()]) {
      try{close()}catch{failed=true}
    }
    entity=undefined; current='';
    if(failed)throw new Error('Dataset view cleanup failed.');
  }
  try { place();showFrame(source.frames[0].id);entity=world.createTransformEntity(group,{persistent:false}); }
  catch(error) {try{dispose()}catch{/* All owned cleanup boundaries were attempted. */}throw error;}
  return {showFrame,setScale:place,resetView:()=>place(),dispose,
    pick(ray:Ray){requireOpen();group.updateWorldMatrix(true,false);return picker?.(ray,group.matrixWorld)},
    select(frameId:string,objectId:string){requireOpen();const index=source.frames.find(f=>f.id===current)?.boxes.findIndex(b=>b.id===objectId)??-1;const key=frameId===current&&index>=0?frameId+'/'+objectId:'';if(key===selected)return;selected=key;if(!key){selectedGeometry.setDrawRange(0,0);return}selectedPositions.array.set(boxPositions.array.subarray(index*72,index*72+72));selectedPositions.needsUpdate=true;selectedGeometry.setDrawRange(0,24)},
    get frameId(){return current},get object(){return group},get closed(){return closed},
    get clipBounds(){return {min:[...bounds.min],max:[...bounds.max],center:[...bounds.center],radius:bounds.radius}}};
}
