// Local scheduler bridge contract. Synthetic Vault/pg_net; never sends HTTP.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const [runtime, output]=process.argv.slice(2);
assert(path.isAbsolute(runtime)&&path.isAbsolute(output));
const {PGlite}=await import(pathToFileURL(path.join(runtime,'dist/index.js')));
const db=new PGlite(), names=[];
const check=async(name,fn)=>{await db.exec('BEGIN');try{await fn();names.push(name)}finally{await db.exec('ROLLBACK')}};
const denied=async(sql)=>{await db.exec('SAVEPOINT denied');let error;try{await db.exec(sql)}catch(e){error=e}await db.exec('ROLLBACK TO SAVEPOINT denied;RELEASE SAVEPOINT denied');assert(error)};
try{
 const fixture=JSON.parse(/^const fixture=(.+);$/m.exec(fs.readFileSync('tests/sql/core.mjs','utf8'))[1]);
 await db.exec(fixture);
 const files=fs.readdirSync('supabase/migrations').filter(n=>n.endsWith('.sql')).sort();
 for(const file of files.slice(0,-1))await db.exec(fs.readFileSync('supabase/migrations/'+file,'utf8'));
 await db.exec(`CREATE SCHEMA vault; CREATE TABLE vault.decrypted_secrets(name text,decrypted_secret text);
 CREATE SCHEMA net; CREATE TABLE net.synthetic_requests(id bigint GENERATED ALWAYS AS IDENTITY,url text,headers jsonb,body jsonb,timeout_ms integer);
 CREATE FUNCTION net.http_post(url text,body jsonb DEFAULT '{}'::jsonb,params jsonb DEFAULT '{}'::jsonb,headers jsonb DEFAULT '{}'::jsonb,timeout_milliseconds integer DEFAULT 5000)
 RETURNS bigint LANGUAGE plpgsql AS $$ DECLARE n bigint; BEGIN INSERT INTO net.synthetic_requests(url,headers,body,timeout_ms) VALUES(url,headers,body,timeout_milliseconds) RETURNING id INTO n; RETURN n; END $$;`);
 const migration=fs.readFileSync('supabase/migrations/'+files.at(-1),'utf8');
 // PGlite lacks these hosted extensions; only their two activation statements are omitted.
 assert.equal((migration.match(/^CREATE EXTENSION /gm)||[]).length,2);
 await db.exec(migration.replace(/^CREATE EXTENSION .*;\n/gm,''));
 const config=()=>db.exec("INSERT INTO vault.decrypted_secrets VALUES ('labelxr_project_url','https://weziynwzjzbsctxxqmus.supabase.co'),('labelxr_cleanup_token','"+'x'.repeat(43)+"')");
 await check('Missing Vault configuration fails before queueing',async()=>{await denied('SELECT labelroom_private.queue_project_cleanup()');assert.equal((await db.query('SELECT * FROM net.synthetic_requests')).rows.length,0)});
 await check('Only the database owner can dispatch, not anon/authenticated/service_role',async()=>{await config();for(const role of ['anon','authenticated','service_role']){await db.exec('SET LOCAL ROLE '+role);await denied('SELECT labelroom_private.queue_project_cleanup()');await db.exec('RESET ROLE')}assert.equal((await db.query('SELECT * FROM net.synthetic_requests')).rows.length,0)});
 await check('Exact URL, separate bearer, limit10 and bounded timeout reach the pg_net port',async()=>{await config();const id=(await db.query('SELECT labelroom_private.queue_project_cleanup() AS id')).rows[0].id;const req=(await db.query('SELECT * FROM net.synthetic_requests WHERE id=$1',[id])).rows[0];assert.equal(req.url,'https://weziynwzjzbsctxxqmus.supabase.co/functions/v1/project-cleanup');assert.deepEqual(req.body,{limit:10});assert.equal(req.headers.Authorization,'Bearer '+'x'.repeat(43));assert.equal(req.headers['Content-Type'],'application/json');assert.equal(req.timeout_ms,60000);assert.equal((await db.query('SELECT request_id FROM labelroom_private.cleanup_dispatches')).rows[0].request_id,id)});
 await check('Malformed origins and tokens never enter the queue',async()=>{await config();for(const url of ['http://weziynwzjzbsctxxqmus.supabase.co','https://evil.invalid','https://weziynwzjzbsctxxqmus.supabase.co/other']){await db.query("UPDATE vault.decrypted_secrets SET decrypted_secret=$1 WHERE name='labelxr_project_url'",[url]);await denied('SELECT labelroom_private.queue_project_cleanup()')}await db.query("UPDATE vault.decrypted_secrets SET decrypted_secret=$1 WHERE name='labelxr_project_url'",['https://weziynwzjzbsctxxqmus.supabase.co']);await db.exec("UPDATE vault.decrypted_secrets SET decrypted_secret='short' WHERE name='labelxr_cleanup_token'");await denied('SELECT labelroom_private.queue_project_cleanup()');assert.equal((await db.query('SELECT * FROM net.synthetic_requests')).rows.length,0)});
 await check('Dispatch records contain no credentials and expire after24hours',async()=>{await config();await db.exec("INSERT INTO labelroom_private.cleanup_dispatches VALUES(-1,clock_timestamp()-interval '25 hours')");await db.exec('SELECT labelroom_private.queue_project_cleanup()');const rows=(await db.query('SELECT * FROM labelroom_private.cleanup_dispatches')).rows;assert.equal(rows.length,1);assert.deepEqual(Object.keys(rows[0]).sort(),['queued_at','request_id']);assert(!JSON.stringify(rows).includes('Bearer'))});
 await check('Scheduler source creates no automatic job or project mutation',async()=>{assert(!/cron\.(?:schedule|alter_job)\s*\(/i.test(migration));assert(!/\b(?:UPDATE|DELETE FROM)\s+public\./i.test(migration));assert.equal((await db.query("SELECT count(*)::int AS n FROM public.projects")).rows[0].n,0)});
 await check('Function and table deny all browser grants with fixed search path',async()=>{const f=(await db.query("SELECT p.prosecdef,p.proconfig,has_function_privilege('anon',p.oid,'EXECUTE') AS a,has_function_privilege('authenticated',p.oid,'EXECUTE') AS u,has_function_privilege('service_role',p.oid,'EXECUTE') AS s FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='labelroom_private' AND p.proname='queue_project_cleanup'")).rows[0];assert(f.prosecdef&&!f.a&&!f.u&&!f.s&&f.proconfig.includes('search_path=""'));for(const role of ['anon','authenticated','service_role'])assert(!(await db.query("SELECT has_table_privilege($1,'labelroom_private.cleanup_dispatches','SELECT') AS v",[role])).rows[0].v)});
 fs.writeFileSync(output,JSON.stringify({schema:'labelxr-cleanup-scheduler-sql/v1',passed:true,count:names.length,cases:names,hostedExtensionsInstalled:false,syntheticVaultAndPgNet:true,networkRequests:0,actualCloudChanges:0},null,2)+'\n');console.log(JSON.stringify({passed:true,count:names.length}));
}finally{await db.close()}
