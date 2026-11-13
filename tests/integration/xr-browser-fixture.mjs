// Actual IWER frames and hand events, actual WebGL/Three and application spatial controls.
// The small dataset, backend and renderer-to-World adapter are explicit test fixtures.
export async function prepareXR(api,current){
 const {Group,Scene,PerspectiveCamera,WebGLRenderer,Vector3,Quaternion,XRDevice,metaQuest3}=api;
 const device=new XRDevice(metaQuest3);device.primaryInputMode='hand';device.installRuntime({forceInstall:true});
 const renderer=new WebGLRenderer({antialias:false});renderer.setSize(640,480);renderer.xr.enabled=true;renderer.xr.setReferenceSpaceType('local-floor');
 document.body.append(renderer.domElement);const scene=new Scene(),camera=new PerspectiveCamera(70,640/480,.001,200),player=new Group();player.add(camera);scene.add(player);camera.position.set(0,1.6,0);
 const listeners=new Set(),controller=new AbortController(),events=[];let frameCount=0,ended=0,lastTime,intervals=[];
 const world={camera,player,get xrSession(){return renderer.xr.getSession()},get xrReferenceSpace(){return renderer.xr.getReferenceSpace()},
  createTransformEntity(group){scene.add(group);return{dispose(){group.removeFromParent()}}},onXRFrame(fn){listeners.add(fn);return()=>listeners.delete(fn)}};
 let view=api.createReviewView(world,api.reviewFrameSource(current.workspace.store.snapshot()));
 const priorPresent=current.presented.length,priorPreview=current.previews.length;
 let displayKey='';
 function syncView(){const s=current.workspace.store.snapshot(),c=current.workspace.store.state().command;if(!s)return;const key=JSON.stringify([s.revision,c]);if(key===displayKey)return;displayKey=key;view.dispose();view=api.createReviewView(world,c?api.reviewProposalFrameSource(s,c):api.reviewFrameSource(s))}
 let safetyLabel='';const nativeFillText=CanvasRenderingContext2D.prototype.fillText;CanvasRenderingContext2D.prototype.fillText=function(text,...args){if(text==='Resume'||text==='Pause')safetyLabel=text;return nativeFillText.call(this,text,...args)};
 const actionLog=[],nativePort=current.workspace.spatial,spatialPort={...nativePort,activate(name){const accepted=nativePort.activate(name);actionLog.push({name,accepted});return accepted}};
 const spatial=api.mountSpatialReview(world,spatialPort,{pick:ray=>view.pick(ray),highlight:(f,o)=>view.select(f,o),recenter:()=>view.resetView()},document,controller.signal);
 renderer.setAnimationLoop((time,frame)=>{if(frame){frameCount++;if(lastTime)intervals.push(time-lastTime);lastTime=time;syncView();for(const fn of [...listeners])fn(frame)}renderer.render(scene,camera)});
 const enter=document.createElement('button');enter.id='enter-xr-fixture';enter.textContent='Enter fixture XR';document.body.prepend(enter);
 enter.onclick=async()=>{try{const session=await navigator.xr.requestSession('immersive-vr',{requiredFeatures:['local-floor','hand-tracking']});for(const type of ['selectstart','selectend'])session.addEventListener(type,e=>events.push({type,hand:e.inputSource.handedness}));session.addEventListener('end',()=>ended++);await renderer.xr.setSession(session)}catch(e){window.labelxrXR.error=e.name+': '+e.message}};
 async function frames(count=4){const session=renderer.xr.getSession();if(!session)throw Error('No emulated session');await new Promise(resolve=>{const tick=()=>{if(--count<=0)resolve();else session.requestAnimationFrame(tick)};session.requestAnimationFrame(tick)})}
 function panel(){return scene.getObjectByName('LabelRoom seated review')}
 function aim(hand,x,y){const group=panel();if(!group)throw Error('Spatial panel not mounted');group.updateWorldMatrix(true,true);const target=group.localToWorld(new Vector3((x/1024-.5)*.7,(.5-y/1280)*.875,.003)),origin=new Vector3(hand==='left'?-.2:.2,1.4,0),q=new Quaternion().setFromUnitVectors(new Vector3(0,0,-1),target.sub(origin).normalize());device.hands[hand].position.set(origin.x,origin.y,origin.z);device.hands[hand].quaternion.set(q.x,q.y,q.z,q.w)}
 window.labelxrXR={error:null,async frames(n){await frames(n)},state(){const s=renderer.xr.getSession();return{safetyLabel,actionLog:actionLog.slice(-20),frameCount,ended,panelVisible:!!panel()?.visible,sessionActive:!!s,isPresenting:renderer.xr.isPresenting,inputSources:s?[...s.inputSources].map(x=>({hand:x.handedness,joints:x.hand?.size??0})):[],events:[...events],listeners:listeners.size,model:current.workspace.spatial.read(),glRenderer:renderer.getContext().getParameter(renderer.getContext().RENDERER),drawCalls:renderer.info.render.calls,intervals:intervals.slice(-120),presentedChanges:current.presented.length-priorPresent,previewChanges:current.previews.length-priorPreview}},
  async resumeIfPaused(){await frames(5);if(safetyLabel==='Resume'){await this.tap('left',186,282);if(safetyLabel!=='Pause')throw Error('Hand safety resume was not confirmed')}},
  async aim(hand,x,y){device.hands[hand].updatePinchValue(0);aim(hand,x,y);await frames(5)},
  async begin(hand){device.hands[hand].updatePinchValue(1);await frames(5)},
  async end(hand){device.hands[hand].updatePinchValue(0);await frames(5)},
  async tap(hand,x,y){await this.aim(hand,x,y);await this.begin(hand);await this.end(hand)},
  async retarget(hand,x,y){aim(hand,x,y);await frames(3)},
  async tracking(hand,connected){device.hands[hand].connected=connected;await frames(5)},
  async visibility(state){device.updateVisibilityState(state);await frames(5)},
  async exit(){await renderer.xr.getSession()?.end()},
  async dispose(){await this.exit();controller.abort();spatial.dispose();CanvasRenderingContext2D.prototype.fillText=nativeFillText;view.dispose();renderer.setAnimationLoop(null);renderer.dispose();renderer.domElement.remove();enter.remove();device.uninstallRuntime();return{listeners:listeners.size,spatialRemoved:!panel(),sessionEnded:ended>0}}
 };
 return{runtime:device.version,device:device.name,actualWebGl:true,syntheticBackend:true,syntheticSource:true,productionSdkWorldAdapterTested:false};
}
