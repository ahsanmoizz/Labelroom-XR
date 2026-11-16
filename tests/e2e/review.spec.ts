import { test } from '@playwright/test';
import { browserSuite } from './run-browser-suite';

test('review decisions, saved recovery, export, responsive layout and navigation', async ({}, info) => {
  await browserSuite(info, 'browser', 'labelxr-browser-review-regression/v1', 43);
});
test('isolation, source-axis projections and tabletop rotation', async ({}, info) => {
  await browserSuite(info, 'view-tools', 'labelxr-inspection-browser/v1', 9);
});
test('actual SDK refocus preserves the current review and receipt download', async ({}, info) => {
  await browserSuite(info, 'focus', 'labelxr-sdk-refocus-review-browser/v1', 6);
});
