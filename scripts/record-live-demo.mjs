import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = process.argv[2];
assert(output && path.isAbsolute(output) && !fs.existsSync(output), 'Pass a new absolute recording directory.');
fs.mkdirSync(output, { recursive: true });
const origin = 'https://labelroom-xr.pages.dev';
const headed = process.argv.includes('--headed');
const injection = buildSync({
  stdin: { resolveDir: root, contents: `
    import {XRDevice,metaQuest3} from 'iwer';
    import {Vector3,Quaternion,Group} from 'three';
    if(window.top===window&&location.origin===${JSON.stringify(origin)}){
      const device=new XRDevice(metaQuest3);device.primaryInputMode='hand';device.installRuntime({forceInstall:true});
      const state={device,session:null,reference:null,panelPose:null,frames:0,events:[]};
      const request=navigator.xr.requestSession.bind(navigator.xr);
      navigator.xr.requestSession=(...args)=>request(...args).then(session=>{
        state.session=session;state.panelPose=null;
        session.addEventListener('end',()=>{if(state.session===session){state.session=null;state.reference=null}}, {once:true});
        const reference=session.requestReferenceSpace.bind(session);
        session.requestReferenceSpace=(...args)=>reference(...args).then(space=>{if(args[0]==='local-floor'||!state.reference)state.reference=space;return space});
        for(const type of ['selectstart','selectend'])session.addEventListener(type,event=>state.events.push({type,hand:event.inputSource.handedness}));
        return session;
      });
      async function frames(n=6){await new Promise(resolve=>{const tick=(time,frame)=>{state.frames++;const pose=state.reference&&frame.getViewerPose(state.reference);if(pose&&!state.panelPose)state.panelPose={position:[pose.transform.position.x,pose.transform.position.y,pose.transform.position.z],rotation:[pose.transform.orientation.x,pose.transform.orientation.y,pose.transform.orientation.z,pose.transform.orientation.w]};if(--n<=0)resolve();else state.session.requestAnimationFrame(tick)};state.session.requestAnimationFrame(tick)})}
      async function tap(hand,x,y){
        await frames();if(!state.panelPose)throw Error('No emulated viewer pose');
        const head=new Vector3(...state.panelPose.position),rotation=new Quaternion(...state.panelPose.rotation),forward=new Vector3(0,0,-1).applyQuaternion(rotation);forward.y=0;forward.normalize();
        const right=new Vector3().crossVectors(forward,new Vector3(0,1,0));const panel=new Group();panel.position.copy(head).addScaledVector(forward,.9).addScaledVector(right,.54);panel.position.y-=.07;panel.lookAt(head);panel.updateWorldMatrix(true,true);
        const target=panel.localToWorld(new Vector3((x/1024-.5)*.7,(.5-y/1280)*.875,.003));
        const start=new Vector3(hand==='left'?-.2:.2,1.4,0),q=new Quaternion().setFromUnitVectors(new Vector3(0,0,-1),target.sub(start).normalize());
        const input=device.hands[hand];input.updatePinchValue(0);input.position.set(start.x,start.y,start.z);input.quaternion.set(q.x,q.y,q.z,q.w);await frames();input.updatePinchValue(1);await frames();input.updatePinchValue(0);await frames();
      }
      window.labelxrDemoRecorder={tap,frames,async exit(){await state.session?.end()},state(){return{active:!!state.session&&!state.session.ended,frames:state.frames,events:state.events.length,inputs:state.session?[...state.session.inputSources].map(x=>({hand:x.handedness,joints:x.hand?.size||0})):[]}}};
    }
  ` },
  bundle: true, platform: 'browser', format: 'iife', target: 'esnext', write: false, logLevel: 'silent',
}).outputFiles[0].text;

