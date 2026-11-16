import { test } from '@playwright/test';
import { browserSuite } from './run-browser-suite';

test('actual SDK World enters and exits XR when an emulated device becomes available', async ({}, info) => {
  await browserSuite(info, 'session', 'labelxr-session-xr-browser/v1', 13);
});
test('emulated hands safely review, approve, undo and inspect in XR', async ({}, info) => {
  await browserSuite(info, 'xr', 'labelxr-webxr-emulator-integration/v1', 11);
});
