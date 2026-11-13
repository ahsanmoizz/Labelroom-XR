import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {buildSync} from 'esbuild';
import {chromium} from 'playwright';
import {runCases} from '../tests/integration/review-form-browser.mjs';
import {runLayoutCases,runLiveProbeCases} from '../tests/integration/layout-browser.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'labelxr-browser-review-'));
const output=process.argv[2]??path.join(os.tmpdir(),'labelxr-browser-review-'+Date.now()+'.json');
if(!path.isAbsolute(output)||fs.existsSync(output))throw Error('Pass a new absolute report path.');
const sources={
 'src/app/store.ts':['createReviewStore'],
 'src/app/review-workspace.ts':['mountReviewWorkspace','reviewProposalFrameSource','reviewFrameSource'],
 'src/app/dataset-workspace.ts':['createDatasetWorkspace'],
 'src/services/analysis.ts':['createReviewAnalysisClient'],
 'src/services/reviews.ts':['ReviewServiceError'],
 'src/services/review-snapshots.ts':['createReviewSnapshotService','createSupabaseReviewSnapshotSessions'],
 'src/domain/review-actions.ts':['manualReviewCommand','duplicateReviewCommand','keepReviewCommand','selectedBox'],
 'src/domain/review-snapshot.ts':['validateReviewSnapshot'],
 'src/domain/review-envelope.ts':['parseReviewEnvelopeBytes'],
 'src/domain/revision.ts':['validateReviewCommand'],
 'src/data/bundle.ts':['loadBundleBytes'],
 'src/data/draft-cache.ts':['createIndexedDbDraftCache','createReviewDraft','validateReviewDraft','draftKey','DraftCacheError'],
 'src/data/form-draft-cache.ts':['createIndexedDbFormCache'],
 'src/ui/review-controls.ts':['mountReviewControls'],
 'src/ui/login.ts':['mountLoginPanel'],
 'src/ui/agent.ts':['mountAgentPanel'],
 'src/workers/protocol.ts':['fitWithinBounds']
};
const contents=Object.entries(sources).map(([file,names])=>'export {'+names.join(',')+'} from '+JSON.stringify(path.join(root,file))+';').join('\n')+'\nexport {zipSync,unzipSync} from "fflate";';
buildSync({stdin:{contents,resolveDir:root},bundle:true,format:'esm',platform:'browser',target:'esnext',outfile:path.join(temp,'bridge.mjs'),logLevel:'silent'});
buildSync({entryPoints:[path.join(root,'src/workers/review.worker.ts')],bundle:true,format:'esm',platform:'browser',target:'esnext',outfile:path.join(temp,'worker.mjs'),logLevel:'silent'});
const assets=new Map([
 ['/final-live-probe.mjs',[fs.readFileSync(path.join(root,'tests/integration/final-live-probe.mjs')),'text/javascript']],
 ['/prior-live-probe.mjs',[fs.readFileSync(path.join(root,'tests/integration/prior-live-probe.mjs')),'text/javascript']],
 ['/modules/bridge.mjs',[fs.readFileSync(path.join(temp,'bridge.mjs')),'text/javascript']],
 ['/workers/review.worker.ts',[fs.readFileSync(path.join(temp,'worker.mjs')),'text/javascript']],
 ['/fixture.mjs',[fs.readFileSync(path.join(root,'tests/integration/browser-review-fixture.mjs')),'text/javascript']],
 ['/layout-fixture.mjs',[fs.readFileSync(path.join(root,'tests/integration/layout-fixture.mjs')),'text/javascript']],
 ['/xr-browser-fixture.mjs',[fs.readFileSync(path.join(root,'tests/integration/xr-browser-fixture.mjs')),'text/javascript']],
 ['/brand-mark.svg',[fs.readFileSync(path.join(root,'public/brand-mark.svg')),'image/svg+xml']],
 ['/review-scene.svg',[fs.readFileSync(path.join(root,'public/review-scene.svg')),'image/svg+xml']],
 ['/workspace.css',[fs.readFileSync(path.join(root,'src/ui/workspace.css')),'text/css']],
 ['/source.zip',[fs.readFileSync(path.join(root,'fixtures/contract-example.zip')),'application/zip']],
 ['/',[Buffer.from('<!doctype html><html><head><meta charset="utf-8"><title>Local review tests</title></head><body><p id="status"></p><main id="workspace"></main><script type="module" src="/fixture.mjs"></script></body></html>'),'text/html']]
]);
const server=http.createServer((request,response)=>{const item=assets.get(request.url);if(request.method!=='GET'||!item){response.writeHead(404).end();return;}response.writeHead(200,{'Content-Type':item[1],'Cache-Control':'no-store'});response.end(item[0]);});
let browser;let blocked=0;
try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin='http://127.0.0.1:'+server.address().port;
 const explicit=process.env.LABELXR_CHROMIUM_PATH;
 const system=process.platform==='linux'&&fs.existsSync('/usr/bin/chromium')?'/usr/bin/chromium':undefined;
 browser=await chromium.launch({headless:true,...(explicit||system?{executablePath:explicit||system}:{}),args:process.platform==='linux'?['--no-sandbox']:[]});
 const context=await browser.newContext();
 await context.route('**/*',route=>{if(new URL(route.request().url()).origin===origin)return route.continue();blocked++;return route.abort('blockedbyclient');});
 const result=await runCases(context,origin+'/');
 const layout=await runLayoutCases(context,origin+'/',process.env.LABELXR_LAYOUT_SCREENSHOTS);
 const liveProbeFixtures=await runLiveProbeCases(context,origin+'/');
 if(blocked)throw Error('Unexpected external requests: '+blocked);
 const report={schema:'labelxr-browser-review-regression/v1',...result,layout,liveProbeFixtures,browser:browser.version(),blockedExternalRequests:blocked,backend:'Explicit synthetic local backend; actual DOM, workers and IndexedDB. Layout scene is a labelled placeholder; no GPU/XR result is claimed.',hardwareAcceptance:false};
 fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({passed:report.passed,count:report.count,browser:report.browser,report:output,externalRequests:blocked}));
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));fs.rmSync(temp,{recursive:true,force:true});}
