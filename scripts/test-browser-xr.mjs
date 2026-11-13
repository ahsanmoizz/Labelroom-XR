import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {buildSync} from 'esbuild';
import {chromium} from 'playwright';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'labelxr-xr-'));
const output=process.argv[2];if(!output||!path.isAbsolute(output)||fs.existsSync(output))throw Error('Pass a new absolute XR report path.');
const modules={
 'src/app/review-workspace.ts':['mountReviewWorkspace','reviewProposalFrameSource','reviewFrameSource'],
 'src/services/analysis.ts':['createReviewAnalysisClient'], 'src/services/reviews.ts':['ReviewServiceError'],
 'src/domain/review-actions.ts':['manualReviewCommand','duplicateReviewCommand','keepReviewCommand','selectedBox'],
 'src/domain/review-snapshot.ts':['validateReviewSnapshot'], 'src/domain/revision.ts':['validateReviewCommand'],
 'src/data/bundle.ts':['loadBundleBytes'], 'src/data/draft-cache.ts':['createIndexedDbDraftCache','createReviewDraft','validateReviewDraft','draftKey','DraftCacheError'],
 'src/data/form-draft-cache.ts':['createIndexedDbFormCache'], 'src/workers/protocol.ts':['fitWithinBounds'],
 'src/xr/spatial-review.ts':['mountSpatialReview'], 'src/xr/review-system.ts':['createReviewView']
};
const contents=Object.entries(modules).map(([p,n])=>'export {'+n.join(',')+'} from '+JSON.stringify(path.join(root,p))+';').join('\n')+'\nexport {zipSync,unzipSync} from "fflate";\nexport {XRDevice,metaQuest3} from "iwer";\nexport {Group,Scene,PerspectiveCamera,WebGLRenderer,Vector3,Quaternion} from "three";';
buildSync({stdin:{contents,resolveDir:root},bundle:true,format:'esm',platform:'browser',target:'esnext',outfile:path.join(temp,'bridge.mjs'),logLevel:'silent'});
buildSync({entryPoints:[path.join(root,'src/workers/review.worker.ts')],bundle:true,format:'esm',platform:'browser',target:'esnext',outfile:path.join(temp,'worker.mjs'),logLevel:'silent'});
const assets=new Map([
 ['/final-live-probe.mjs',[fs.readFileSync(path.join(root,'tests/integration/final-live-probe.mjs')),'text/javascript']],
 ['/prior-live-probe.mjs',[fs.readFileSync(path.join(root,'tests/integration/prior-live-probe.mjs')),'text/javascript']],
 ['/modules/bridge.mjs',[fs.readFileSync(path.join(temp,'bridge.mjs')),'text/javascript']],['/workers/review.worker.ts',[fs.readFileSync(path.join(temp,'worker.mjs')),'text/javascript']],
 ['/fixture.mjs',[fs.readFileSync(path.join(root,'tests/integration/browser-review-fixture.mjs')),'text/javascript']],['/layout-fixture.mjs',[fs.readFileSync(path.join(root,'tests/integration/layout-fixture.mjs')),'text/javascript']],
 ['/xr-browser-fixture.mjs',[fs.readFileSync(path.join(root,'tests/integration/xr-browser-fixture.mjs')),'text/javascript']],['/source.zip',[fs.readFileSync(path.join(root,'fixtures/contract-example.zip')),'application/zip']],
 ['/',[Buffer.from('<!doctype html><html><head><meta charset="utf-8"><title>Actual WebXR emulator integration fixture</title></head><body><p id="status"></p><main id="workspace"></main><script type="module" src="/fixture.mjs"></script></body></html>'),'text/html']]
]);
const server=http.createServer((req,res)=>{const a=assets.get(req.url);if(req.method!=='GET'||!a){res.writeHead(404).end();return}res.writeHead(200,{'Content-Type':a[1],'Cache-Control':'no-store'});res.end(a[0])});
let browser,page,blocked=0,fixtureInfo;const errors=[],cases=[];let report;
const test=async(name,run)=>{await run();cases.push({name,passed:true})};
try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 const explicit=process.env.LABELXR_CHROMIUM_PATH;
 browser=await chromium.launch({headless:true,...(explicit?{executablePath:explicit}:{}),args:process.platform==='linux'?['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']:[]});
 const context=await browser.newContext({viewport:{width:1280,height:800}});await context.route('**/*',route=>{if(new URL(route.request().url()).origin===origin)return route.continue();blocked++;return route.abort('blockedbyclient')});
 page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(origin,{waitUntil:'load'});await page.waitForFunction(()=>!!window.labelxrBrowser);await page.evaluate(()=>window.labelxrBrowser.setup({variant:'multi',projectId:crypto.randomUUID()}));await page.waitForFunction(()=>window.labelxrBrowser.state().phase==='ready');
 fixtureInfo=await page.evaluate(()=>window.labelxrBrowser.prepareXR());
 const xr=()=>page.evaluate(()=>window.labelxrXR.state()),state=()=>page.evaluate(()=>window.labelxrBrowser.state());
 const tap=(hand,x,y)=>page.evaluate(([h,x,y])=>window.labelxrXR.tap(h,x,y),[hand,x,y]);
 const input=(name,...args)=>page.evaluate(([n,a])=>window.labelxrXR[n](...a),[name,args]);
 const phase=p=>page.waitForFunction(p=>window.labelxrBrowser.state().phase===p,p);
 const enter=async()=>{const before=(await xr()).frameCount;await page.getByRole('button',{name:'Enter fixture XR',exact:true}).click();await page.waitForFunction(n=>window.labelxrXR.error||(window.labelxrXR.state().sessionActive&&window.labelxrXR.state().frameCount>n+4),before);const s=await xr();assert.equal(await page.evaluate(()=>window.labelxrXR.error),null);assert(s.sessionActive&&s.panelVisible&&s.drawCalls>0)};
 await test('IWER Quest 3 session renders the actual app spatial panel with two emulated hands',async()=>{await enter();const s=await xr();assert.equal(fixtureInfo.runtime,'2.5.0');assert.deepEqual(s.inputSources.map(x=>x.hand).sort(),['left','right']);assert(s.inputSources.every(x=>x.joints===25));assert(s.isPresenting)});
 await test('A paused session refuses edits before explicit Resume',async()=>{const before=(await xr()).model.fields.x.value;await tap('left',516,414);await tap('left',933,504);assert.equal((await xr()).model.fields.x.value,before);assert.equal((await state()).attempts,0)});
 await test('Left and right native select events nudge only after a matching pinch release',async()=>{await tap('left',186,282);await tap('left',516,414);const before=Number((await xr()).model.fields.x.value);await input('aim','left',933,504);await input('begin','left');assert.equal(Number((await xr()).model.fields.x.value),before);await input('end','left');assert.equal(Number((await xr()).model.fields.x.value),Number((before+.01).toFixed(6)));const y=Number((await xr()).model.fields.y.value);await tap('right',933,584);assert.equal(Number((await xr()).model.fields.y.value),Number((y+.01).toFixed(6)));assert.equal((await state()).attempts,0)});
 await test('Releasing on a different control cancels the held intent',async()=>{const before=(await xr()).model.fields;await input('aim','right',933,504);await input('begin','right');await input('retarget','right',933,584);await input('end','right');assert.deepEqual((await xr()).model.fields,before)});
 await test('Hand preview and reject leave the synthetic saved revision unchanged',async()=>{await tap('right',186,1184);await phase('proposed');assert.equal((await state()).attempts,0);await tap('left',826,1184);await phase('ready');assert.equal((await state()).serverRevision,0)});
 await test('Hand tracking loss cancels held approval and requires a fresh Resume',async()=>{await tap('left',516,414);await tap('left',933,504);await tap('left',186,1184);await phase('proposed');await input('aim','right',506,1184);await input('begin','right');await input('tracking','right',false);await input('tracking','right',true);await input('end','right');await tap('right',506,1184);assert.equal((await state()).serverRevision,0);assert.equal((await state()).attempts,0);await tap('left',186,282);await tap('right',506,1184);await phase('ready');assert.equal((await state()).revision,1);assert.equal((await state()).serverCalls,1)});
 await test('Hand undo requires preview then separate approval and restores original labels',async()=>{await tap('left',846,414);await tap('right',752,614);await phase('proposed');assert.equal((await state()).command.operation,'undo');assert.equal((await state()).serverRevision,1);await tap('left',506,1184);await phase('ready');const s=await state();assert.equal(s.revision,2);assert.equal(s.labels,s.originalLabels)});
 await test('Exit and re-entry remain paused, then dispose retires the spatial session',async()=>{await input('exit');assert.equal((await xr()).sessionActive,false);assert.equal((await xr()).panelVisible,false);await enter();const before=(await state()).attempts;await tap('right',506,1184);assert.equal((await state()).attempts,before);const done=await input('dispose');assert(done.spatialRemoved&&done.listeners===0&&done.sessionEnded)});
 assert.equal(blocked,0);assert.deepEqual(errors,[]);report={schema:'labelxr-webxr-emulator-integration/v1',passed:true,count:cases.length,cases,fixture:fixtureInfo,browser:browser.version(),actualWebGlRendered:true,actualEmulatedXrFrames:true,nativeEmulatedHandEvents:true,syntheticBackend:true,syntheticSource:true,productionSdkWorldAdapterTested:false,physicalQuestAcceptancePassed:false,liveGuestLifecycleAcceptancePassed:false,fullProductAcceptancePassed:false,externalRequests:blocked,pageErrors:errors};
}catch(error){report={schema:'labelxr-webxr-emulator-integration/v1',passed:false,count:cases.length,cases,error:String(error?.stack??error).slice(0,6000),observed:await page?.evaluate(()=>({xr:window.labelxrXR?.state(),error:window.labelxrXR?.error,review:window.labelxrBrowser?.state()})).catch(()=>null),pageErrors:errors,externalRequests:blocked,fixture:fixtureInfo,physicalQuestAcceptancePassed:false,fullProductAcceptancePassed:false};process.exitCode=1;
}finally{fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});await browser?.close();await new Promise(r=>server.close(r));fs.rmSync(temp,{recursive:true,force:true});console.log(JSON.stringify({passed:report.passed,count:cases.length,error:report.error,report:output}));}
