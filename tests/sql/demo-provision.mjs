import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [runtime] = process.argv.slice(2);
assert(path.isAbsolute(runtime ?? ''), 'Pass the absolute path to the PGlite 0.3.14 package.');
const root = fileURLToPath(new URL('../../', import.meta.url));
const core = await readFile(path.join(root, 'tests/sql/core.mjs'), 'utf8');
const fixture = JSON.parse(/^const fixture=(.+);$/m.exec(core)[1]);
const files = JSON.parse(/^const runtimeFiles=(.+);$/m.exec(core)[1]);
for (const [file, hash] of Object.entries(files)) {
  assert.equal(createHash('sha256').update(await readFile(path.join(runtime, file))).digest('hex'), hash, file);
}
const { PGlite } = await import(pathToFileURL(path.join(runtime, 'dist/index.js')).href);
const db = new PGlite();
const guestA = '11111111-1111-4111-8111-111111111111';
const guestB = '22222222-2222-4222-8222-222222222222';
const member = '33333333-3333-4333-8333-333333333333';
const reserve = 'select public.labelroom_demo_reserve($1) as project';
const finalize = 'select public.labelroom_demo_finalize($1,$2,$3,$4) as project';
const manifest = '{"sample":"synthetic SQL fixture"}';
const labels = '{"openlabel":{"frames":{}}}';
const seed = 'demo-seeds/pandaset-v1/original.lrx.zip';
const seedHash = 'a23c36b9a243e7d8d9bace94c44caf40e8467c5dd1d8f10ed9e7f60834addc9b';
const cases = [];
function query(role, owner, sql, params = []) {
  assert(['anon', 'authenticated', 'service_role'].includes(role));
  return db.transaction(async tx => {
    await tx.exec('SET LOCAL ROLE ' + role);
    await tx.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [owner]);
    return tx.query(sql, params);
  });
}
const service = (sql, params) => query('service_role', '', sql, params);
const denies = (work, code) => assert.rejects(work, { code });
async function test(name, fn) {
  await fn();
  cases.push(name);
}
try {
  await db.waitReady;
  await db.exec(fixture);
  for (const name of ['202610100001_core.sql', '202610100004_projects.sql', '20261109192832_demo_provision.sql']) {
    await db.exec(await readFile(path.join(root, 'supabase/migrations', name), 'utf8'));
  }
  await db.query('INSERT INTO auth.users VALUES ($1,true),($2,true),($3,false)', [guestA, guestB, member]);
  const first = (await service(reserve, [guestA])).rows[0].project;
  const second = (await service(reserve, [guestB])).rows[0].project;
  const original = first.storage_prefix + '/original.lrx.zip';
  const args = [guestA, first.id, manifest, labels];

  await test('only the server role can call either RPC', async () => {
    for (const role of ['anon', 'authenticated']) {
      await denies(query(role, guestA, reserve, [guestA]), '42501');
      await denies(query(role, guestA, finalize, args), '42501');
    }
  });
  await test('permanent and missing identities are rejected', async () => {
    await denies(service(reserve, [member]), '42501');
    await denies(service(reserve, [null]), '42501');
  });
  await test('each verified guest gets one distinct pinned reservation', async () => {
    assert.notEqual(first.id, second.id);
    assert.equal(first.status, 'staging');
    assert.equal(first.source_hash, seedHash);
    assert.equal(first.source_bytes, 11404047);
    assert.deepEqual((await service(reserve, [guestA])).rows[0].project, first);
    const interval = await db.query("select expires_at-created_at = interval '24 hours' as exact from projects where id=$1", [first.id]);
    assert.equal(interval.rows[0].exact, true);
  });
  await test('an original object is required and failed finalization leaves no version', async () => {
    await denies(service(finalize, args), '55000');
    assert.equal((await db.query('select * from label_versions')).rows.length, 0);
  });

  await service("INSERT INTO storage.objects(bucket_id,name) VALUES ('project-data',$1),('project-data',$2)", [original, seed]);
  await test('staging source and shared seed are hidden from the guest', async () => {
    assert.equal((await query('authenticated', guestA, 'select * from projects')).rows.length, 0);
    assert.equal((await query('authenticated', guestA, 'select * from storage.objects')).rows.length, 0);
  });
  await test('guest cannot upload an original or finalize another guest', async () => {
    await denies(query('authenticated', guestB, "INSERT INTO storage.objects(bucket_id,name) VALUES ('project-data',$1)",
      [second.storage_prefix + '/original.lrx.zip']), '42501');
    await denies(service(finalize, [guestB, first.id, manifest, labels]), '42501');
  });
  await test('finalize publishes one atomic revision zero and retries reuse it', async () => {
    const ready = (await service(finalize, args)).rows[0].project;
    assert.equal(ready.status, 'ready');
    assert.equal(ready.current_revision, 0);
    assert.deepEqual((await service(finalize, args)).rows[0].project, ready);
    assert.deepEqual((await service(reserve, [guestA])).rows[0].project, ready);
    assert.equal((await db.query('select * from label_versions')).rows.length, 1);
    await denies(service(finalize, [guestA, first.id, '{}', labels]), '40001');
  });
  await test('only the owner reads the ready project, version and copied object', async () => {
    const ownerObjects = await query('authenticated', guestA, 'select name from storage.objects');
    assert.deepEqual(ownerObjects.rows, [{ name: original }]);
    assert.equal((await query('authenticated', guestA, 'select * from projects')).rows.length, 1);
    assert.equal((await query('authenticated', guestA, 'select * from label_versions')).rows.length, 1);
    for (const other of [guestB, member]) {
      for (const table of ['projects', 'label_versions', 'storage.objects']) {
        assert.equal((await query('authenticated', other, 'select * from ' + table)).rows.length, 0);
      }
    }
    assert.equal((await query('anon', '', 'select * from storage.objects')).rows.length, 0);
  });
  await test('expired demo cannot be reopened or read through RLS', async () => {
    // Advance only the fixture timestamps. The production trigger stays enabled for the assertions.
    await db.exec("ALTER TABLE projects DISABLE TRIGGER labelroom_project_guard; UPDATE projects SET created_at=now()-interval '25 hours',expires_at=now()-interval '1 hour' WHERE status='ready'; ALTER TABLE projects ENABLE TRIGGER labelroom_project_guard;");
    await denies(service(reserve, [guestA]), '40001');
    await denies(service(finalize, args), '40001');
    assert.equal((await query('authenticated', guestA, 'select * from projects')).rows.length, 0);
    assert.equal((await query('authenticated', guestA, 'select * from storage.objects')).rows.length, 0);
  });
  console.log(JSON.stringify({ schema: 'labelxr-demo-provision-sql/v1', count: cases.length, cases, passed: true }));
} finally {
  await db.close();
}
