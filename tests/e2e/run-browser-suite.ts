import { test, expect, type TestInfo } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdir, readFile, copyFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

/** Run the existing DOM/WebGL/worker assertions, without replacing them with mocks. */
export async function browserSuite(info: TestInfo, name: string, schema: string, minimum: number) {
  const report = info.outputPath(name + '.json');
  await mkdir(path.dirname(report), { recursive: true });
  const entrypoint = name === 'browser' ? 'review' : name;
  const command = path.join(root, 'scripts', `test-browser-${entrypoint}.mjs`);
  const result = await new Promise<{code: number | null; signal: string | null; log: string}>((resolve, reject) => {
    const child = spawn(process.execPath, [command, report], { cwd: root, env: process.env });
    let log = '';
    const capture = (chunk: Buffer) => { log = (log + chunk.toString()).slice(-64_000); };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    const timeout = setTimeout(() => child.kill('SIGTERM'), 270_000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timeout); resolve({ code, signal, log }); });
  });
  await info.attach('runner-log', { body: result.log, contentType: 'text/plain' });
  expect(result.code, result.log || String(result.signal)).toBe(0);
  const bytes = await readFile(report);
  const evidence = JSON.parse(bytes.toString());
  expect(evidence.schema).toBe(schema);
  expect(evidence.passed).toBe(true);
  expect(evidence.count).toBeGreaterThanOrEqual(minimum);
  expect(evidence.pageErrors || []).toEqual([]);
  await info.attach(name, { body: bytes, contentType: 'application/json' });
  if (process.env.LABELXR_E2E_REPORT_DIR) {
    await mkdir(process.env.LABELXR_E2E_REPORT_DIR, { recursive: true });
    await copyFile(report, path.join(process.env.LABELXR_E2E_REPORT_DIR, name + '.json'), constants.COPYFILE_EXCL);
  }
  test.info().annotations.push({ type: 'scope', description: 'Local synthetic services; physical and hosted acceptance are separate.' });
}