const report = { schema: 'labelxr-live-emulator-recording/v1', origin, commit: process.env.GITHUB_SHA || null, realHostedBackend: true, syntheticBackend: false, emulatedQuest: true, physicalQuestTested: false, passed: false, steps: [], pageErrors: [], agentResponses: [] };
let browser, context, page, video;
const begun = Date.now();
const mark = name => report.steps.push({ name, elapsedSeconds: Math.round((Date.now() - begun) / 1000), passed: true });
async function caption(text) {
  await page.evaluate(text => {
    let box = document.getElementById('labelxr-recording-caption');
    if (!box) { box = document.createElement('div'); box.id = 'labelxr-recording-caption'; box.style.cssText = 'position:fixed;left:24px;right:24px;bottom:18px;z-index:2147483647;padding:14px 20px;border-radius:10px;background:rgba(7,17,29,.94);color:#ecfffa;font:600 19px system-ui;pointer-events:none;border:1px solid #4f9f93'; document.body.append(box); }
    box.textContent = 'QUEST 3 EMULATION  |  ' + text;
  }, text);
}
async function tab(name) {
  const item = page.getByRole('tab', { name, exact: true });
  if (await item.count()) await item.click();
}
async function button(name) { await page.getByRole('button', { name, exact: true }).click(); }
const revision = () => page.locator('[data-saved-revision]').first().getAttribute('data-saved-revision');
async function hand(name, x, y) { await page.evaluate(([name,x,y]) => window.labelxrDemoRecorder.tap(name,x,y), [name,x,y]); }
try {
  browser = await chromium.launch({ headless: !headed, ...(process.env.LABELXR_CHROMIUM_PATH ? { executablePath: process.env.LABELXR_CHROMIUM_PATH } : {}), args: process.platform === 'linux' ? ['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] : [] });
  context = await browser.newContext({ viewport: { width: 1600, height: 900 }, recordVideo: { dir: path.join(output,'raw-video'), size: { width:1600,height:900 } }, acceptDownloads: true });
  page = await context.newPage(); video = page.video();
  await page.addInitScript({ content: injection });
  page.on('pageerror', error => report.pageErrors.push(error.message.slice(0,400)));
  page.on('response', response => { if (new URL(response.url()).pathname === '/functions/v1/agent') report.agentResponses.push({ status: response.status() }); });
  await page.goto(origin, { waitUntil:'domcontentloaded' });
  // Only the normal no-account route is used. No CAPTCHA token is manufactured,
  // no security widget is clicked, and no authentication or backend is mocked.
  report.stage = 'normal-demo-security-check';
  const enter = page.getByRole('button',{name:'Enter demo',exact:true});
  await enter.waitFor({state:'visible',timeout:30_000});
  console.log(headed ? 'Complete any security check normally in the browser. Then leave the window alone while recording runs.' : 'Waiting for the ordinary automatic security check; an interactive challenge stops this attempt.');
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b=>b.textContent==='Enter demo'&&!b.disabled),{},{timeout:headed?300_000:60_000});
  await enter.click(); mark('Normal anonymous sign-in');
  report.stage = 'licensed-demo-load';
  await page.getByRole('button',{name:'Open PandaSet demo',exact:true}).waitFor({timeout:60_000});
  await button('Open PandaSet demo');
  await page.locator('[data-saved-revision]').first().waitFor({state:'attached',timeout:90_000});
  await page.waitForFunction(()=>!!document.querySelector('[data-saved-revision]')?.getAttribute('data-saved-revision'));
  await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='Preview edit'&&!b.disabled));
  const initial = Number(await revision()); assert.equal(initial,0,'A fresh revision-zero demo is required.');
  mark('Real licensed PandaSet demo loaded');
  report.recordingStartSeconds = report.steps.at(-1).elapsedSeconds;
  await caption('Review existing 3D labels against real licensed scan points.'); await page.waitForTimeout(6000);
  report.stage = 'manual-xr-entry';
  await button('Enter XR');
  await page.waitForFunction(()=>window.labelxrDemoRecorder?.state().inputs.length===2);
  await page.evaluate(()=>window.labelxrDemoRecorder.frames(12));
  mark('Actual hosted application entered emulated XR with two hands');
  await caption('A seated spatial workspace. No physical headset is being used.'); await page.waitForTimeout(7000);
  report.stage = 'hand-review';
  await hand('left',186,282); // Explicit Resume after entering XR.
  await hand('left',516,414); // Edit tab.
  await hand('right',933,504); // One 0.01 m X step.
  await hand('left',186,1184); // Preview.
  await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='Approve and save'&&!b.disabled));
  await caption('Preview first. A proposed change has not been saved.'); await page.waitForTimeout(5000);
  await hand('right',826,1184); // Reject.
  await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='Preview edit'&&!b.disabled));
  assert.equal(Number(await revision()),initial); mark('Emulated hand preview and reject preserved saved labels');
  await hand('left',933,504); await hand('left',186,1184);
  await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='Approve and save'&&!b.disabled));
  await hand('right',506,1184);
  await page.waitForFunction(r=>Number(document.querySelector('[data-saved-revision]')?.getAttribute('data-saved-revision'))===r,initial+1);
  mark('Explicit hand approval saved exactly one real hosted revision');
  await caption('Approve explicitly. The saved revision and audit advance together.'); await page.waitForTimeout(6000);
  await hand('left',832,282); await hand('right',268,514); await hand('left',186,814);
  await caption('Isolate a label and inspect source-axis depth projections.'); await page.waitForTimeout(6000);
  await hand('right',752,614); await page.waitForTimeout(4000); await hand('left',268,714);
  mark('Emulated hand isolation, depth projection, rotation and reset invoked');
  await page.evaluate(()=>window.labelxrDemoRecorder.exit());
  await tab('AI');
  report.stage = 'bounded-live-ai';
  await button('Check AI availability');
  const consent = page.getByLabel('Allow AI inspection for this project',{exact:true});
  await consent.check(); await button('Save AI consent');
  await page.getByRole('button',{name:'Ask AI to inspect',exact:true}).waitFor();
  await page.getByLabel('AI inspection question',{exact:true}).fill('Measure the selected box point support using the inspection tool. Explain the measured count and uncertainty. Do not save or change any labels.');
  await caption('Optional live AI measures the selection. It never approves edits.');
  await button('Ask AI to inspect');
  await page.waitForFunction(()=>document.querySelector('[data-ai-status]')?.getAttribute('data-ai-status')==='complete',{},{timeout:90_000});
  assert.equal(Number(await revision()),initial+1); mark('Real bounded AI inspection left the saved revision unchanged');
  await page.waitForTimeout(6000); await consent.uncheck(); await button('Save AI consent');
  await page.waitForFunction(()=>document.querySelector('[data-ai-status]')?.getAttribute('data-ai-status')==='consent-required');
  report.temporaryConsentRevoked=true;mark('Temporary consent revoked');
  await tab('History'); await button('Preview last-edit undo'); await tab('Review'); await button('Approve and save');
  await page.waitForFunction(r=>Number(document.querySelector('[data-saved-revision]')?.getAttribute('data-saved-revision'))===r,initial+2);
  mark('Explicit approved undo saved revision two');
  await caption('Undo is a new audited revision. The source scan stays intact.'); await page.waitForTimeout(5000);
  report.stage = 'refresh-export';
  const debuggerSession=await context.newCDPSession(page);await debuggerSession.send('Network.setCacheDisabled',{cacheDisabled:true});
  await page.reload({waitUntil:'domcontentloaded'});
  await page.waitForFunction(r=>Number(document.querySelector('[data-saved-revision]')?.getAttribute('data-saved-revision'))===r,initial+2,{timeout:90_000});
  mark('Hard reload reopened the same saved revision');
  await tab('History');
  const downloaded = page.waitForEvent('download'); await button('Export saved revision');
  const file = await downloaded; await file.saveAs(path.join(output,'saved-export.lrx.zip'));
  mark('Real saved export downloaded');
  await caption('Export corrected labels, original points and the review history.'); await page.waitForTimeout(8000);
  report.finalRevision = Number(await revision());
  report.passed = report.pageErrors.length===0;
  report.stage = 'complete';
} catch(error) {
  report.error = error.message.slice(0,1500);
  if(page){await page.screenshot({path:path.join(output,'stopped.png')}).catch(()=>{});report.visibleText=await page.locator('body').innerText().then(t=>t.slice(0,16000)).catch(()=>null);}
  process.exitCode=1;
} finally {
  // Revoke the recorder's own temporary project consent even if filming stopped.
  if(page){
    try{
      await page.evaluate(()=>window.labelxrDemoRecorder?.exit());
      await tab('AI');
      const consent=page.getByLabel('Allow AI inspection for this project',{exact:true});
      if(await consent.count()&&await consent.isChecked()&&await consent.isEnabled()){
        await consent.uncheck();await button('Save AI consent');
        await page.waitForFunction(()=>document.querySelector('[data-ai-status]')?.getAttribute('data-ai-status')==='consent-required',{},{timeout:15_000});
        report.temporaryConsentRevoked=true;
      }
    }catch{report.consentCleanupUnverified=true;}
  }
  report.durationSeconds=Math.round((Date.now()-begun)/1000);
  await context?.close();
  if(video)await video.saveAs(path.join(output,'labelroom-live-emulator.webm')).catch(()=>{});
  await browser?.close();
  fs.writeFileSync(path.join(output,'recording-report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({passed:report.passed,stage:report.stage,steps:report.steps.length,error:report.error}));
  if(!report.passed)process.exitCode=1;
}
