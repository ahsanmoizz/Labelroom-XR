import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/** Render the actual screen components; measurements are UI layout, never GPU/XR proof. */
export async function runLayoutCases(context,url,screenshots){
 const cases=[];
 if(screenshots){assert(path.isAbsolute(screenshots));fs.mkdirSync(screenshots,{recursive:true})}
 for(const [width,height]of [[1920,1080],[1366,768],[1100,800],[900,900],[768,1024],[640,480],[390,844],[320,800]]){
  const p=await context.newPage();const errors=[];p.on('pageerror',e=>errors.push(e.message));
  try{
   await p.setViewportSize({width,height});await p.goto(url,{waitUntil:'load'});await p.waitForFunction(()=>!!window.labelxrBrowser);
   await p.evaluate(()=>window.labelxrBrowser.setup({variant:'multi',projectId:crypto.randomUUID()}));
   await p.waitForFunction(()=>window.labelxrBrowser.state().phase==='ready');
   await p.evaluate(()=>window.labelxrBrowser.prepareLayout());
   await p.getByRole('button',{name:'Open PandaSet demo',exact:true}).click();
   await p.getByLabel('AI inspection question',{exact:true}).waitFor();
   await p.getByRole('button',{name:'Preview edit',exact:true}).waitFor();
   const geometry=await p.evaluate(()=>{
    const rect=e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}},visible=e=>e.getClientRects().length>0;
    const panel=document.querySelector('.dataset-panel'),account=document.getElementById('account-container');
    const fields=[...panel.querySelectorAll('input:not([type=range]):not([type=checkbox]):not([type=file]),select,textarea')].filter(visible).map(e=>({label:e.getAttribute('aria-label'),rect:rect(e),font:parseFloat(getComputedStyle(e).fontSize),labelDisplay:getComputedStyle(e.closest('label')).display}));
    const buttons=[...document.querySelectorAll('.dataset-panel button,.account-card button')].filter(visible).map(e=>({text:e.textContent,rect:rect(e)}));
    const collisions=[];
    for(const group of panel.querySelectorAll('.action-grid')){const nodes=[...group.children].filter(visible);for(let i=0;i<nodes.length;i++)for(let j=i+1;j<nodes.length;j++){const a=rect(nodes[i]),b=rect(nodes[j]);if(Math.min(a.right,b.right)-Math.max(a.x,b.x)>1&&Math.min(a.bottom,b.bottom)-Math.max(a.y,b.y)>1)collisions.push([nodes[i].textContent,nodes[j].textContent])}}
    const toolbar=document.querySelector('.workspace-toolbar'),menuButtons=[...toolbar.querySelectorAll('button')].filter(visible).map(e=>({text:e.textContent,rect:rect(e)}));
    return{viewport:innerWidth,documentWidth:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth,panel:rect(panel),panelScrollWidth:panel.scrollWidth,panelClientWidth:panel.clientWidth,account:rect(account),fields,buttons,collisions,toolbar:rect(toolbar),menuButtons,mobileFlow:getComputedStyle(panel).overflowY};
   });
   assert(geometry.scrollWidth<=geometry.documentWidth+1,'Page has horizontal scrolling');
   assert(geometry.panelScrollWidth<=geometry.panelClientWidth+1,'Panel has horizontal scrolling');
   assert(geometry.panel.x>=0&&geometry.panel.right<=width+1,'Panel extends beyond the viewport');
   assert.equal(geometry.collisions.length,0,'Action targets overlap');
   assert(geometry.fields.length>=13,'Expected review and question fields');
   for(const f of geometry.fields){assert(f.rect.height>=47,`Field ${f.label} is too short`);assert(f.font>=16,`Field ${f.label} is too small`);assert.equal(f.labelDisplay,'grid');assert(f.rect.x>=geometry.panel.x&&f.rect.right<=geometry.panel.right,`Field ${f.label} escapes the panel`)}
   for(const b of geometry.buttons)assert(b.rect.width>=44&&b.rect.height>=47,`Button ${b.text} is too small`);
   assert.equal(geometry.menuButtons.length,4);assert(geometry.toolbar.x>=0&&geometry.toolbar.right<=width+1&&geometry.toolbar.bottom<=height+1,'Menu toolbar escapes viewport');
   for(const b of geometry.menuButtons)assert(b.rect.width>=44&&b.rect.height>=47,`Menu button ${b.text} is too small`);
   if(width>900)assert(geometry.panel.bottom<=geometry.toolbar.y,'Toolbar covers the controls panel');
   if(width<=900)assert(geometry.panel.y>=geometry.account.bottom,'Mobile panels overlap instead of stacking');
   const question=p.getByLabel('AI inspection question',{exact:true});await question.fill('Inspect the selected object without changing saved labels.');assert.equal(await question.inputValue(),'Inspect the selected object without changing saved labels.');
   const x=p.getByLabel('X (metres)',{exact:true});await x.fill('0.375');await p.getByText('Typed edit preserved on this device.',{exact:false}).waitFor();
   const beforeMenus=await p.evaluate(()=>window.labelxrBrowser.state());
   await p.getByRole('button',{name:'Hide controls',exact:true}).click();assert.equal(await x.isVisible(),false);
   await p.getByRole('button',{name:'Show controls',exact:true}).click();assert.equal(await x.inputValue(),'0.375');assert.equal(await question.inputValue(),'Inspect the selected object without changing saved labels.');
   await p.getByRole('button',{name:'Hide account',exact:true}).click();assert.equal(await p.getByRole('button',{name:'Sign out',exact:true}).isVisible(),false);
   await p.getByRole('button',{name:'Show account',exact:true}).click();assert.equal(await p.getByRole('button',{name:'Sign out',exact:true}).isVisible(),true);
   await p.getByRole('button',{name:'Focus scene',exact:true}).click();assert.equal(await x.isVisible(),false);assert.equal(await p.getByRole('button',{name:'Sign out',exact:true}).isVisible(),false);
   await p.getByRole('button',{name:'Restore panels',exact:true}).click();assert.equal(await x.inputValue(),'0.375');assert.equal(await p.getByRole('button',{name:'Sign out',exact:true}).isVisible(),true);
   await p.getByRole('button',{name:'User guide',exact:true}).click();const guide=p.getByRole('dialog',{name:'How to use LabelRoom XR',exact:true});await guide.waitFor();assert.equal(await guide.locator('ol > li').count(),5);
   await p.keyboard.press('Escape');assert.equal(await guide.isVisible(),false);assert.equal(await p.getByRole('button',{name:'User guide',exact:true}).evaluate(e=>e===document.activeElement),true);
   await p.getByRole('button',{name:'User guide',exact:true}).click();await p.getByRole('button',{name:'Close guide',exact:true}).click();assert.equal(await guide.isVisible(),false);
   assert.deepEqual(await p.evaluate(()=>window.labelxrBrowser.state()),beforeMenus,'Menu visibility or guidance changed review state');
   await p.getByRole('button',{name:'Preview edit',exact:true}).click();await p.waitForFunction(()=>window.labelxrBrowser.state().phase==='proposed');assert.equal((await p.evaluate(()=>window.labelxrBrowser.state())).attempts,0);
   await p.getByRole('button',{name:'Hide controls',exact:true}).click();await p.getByRole('button',{name:'Show controls',exact:true}).click();assert.equal((await p.evaluate(()=>window.labelxrBrowser.state())).phase,'proposed');assert.equal((await p.evaluate(()=>window.labelxrBrowser.state())).attempts,0);
   await p.getByRole('button',{name:'Reject preview',exact:true}).click();await p.waitForFunction(()=>window.labelxrBrowser.state().phase==='ready');assert.equal((await p.evaluate(()=>window.labelxrBrowser.state())).serverRevision,0);
   await p.getByRole('button',{name:'Reset demo',exact:true}).click();await p.getByRole('button',{name:'Confirm reset and discard demo edits',exact:true}).waitFor();await p.getByRole('button',{name:'Keep my demo',exact:true}).click();
   assert.equal(await p.getByRole('button',{name:'Confirm reset and discard demo edits',exact:true}).count(),0);
   await x.focus();await x.press('Tab');const focus=await p.evaluate(()=>({outline:getComputedStyle(document.activeElement).outlineStyle,width:parseFloat(getComputedStyle(document.activeElement).outlineWidth)}));assert.equal(focus.outline,'solid');assert(focus.width>=3);
   if(screenshots)await p.screenshot({path:path.join(screenshots,`layout-${width}x${height}.png`),fullPage:width<=900});
   assert.deepEqual(errors,[]);
   cases.push({name:`Actual panels at ${width} × ${height}`,passed:true,viewport:{width,height},fieldCount:geometry.fields.length,buttonCount:geometry.buttons.length,horizontalOverflow:false,overlappingTargets:0,minimumTargetHeight:Math.min(...geometry.buttons.map(x=>x.rect.height)),previewRejectPreservedServerRevision:true,keyboardFocusVisible:true,menuTogglePreservedTypedValues:true,menuTogglePreservedProposal:true,focusSceneRestoredPanels:true,guideOpenCloseAndEscapePassed:true,menuToolbarFitsViewport:true});
  }finally{await p.evaluate(()=>window.labelxrBrowser?.dispose()).catch(()=>{});await p.close()}
 }
 return{schema:'labelxr-responsive-layout-browser/v1',passed:true,count:cases.length,cases,actualDomAndCssMeasured:true,syntheticBackend:true,gpuAcceptancePassed:false,questAcceptancePassed:false};
}

