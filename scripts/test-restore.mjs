// Isolated PostgreSQL recovery rehearsal. Never connects to a hosted database.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {unzipSync} from 'fflate';
const output=process.argv[2];
assert(output&&path.isAbsolute(output)&&!fs.existsSync(output),'Pass a new absolute report directory.');
assert(process.argv.includes('--isolated-local-service'),'Explicit isolated local PostgreSQL service required.');
assert(!process.env.PGHOST||['localhost','127.0.0.1','::1'].includes(process.env.PGHOST),'Remote database addresses are prohibited.');
const port=process.env.LABELXR_RESTORE_PORT||'5432';assert(/^\d{1,5}$/.test(port),'Invalid local port.');
fs.mkdirSync(output,{recursive:true});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const env={...process.env,PGHOST:'127.0.0.1',PGHOSTADDR:'127.0.0.1',PGPORT:port,PGUSER:'postgres',PGDATABASE:'postgres',PGOPTIONS:'',PGSERVICE:'',PGSERVICEFILE:''};
const databases=['labelxr_rehearsal_source','labelxr_rehearsal_restored'];
const report={schema:'labelxr-isolated-postgres-restore/v1',startedAt:new Date().toISOString(),commit:process.env.GITHUB_SHA||null,passed:false,host:'loopback-only',syntheticSupabaseSchemas:true,hostedDatabaseRestored:false,hostedStorageRestored:false,migrations:[],checks:[]};
function command(name,args,input){const result=spawnSync(name,args,{env,encoding:'utf8',input,timeout:120000,maxBuffer:8*1024*1024});assert.equal(result.status,0,`${name} failed: ${(result.stderr||'').slice(0,1200)}`);return result.stdout.trim();}
function sql(database,text){assert(databases.includes(database)||database==='postgres');return command('psql',['--no-psqlrc','--set','ON_ERROR_STOP=1','--tuples-only','--no-align','--dbname',database],text);}
const literal=value=>"'"+String(value).replaceAll("'","''")+"'";
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',P='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const fingerprint=`SELECT jsonb_build_object(
 'projects',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY id),'[]') FROM public.projects x),
 'versions',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY project_id,revision),'[]') FROM public.label_versions x),
 'mutations',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY project_id,revision),'[]') FROM public.mutations x),
 'agentTurns',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY owner_id,turn_id),'[]') FROM public.agent_turns x),
 'budgets',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY day,scope,owner_id),'[]') FROM public.daily_budget x),
 'accounts',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY id),'[]') FROM auth.users x),
 'buckets',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY id),'[]') FROM storage.buckets x),
 'storage',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY name),'[]') FROM storage.objects x),
 'policies',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY schemaname,tablename,policyname),'[]') FROM pg_policies x WHERE schemaname IN ('public','storage')),
 'rls',(SELECT jsonb_agg(jsonb_build_array(n.nspname,c.relname,c.relrowsecurity) ORDER BY n.nspname,c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r' AND n.nspname IN ('public','storage')),
 'functions',(SELECT jsonb_agg(jsonb_build_array(n.nspname,p.proname,pg_get_function_identity_arguments(p.oid),p.prosecdef,p.proconfig,p.proacl::text,pg_get_functiondef(p.oid)) ORDER BY n.nspname,p.proname,p.oid::regprocedure::text) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','labelroom_private','auth')),
 'grants',(SELECT jsonb_agg(to_jsonb(x) ORDER BY table_schema,table_name,grantee,privilege_type) FROM information_schema.table_privileges x WHERE table_schema IN ('public','storage'))
);`;
try{
 report.postgres=command('psql',['--version']);
 assert.equal(sql('postgres',"SELECT count(*) FROM pg_database WHERE datname IN ('labelxr_rehearsal_source','labelxr_rehearsal_restored');"),'0','Existing databases must not be overwritten.');
 assert.equal(sql('postgres',"SELECT count(*) FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role');"),'0','Use a new dedicated PostgreSQL instance.');
 for(const name of databases)command('createdb',[name]);
 const core=fs.readFileSync('tests/sql/core.mjs','utf8');const fixture=JSON.parse(/^const fixture=(.+);$/m.exec(core)[1]);
 sql(databases[0],fixture);
 // pg_cron, Vault and pg_net belong to the hosted scheduler and are validated
 // by their dedicated fixture and observed hosted operations, not simulated here.
 const migrations=fs.readdirSync('supabase/migrations').filter(x=>x.endsWith('.sql')&&!x.includes('bounded_cleanup_schedule')).sort();
 for(const name of migrations){const bytes=fs.readFileSync(path.join('supabase/migrations',name));sql(databases[0],bytes.toString());report.migrations.push({name,sha256:hash(bytes)});}
 const original=fs.readFileSync('fixtures/contract-example.zip'),members=unzipSync(original),manifest=JSON.parse(Buffer.from(members['manifest.json'])),labels=JSON.parse(Buffer.from(members['labels.openlabel.json']));
 const frame=manifest.frames[0].id,object=Object.keys(labels.openlabel.frames[frame].objects)[0],before=labels.openlabel.frames[frame].objects[object].object_data.cuboid[0].val;
 const after=[...before];after[0]+=.01;
 const review={projectId:P,requestId:'99999999-9999-4999-8999-999999999999',baseRevision:0,operation:'updateCuboid',frameId:frame,objectId:object,before,after,reason:'other'};
 sql(databases[0],`BEGIN;INSERT INTO auth.users VALUES('${A}',false),('${B}',false);INSERT INTO public.projects(id,owner_id,kind,quota_slot,storage_prefix) VALUES('${P}','${A}','private',1,'${A}/${P}');UPDATE public.projects SET source_hash='${hash(original)}',source_bytes=${original.length},manifest=${literal(JSON.stringify(manifest))}::jsonb,source_label_doc=${literal(JSON.stringify(labels))}::jsonb WHERE id='${P}';INSERT INTO public.label_versions(project_id,revision,label_doc) VALUES('${P}',0,${literal(JSON.stringify(labels))}::jsonb);UPDATE public.projects SET status='ready' WHERE id='${P}';INSERT INTO storage.objects(bucket_id,name) VALUES('project-data','${A}/${P}/original.lrx.zip');COMMIT;BEGIN;SET LOCAL ROLE authenticated;SELECT set_config('request.jwt.claim.sub','${A}',true);SELECT public.commit_review(${literal(JSON.stringify(review))}::jsonb);COMMIT;`);
 sql(databases[0],`UPDATE public.projects SET ai_consent=true WHERE id='${P}';BEGIN;SET LOCAL ROLE service_role;SELECT public.reserve_ai_budget('${A}','${P}','77777777-7777-4777-8777-777777777777',1,1);COMMIT;`);
 const baseline=JSON.parse(sql(databases[0],fingerprint));
 assert.equal(baseline.budgets.length,2);assert.equal(baseline.agentTurns.length,1);
 const backup=path.join(output,'isolated-fixture.dump');
 command('pg_dump',['--format=custom','--file',backup,'--dbname',databases[0]]);
 command('pg_restore',['--exit-on-error','--single-transaction','--dbname',databases[1],backup]);
 assert.deepEqual(JSON.parse(sql(databases[1],fingerprint)),baseline,'Restored data, procedures, grants, policies or RLS differ.');
 report.checks.push('All fixture rows, complete review history, procedure definitions, ACLs, RLS and policies restored exactly');
 for(const [owner,count]of[[A,'1'],[B,'0']]){
  const result=sql(databases[1],`BEGIN;SET LOCAL ROLE authenticated;SELECT set_config('request.jwt.claim.sub','${owner}',true);SELECT count(*) FROM public.projects;ROLLBACK;`).split('\n');assert(result.includes(count),'Restored ownership boundary failed.');
 }
 report.checks.push('Restored owner can read its project; second owner cannot');
 assert.equal(sql(databases[1],"SELECT has_function_privilege('anon','public.commit_review(jsonb)','EXECUTE') OR has_function_privilege('authenticated','public.reserve_ai_budget(uuid,uuid,uuid,integer,integer)','EXECUTE');"),'f');
 report.checks.push('Anonymous review and authenticated budget execution remain denied');
 const storageCopy=path.join(output,'synthetic-original.lrx.zip');fs.writeFileSync(storageCopy,original,{flag:'wx'});assert.equal(hash(fs.readFileSync(storageCopy)),hash(original));
 report.checks.push('Separately copied fixture object bytes retain their SHA-256');
 report.dumpSha256=hash(fs.readFileSync(backup));report.catalogAndDataSha256=hash(JSON.stringify(baseline));report.sourceSha256=hash(original);report.passed=true;
}catch(error){report.error=String(error.message).slice(0,2000);process.exitCode=1;}
finally{report.finishedAt=new Date().toISOString();fs.writeFileSync(path.join(output,'restore-report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,error:report.error,hostedDatabaseRestored:false}));}
