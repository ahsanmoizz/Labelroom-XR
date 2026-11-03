// LABELXR-SERVER-ENVIRONMENT-CASES-v1
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';import {createRequire} from 'node:module';import assert from 'node:assert/strict';import crypto from 'node:crypto';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),args=process.argv.slice(2),deps=args[0]==='--dependencies'?args[1]:root,require=createRequire(path.join(deps,'package.json')),esbuild=require('esbuild'),names=[];
const stage=fs.mkdtempSync(path.join(root,'server-env-check-')),pub='sb_publishable_fixture_public',secret='sb_secret_fixture_private',pub2='sb_publishable_fixture_second',secret2='sb_secret_fixture_second',jwt=role=>'eyJhbGciOiJIUzI1NiJ9.'+Buffer.from(JSON.stringify({role})).toString('base64url')+'.signature';
const run=async(n,f)=>{await f();names.push(n)},read=o=>n=>o[n],deny=f=>assert.throws(f,/^Error: Configuration$/);
const output=path.join(stage,'environment.mjs');esbuild.buildSync({entryPoints:[path.join(root,'supabase/functions/_shared/environment.ts')],bundle:true,format:'esm',platform:'neutral',target:'es2022',outfile:output});
const {publicApiKey,serverApiKey}=await import(pathToFileURL(output).href);
await run('Hosted default publishable key resolves',()=>assert.equal(publicApiKey(read({SUPABASE_PUBLISHABLE_KEYS:JSON.stringify({default:pub})})),pub));
await run('Hosted default secret key resolves',()=>assert.equal(serverApiKey(read({SUPABASE_SECRET_KEYS:JSON.stringify({default:secret})})),secret));
await run('Public hosted map takes precedence over singular key',()=>assert.equal(publicApiKey(read({SUPABASE_PUBLISHABLE_KEYS:JSON.stringify({default:pub}),SUPABASE_PUBLISHABLE_KEY:pub2})),pub));
await run('Server hosted map takes precedence over singular and legacy keys',()=>assert.equal(serverApiKey(read({SUPABASE_SECRET_KEYS:JSON.stringify({default:secret}),SUPABASE_SECRET_KEY:secret2,SUPABASE_SERVICE_ROLE_KEY:jwt('service_role')})),secret));
await run('Singular local publishable key remains supported',()=>assert.equal(publicApiKey(read({SUPABASE_PUBLISHABLE_KEY:pub})),pub));
await run('Singular local secret key remains supported',()=>assert.equal(serverApiKey(read({SUPABASE_SECRET_KEY:secret})),secret));
await run('Legacy service-role configuration remains supported',()=>assert.equal(serverApiKey(read({SUPABASE_SERVICE_ROLE_KEY:jwt('service_role')})),jwt('service_role')));
await run('Modern singular server key precedes legacy key',()=>assert.equal(serverApiKey(read({SUPABASE_SECRET_KEY:secret,SUPABASE_SERVICE_ROLE_KEY:jwt('service_role')})),secret));
for(const [label,map]of [['malformed','{bad'],['null','null'],['array','[]'],['number','7'],['empty object','{}'],['other named key',JSON.stringify({web:pub})],['non-string default','{"default":1}'],['empty default','{"default":""}'],['oversized map',' '.repeat(32769)]]){
 await run('Public map refuses '+label+' without fallback',()=>deny(()=>publicApiKey(read({SUPABASE_PUBLISHABLE_KEYS:map,SUPABASE_PUBLISHABLE_KEY:pub}))));
 await run('Server map refuses '+label+' without fallback',()=>deny(()=>serverApiKey(read({SUPABASE_SECRET_KEYS:map,SUPABASE_SECRET_KEY:secret,SUPABASE_SERVICE_ROLE_KEY:jwt('service_role')}))));
}
await run('Public resolver never accepts a privileged key',()=>deny(()=>publicApiKey(read({SUPABASE_PUBLISHABLE_KEYS:JSON.stringify({default:secret})}))));
await run('Server resolver never accepts a publishable key',()=>deny(()=>serverApiKey(read({SUPABASE_SECRET_KEYS:JSON.stringify({default:pub})}))));
await run('Public resolver has no service-role fallback',()=>deny(()=>publicApiKey(read({SUPABASE_SERVICE_ROLE_KEY:jwt('service_role')}))));
await run('Empty singular public key is refused',()=>deny(()=>publicApiKey(read({SUPABASE_PUBLISHABLE_KEY:''}))));
await run('Empty singular secret key is refused without legacy fallback',()=>deny(()=>serverApiKey(read({SUPABASE_SECRET_KEY:'',SUPABASE_SERVICE_ROLE_KEY:jwt('service_role')}))));
await run('Missing public and server credentials fail closed',()=>{deny(()=>publicApiKey(read({})));deny(()=>serverApiKey(read({})))});
await run('Legacy anonymous key cannot become the server key',()=>deny(()=>serverApiKey(read({SUPABASE_SERVICE_ROLE_KEY:jwt('anon')}))));
await run('Malformed legacy service key is refused',()=>deny(()=>serverApiKey(read({SUPABASE_SERVICE_ROLE_KEY:'invalid'}))));
await run('Public and secret key whitespace is refused',()=>{deny(()=>publicApiKey(read({SUPABASE_PUBLISHABLE_KEY:' '+pub})));deny(()=>serverApiKey(read({SUPABASE_SECRET_KEY:secret+' '})))});
await run('Oversized public and secret keys are refused',()=>{deny(()=>publicApiKey(read({SUPABASE_PUBLISHABLE_KEY:'sb_publishable_'+'x'.repeat(512)})));deny(()=>serverApiKey(read({SUPABASE_SECRET_KEY:'sb_secret_'+'x'.repeat(512)})))});
await run('Only the own default member is selected',()=>assert.equal(publicApiKey(read({SUPABASE_PUBLISHABLE_KEYS:JSON.stringify({web:pub2,default:pub,__proto__:null})})),pub));
const mock=path.join(stage,'sdk-fixture.mjs');fs.writeFileSync(mock,"export function createClient(url,key,options){const s=globalThis.__labelxrEntry;s.keys.push(key);return{auth:{async getUser(){s.authCalls++;return{data:{user:null},error:{code:'invalid'}}}},rpc(){s.rpcCalls++;throw Error('Unexpected RPC')},storage:{from(){s.storageCalls++;throw Error('Unexpected storage')}}}}\n");
const savedDeno=globalThis.Deno,savedProbe=globalThis.__labelxrEntry,savedFetch=globalThis.fetch;let networkAttempts=0;globalThis.fetch=()=>{networkAttempts++;throw Error('External requests disabled')};
async function boot(endpoint,env){
 const state={keys:[],authCalls:0,rpcCalls:0,storageCalls:0,handler:null};globalThis.__labelxrEntry=state;globalThis.Deno={env:{get:read({SUPABASE_URL:'https://project.supabase.co',ALLOWED_ORIGIN:'http://localhost:8081',...env})},serve:h=>state.handler=h};
 const p=path.join(stage,endpoint+'-'+crypto.randomUUID()+'.mjs');esbuild.buildSync({entryPoints:[path.join(root,'supabase/functions',endpoint,'entry.ts')],bundle:true,format:'esm',platform:'node',target:'es2022',packages:'external',alias:{'npm:@supabase/supabase-js@2.117.3':mock},outfile:p,define:{'import.meta.main':'true'}});await import(pathToFileURL(p).href);assert.equal(typeof state.handler,'function');return state;
}
const request=(origin='http://localhost:8081',token)=>new Request('https://project.supabase.co/functions/v1/test',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:'{}'});
try{
 for(const endpoint of ['review-commit','project-admin']){
  const env=endpoint==='review-commit'?{SUPABASE_PUBLISHABLE_KEYS:JSON.stringify({default:pub})}:{SUPABASE_SECRET_KEYS:JSON.stringify({default:secret})};
  await run(endpoint+' boots from hosted key map',async()=>{const s=await boot(endpoint,env);assert.deepEqual(s.keys,[endpoint==='review-commit'?pub:secret])});
  await run(endpoint+' still rejects a missing caller JWT before provider calls',async()=>{const s=await boot(endpoint,env);assert.equal((await s.handler(request())).status,401);assert.equal(s.authCalls+s.rpcCalls+s.storageCalls,0)});
  await run(endpoint+' still rejects an unapproved browser origin',async()=>{const s=await boot(endpoint,env);assert.equal((await s.handler(request('https://other.example'))).status,403);assert.equal(s.authCalls+s.rpcCalls+s.storageCalls,0)});
  await run(endpoint+' validates a supplied caller through getUser',async()=>{const s=await boot(endpoint,env);assert.equal((await s.handler(request(undefined,'a.b.c'))).status,401);assert.equal(s.authCalls,1);assert.equal(s.rpcCalls+s.storageCalls,0)});
  await run(endpoint+' malformed hosted configuration returns generic503',async()=>{const s=await boot(endpoint,endpoint==='review-commit'?{SUPABASE_PUBLISHABLE_KEYS:'{bad'}:{SUPABASE_SECRET_KEYS:'{bad'});const r=await s.handler(request());assert.equal(r.status,503);assert.equal((await r.json()).error.code,'configuration');assert.equal(s.keys.length,0)});
  await run(endpoint+' missing origin returns generic503',async()=>{const s=await boot(endpoint,{...env,ALLOWED_ORIGIN:''});assert.equal((await s.handler(request())).status,503)});
 }
}finally{globalThis.Deno=savedDeno;globalThis.__labelxrEntry=savedProbe;globalThis.fetch=savedFetch}
assert.equal(networkAttempts,0);
const result={schema:'labelxr-server-environment-cases/v1',passed:true,count:names.length,names,esbuild:esbuild.version,entrySdkFactoryIsSynthetic:true,entryHttpAndAuthValidatorsAreOriginal:true,networkAttempts,providerRequests:0,actualCloudTested:false,livePrivatePersistencePassed:false};
console.log(JSON.stringify(result));
