import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

// Read-only production verification. Only public same-origin files are fetched.
const root = fileURLToPath(new URL('../', import.meta.url));
const [originArg, output] = process.argv.slice(2);
const origin = new URL(originArg || 'https://labelroom-xr.pages.dev');
assert(origin.protocol === 'https:' && origin.pathname === '/' && !origin.search && !origin.hash && !origin.username && !origin.password);
assert(output && path.isAbsolute(output) && !fs.existsSync(output), 'Pass a new absolute report directory.');
fs.mkdirSync(output, { recursive: true });
const hash = b => createHash('sha256').update(b).digest('hex');
const publicNames = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_PUBLISHABLE_KEY', 'VITE_APP_ORIGIN', 'VITE_TURNSTILE_SITE_KEY', 'VITE_GUEST_DEMO', 'VITE_STAGING_GUEST_DEMO'];
const cache = new Map();
async function get(relative) {
  const url = new URL(relative, origin);
  assert(url.origin === origin.origin && !url.search && !url.hash, 'Only public same-origin paths are allowed.');
  if (cache.has(url.href)) return cache.get(url.href);
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  const reader = response.body?.getReader(), chunks = []; let length = 0;
  if (reader) for (;;) { const next = await reader.read(); if (next.done) break; length += next.value.length; if (length > 16 * 1024 * 1024) { await reader.cancel(); throw Error('Public asset exceeds the read bound.'); } chunks.push(next.value); }
  const data = Buffer.concat(chunks);
  const result = { status: response.status, data, headers: Object.fromEntries(response.headers) };
  cache.set(url.href, result); return result;
}
const report = { schema: 'labelxr-public-build-readback/v1', origin: origin.origin, commit: process.env.GITHUB_SHA || null, checkedAt: new Date().toISOString(), passed: false, hostedWrites: 0, modelRequests: 0, files: [] };
try {
  const index = await get('/'); assert.equal(index.status, 200, 'Public entry did not return HTTP 200.');
  const html = index.data.toString(), queue = [];
  for (const m of html.matchAll(/(?:src|href)=["']([^"']+\.js)["']/g)) {
    const url = new URL(m[1], origin); if (url.origin === origin.origin && url.pathname.startsWith('/assets/')) queue.push(url.pathname);
  }
  assert(queue.length, 'Public module entry was not found.');
  const env = {}, visited = new Set();
  while (queue.length && visited.size < 40) {
    const item = queue.shift(); if (visited.has(item)) continue; visited.add(item);
    const fetched = await get(item); assert.equal(fetched.status, 200, 'Referenced module is unavailable.');
    const text = fetched.data.toString();
    for (const name of publicNames) {
      const match = new RegExp('(?:["\\\']?' + name + '["\\\']?)\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")').exec(text);
      if (match) env[name] = JSON.parse(match[1]);
    }
    for (const m of text.matchAll(/["'](\.\/[A-Za-z0-9_.\/-]+\.js)["']/g)) {
      const next = new URL(m[1], new URL(item, origin)); if (next.origin === origin.origin && next.pathname.startsWith('/assets/')) queue.push(next.pathname);
    }
  }
  for (const name of publicNames.slice(0, 4)) assert(typeof env[name] === 'string' && env[name], 'Missing public build setting: ' + name);
  assert.equal(new URL(env.VITE_APP_ORIGIN).origin, origin.origin, 'Build origin differs from served origin.');
  assert(/^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(env.VITE_SUPABASE_URL), 'Unexpected public backend origin.');
  assert(env.VITE_SUPABASE_PUBLISHABLE_KEY.startsWith('sb_publishable_'), 'A modern publishable key is required.');
  report.publicConfiguration = { appOrigin: env.VITE_APP_ORIGIN, backendOrigin: env.VITE_SUPABASE_URL, publishableKeySha256: hash(env.VITE_SUPABASE_PUBLISHABLE_KEY), turnstileSiteKeySha256: hash(env.VITE_TURNSTILE_SITE_KEY), guestDemo: env.VITE_GUEST_DEMO === 'true' };
  const buildEnv = { ...process.env, NODE_ENV: 'production' };
  for (const key of Object.keys(buildEnv)) if (key.startsWith('VITE_')) delete buildEnv[key];
  Object.assign(buildEnv, env);
  const build = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], { cwd: root, env: buildEnv, encoding: 'utf8', timeout: 180_000, maxBuffer: 1024 * 1024 });
  fs.writeFileSync(path.join(output, 'build.log'), (build.stdout || '') + (build.stderr || ''));
  assert.equal(build.status, 0, 'Reproducible build failed.');
  function walk(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]); }
  const files = walk(path.join(root, 'dist')).filter(p => path.basename(p) !== '_headers');
  for (const file of files) {
    const relative = path.relative(path.join(root, 'dist'), file).split(path.sep).join('/');
    const local = fs.readFileSync(file), served = await get('/' + relative);
    report.files.push({ path: relative, status: served.status, bytes: local.length, builtSha256: hash(local), servedSha256: hash(served.data), matches: served.status === 200 && hash(local) === hash(served.data) });
  }
  report.headers = { noSniff: index.headers['x-content-type-options'] === 'nosniff', denyFraming: index.headers['x-frame-options'] === 'DENY', xrPermissions: (index.headers['permissions-policy'] || '').includes('xr-spatial-tracking=(self)') };
  report.passed = report.files.length > 0 && report.files.every(f => f.matches) && Object.values(report.headers).every(Boolean);
  report.mismatches = report.files.filter(f => !f.matches).map(f => f.path);
} catch (error) { report.error = error.message; }
fs.writeFileSync(path.join(output, 'public-readback.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ passed: report.passed, files: report.files.length, mismatches: report.mismatches || [], error: report.error }));
if (!report.passed) process.exitCode = 1;
