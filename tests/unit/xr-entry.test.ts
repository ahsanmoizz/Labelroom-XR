import {it} from 'vitest';
import assert from 'node:assert/strict';
import {mountXrEntry} from '../../src/ui/xr-entry';
const tick=async()=>{for(let i=0;i<5;i++)await Promise.resolve()};
function fixture(support=true){
 const timers=new Map();let id=0,dataset=false,launches=0;
 const win={navigator:{xr:{async isSessionSupported(){return support}}},setInterval(fn){timers.set(++id,fn);return id},clearInterval(key){timers.delete(key)}};
 class Element{children=[];handlers=new Map();disabled=false;textContent='';parent;
  constructor(readonly ownerDocument:any){}setAttribute(){}append(...nodes){for(const n of nodes){this.children.push(n);n.parent=this}}remove(){if(this.parent)this.parent.children=this.parent.children.filter(n=>n!==this)}addEventListener(n,fn){this.handlers.set(n,fn)}removeEventListener(n){this.handlers.delete(n)}click(){this.handlers.get('click')?.()}}
 const doc={defaultView:win,createElement(){return new Element(doc)}},root=new Element(doc),controller=new AbortController();
 const world={sessionRequestPending:false,xrSession:undefined,launchXR(){launches++;world.sessionRequestPending=true}};
 const view=mountXrEntry(root as any,world as any,controller.signal,()=>dataset),section=root.children[0],button=section.children[0],status=section.children[1];
 return{world,view,root,button,status,controller,timers,load(){dataset=true;view.refresh()},poll(){for(const fn of [...timers.values()])fn()},get launches(){return launches}};
}
it('manual XR never requests automatically and duplicate clicks share the SDK pending gate',async()=>{const f=fixture();await tick();assert(f.button.disabled);f.load();assert(!f.button.disabled);assert.equal(f.launches,0);f.button.click();f.button.click();assert.equal(f.launches,1);assert(f.button.disabled);f.world.sessionRequestPending=false;f.poll();assert.match(f.status.textContent,/XR did not open/);assert(!f.button.disabled);f.view.dispose();assert.equal(f.timers.size,0);assert.equal(f.root.children.length,0)});
it('unsupported XR leaves desktop use available and cannot launch',async()=>{const f=fixture(false);await tick();f.load();assert(f.button.disabled);f.button.click();assert.equal(f.launches,0);assert.match(f.status.textContent,/Desktop review is ready/);f.view.dispose()});
it('account abort retires a late SDK session after an in-flight permission request',async()=>{const f=fixture();await tick();f.load();f.button.click();f.controller.abort();assert.equal(f.root.children.length,0);assert.equal(f.timers.size,1);let ended=0;f.world.xrSession={end:async()=>{ended++}};f.world.sessionRequestPending=false;f.poll();await tick();assert.equal(ended,1);assert.equal(f.timers.size,0);f.button.click();assert.equal(f.launches,1)});
it('active session exit is explicit and cleanup handles rejected end promises',async()=>{const f=fixture();await tick();f.load();let ended=0;const session=new EventTarget();session.end=async()=>{ended++;throw Error('synthetic already ended')};f.world.xrSession=session;f.poll();assert.equal(f.button.textContent,'Exit XR');f.button.click();await tick();assert.match(f.status.textContent,/XR did not close/);f.view.dispose();await tick();assert.equal(ended,2);assert.equal(f.timers.size,0)});
it('aborting before support resolution cannot resurrect an XR control',async()=>{const f=fixture();f.controller.abort();await tick();assert.equal(f.root.children.length,0);assert.equal(f.timers.size,0);assert.equal(f.launches,0)});
