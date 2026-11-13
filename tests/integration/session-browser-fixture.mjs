import {World, XRDevice, metaQuest3, createApplicationHost, createDatasetWorkspace, createChallenge} from './session-bridge.mjs';
import options from './session-options.mjs';
const device = new XRDevice(metaQuest3); device.primaryInputMode = 'hand'; device.installRuntime({forceInstall:true});
const counts = {offers:0, requests:0, worlds:0, disposed:0, frames:0, widgets:0};
const offer = navigator.xr.offerSession.bind(navigator.xr), request = navigator.xr.requestSession.bind(navigator.xr);
navigator.xr.offerSession = (...args) => {counts.offers++; return offer(...args)};
navigator.xr.requestSession = (...args) => {counts.requests++; return request(...args)};
let release, first = true, fail = false, listener, currentWorld;
const held = new Promise(resolve => {release=resolve});
const identity = () => JSON.parse(localStorage.getItem('synthetic-session-identity') || 'null');
const port = {
 async readIdentity(){if(first){first=false;await held;if(fail)return{ok:false,user:null}}return{ok:true,user:identity()}},
 async enterGuest(){const user={id:'22222222-2222-4222-8222-222222222222',anonymous:true,email:null};localStorage.setItem('synthetic-session-identity',JSON.stringify(user));return{ok:true,userId:user.id}},
 async requestCode(){return{ok:true}},async verifyCode(){return{ok:false}},
 async signOut(){localStorage.removeItem('synthetic-session-identity');listener?.('SIGNED_OUT');return{ok:true}},
 listen(fn){listener=fn;return()=>{listener=null}}
};
const challenges=[];
const open = createDatasetWorkspace(async()=>async container=>{
 const world=await World.create(container,options); currentWorld=world; counts.worlds++;
 world.onXRFrame(()=>counts.frames++);const destroy=world.destroy.bind(world);world.destroy=()=>{counts.disposed++;destroy()};return world;
});
const host=createApplicationHost({statusRoot:document.getElementById('setup-status'),accountRoot:document.getElementById('account-container'),privateRoot:document.getElementById('scene-container'),connect:async()=>port,
 challenge(container,key){return createChallenge(container,key,async()=>({render(el,o){counts.widgets++;challenges.push(o);return'fixture-'+counts.widgets},remove(){}}))},openWorkspace:open,reload(){location.reload()}});
const env={VITE_SUPABASE_URL:'https://example.supabase.co',VITE_SUPABASE_PUBLISHABLE_KEY:'sb_publishable_synthetic_session_only',VITE_TURNSTILE_SITE_KEY:'synthetic_session_site_key',VITE_APP_ORIGIN:location.origin};
void host.start(env,'development',location.origin);
window.labelxrSession={releaseInitial(failure=false){fail=failure;release()},solve(){challenges.at(-1).callback('synthetic-session-security-token')},state(){return{...counts,identity:identity()?.id??null,accountState:document.getElementById('account-container').getAttribute('data-account-state'),sessionActive:!!currentWorld?.xrSession,pending:currentWorld?.sessionRequestPending??false,drawCalls:currentWorld?.renderer.info.render.calls??0,inputSources:currentWorld?.xrSession?[...currentWorld.xrSession.inputSources].map(s=>({hand:s.handedness,joints:s.hand?.size??0})):[]}},dispose(){host.dispose();device.uninstallRuntime()}};
window.addEventListener('pagehide',()=>host.dispose(),{once:true});
