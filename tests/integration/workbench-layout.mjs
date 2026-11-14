import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/** Actual mounted controls and CSS. No provider requests or GPU claim. */
export async function runLayoutCases(context, url, screenshots) {
 const cases=[];
 if(screenshots){assert(path.isAbsolute(screenshots));fs.mkdirSync(screenshots,{recursive:true})}
 for(const [width,height] of [[1792,1024],[1440,900],[1366,768],[1100,800],[900,900],[768,1024],[640,480],[390,844],[320,800]]){
  const p=await context.newPage(), errors=[];p.on('pageerror',e=>errors.push(e.message));
  try{
   await p.setViewportSize({width,height});await p.goto(url,{waitUntil:'load'});await p.waitForFunction(()=>!!window.labelxrBrowser);
   await p.evaluate(()=>window.labelxrBrowser.setup({variant:'multi',projectId:crypto.randomUUID()}));
   await p.waitForFunction(()=>window.labelxrBrowser.state().phase==='ready');await p.evaluate(()=>window.labelxrBrowser.prepareLayout());
   await p.getByRole('button',{name:'Open PandaSet demo',exact:true}).click();
   await p.getByRole('button',{name:'Preview edit',exact:true}).waitFor();
   assert.equal(await p.getByRole('tab',{name:'Review',exact:true}).getAttribute('aria-selected'),'true');
   const measured=[];
   for(const name of ['Dataset','Review','Checks','History','AI']){
    await p.getByRole('tab',{name,exact:true}).click();
    measured.push(await p.evaluate(()=>{
     const r=e=>{const x=e.getBoundingClientRect();return{x:x.x,y:x.y,right:x.right,bottom:x.bottom,width:x.width,height:x.height}};
     const visible=e=>!!e.getClientRects().length;
     const panel=document.querySelector('.dataset-panel'),pane=panel.querySelector('[role=tabpanel]:not([hidden])');
     const fields=[...pane.querySelectorAll('input:not([type=range]):not([type=checkbox]):not([type=file]),select,textarea')].filter(visible).map(e=>({label:e.getAttribute('aria-label'),rect:r(e),font:parseFloat(getComputedStyle(e).fontSize)}));
     const buttons=[...pane.querySelectorAll('button')].filter(visible).map(e=>({text:e.textContent,rect:r(e)}));
     const overlaps=[];
     for(const grid of pane.querySelectorAll('.action-grid')){
      const children=[...grid.children].filter(visible);for(let i=0;i<children.length;i++)for(let j=i+1;j<children.length;j++){
       const a=r(children[i]),b=r(children[j]);if(Math.min(a.right,b.right)-Math.max(a.x,b.x)>1&&Math.min(a.bottom,b.bottom)-Math.max(a.y,b.y)>1)overlaps.push([children[i].textContent,children[j].textContent]);
      }
     }
     return{panel:r(panel),fields,buttons,overlaps,pageWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth,panelScrollWidth:panel.scrollWidth,panelClientWidth:panel.clientWidth};
    }));
   }
   for(const m of measured){
    assert(m.pageWidth<=m.clientWidth+1,'Horizontal document overflow');assert(m.panelScrollWidth<=m.panelClientWidth+1,'Horizontal inspector overflow');
    assert(m.panel.x>=0&&m.panel.right<=width+1&&m.panel.bottom<=height+1,'Inspector escapes viewport '+JSON.stringify({width,height,panel:m.panel}));assert.equal(m.overlaps.length,0,'Actions overlap');
    for(const f of m.fields){assert(f.rect.height>=47&&f.font>=16,'Field too small: '+f.label);assert(f.rect.x>=m.panel.x&&f.rect.right<=m.panel.right+1,'Field escapes inspector');}
    for(const b of m.buttons)assert(b.rect.height>=47&&b.rect.width>=44,'Button too small: '+b.text);
   }
   assert(measured.reduce((n,m)=>n+m.fields.length,0)>=13,'Existing selection/geometry/AI fields missing');
   await p.getByRole('tab',{name:'AI',exact:true}).click();const question=p.getByLabel('AI inspection question',{exact:true});await question.fill('Inspect without changing saved labels.');
   await p.getByRole('tab',{name:'Review',exact:true}).click();const x=p.getByLabel('X (metres)',{exact:true});await x.fill('0.375');await p.getByText('Typed edit preserved on this device.',{exact:false}).waitFor({state:'attached'});
   await p.getByRole('tab',{name:'History',exact:true}).click();assert.equal(await p.getByRole('button',{name:'Download recovery draft',exact:true}).isDisabled(),true);
   await p.getByRole('tab',{name:'AI',exact:true}).click();assert.equal(await question.inputValue(),'Inspect without changing saved labels.');
   await p.getByRole('tab',{name:'Review',exact:true}).click();assert.equal(await x.inputValue(),'0.375');
   const before=await p.evaluate(()=>window.labelxrBrowser.state());
   await p.getByRole('button',{name:'Hide controls',exact:true}).click();assert.equal(await x.isVisible(),false);
   await p.getByRole('button',{name:'Show controls',exact:true}).click();assert.equal(await x.inputValue(),'0.375');
   await p.getByRole('button',{name:'Show account',exact:true}).click();assert.equal(await p.getByRole('button',{name:'Sign out',exact:true}).isVisible(),true);
   await p.getByRole('button',{name:'Focus scene',exact:true}).click();assert.equal(await x.isVisible(),false);assert.equal(await p.getByRole('button',{name:'Sign out',exact:true}).isVisible(),false);
   await p.getByRole('button',{name:'Restore panels',exact:true}).click();assert.equal(await x.inputValue(),'0.375');assert.equal(await p.getByRole('button',{name:'Sign out',exact:true}).isVisible(),true);
   await p.getByRole('button',{name:'Hide account',exact:true}).click();
   await p.getByRole('button',{name:'User guide',exact:true}).click();const guide=p.getByRole('dialog',{name:'How to use LabelRoom XR',exact:true});await guide.waitFor();assert.equal(await guide.locator('ol > li').count(),5);
   await p.keyboard.press('Escape');assert.equal(await guide.isVisible(),false);
   assert.deepEqual(await p.evaluate(()=>window.labelxrBrowser.state()),before,'Navigation changed the saved/review state');
   await p.getByRole('button',{name:'Preview edit',exact:true}).click();await p.waitForFunction(()=>window.labelxrBrowser.state().phase==='proposed');
   await p.getByRole('tab',{name:'History',exact:true}).click();await p.getByRole('tab',{name:'Review',exact:true}).click();assert.equal((await p.evaluate(()=>window.labelxrBrowser.state())).attempts,0);
   await p.getByRole('button',{name:'Reject preview',exact:true}).click();await p.waitForFunction(()=>window.labelxrBrowser.state().phase==='ready');assert.equal((await p.evaluate(()=>window.labelxrBrowser.state())).serverRevision,0);
   await p.getByRole('tab',{name:'Dataset',exact:true}).click();await p.getByLabel('Display scale',{exact:true}).waitFor({state:width<=900?'visible':'attached'});
   await p.getByRole('button',{name:'Reset demo',exact:true}).click();await p.getByRole('button',{name:'Keep my demo',exact:true}).click();assert.equal(await p.getByRole('button',{name:'Confirm reset and discard demo edits',exact:true}).count(),0);
   await p.getByRole('tab',{name:'Dataset',exact:true}).focus();await p.keyboard.press('ArrowRight');assert.equal(await p.getByRole('tab',{name:'Review',exact:true}).getAttribute('aria-selected'),'true');
   await x.focus();const focus=await x.evaluate(e=>({style:getComputedStyle(e).outlineStyle,width:parseFloat(getComputedStyle(e).outlineWidth)}));assert.equal(focus.style,'solid');assert(focus.width>=3);
   if(screenshots){await p.screenshot({path:path.join(screenshots,`workbench-${width}x${height}.png`)});if(width===1792)for(const name of ['Dataset','Checks','History','AI']){await p.getByRole('tab',{name,exact:true}).click();await p.screenshot({path:path.join(screenshots,`workbench-${name.toLowerCase()}-${width}x${height}.png`)});}}
   assert.deepEqual(errors,[]);
   cases.push({name:`Graphite workspace ${width} × ${height}`,passed:true,viewport:{width,height},allFiveSectionsMeasured:true,typedValuesAndAiQuestionPreserved:true,proposalPreserved:true,menuAndGuidePassed:true,resetCancelled:true,keyboardTabsPassed:true,horizontalOverflow:false});
  }finally{await p.evaluate(()=>window.labelxrBrowser?.dispose()).catch(()=>{});await p.close()}
 }
 return{schema:'labelxr-responsive-layout-browser/v1',passed:true,count:cases.length,cases,actualDomAndCssMeasured:true,syntheticBackend:true,gpuAcceptancePassed:false,questAcceptancePassed:false};
}
