// LABELXR-SEATED-HAND-REVIEW-v1
import type {World} from '@iwsdk/core';
import {BufferAttribute,BufferGeometry,CanvasTexture,Group,Line,LineBasicMaterial,Mesh,MeshBasicMaterial,PlaneGeometry,Quaternion,Ray,Raycaster,SRGBColorSpace,Vector3} from 'three';
import {createHandIntentGate,type Hand,type HandSample} from './hand-gate';
import {spatialFields,type SpatialAction,type SpatialChoice,type SpatialField,type SpatialReviewPort} from '../ui/spatial-review-port';
type SpatialWorld=Pick<World,'createTransformEntity'> & Partial<Pick<World,'onXRFrame'|'xrSession'|'xrReferenceSpace'|'player'>>;
interface Presentation {pick(ray:Ray):{frameId:string;objectId:string;distance:number}|undefined;highlight(frameId:string,objectId:string):void;recenter():void}
interface Button {key:string;label:string;x:number;y:number;w:number;h:number;enabled:boolean}
const W=1024,H=1280;
/** World-anchored panel. Native selectstart/end are pinches; every edit goes through the existing controller. */
export function mountSpatialReview(world:SpatialWorld,port:SpatialReviewPort,view:Presentation,doc:Document,signal:AbortSignal){
  if(!world.onXRFrame)return {dispose(){}};
  const canvas=doc.createElement('canvas');canvas.width=W;canvas.height=H;
  const ctx=canvas.getContext('2d');if(!ctx)throw Error('Spatial panel drawing is unavailable.');
  const texture=new CanvasTexture(canvas);texture.colorSpace=SRGBColorSpace;
  const geometry=new PlaneGeometry(0.70,0.875),material=new MeshBasicMaterial({map:texture,toneMapped:false});
  const mesh=new Mesh(geometry,material),group=new Group();group.name='LabelRoom seated review';group.add(mesh);group.visible=false;
  let entity:ReturnType<SpatialWorld['createTransformEntity']>;try{entity=world.createTransformEntity(group,{persistent:false})}catch(error){for(const close of[()=>group.clear(),()=>geometry.dispose(),()=>material.dispose(),()=>texture.dispose()])try{close()}catch{}throw error}
  const gate=createHandIntentGate(),caster=new Raycaster();
  const rays={} as Record<Hand,{line:Line;geometry:BufferGeometry;material:LineBasicMaterial;positions:BufferAttribute}>;
  for(const hand of ['left','right'] as const){const positions=new BufferAttribute(new Float32Array(6),3),g=new BufferGeometry();g.setAttribute('position',positions);const m=new LineBasicMaterial({color:0x80e1d5,depthTest:false}),line=new Line(g,m);line.frustumCulled=false;line.visible=false;line.renderOrder=3;group.add(line);rays[hand]={line,geometry:g,material:m,positions};}
  let cleanupFailed=false,closed=false,page:'select'|'edit'|'review'='select',buttons:Button[]=[],lastPaint='',hover='',session:XRSession|undefined,recenter=true,lastFrame=0,viewerTracked=false;
  const head=new Vector3(),headRotation=new Quaternion(),headForward=new Vector3(),headRight=new Vector3();
  const targets:Record<Hand,string>={left:'',right:''};
  function context(){return JSON.stringify({page,...port.read()})}
  function wrap(text:string,y:number,lines=3){const words=text.split(/\s+/);let line='',row=0;for(const word of words){const next=line?line+' '+word:word;if(ctx!.measureText(next).width>W-72&&line){ctx!.fillText(line,36,y+row*34);line=word;if(++row>=lines)return}else line=next}if(row<lines)ctx!.fillText(line,36,y+row*34)}
  function paint(){
    if(closed)return;const model=port.read(),state=gate.state(),key=JSON.stringify({model,state,page,hover});if(key===lastPaint)return;lastPaint=key;buttons=[];
    ctx!.fillStyle='#101e2d';ctx!.fillRect(0,0,W,H);ctx!.textAlign='left';ctx!.font='bold 38px system-ui';ctx!.fillStyle='#f2f8ff';ctx!.fillText('LabelRoom · seated review',36,55);
    ctx!.font='27px system-ui';ctx!.fillStyle='#b9eaff';ctx!.fillText('Saved revision '+(model.revision??'—')+' · '+model.phase,36,100);
    ctx!.fillStyle=state.paused?'#ffd28e':'#f2f8ff';wrap(state.paused?state.reason:model.message,145,3);
    function button(key:string,label:string,x:number,y:number,w:number,enabled=true){const b={key,label,x,y,w,h:68,enabled};buttons.push(b);ctx!.fillStyle=!enabled?'#283b49':hover===key?'#b5f4e9':'#80e1d5';ctx!.fillRect(x,y,w,b.h);ctx!.font='26px system-ui';ctx!.fillStyle=enabled?'#08202b':'#91a5b3';ctx!.textAlign='center';const fit=label.length>29?label.slice(0,28)+'…':label;ctx!.fillText(fit,x+w/2,y+44);ctx!.textAlign='left';}
    button(state.paused?'resume':'pause',state.paused?'Resume':'Pause',36,248,300);
    button('recenter','Recenter view',356,248,300,!state.paused);
    ctx!.font='23px system-ui';ctx!.fillStyle='#b9cbd7';ctx!.fillText('Point and pinch. Release on the same control.',36,353);
    for(const [i,p]of(['select','edit','review']as const).entries())button('page:'+p,p.toUpperCase(),36+i*320,380,300,!state.paused);
    if(page==='select'){
      const names:SpatialChoice[]=['frame','object','reason','issue','partner'];
      names.forEach((name,i)=>{const c=model.choices[name],y=480+i*100;button('cycle:'+name+':-1','‹',36,y,100,!state.paused&&!c.disabled);button('cycle:'+name+':1','›',888,y,100,!state.paused&&!c.disabled);ctx!.fillStyle='#f2f8ff';ctx!.font='25px system-ui';ctx!.fillText(name.toUpperCase()+': '+c.value.slice(0,41),156,y+43)});
      ctx!.fillStyle='#b9cbd7';ctx!.font='25px system-ui';wrap('Point at a box and pinch to select it. Amber outlines mark the selected occurrence. Source units are metres.',1030,3);
    }else if(page==='edit'){
      const labels=['X','Y','Z','Length','Width','Height','Yaw °'];
      spatialFields.forEach((name,i)=>{const f=model.fields[name],y=470+i*80;button('nudge:'+name+':-1','−',36,y,110,!state.paused&&!f.disabled);button('nudge:'+name+':1','+',878,y,110,!state.paused&&!f.disabled);ctx!.fillStyle='#f2f8ff';ctx!.font='27px system-ui';ctx!.fillText(labels[i]+': '+f.value.slice(0,30),172,y+43)});
      ctx!.font='24px system-ui';ctx!.fillStyle='#b9cbd7';ctx!.fillText('Each tap: 0.01 m or 1°. Values remain a local draft.',36,1075);
    }else{
      const names:SpatialAction[]=['keep','duplicate','compare','undo','retry','reload','restore','discard'];
      names.forEach((name,i)=>{const a=model.actions[name];button('action:'+name,a.label,36+i%2*484,480+Math.floor(i/2)*100,464,!state.paused&&!a.disabled)});
      ctx!.fillStyle='#b9cbd7';ctx!.font='25px system-ui';wrap('Keep needs a reason. Duplicate removal needs confirmation, then a preview and approval. Recovery stays on this device.',950,4);
    }
    for(const [i,name]of(['preview','approve','reject']as const).entries()){const a=model.actions[name];button('action:'+name,a.label,36+i*320,1150,300,!state.paused&&!a.disabled)}
    ctx!.font='22px system-ui';ctx!.fillStyle='#b9cbd7';ctx!.fillText('Preview first · Approve explicitly to save · AI never applies edits',36,1250);
    texture.needsUpdate=true;
  }
  function place(){headForward.set(0,0,-1).applyQuaternion(headRotation);headForward.y=0;if(headForward.lengthSq()<0.01)headForward.set(0,0,-1);headForward.normalize();headRight.crossVectors(headForward,new Vector3(0,1,0));group.position.copy(head).addScaledVector(headForward,0.9).addScaledVector(headRight,0.54);group.position.y-=0.07;group.lookAt(head);group.updateWorldMatrix(true,true);view.recenter();recenter=false;}
  function readHand(frame:XRFrame,source:XRInputSource|undefined):{sample:HandSample;ray?:Ray}{
    const reference=world.xrReferenceSpace;if(!source?.hand||!reference||!world.player)return{sample:{tracked:false,open:false}};
    try{
      const pose=frame.getPose(source.targetRaySpace,reference),wrist=source.hand.get('wrist'),index=source.hand.get('index-finger-tip'),thumb=source.hand.get('thumb-tip');
      const wristPose=wrist&&frame.getJointPose?.(wrist,reference),indexPose=index&&frame.getJointPose?.(index,reference),thumbPose=thumb&&frame.getJointPose?.(thumb,reference);
      if(!pose||!wristPose||!indexPose||!thumbPose||[...pose.transform.matrix].some(v=>!Number.isFinite(v)))return{sample:{tracked:false,open:false}};
      world.player.updateWorldMatrix(true,false);
      const p=pose.transform.position,q=pose.transform.orientation,origin=new Vector3(p.x,p.y,p.z).applyMatrix4(world.player.matrixWorld),direction=new Vector3(0,0,-1).applyQuaternion(new Quaternion(q.x,q.y,q.z,q.w)).transformDirection(world.player.matrixWorld);
      const a=indexPose.transform.position,b=thumbPose.transform.position,open=Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z)>0.035;
      return{sample:{tracked:true,open},ray:new Ray(origin,direction)};
    }catch{return{sample:{tracked:false,open:false}}}
  }
  function target(ray:Ray){
    caster.ray.copy(ray);caster.near=0;caster.far=5;group.updateWorldMatrix(true,true);
    const panelHit=caster.intersectObject(mesh,false)[0],box=gate.state().paused?undefined:view.pick(ray);
    if(panelHit?.uv&&(!box||panelHit.distance<=box.distance)){const x=panelHit.uv.x*W,y=(1-panelHit.uv.y)*H,b=buttons.find(b=>b.enabled&&x>=b.x&&x<=b.x+b.w&&y>=b.y&&y<=b.y+b.h);return{key:b?.key??'',distance:panelHit.distance}}
    return{key:box?'box:'+encodeURIComponent(box.frameId)+':'+encodeURIComponent(box.objectId):'',distance:box?.distance??1.5};
  }
  function samples(frame:XRFrame){
    const sources=session?[...session.inputSources]:[],left=readHand(frame,sources.find(s=>s.hand&&s.handedness==='left')),right=readHand(frame,sources.find(s=>s.hand&&s.handedness==='right'));
    gate.sample({visible:session?.visibilityState==='visible'&&doc.visibilityState!=='hidden',viewerTracked:viewerTracked&&performance.now()-lastFrame<150,left:left.sample,right:right.sample});
    return {left,right};
  }
  function activate(key:string){
    if(closed)return;
    if(key==='resume')return;
    if(key==='pause'){gate.pause();return}
    if(key==='recenter'){recenter=true;return}
    if(key.startsWith('page:')){page=key.slice(5)as typeof page;return}
    const [kind,name,delta]=key.split(':');
    if(kind==='cycle')port.cycle(name as SpatialChoice,Number(delta)as -1|1);
    if(kind==='nudge')port.nudge(name as SpatialField,Number(delta)as -1|1);
    if(kind==='action')port.activate(name as SpatialAction);
    if(kind==='box')port.select(decodeURIComponent(name),decodeURIComponent(delta));
  }
  function gesture(event:XRInputSourceEvent,ending:boolean){
    if(closed||!event.inputSource.hand||!['left','right'].includes(event.inputSource.handedness))return;
    const hand=event.inputSource.handedness as Hand;
    try{const reading=samples(event.frame)[hand];paint();const key=reading.ray?target(reading.ray).key:'';if(ending){const accepted=gate.end(hand,key,context());if(accepted)activate(accepted)}else gate.begin(hand,key,context());paint()}catch{gate.pause('Input could not be checked. Release your pinch and resume.');paint()}
  }
  const start=(e:XRInputSourceEvent)=>gesture(e,false),end=(e:XRInputSourceEvent)=>gesture(e,true);
  function sessionPause(){gate.pause('Session changed. Release your pinch, then choose Resume.');paint()}
  function sessionEnd(){group.visible=false;for(const h of ['left','right']as const)rays[h].line.visible=false;sessionPause();unbind();}
  function unbind(){session?.removeEventListener('selectstart',start);session?.removeEventListener('selectend',end);session?.removeEventListener('visibilitychange',sessionPause);session?.removeEventListener('inputsourceschange',sessionPause);session?.removeEventListener('end',sessionEnd);session=undefined;}
  function bind(next:XRSession){unbind();session=next;gate.pause();recenter=true;next.addEventListener('selectstart',start);next.addEventListener('selectend',end);next.addEventListener('visibilitychange',sessionPause);next.addEventListener('inputsourceschange',sessionPause);next.addEventListener('end',sessionEnd);}
  let stop=()=>{};
  try{stop=world.onXRFrame(frame=>{
    if(closed)return;
    try{
      const next=world.xrSession,reference=world.xrReferenceSpace;if(!next||!reference||!world.player)return;if(next!==session)bind(next);
      const viewer=frame.getViewerPose(reference);viewerTracked=!!viewer;lastFrame=performance.now();
      if(viewer){world.player.updateWorldMatrix(true,false);const p=viewer.transform.position,q=viewer.transform.orientation;head.set(p.x,p.y,p.z).applyMatrix4(world.player.matrixWorld);headRotation.set(q.x,q.y,q.z,q.w).premultiply(world.player.getWorldQuaternion(new Quaternion()));if(recenter)place();}
      group.visible=!!viewer&&next.visibilityState==='visible';paint();const reading=samples(frame);let hovered='';
      for(const h of ['left','right']as const){const r=reading[h],visual=rays[h];visual.line.visible=group.visible&&!!r.ray;if(!r.ray){targets[h]='';continue}const hit=target(r.ray);targets[h]=hit.key;if(hit.key)hovered=hit.key;const from=group.worldToLocal(r.ray.origin.clone()),to=group.worldToLocal(r.ray.at(hit.distance,new Vector3()));visual.positions.array.set([...from,...to]);visual.positions.needsUpdate=true;visual.material.color.setHex(hit.key?0xffc45c:0x80e1d5);}
      hover=hovered;const model=port.read();view.highlight(model.choices.frame.value,model.choices.object.value);paint();
    }catch{gate.pause('Spatial controls are paused after a display or tracking error.');paint()}
  });
  }catch(error){try{dispose()}catch{}throw error}
  doc.addEventListener('visibilitychange',sessionPause);
  function onAbort(){try{dispose()}catch{cleanupFailed=true}}
  function dispose(){if(closed){if(cleanupFailed)throw Error('Spatial panel cleanup failed.');return}closed=true;stop();unbind();doc.removeEventListener('visibilitychange',sessionPause);signal.removeEventListener('abort',onAbort);gate.dispose();let failed=false;for(const close of[()=>entity.dispose({disposeResources:false}),()=>group.removeFromParent(),()=>group.clear(),()=>geometry.dispose(),()=>material.dispose(),()=>texture.dispose(),...(['left','right']as const).flatMap(h=>[()=>rays[h].geometry.dispose(),()=>rays[h].material.dispose()])])try{close()}catch{failed=true}if(failed){cleanupFailed=true;throw Error('Spatial panel cleanup failed.');}}
  signal.addEventListener('abort',onAbort,{once:true});try{if(signal.aborted)dispose();else paint()}catch(error){try{dispose()}catch{}throw error}
  return{dispose};
}
