import http from 'node:http';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {chromium} from 'playwright';

const bundle=await build({entryPoints:['supabase/functions/_shared/http.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {checkRequest,problemResponse,jsonResponse}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].contents).toString('base64'));
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve('http://127.0.0.1:'+server.address().port)));
const client=http.createServer((_q,r)=>{r.writeHead(200,{'Content-Type':'text/html'});r.end('<!doctype html><title>Connection protocol regression</title>')});
const origin=await listen(client),records=[],cases=[];let actualAgentPosts=0,unexpectedWritePosts=0,browser;
const api=http.createServer(async(req,res)=>{
 const record={method:req.method,requestMethod:req.headers['access-control-request-method']??null,path:req.url};records.push(record);
 const chunks=[];for await(const chunk of req)chunks.push(chunk);
 const request=new Request('http://127.0.0.1'+req.url,{method:req.method,headers:req.headers,...(chunks.length?{body:Buffer.concat(chunks)}:{})});
 let response;
 try{
  response=checkRequest(request,origin,'fixture-request');
  if(!response){
   if(req.url!=='/functions/v1/agent'){unexpectedWritePosts++;throw Error('Unexpected write endpoint POST')}
   const body=await request.json();assert.equal(body.operation,'context');actualAgentPosts++;
   response=jsonResponse(request,origin,'fixture-request',{kind:'context',enabled:false,consent:false});
  }
 }catch(error){response=problemResponse(request,origin,'fixture-request',error)}
 record.status=response.status;res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
});
const base=await listen(api),output=process.argv[2]??'artifacts/cors.json';
const report={schema:'labelxr-actual-browser-cors-regression/v1',passed:false,count:0,cases,actualBrowserNetwork:true,actualApplicationCorsHandler:true,syntheticServerAndCredentials:true,liveCloudMutationPerformed:false};
try{
 browser=await chromium.launch({headless:true,args:process.platform==='linux'?['--no-sandbox']:[]});
 const page=await browser.newPage();await page.goto(origin);
 const old=await page.evaluate(async base=>{try{await fetch(base+'/functions/v1/review-commit',{method:'OPTIONS',headers:{apikey:'fixture-public',Authorization:'Bearer fixture-only'}});return 'unexpectedly-readable'}catch(error){return error.name}},base);
 assert.equal(old,'TypeError');assert(records.some(x=>x.method==='OPTIONS'&&x.requestMethod==='OPTIONS'&&x.status===405));
 cases.push({name:'Old manual OPTIONS reproduces browser rejection with the real CORS guard',passed:true});
 for(const endpoint of ['review-commit','project-admin','demo-provision','agent']){
  const response=await fetch(base+'/functions/v1/'+endpoint,{method:'OPTIONS',headers:{Origin:origin,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization, apikey, content-type'}});
  assert.equal(response.status,204);assert.equal(response.headers.get('access-control-allow-origin'),origin);assert(response.headers.get('access-control-allow-methods').split(',').map(x=>x.trim()).includes('POST'));
 }
 assert.equal(records.filter(x=>x.method==='OPTIONS'&&x.requestMethod==='POST'&&x.status===204).length,4);
 cases.push({name:'Native preflight with requested method POST accepts all four function paths',passed:true});
 const context=await page.evaluate(async base=>{const r=await fetch(base+'/functions/v1/agent',{method:'POST',headers:{apikey:'fixture-public',Authorization:'Bearer fixture-only','Content-Type':'application/json'},body:JSON.stringify({operation:'context'})});return {status:r.status,body:await r.json()}},base);
 assert.equal(context.status,200);assert.equal(context.body.data.kind,'context');assert.equal(actualAgentPosts,1);
 assert(records.some(x=>x.path==='/functions/v1/agent'&&x.method==='OPTIONS'&&x.requestMethod==='POST'&&x.status===204));
 cases.push({name:'Browser automatically negotiates POST preflight and reads agent context',passed:true});
 const forbidden=await page.evaluate(async base=>{try{await fetch(base+'/functions/v1/agent',{method:'POST',headers:{'Content-Type':'application/json','X-Not-Allowed':'fixture'},body:'{"operation":"context"}'});return 'unexpectedly-readable'}catch(error){return error.name}},base);
 assert.equal(forbidden,'TypeError');assert.equal(actualAgentPosts,1);assert.equal(unexpectedWritePosts,0);
 cases.push({name:'Disallowed headers remain blocked without relaxing browser or server security',passed:true});
 report.passed=true;report.count=cases.length;report.browser=browser.version();report.automaticAndNativePreflights=records;report.actualAgentContextPosts=actualAgentPosts;report.writeEndpointPosts=unexpectedWritePosts;
}catch(error){report.error=String(error);throw error}
finally{
 fs.mkdirSync(new URL('.', 'file://'+process.cwd()+'/'+output),{recursive:true});fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
 await browser?.close();api.closeAllConnections();client.closeAllConnections();await Promise.all([new Promise(r=>api.close(r)),new Promise(r=>client.close(r))]);
}
console.log(JSON.stringify({passed:report.passed,count:report.count}));
