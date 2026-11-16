import { test } from '@playwright/test';
import { browserSuite } from './run-browser-suite';

test('account entry, authorization boundaries and security footprint', async ({}, info) => {
  await browserSuite(info, 'auth', 'labelxr-auth-entry-browser/v1', 14);
});
test('hard refresh, owner-bound recovery and consent', async ({}, info) => {
  await browserSuite(info, 'refresh', 'labelxr-hard-refresh-browser/v1', 12);
});
test('measured AI evidence is readable and failures are disclosed', async ({}, info) => {
  await browserSuite(info, 'ai-readable', 'labelxr-ai-readable-browser/v1', 8);
});
