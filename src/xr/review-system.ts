// LABELXR-READONLY-REVIEW-VIEW-v1
import type { World } from '@iwsdk/core';
import { BufferAttribute, BufferGeometry, Group, LineBasicMaterial, LineSegments, Points, PointsMaterial, Sphere, Vector3, Ray } from 'three';
import type { FrameViewSource } from './frame-view';
import {createReviewBoxPicker} from './box-picking';
import { buildFrameView, clipViewBounds, tabletopPlacement } from './frame-view';
import { previewDistance } from './preview-fit';
import {depthViews,isolateFrameView,edgeBounds,projectDepth,type DepthView,type InspectionState} from './inspection';
import type {FrameView} from './frame-view';

/** An ECS-owned read-only view; this component performs no storage, network or label edits. */
export function createReviewView(world: Pick<World,'createTransformEntity'> & Partial<Pick<World,'camera'>>, source: FrameViewSource) {
  const bounds=clipViewBounds(source), maxPoints=Math.max(...source.frames.map(f=>f.pointCount)), maxBoxes=Math.max(...source.frames.map(f=>f.boxes.length));
  const pointPositions=new BufferAttribute(new Float32Array(maxPoints*3),3);
  const boxPositions=new BufferAttribute(new Float32Array(maxBoxes*72),3);
  const pointGeometry=new BufferGeometry(), boxGeometry=new BufferGeometry();
  pointGeometry.setAttribute('position',pointPositions); boxGeometry.setAttribute('position',boxPositions);
  const selectedArray=new Float32Array(72),selectedPositions=new BufferAttribute(selectedArray,3),selectedGeometry=new BufferGeometry();selectedGeometry.setAttribute('position',selectedPositions);selectedGeometry.setDrawRange(0,0);
  const selectedMaterial=new LineBasicMaterial({color:0x90e3cc,depthTest:false}),selectedLines=new LineSegments(selectedGeometry,selectedMaterial);selectedLines.renderOrder=2;
  const pointMaterial=new PointsMaterial({color:0xdcebf1,size:1.5,sizeAttenuation:false});
  const boxMaterial=new LineBasicMaterial({color:0x4d9b8c});
  const points=new Points(pointGeometry,pointMaterial), boxes=new LineSegments(boxGeometry,boxMaterial), group=new Group();
  group.name='LabelRoom read-only dataset'; group.add(points,boxes,selectedLines);
  let entity: ReturnType<World['createTransformEntity']> | undefined, closed=false, current='', selected='';
  let picker:ReturnType<typeof createReviewBoxPicker>|undefined;
  let built:FrameView|undefined,visible:FrameView|undefined,isolated=false,rotationDegrees=0,displayScale=.02,depthView:DepthView='scene',version=0,projection:InspectionState['projection'];
  function requireOpen(){if(closed)throw new Error('Dataset view is closed.');}
  function activeBounds(){return isolated&&selected?edgeBounds(selectedArray):bounds;}
  function place(scale=displayScale) {
    requireOpen(); const focusBounds=activeBounds();tabletopPlacement(focusBounds,scale);displayScale=scale;
    group.rotation.y=rotationDegrees*Math.PI/180;
    const center=new Vector3(...focusBounds.center).applyQuaternion(group.quaternion).multiplyScalar(scale);
    if (world.camera) {
      const camera=world.camera,distance=previewDistance(focusBounds,camera);
      camera.updateWorldMatrix(true,false);
      group.position.copy(camera.getWorldPosition(new Vector3()).addScaledVector(camera.getWorldDirection(new Vector3()),distance)).sub(center);
    } else group.position.set(0,1.1,-1.5).sub(center);
    group.scale.setScalar(scale);
  }
  function redraw(){
    if(!built)return;const frame=source.frames.find(f=>f.id===current)!,id=selected,index=frame.boxes.findIndex(b=>b.id===id);
    if(index<0){selected='';isolated=false;selectedGeometry.setDrawRange(0,0);}else{selectedPositions.array.set(built.boxEdges.subarray(index*72,index*72+72));selectedPositions.needsUpdate=true;selectedGeometry.setDrawRange(0,24);}
    const filtered=isolated&&index>=0?isolateFrameView(built,frame.boxes[index].box):built;
    visible=isolated&&index>=0?{...filtered,boxEdges:built.boxEdges.slice(index*72,index*72+72),boxIds:[id]}:filtered;
    pointPositions.array.set(visible.positions);boxPositions.array.set(visible.boxEdges);pointPositions.needsUpdate=true;boxPositions.needsUpdate=true;
    pointGeometry.setDrawRange(0,visible.pointCount);boxGeometry.setDrawRange(0,visible.boxEdges.length/3);
    picker=createReviewBoxPicker(isolated&&index>=0?{...frame,boxes:[frame.boxes[index]]}:frame);
    projection=undefined;version++;
  }
  function showFrame(id: string) {
    requireOpen();const frame=buildFrameView(source,id);
    if(frame.positions.length>pointPositions.array.length||frame.boxEdges.length>boxPositions.array.length)throw Error('Frame exceeds allocated capacity.');
    const oldId=selected;built=frame;current=id;selected=source.frames.find(f=>f.id===id)!.boxes.some(b=>b.id===oldId)?oldId:'';redraw();
    const sphere=new Sphere(new Vector3(...frame.bounds.center),frame.bounds.radius);pointGeometry.boundingSphere=sphere;boxGeometry.boundingSphere=sphere.clone();selectedGeometry.boundingSphere=sphere.clone();place();
    return {frameId:id,pointCount:frame.pointCount,boxCount:frame.boxIds.length};
  }
  function inspection():InspectionState{
    requireOpen();if(!visible)throw Error('No inspection frame.');
    if(depthView!=='scene'&&!projection)projection=projectDepth(visible,depthView,selected?selectedArray:new Float32Array());
    return {version,frameId:current,objectId:selected,isolated,canIsolate:!!selected,rotationDegrees,depthView,shownPoints:visible.pointCount,totalPoints:built!.pointCount,projection};
  }
  function dispose() {
    if(closed)return;closed=true;let failed=false;
    for(const close of [()=>entity?.dispose({disposeResources:false}),()=>group.removeFromParent(),()=>group.clear(),()=>pointGeometry.dispose(),()=>boxGeometry.dispose(),()=>pointMaterial.dispose(),()=>boxMaterial.dispose(),()=>selectedGeometry.dispose(),()=>selectedMaterial.dispose()]) {
      try{close()}catch{failed=true}
    }
    entity=undefined; current='';built=visible=undefined;projection=undefined;
    if(failed)throw new Error('Dataset view cleanup failed.');
  }
  try { place();showFrame(source.frames[0].id);entity=world.createTransformEntity(group,{persistent:false}); }
  catch(error) {try{dispose()}catch{/* All owned cleanup boundaries were attempted. */}throw error;}
  return {showFrame,setScale:place,recenterView:()=>place(),resetView:()=>{isolated=false;rotationDegrees=0;depthView='scene';redraw();place(.02)},dispose,inspection,
    setIsolation(enabled:boolean){requireOpen();if(enabled&&!selected)throw Error('Select an object before isolating.');isolated=enabled;redraw();place();},
    rotateView(deltaDegrees:number){requireOpen();if(!Number.isFinite(deltaDegrees)||Math.abs(deltaDegrees)>360)throw Error('Invalid display rotation.');rotationDegrees=((rotationDegrees+deltaDegrees)%360+360)%360;version++;place();},
    setDepthView(value:DepthView){requireOpen();if(!depthViews.includes(value))throw Error('Unknown depth view.');depthView=value;projection=undefined;version++;},
    pick(ray:Ray){requireOpen();group.updateWorldMatrix(true,false);return picker?.(ray,group.matrixWorld)},
    select(frameId:string,objectId:string){requireOpen();const valid=source.frames.find(f=>f.id===current)?.boxes.some(b=>b.id===objectId),key=frameId===current&&valid?objectId:'';if(key===selected)return;selected=key;redraw();if(isolated)place();},
    get frameId(){return current},get object(){return group},get closed(){return closed},
    get clipBounds(){return {min:[...bounds.min],max:[...bounds.max],center:[...bounds.center],radius:bounds.radius}}};
}
