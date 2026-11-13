// Actual application panels and store, with an explicit scene/backend fixture.
export async function prepareLayout(api,current,options={}){
 const doc=document;
 if(!doc.getElementById('workspace-css'))await new Promise((resolve,reject)=>{const link=doc.createElement('link');link.id='workspace-css';link.rel='stylesheet';link.href='/workspace.css';link.onload=resolve;link.onerror=reject;doc.head.append(link)});
 doc.getElementById('status').hidden=true;
 const account=doc.createElement('aside'),sceneRoot=doc.createElement('div'),controller=new AbortController();
 account.id='account-container';account.setAttribute('aria-label','Account access');sceneRoot.id='scene-container';sceneRoot.setAttribute('aria-label','Review workspace');
 const workspace=doc.getElementById('workspace');workspace.remove();doc.body.append(account,sceneRoot);
 const auth={getState:()=>({phase:'signed-in',user:{id:current.scope.ownerId,kind:'guest'},resendAfterSeconds:0}),subscribe:()=>()=>{},signOut:async()=>({ok:true})};
 const challenge={getState:()=>({status:'idle'}),subscribe:()=>()=>{},pause(){},dispose(){}};
 const captchaElement=doc.createElement('div');
 const login=api.mountLoginPanel(account,auth,challenge,{captchaElement,every:()=>()=>{}});
 const makeProject=()=>({original:current.source,project:current.model.head(),labels:{document:current.model.version().label_doc}});
 let ai;
 const owner=await api.createDatasetWorkspace(async()=>async host=>{
  const placeholder=doc.createElement('div');placeholder.setAttribute('aria-label','Layout fixture scene');placeholder.textContent='Layout check only · synthetic backend · 3D rendering not exercised';
  placeholder.style.cssText='height:100%;display:grid;place-items:center;padding:32px;text-align:center;color:#b8c9d5;background:radial-gradient(ellipse at center,#17313b,#050c13 70%);font:14px/1.6 system-ui';host.append(placeholder);
  return{exitXR(){},destroy(){},createTransformEntity(){throw Error('No scene entity should be created by a layout fixture')},renderer:{dispose(){},domElement:placeholder}};
 },{
  createView:()=>({showFrame(){},setScale(){},resetView(){},dispose(){}}),
  guestDemo:async()=>{if(options.guestDelayMs)await new Promise(resolve=>setTimeout(resolve,options.guestDelayMs));if(options.guestFailure)throw Error('Synthetic guest open failure');return makeProject()},resetGuestDemo:async()=>makeProject(),
  review:(root,_signal,_context,_project,presentation)=>{root.append(workspace);ai=api.mountAgentPanel(workspace,{store:current.workspace.store,signal:controller.signal,selection:()=>({frameId:current.source.frames[0].id,objectId:current.source.frames[0].boxes[0].id}),service:{request:async()=>{throw Error('No live AI provider in the layout fixture')}},focus:()=>false,preview:async()=>false});presentation.phase('ready');return{store:current.workspace.store,dispose(){}}}
 })(sceneRoot,controller.signal,{user:{id:current.scope.ownerId,kind:'guest'},config:{}});
 const originalDispose=window.labelxrBrowser.dispose;
 window.labelxrBrowser.dispose=()=>{ai?.dispose();login.dispose();controller.abort();owner.dispose();originalDispose()};
 return{syntheticBackend:true,gpuTested:false};
}
