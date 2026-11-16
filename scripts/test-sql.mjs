import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const jobs = [
  ['core', 'labelxr-core-sql-tests/v1', 108],
  ['review-budget', 'labelxr-review-budget-sql/v1', 82],
  ['agent', 'labelxr-ai-private-sql/v1', 22],
  ['demo-provision', 'labelxr-demo-provision-sql/v1', 9],
  ['guest-release', 'labelxr-guest-release-sql/v1', 18],
  ['cleanup-scheduler', 'labelxr-cleanup-scheduler-sql/v1', 7],
];
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--list') {
  for (const [name, , count] of jobs) console.log(`${name}: at least ${count} in-memory SQL cases`);
  process.exit(0);
}
assert(args.length === 4 && args[0] === '--runtime' && args[2] === '--output-dir',
  'Use --runtime ABS_PGLITE_PACKAGE --output-dir ABS_NEW_DIRECTORY');
const runtime = args[1], output = args[3];
assert(path.isAbsolute(runtime) && path.isAbsolute(output), 'Absolute paths required.');
const inside = (p, base) => { const r = path.relative(base, p); return r === '' || (r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r)); };
assert(!inside(output, root) && !inside(output, runtime), 'Reports must be outside the source and runtime.');
assert(!fs.existsSync(output), 'Output directory already exists; choose a new run directory.');
fs.mkdirSync(output, { recursive: true });
const compiled = path.join(output, 'review-reference.mjs');
buildSync({
  stdin: { contents: 'export {quaternionToYaw,orientedBoxIoU} from "./src/domain/geometry.ts"; export {reviewIssueFingerprint,validateReviewCommand} from "./src/domain/revision.ts"; export {unzipSync} from "fflate";', resolveDir: root },
  bundle: true, platform: 'node', format: 'esm', target: 'esnext', outfile: compiled, logLevel: 'silent',
});
const results = [];
for (const [name, schema, minimum] of jobs) {
  const report = path.join(output, name === 'core' ? 'core-sql-report.json' : name + '.json');
  const options = name === 'core' ? ['--runtime', runtime, '--output', report]
    : name === 'review-budget' ? ['--runtime', runtime, '--compiled', compiled, '--output', report]
    : name === 'demo-provision' ? [runtime] : [runtime, report];
  const run = spawnSync(process.execPath, [path.join(root, 'tests/sql', name + '.mjs'), ...options], {
    cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
  });
  fs.writeFileSync(path.join(output, name + '.log'), (run.stdout || '') + (run.stderr || ''));
  let evidence, error;
  try {
    assert.equal(run.status, 0, `Runner exited ${run.status}: ${run.error?.message || run.signal || ''}`);
    if (name === 'demo-provision') {
      evidence = JSON.parse(run.stdout.trim().split(/\r?\n/).at(-1));
      fs.writeFileSync(report, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
    } else evidence = JSON.parse(fs.readFileSync(report, 'utf8'));
    assert.equal(evidence.schema, schema);
    assert(evidence.passed === true || evidence.status === 'passed', 'Fixture did not pass.');
    assert((evidence.count ?? evidence.casesPassed) >= minimum, 'Required fixture coverage was lost.');
  } catch (e) { error = e.message; }
  const result = { suite: name, passed: !error, count: evidence?.count ?? evidence?.casesPassed ?? 0, ...(error ? { error } : {}) };
  results.push(result);
  console.log(JSON.stringify(result));
}
const summary = {
  schema: 'labelxr-sql-validation/v1', passed: results.every(x => x.passed),
  count: results.reduce((n, x) => n + (x.passed ? x.count : 0), 0), suites: results,
  syntheticSupabaseSchemas: true, liveCloudTested: false, physicalQuestTested: false,
};
fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
if (!summary.passed) process.exitCode = 1;