/** Portable acceptance collector tested against actual panels and an explicitly synthetic API. */
export async function runLiveProbeCases(context,url){
 const cases=[];
 for(const mode of ['a','b','bad-auth','bad-source']){
  const page=await context.newPage();
  try{
   await page.goto(url,{waitUntil:'load'});await page.waitForFunction(()=>!!window.labelxrBrowser);
   await page.evaluate(()=>window.labelxrBrowser.setup({variant:'live',projectId:crypto.randomUUID()}));await page.waitForFunction(()=>window.labelxrBrowser.state().phase==='ready');
   const r=await page.evaluate(mode=>window.labelxrBrowser.exerciseLiveProbe(mode),mode);
   if(mode==='a'){assert.equal(r.receipt.result,'completed');assert.equal(r.state.serverRevision,0);assert.equal(r.receipt.approvedMutations,0)}
   if(mode==='b'){assert.equal(r.receipt.result,'completed',JSON.stringify({receipt:r.receipt,state:{phase:r.state.phase,message:r.state.message,revision:r.state.revision,serverRevision:r.state.serverRevision,attempts:r.state.attempts}}));assert.equal(r.state.serverRevision,4);assert.equal(r.receipt.approvedMutations,4);assert.equal(r.downloads,1);assert.equal(r.offers.length,1);assert.equal(r.receipt.tests.length,7)}
   if(mode==='bad-auth'||mode==='bad-source'){assert.equal(r.receipt.result,'stopped');assert.equal(r.receipt.approvedMutations,0);assert.equal(r.state.serverRevision,0)}
   cases.push({name:'Portable collector '+mode,passed:true});
  }finally{await page.evaluate(()=>window.labelxrBrowser?.dispose()).catch(()=>{});await page.close()}
 }
 return{passed:true,count:cases.length,cases,actualApplicationControls:true,syntheticCloudApi:true,liveCloudMutationPerformed:false};
}
