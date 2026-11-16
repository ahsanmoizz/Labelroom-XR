import {depthViews,type InspectionPort,type InspectionState} from '../xr/inspection';
import {paintDepthProjection} from './depth-canvas';

/** Read-only view tools have no review store or service capability. */
export function mountInspectionControls(root:HTMLElement,get:()=>InspectionPort|undefined,enabled:()=>boolean,changed:()=>void){
 const doc=root.ownerDocument,section=doc.createElement('details'),title=doc.createElement('summary'),status=doc.createElement('p'),actions=doc.createElement('div'),canvas=doc.createElement('canvas');
 section.className='inspection-controls';title.textContent='Object isolation and depth views';status.setAttribute('role','status');status.setAttribute('aria-label','View inspection status');actions.className='action-grid';
 const handlers:(()=>void)[]=[];
 function button(text:string,work:(port:InspectionPort,state:InspectionState)=>void){const b=doc.createElement('button');b.type='button';b.textContent=text;const click=()=>{const port=get();if(b.disabled||!port)return;try{work(port,port.inspection());render();changed();}catch{status.textContent='View inspection is unavailable. Your saved labels are unchanged.';}};b.addEventListener('click',click);handlers.push(()=>b.removeEventListener('click',click));actions.append(b);return b;}
 const isolate=button('Isolate selected object',(p)=>p.setIsolation(true)),all=button('Show all objects',p=>p.setIsolation(false)),left=button('Rotate view left',p=>p.rotateView(-15)),right=button('Rotate view right',p=>p.rotateView(15));
 const label=doc.createElement('label'),mode=doc.createElement('select');label.textContent='Depth projection';mode.setAttribute('aria-label','Depth projection');
 for(const [i,text]of ['3D scene','Top · X/Y','Front · X/Z','Side · Y/Z'].entries()){const option=doc.createElement('option');option.value=depthViews[i];option.textContent=text;mode.append(option);}label.append(mode);
 const change=()=>{const p=get();if(!p||mode.disabled)return;try{p.setDepthView(mode.value as InspectionState['depthView']);render();changed();}catch{status.textContent='Depth projection could not be displayed. The 3D view and saved labels are unchanged.';}};mode.addEventListener('change',change);
 canvas.width=640;canvas.height=400;canvas.hidden=true;canvas.setAttribute('aria-label','Orthographic source-axis depth projection');canvas.setAttribute('role','img');
 const note=doc.createElement('p');note.className='object-meta';note.textContent='Display only. Isolation shows the selected label and points within 0.5 m of its bounds. Depth colours encode the named source axis; they do not mark label errors. Reset view restores the full scene.';
 section.append(title,status,actions,label,canvas,note);root.append(section);let painted=-1,closed=false,lastPort:InspectionPort|undefined,lastKey='';
 function render(){if(closed)return;const port=get();let state:InspectionState|undefined;try{state=port?.inspection()}catch{}const disabled=!state||!enabled();const key=String(state?.version)+'/'+disabled;if(port===lastPort&&key===lastKey)return;if(port!==lastPort)painted=-1;lastPort=port;lastKey=key;isolate.disabled=disabled||!state?.canIsolate||!!state?.isolated;all.disabled=disabled||!state?.isolated;left.disabled=right.disabled=mode.disabled=disabled;
  if(!state){status.textContent='Open a dataset, then select a saved-review object to isolate it.';canvas.hidden=true;return;}
  mode.value=state.depthView;status.textContent=`Frame ${state.frameId} · ${state.isolated?'Isolated object '+state.objectId:'Full scene'} · ${state.shownPoints.toLocaleString('en-US')} displayed / ${state.totalPoints.toLocaleString('en-US')} frame points · view rotation ${state.rotationDegrees}°. Source and saved labels are unchanged.`;
  canvas.hidden=!state.projection;if(state.projection&&painted!==state.version){const ctx=canvas.getContext?.('2d');if(ctx){paintDepthProjection(ctx,state.projection,0,0,canvas.width,canvas.height);painted=state.version;}else{canvas.hidden=true;status.textContent+=' Depth drawing is unavailable in this browser.';}}
 }
 render();return{render,dispose(){if(closed)return;closed=true;lastPort=undefined;status.textContent='';canvas.width=canvas.height=1;handlers.forEach(fn=>fn());mode.removeEventListener('change',change);section.remove();}};
}
