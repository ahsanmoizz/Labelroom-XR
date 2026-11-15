import {loadBundleBytes,mountDatasetPanel,createReviewView,PerspectiveCamera,createWorkspaceCache} from '/bridge.mjs';
const bytes=new Uint8Array(await (await fetch('/source.zip')).arrayBuffer()),source=await loadBundleBytes(bytes,'contract-example.zip');
const cache=createWorkspaceCache({backend:'https://example.supabase.co',ownerId:'11111111-1111-4111-8111-111111111111',kind:'member'},localStorage,indexedDB);
const camera=new PerspectiveCamera(65,1.5,.01,1000),views=[];let entities=0;
const panel=mountDatasetPanel(document.querySelector('main'),{createView:(raw,display)=>{const view=createReviewView({camera,createTransformEntity(){entities++;return{dispose(){entities--;}}}},display??raw);views.push(view);return view;}});
const originalPoints=Array.from(source.getFramePoints('0')),originalBoxes=JSON.stringify(source.frames[0].boxes),originalBytes=Array.from(source.getOriginalZipBytes());panel.show(source);const remembered=cache.read();if(remembered?.sourceHash===source.bundleSha256)panel.restoreView(remembered.frameId,remembered.scale,remembered.inspection,remembered.objectId);panel.subscribeView(()=>{const state=panel.viewState();if(state)cache.write({schema:'labelxr-open-workspace/v1',kind:'local',sourceHash:source.bundleSha256,reviewOpen:false,...state});});
window.inspectionFixture={
 select(){panel.focusFrame('0',source.frames[0].boxes[0].id);},
 state(){const s=panel.inspection();return {...s,projection:s.projection?{view:s.projection.view,axes:s.projection.axes,points:Array.from(s.projection.points),selectedEdges:Array.from(s.projection.selectedEdges)}:undefined,entities,camera:camera.position.toArray(),sourcePointsUnchanged:JSON.stringify(Array.from(source.getFramePoints('0')))===JSON.stringify(originalPoints),sourceBoxesUnchanged:JSON.stringify(source.frames[0].boxes)===originalBoxes,sourceZipUnchanged:JSON.stringify(Array.from(source.getOriginalZipBytes()))===JSON.stringify(originalBytes)};},
 preview(){panel.replaceSaved({...source,frames:source.frames.map(f=>({...f,boxes:f.boxes.map(b=>({...b,box:{...b.box,center:[b.box.center[0]+.01,b.box.center[1]+.01,b.box.center[2]+.01]}}))}))},source.bundleSha256);},
 dispose(){panel.dispose();return {entities,allViewsClosed:views.every(v=>v.closed)};}
};
