import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {buildSync} from 'esbuild';
import {chromium} from 'playwright';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'labelxr-session-'));
const output=process.argv[2];if(!output||!path.isAbsolute(output)||fs.existsSync(output))throw Error('Pass a new absolute report path.');
const config=JSON.parse(fs.readFileSync(path.join(root,'iwsdk.config.json'),'utf8'));assert.equal(config.world.xr.offer,'none');
const options={...config.world,xr:{offer:config.world.xr.offer,sessionMode:'immersive-vr',features:config.world.xr.features}};
const contents=`export {World} from '@iwsdk/core';export {XRDevice,metaQuest3} from 'iwer';export {createApplicationHost} from './src/app/host.ts';export {createDatasetWorkspace} from './src/app/dataset-workspace.ts';export {createChallenge} from './src/services/captcha.ts';`;
buildSync({stdin:{contents,resolveDir:root},bundle:true,format:'esm',platform:'browser',target:'esnext',define:{'import.meta.env.DEV':'false'},outfile:path.join(temp,'bridge.mjs'),logLevel:'silent'});
const assets=new Map([
 ['/session-bridge.mjs',[fs.readFileSync(path.join(temp,'bridge.mjs')),'text/javascript']],
 ['/session-options.mjs',[Buffer.from('export default '+JSON.stringify(options)),'text/javascript']],
 ['/fixture.mjs',[fs.readFileSync(path.join(root,'tests/integration/session-browser-fixture.mjs')),'text/javascript']],
 ['/workspace.css',[fs.readFileSync(path.join(root,'src/ui/workspace.css')),'text/css']],
 ['/brand-mark.svg',[fs.readFileSync(path.join(root,'public/brand-mark.svg')),'image/svg+xml']],
 ['/review-scene.svg',[fs.readFileSync(path.join(root,'public/review-scene.svg')),'image/svg+xml']],
 ['/',[Buffer.from('<!doctype html><html><head><meta charset="utf-8"><style>[hidden]{display:none!important}html,body,#scene-container{height:100%;margin:0}</style><link rel="stylesheet" href="/workspace.css"></head><body><main id="setup-status"></main><aside id="account-container" hidden></aside><div id="scene-container" hidden></div><script type="module" src="/fixture.mjs"></script></body></html>'),'text/html']]
]);
const server=http.createServer((req,res)=>{const a=assets.get(req.url);if(!a){res.writeHead(404).end();return}res.writeHead(200,{'Content-Type':a[1],'Cache-Control':'no-store'});res.end(a[0])});
let browser,page,blocked=0,report;const errors=[],cases=[];
try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 const explicit=process.env.LABELXR_CHROMIUM_PATH;
 browser=await chromium.launch({headless:true,...(explicit?{executablePath:explicit}:{}),args:process.platform==='linux'?['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']:[]});
 const context=await browser.newContext({viewport:{width:1366,height:900}});await context.route('**/*',route=>{if(new URL(route.request().url()).origin===origin)return route.continue();blocked++;return route.abort('blockedbyclient')});
 page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 const state=()=>page.evaluate(()=>window.labelxrSession.state());
 const test=async(name,run)=>{await run();cases.push({name,passed:true})};
 const ready=async()=>{await page.goto(origin);await page.waitForFunction(()=>window.labelxrSession?.state().accountState==='restoring')};
 const noEntry=async()=>{assert.equal(await page.getByRole('button',{name:'Enter demo',exact:true}).isVisible(),false);assert.equal(await page.getByLabel('Email address',{exact:true}).isVisible(),false);assert.equal(await page.getByRole('button',{name:'Enter XR',exact:true}).count(),0)};
 await test('Pending initial verification shows only restoration; no login, CAPTCHA or XR requests',async()=>{await ready();await noEntry();await page.waitForTimeout(500);await noEntry();assert.deepEqual((({offers,requests,worlds,widgets})=>({offers,requests,worlds,widgets}))(await state()),{offers:0,requests:0,worlds:0,widgets:0})});
 await test('Confirmed signed-out entry has no SDK World or offered XR button',async()=>{await page.evaluate(()=>window.labelxrSession.releaseInitial());await page.getByRole('button',{name:'Enter demo',exact:true}).waitFor();assert.equal((await state()).widgets,1);assert.equal((await state()).worlds,0);assert.equal(await page.getByRole('button',{name:'Enter XR',exact:true}).count(),0)});
 await test('Demo verification creates exactly one real SDK World and dataset-gated manual XR control',async()=>{await page.evaluate(()=>window.labelxrSession.solve());await page.getByRole('button',{name:'Enter demo',exact:true}).click();await page.getByRole('button',{name:'Enter XR',exact:true}).waitFor();await page.waitForFunction(()=>window.labelxrSession.state().worlds===1);assert.equal(await page.getByRole('button',{name:'Enter XR',exact:true}).isDisabled(),true);assert.equal((await state()).offers,0);assert.equal((await state()).requests,0)});
 await test('Local dataset becomes XR-ready without requesting a session automatically',async()=>{await page.getByLabel('Choose dataset ZIP',{exact:true}).setInputFiles(path.join(root,'fixtures/contract-example.zip'));await page.waitForFunction(()=>!document.querySelector('.workspace-xr-entry button').disabled);assert.equal((await state()).requests,0);assert.equal((await state()).offers,0)});
 await test('Manual entry starts actual SDK World XR frames with two emulated hands once',async()=>{await page.getByRole('button',{name:'Enter XR',exact:true}).click();await page.waitForFunction(()=>window.labelxrSession.state().sessionActive&&window.labelxrSession.state().frames>4);const s=await state();assert.equal(s.requests,1);assert.equal(s.offers,0);assert(s.drawCalls>0);assert.equal(s.inputSources.length,2);assert(s.inputSources.every(x=>x.joints===25));await page.waitForFunction(()=>!document.querySelector('.workspace-xr-entry button').disabled)});
 await test('Explicit exit and re-entry do not create offered sessions or duplicate Worlds',async()=>{await page.getByRole('button',{name:'Exit XR',exact:true}).click();await page.waitForFunction(()=>!window.labelxrSession.state().sessionActive);await page.getByRole('button',{name:'Enter XR',exact:true}).click();await page.waitForFunction(()=>window.labelxrSession.state().sessionActive&&!window.labelxrSession.state().pending);assert.equal((await state()).requests,2);assert.equal((await state()).offers,0);assert.equal((await state()).worlds,1);await page.getByRole('button',{name:'Exit XR',exact:true}).click();await page.waitForFunction(()=>!window.labelxrSession.state().sessionActive)});
 await test('Full reload keeps login hidden until the same persisted guest is verified',async()=>{const owner=(await state()).identity;await ready();await noEntry();await page.waitForTimeout(500);await noEntry();assert.equal((await state()).widgets,0);await page.evaluate(()=>window.labelxrSession.releaseInitial());await page.getByRole('button',{name:'Sign out',exact:true}).waitFor();await page.getByRole('button',{name:'Enter XR',exact:true}).waitFor();assert.equal((await state()).identity,owner);assert.equal((await state()).widgets,0);assert.equal((await state()).requests,0);assert.equal((await state()).offers,0)});
 await test('Sign-out disposes the World and removes XR before returning to entry',async()=>{await page.getByRole('button',{name:'Sign out',exact:true}).click();await page.getByRole('button',{name:'Enter demo',exact:true}).waitFor();assert.equal((await state()).identity,null);assert.equal((await state()).disposed,1);assert.equal((await state()).offers,0);assert.equal(await page.getByRole('button',{name:'Enter XR',exact:true}).count(),0)});
 await test('Failed restoration never opens a private World or exposes unverified content',async()=>{await ready();await noEntry();await page.evaluate(()=>window.labelxrSession.releaseInitial(true));await page.getByRole('alert').filter({hasText:'Your session could not be verified.'}).waitFor();assert.equal((await state()).worlds,0);assert.equal((await state()).requests,0);assert.equal((await state()).offers,0)});
 assert.equal(blocked,0);assert.deepEqual(errors,[]);
 report={schema:'labelxr-session-xr-browser/v1',passed:true,count:cases.length,cases,browser:browser.version(),actualSdkWorldCreateTested:true,actualWebGlRendered:true,manualSdkXrSessionFrames:true,noAutomaticOffers:true,delayedInitialAuthAndFullReloadTested:true,syntheticAuthProvider:true,syntheticDataset:true,liveCloudMutationPerformed:false,physicalQuestAcceptancePassed:false,externalRequests:blocked,pageErrors:errors};
}catch(error){report={schema:'labelxr-session-xr-browser/v1',passed:false,count:cases.length,cases,error:String(error?.stack??error).slice(0,7000),observed:await page?.evaluate(()=>window.labelxrSession?.state()).catch(()=>null),externalRequests:blocked,pageErrors:errors};process.exitCode=1}
finally{fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});await browser?.close();await new Promise(r=>server.close(r));fs.rmSync(temp,{recursive:true,force:true});console.log(JSON.stringify({passed:report.passed,count:cases.length,error:report.error,report:output}))}
