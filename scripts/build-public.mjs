import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {buildSync} from 'esbuild';
import {spawnSync} from 'node:child_process';
const [target, configPath] = process.argv.slice(2);
const environments = {
  staging: ['https://aawwmcbhyyokkhhvcfmv.supabase.co', 'https://guest-staging.labelroom-xr.pages.dev'],
  production: ['https://weziynwzjzbsctxxqmus.supabase.co', 'https://labelroom-xr.pages.dev']
};
assert(Object.hasOwn(environments,target), 'Choose staging or production explicitly.');
for(const name of ['.env','.env.local','.env.production','.env.production.local']) assert(!fs.existsSync(name),'Use a clean release checkout without local Vite environment files.');
assert(configPath && path.isAbsolute(configPath), 'Pass an absolute public configuration JSON path.');
const st=fs.lstatSync(configPath);assert(st.isFile()&&!st.isSymbolicLink()&&st.size<=4096,'Bounded regular public configuration required.');
const input=JSON.parse(fs.readFileSync(configPath,'utf8'));
const names=['VITE_SUPABASE_URL','VITE_SUPABASE_PUBLISHABLE_KEY','VITE_APP_ORIGIN','VITE_TURNSTILE_SITE_KEY','VITE_GUEST_DEMO'];
assert(input&&typeof input==='object'&&!Array.isArray(input)&&Object.keys(input).every(k=>names.includes(k)), 'Only the five public build values are accepted.');
const compiled=buildSync({stdin:{contents:'export {validatePublicConfig} from "./src/app/config.ts"',resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false,logLevel:'silent'}).outputFiles[0].text;
const {validatePublicConfig}=await import('data:text/javascript;base64,'+Buffer.from(compiled).toString('base64'));
assert.equal(validatePublicConfig(input,'production').status,'valid','Invalid public build configuration.');
assert.equal(input.VITE_SUPABASE_URL,environments[target][0],'Backend does not match the selected environment.');
assert.equal(input.VITE_APP_ORIGIN,environments[target][1],'Application origin does not match the selected environment.');
assert(['true','false'].includes(input.VITE_GUEST_DEMO),'Set VITE_GUEST_DEMO explicitly.');
const env={...process.env,NODE_ENV:'production'};for(const k of Object.keys(env))if(k.startsWith('VITE_'))delete env[k];Object.assign(env,input);
const result=spawnSync(process.platform==='win32'?'npm.cmd':'npm',['run','build'],{stdio:'inherit',env,shell:process.platform==='win32'});
process.exitCode=result.status??1;
