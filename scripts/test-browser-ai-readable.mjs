import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {buildSync} from 'esbuild';
import {chromium} from 'playwright';
import {browserModuleSource} from './browser-module-source.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'labelxr-ai-readable-'));
const output=process.argv[2];if(!output||!path.isAbsolute(output)||fs.existsSync(output))throw Error('Pass a new absolute report path.');
buildSync({stdin:{contents:browserModuleSource(path.join(root,'src/ui/agent.ts')),resolveDir:root},bundle:true,format:'esm',platform:'browser',target:'esnext',outfile:path.join(temp,'bridge.mjs'),logLevel:'silent'});
const fixture=`import {mountAgentPanel} from '/bridge.mjs';
const scope={projectId:'00000000-0000-4000-8000-000000000001',sourceBundleSha256:'a'.repeat(64),revision:2};
const source='a23c36b9a243e7d8d9bace94c44caf40e8467c5dd1d8f10ed9e7f60834addc9b';scope.sourceBundleSha256=source;
const ids=['5b467499-5bd1-4948-acf7-7888ac8aa795','aae4605b-e9e1-4984-9899-ac1901b9dfa8','b55795c2-af75-40cc-a1e6-dd2dc56d944b','f0b0ba89-d433-4d6b-bcdb-9d564ff28a73','f76608e5-5e51-46f9-a54b-a0d5b5075b4b','25aa67dd-44e7-4d36-8d1a-e668bfadf877','7e7bd93f-1d42-4f50-8b3b-1ea17eeedcb0','3a2e3e07-5bdb-47fb-9a9c-ae6bd56fe4c5'];
let panel,abort,release;
window.setup=(mode='normal')=>{
 panel?.dispose();abort=new AbortController();let consent=false;
 const stats={requests:0,modelRequests:0,previews:0,saves:0};
 const snapshot={ownerId:'00000000-0000-4000-8000-000000000002',...scope,frames:[{id:'03',boxes:ids.map(id=>({id}))}]};
 const result={total:8,cursor:0,next:null,issues:[0,0,0,1,2,3,3,4].map((support,i)=>({key:JSON.stringify(['LOW_SUPPORT','03',ids[i]]),type:'LOW_SUPPORT',frameId:'03',objectIds:[ids[i]],severity:(5-support)/5,evidence:{support,pointCount:173393}}))};
 if(mode==='injection')result.issues[0].objectIds[0]='<img src=x onerror=alert(1)>';
 const service={async request(r){stats.requests++;if(r.operation!=='step'){if(r.operation==='consent')consent=r.enabled;return {...scope,kind:'context',enabled:true,consent};}stats.modelRequests++;const base={...scope,turnId:r.turnId,callIndex:r.callIndex};if(r.callIndex===1)return {...base,kind:'tools',calls:[{id:'issues-proof',name:'listIssues',args:{frameId:'03',cursor:0,limit:10}}]};if(mode==='hold')await new Promise(resolve=>release=resolve);if(mode==='failure')throw Error('Synthetic provider follow-up stopped. No edit was applied.');return {...base,kind:'final',answer:{assessment:'review-measurements',evidenceIds:['issues-proof']}};}};
 panel=mountAgentPanel(document.querySelector('main'),{store:{snapshot:()=>snapshot,state:()=>({phase:'ready'}),subscribe:()=>()=>{}},service,signal:abort.signal,selection:()=>({frameId:'03',objectId:ids[0]}),focus:()=>true,preview:async()=>{stats.previews++;},analysis:{async setFrame(){},async listIssues(){return result;},cancel(){},dispose(){}}});
 window.releaseFinal=()=>release?.();window.stats=()=>({...stats});
};window.setup();`;
const assets=new Map([
 ['/bridge.mjs',[fs.readFileSync(path.join(temp,'bridge.mjs')),'text/javascript']],
 ['/fixture.mjs',[Buffer.from(fixture),'text/javascript']],
 ['/workspace.css',[fs.readFileSync(path.join(root,'src/ui/workspace.css')),'text/css']],
 ['/workbench.css',[fs.readFileSync(path.join(root,'src/ui/workbench.css')),'text/css']],
 ['/',[Buffer.from('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/workspace.css"><style>body{overflow:auto}main{max-width:550px;margin:0 auto;padding:16px}</style><main></main><script type="module" src="/fixture.mjs"></script>'),'text/html']]
]);
const server=http.createServer((request,response)=>{const asset=assets.get(request.url);if(request.method!=='GET'||!asset){response.writeHead(404).end();return;}response.writeHead(200,{'Content-Type':asset[1],'Cache-Control':'no-store'});response.end(asset[0]);});
let browser,report,page;const cases=[],errors=[];let externalRequests=0;
try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 const explicit=process.env.LABELXR_CHROMIUM_PATH,system=process.platform==='linux'&&fs.existsSync('/usr/bin/chromium')?'/usr/bin/chromium':undefined;
 browser=await chromium.launch({headless:true,...(explicit||system?{executablePath:explicit||system}:{}),args:process.platform==='linux'?['--no-sandbox']:[]});
 const context=await browser.newContext({viewport:{width:1366,height:900}});await context.route('**/*',r=>{if(new URL(r.request().url()).origin===origin)return r.continue();externalRequests++;return r.abort('blockedbyclient');});page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(origin);await page.waitForFunction(()=>window.setup);
 const test=async(name,run)=>{await run();cases.push({name,passed:true});};
 async function run(mode='normal'){await page.evaluate(m=>window.setup(m),mode);await page.getByLabel('Allow AI inspection for this project',{exact:true}).check();await page.getByRole('button',{name:'Save AI consent',exact:true}).click();await page.locator('.ai-panel[data-ai-status="ready"]').waitFor();await page.getByLabel('AI inspection question',{exact:true}).fill('Explain the issues in this frame.');await page.getByRole('button',{name:'Ask AI to inspect',exact:true}).click();}
 await test('Mounted assistance makes no automatic service or model request',async()=>{assert.equal((await page.evaluate(()=>window.stats())).requests,0);assert.equal(await page.getByRole('button',{name:'Ask AI to inspect',exact:true}).isDisabled(),true);});
 await test('A measured tool result stays inspecting until an actual final response',async()=>{await run('hold');await page.getByText('Found 8 potential issues in frame 03. Showing all 8.',{exact:true}).waitFor();assert.equal(await page.locator('.ai-panel').getAttribute('data-ai-status'),'inspecting');assert.equal(await page.getByRole('status').innerText(),'Inspecting the saved revision. No edit is being applied.');await page.evaluate(()=>window.releaseFinal());await page.locator('.ai-panel[data-ai-status="complete"]').waitFor();});
 await test('All eight exact measurements have a readable final summary with zero save/preview callbacks',async()=>{assert.match(await page.getByRole('status').innerText(),/Found 8 potential issues in frame 03/);assert.equal(await page.locator('.ai-measurements > li').count(),8);const text=await page.locator('.ai-measurements').innerText();for(const support of [0,1,2,3,4])assert.ok(text.includes(support+' supporting points out of 173,393'));const stats=await page.evaluate(()=>window.stats());assert.equal(stats.modelRequests,2);assert.equal(stats.previews,0);assert.equal(stats.saves,0);});
 await test('Raw JSON and exact provenance remain collapsed, with no confidence-percentage claim',async()=>{assert.equal(await page.locator('details').getAttribute('open'),null);assert.equal(await page.locator('pre').isVisible(),false);assert.equal((await page.locator('.ai-panel').innerText()).includes('"severity"'),false);assert.match(await page.locator('.ai-evidence-note').innerText(),/ranking score, not an error probability/);});
 await test('Keyboard disclosure exposes exact source, revision, evidence ID and unmodified measurement JSON',async()=>{const toggle=page.locator('details > summary');await toggle.focus();await page.keyboard.press('Enter');assert.equal(await page.locator('pre').isVisible(),true);const raw=JSON.parse(await page.locator('pre').innerText());assert.equal(raw.result.issues[0].evidence.support,0);assert.equal(raw.result.issues[7].severity,.2);assert.equal(raw.result.issues[7].evidence.support,4);assert.match(await page.locator('details > p').innerText(),/saved revision 2/);assert.match(await page.locator('details > p').innerText(),/a23c36b9a243e7d8d9bace94c44caf40e8467c5dd1d8f10ed9e7f60834addc9b/);await page.keyboard.press('Enter');});
 await test('Long technical IDs and JSON do not produce horizontal overflow at 390px',async()=>{await page.setViewportSize({width:390,height:844});await page.locator('details > summary').click();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.locator('details > summary').click();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.setViewportSize({width:1366,height:900});});
 await test('Provider follow-up failure is visible and never labelled complete',async()=>{await run('failure');await page.locator('.ai-panel[data-ai-status="unavailable"]').waitFor();assert.match(await page.getByRole('status').innerText(),/follow-up stopped/);assert.equal((await page.getByRole('status').innerText()).includes('Inspection complete'),false);assert.equal((await page.evaluate(()=>window.stats())).modelRequests,2);});
 await test('Tool-provided text is never interpreted as executable markup',async()=>{await run('injection');await page.locator('.ai-panel[data-ai-status="complete"]').waitFor();assert.equal(await page.locator('.ai-panel img').count(),0);assert.equal(await page.locator('.ai-panel script').count(),0);assert.match(await page.locator('.ai-measurements').innerText(),/<img src/);});
 assert.deepEqual(errors,[]);assert.equal(externalRequests,0);
 report={schema:'labelxr-ai-readable-browser/v1',passed:true,count:cases.length,cases,browser:browser.version(),syntheticService:true,syntheticMeasurements:true,realModelRequests:0,liveCloudMutations:0,physicalQuestVerified:false,pageErrors:errors,externalRequests};
}catch(error){process.exitCode=1;report={schema:'labelxr-ai-readable-browser/v1',passed:false,count:cases.length,cases,error:String(error.stack??error).slice(0,4000),pageErrors:errors,externalRequests,body:await page?.locator('body').innerText().catch(()=>null)};}
finally{fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});await browser?.close();await new Promise(r=>server.close(r));fs.rmSync(temp,{recursive:true,force:true});console.log(JSON.stringify({passed:report.passed,count:report.count,error:report.error,output}));}
