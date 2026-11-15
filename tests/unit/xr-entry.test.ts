import {it} from 'vitest';
import assert from 'node:assert/strict';
import {mountXrEntry} from '../../src/ui/xr-entry';
const tick=async()=>{for(let i=0;i<5;i++)await Promise.resolve()};
function fixture(support=true){
 const timers=new Map();let id=0,dataset=false,launches=0;
 let capability:()=>Promise<boolean>=async()=>support; const xr=Object.assign(new EventTarget(),{isSessionSupported:()=>capability()});
 const win=Object.assign(new EventTarget(),{navigator:{xr},setInterval(fn){timers.set(++id,fn);return id},clearInterval(key){timers.delete(key)}});
 class Element{children=[];handlers=new Map();disabled=false;open=false;textContent='';parent;showModal(){this.open=true}close(){this.open=false}focus(){}
  constructor(readonly ownerDocument:any){}setAttribute(){}append(...nodes){for(const n of nodes){this.children.push(n);n.parent=this}}remove(){if(this.parent)this.parent.children=this.parent.children.filter(n=>n!==this)}addEventListener(n,fn){this.handlers.set(n,fn)}removeEventListener(n){this.handlers.delete(n)}click(){this.handlers.get('click')?.()}}
 const doc=Object.assign(new EventTarget(),{defaultView:win,visibilityState:'visible',createElement(){return new Element(doc)}}),root=new Element(doc),controller=new AbortController();
 const world={sessionRequestPending:false,xrSession:undefined,launchXR(){launches++;world.sessionRequestPending=true}};
 const view=mountXrEntry(root as any,world as any,controller.signal,()=>dataset),section=root.children[0],button=section.children[0],status=section.children[1];
 return{world,view,root,button,status,controller,timers,xr,win,doc,help:section.children[2],capability(fn:()=>Promise<boolean>){capability=fn},load(){dataset=true;view.refresh()},poll(){for(const fn of [...timers.values()])fn()},get launches(){return launches}};
}
it('manual XR never requests automatically and duplicate clicks share the SDK pending gate',async()=>{const f=fixture();await tick();assert(f.button.disabled);f.load();assert(!f.button.disabled);assert.equal(f.launches,0);f.button.click();f.button.click();assert.equal(f.launches,1);assert(f.button.disabled);f.world.sessionRequestPending=false;f.poll();assert.match(f.status.textContent,/XR did not open/);assert(!f.button.disabled);f.view.dispose();assert.equal(f.timers.size,0);assert.equal(f.root.children.length,0)});
it('unsupported XR opens visible setup guidance without making a session request',async()=>{const f=fixture(false);await tick();f.load();assert(!f.button.disabled);assert.equal(f.button.textContent,'XR setup');f.button.click();await tick();assert.equal(f.launches,0);assert(f.help.open);assert.match(f.help.children[1].textContent,/No immersive XR device/);f.view.dispose();assert(!f.help.open)});
it('account abort retires a late SDK session after an in-flight permission request',async()=>{const f=fixture();await tick();f.load();f.button.click();f.controller.abort();assert.equal(f.root.children.length,0);assert.equal(f.timers.size,1);let ended=0;f.world.xrSession={end:async()=>{ended++}};f.world.sessionRequestPending=false;f.poll();await tick();assert.equal(ended,1);assert.equal(f.timers.size,0);f.button.click();assert.equal(f.launches,1)});
it('active session exit is explicit and cleanup handles rejected end promises',async()=>{const f=fixture();await tick();f.load();let ended=0;const session=new EventTarget();session.end=async()=>{ended++;throw Error('synthetic already ended')};f.world.xrSession=session;f.poll();assert.equal(f.button.textContent,'Exit XR');f.button.click();await tick();assert.match(f.status.textContent,/XR did not close/);f.view.dispose();await tick();assert.equal(ended,2);assert.equal(f.timers.size,0)});
it('aborting before support resolution cannot resurrect an XR control',async()=>{const f=fixture();f.controller.abort();await tick();assert.equal(f.root.children.length,0);assert.equal(f.timers.size,0);assert.equal(f.launches,0)});

it('a headset connected after the demo opens enables manual entry without reloading or auto launch',async()=>{
 const f=fixture(false);await tick();f.load();assert.equal(f.button.textContent,'XR setup');f.capability(async()=>true);f.xr.dispatchEvent(new Event('devicechange'));await tick();assert.equal(f.button.textContent,'Enter XR');assert.equal(f.launches,0);f.button.click();assert.equal(f.launches,1);f.world.sessionRequestPending=false;f.view.dispose();
});
it('returning to the browser rechecks capability and never starts a session',async()=>{
 const f=fixture(false);await tick();f.load();f.capability(async()=>true);f.win.dispatchEvent(new Event('focus'));await tick();assert.equal(f.button.textContent,'Enter XR');assert.equal(f.launches,0);f.capability(async()=>false);f.doc.dispatchEvent(new Event('visibilitychange'));await tick();assert.equal(f.button.textContent,'XR setup');f.view.dispose();
});
it('an older availability response cannot overwrite a newer connected device',async()=>{
 const f=fixture(false);await tick();f.load();let release;f.capability(()=>new Promise(resolve=>{release=resolve}));f.xr.dispatchEvent(new Event('devicechange'));f.capability(async()=>true);f.xr.dispatchEvent(new Event('devicechange'));await tick();release(false);await tick();assert.equal(f.button.textContent,'Enter XR');f.view.dispose();
});
it('a rejected capability check still offers visible setup without an unhandled rejection',async()=>{
 const f=fixture();await tick();f.load();f.capability(async()=>{throw Error('synthetic policy denial')});f.xr.dispatchEvent(new Event('devicechange'));await tick();assert.equal(f.button.textContent,'XR setup');f.button.click();await tick();assert(f.help.open);assert.equal(f.launches,0);f.view.dispose();
});
it('a missing WebXR API gives browser guidance and can detect later runtime availability',async()=>{
 const f=fixture(false);await tick();f.load();f.win.navigator.xr=undefined as any;f.win.dispatchEvent(new Event('focus'));await tick();f.button.click();await tick();assert.match(f.help.children[1].textContent,/does not expose WebXR/);f.win.navigator.xr=f.xr;f.capability(async()=>true);f.win.dispatchEvent(new Event('focus'));await tick();assert.equal(f.button.textContent,'Enter XR');assert.equal(f.launches,0);f.view.dispose();
});
it('failed SDK session requests show actionable guidance without retrying the request',async()=>{
 const f=fixture();await tick();f.load();f.button.click();f.world.sessionRequestPending=false;f.poll();assert(f.help.open);assert.match(f.help.children[1].textContent,/site has permission/);assert.equal(f.launches,1);f.poll();assert.equal(f.launches,1);f.view.dispose();
});
it('an explicit availability recheck and closing setup preserve the dataset gate',async()=>{
 const f=fixture(false);await tick();f.load();f.button.click();await tick();f.capability(async()=>true);f.help.children[2].click();await tick();assert.equal(f.button.textContent,'Enter XR');assert.equal(f.launches,0);f.help.children[3].click();assert(!f.help.open);assert(!f.button.disabled);f.view.dispose();
});
