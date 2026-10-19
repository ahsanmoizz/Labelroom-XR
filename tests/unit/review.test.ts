// LABELXR-REVIEW-TESTS-v1
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import { validateReviewCommand, reviewIssueFingerprint, type ReviewContext } from '../../src/domain/revision';
import type { BundleManifest } from '../../src/domain/schema';

const projectId = '00000000-0000-4000-8000-000000000002';
const requestId = '00000000-0000-4000-8000-000000000003';
const previousId = '00000000-0000-4000-8000-000000000004';
const sourceBundleSha256 = 'a'.repeat(64);
const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const val = [0, 0, 0.5, 0, 0, 0, 1, 2, 2, 2];
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v));
function fixtures() {
  const manifest = JSON.parse(fs.readFileSync(new URL('../../contracts/manifest.example.json', import.meta.url), 'utf8')) as BundleManifest;
  const labels = JSON.parse(fs.readFileSync(new URL('../../contracts/labels.example.openlabel.json', import.meta.url), 'utf8'));
  labels.openlabel.objects.partner = { name: 'partner', type: 'Example' };
  labels.openlabel.frames['0'].objects.partner = copy(labels.openlabel.frames['0'].objects['object-01']);
  labels.openlabel.frames['0'].objects.partner.object_data.cuboid[0].val[0] = 0.05;
  const context: ReviewContext = { projectId, sourceBundleSha256, revision: 0, manifest, labels: bytes(labels) };
  const command = { projectId, requestId, baseRevision: 0, operation: 'updateCuboid', frameId: '0', objectId: 'object-01', before: [...val], after: [0.1, ...val.slice(1)], reason: 'other' };
  return { context, command, labels };
}
const issue = { type: 'LOW_SUPPORT' as const, objectIds: ['object-01'] };
async function keep(f = fixtures()) {
  const fingerprint = await reviewIssueFingerprint(f.context, '0', issue);
  return { ...f.command, operation: 'keepIssue', after: undefined, issue, fingerprint };
}
function removal(f = fixtures()) {
  return { ...f.command, operation: 'removeDuplicate', after: undefined, partnerId: 'partner', partnerBefore: [0.05, ...val.slice(1)], confirmed: true, reason: 'duplicate' };
}
function undoFixture() {
  const f = fixtures(); f.context.revision = 1;
  f.context.lastMutation = { projectId, requestId: previousId, revision: 1, operation: 'updateCuboid', frameId: '0', objectId: 'object-01' };
  const command = { projectId, requestId, baseRevision: 1, operation: 'undo', frameId: '0', objectId: 'object-01', undoOf: previousId, reason: 'other' };
  return { ...f, command };
}
function editedLabels(f: ReturnType<typeof fixtures>) { f.context.labels = bytes(f.labels); }

describe('REV command boundary', () => {
  it('accepts the supplied exact edit example as a candidate without Saved state', async () => {
    const f = fixtures(), example = JSON.parse(fs.readFileSync(new URL('../../contracts/edit.example.json', import.meta.url), 'utf8'));
    const r = await validateReviewCommand(bytes(example), f.context);
    expect(r).toMatchObject({ disposition: 'new', candidateRevision: 1, command: example });
    expect(r).not.toHaveProperty('committedRevision'); expect(r).not.toHaveProperty('saveState'); expect(r.payloadSha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it('leaves source labels, manifest, input command and context byte identical', async () => {
    const f = fixtures(), before = JSON.stringify(f.context), input = bytes(f.command), saved = new Uint8Array(input);
    await validateReviewCommand(input, f.context); expect(input).toEqual(saved); expect(JSON.stringify(f.context)).toBe(before);
  });
  it('deep freezes accepted commands and their value arrays', async () => {
    const f = fixtures(), r = await validateReviewCommand(bytes(f.command), f.context);
    expect(Object.isFrozen(r)).toBe(true); expect(Object.isFrozen(r.command)).toBe(true);
    if (r.command.operation === 'updateCuboid') expect(Object.isFrozen(r.command.after)).toBe(true);
  });
  it('snapshots labels, manifest, command and revision before the first asynchronous hash', async () => {
    const f = fixtures(), input = bytes(f.command), promise = validateReviewCommand(input, f.context);
    input.fill(0); f.context.labels.fill(0); f.context.revision = 300; f.context.manifest.frames[0].id = 'changed';
    expect(await promise).toMatchObject({ disposition: 'new', candidateRevision: 1 });
  });
  it.each(['occlusion', 'valid-geometry', 'duplicate', 'other'])('accepts explicit update reason %s', async reason => {
    const f = fixtures(); f.command.reason = reason;
    expect((await validateReviewCommand(bytes(f.command), f.context)).disposition).toBe('new');
  });
  it.each([
    ['unknown operation', { operation: 'deleteProject' }], ['arbitrary patch', { patch: [] }], ['unknown reason', { reason: 'guess' }],
    ['missing request ID', { requestId: undefined }], ['bad UUID', { requestId: 'x' }], ['UUID whitespace', { requestId: requestId + ' ' }],
    ['blank frame', { frameId: ' ' }], ['long object ID', { objectId: 'x'.repeat(129) }], ['fraction revision', { baseRevision: 0.5 }],
    ['negative revision', { baseRevision: -1 }], ['revision above cap', { baseRevision: 301 }], ['coerced revision', { baseRevision: '0' }],
    ['short before tuple', { before: [0] }], ['long after tuple', { after: [...val, 1] }], ['out of bounds centre', { after: [251, ...val.slice(1)] }],
    ['undersize', { after: [...val.slice(0, 7), 0.01, 2, 2] }], ['oversize', { after: [...val.slice(0, 7), 51, 2, 2] }],
    ['bad quaternion', { after: [0, 0, 0, 0, 0, 0, 2, 2, 2, 2] }], ['non-upright quaternion', { after: [0, 0, 0, Math.SQRT1_2, 0, 0, Math.SQRT1_2, 2, 2, 2] }],
    ['numeric null', { after: [null, ...val.slice(1)] }],
  ])('rejects strict command: %s', async (_, change) => {
    const f = fixtures(); await expect(validateReviewCommand(bytes({ ...f.command, ...change }), f.context)).rejects.toMatchObject({ code: 'COMMAND' });
  });
  it.each([
    ['duplicate decoded key', '{"projectId":1,"projectId":2}'], ['escaped duplicate key', '{"x":1,"\\u0078":2}'],
    ['deep JSON', '['.repeat(9) + '0' + ']'.repeat(9)], ['trailing JSON', '{}{}'], ['infinite number', '1e999'],
  ])('rejects malformed bytes: %s', async (_, text) => {
    await expect(validateReviewCommand(new TextEncoder().encode(text), fixtures().context)).rejects.toMatchObject({ code: 'COMMAND' });
  });
  it('rejects invalid UTF8', async () => { await expect(validateReviewCommand(new Uint8Array([0xff]), fixtures().context)).rejects.toMatchObject({ code: 'COMMAND' }); });
  it('rejects input above 16 KiB', async () => { await expect(validateReviewCommand(new Uint8Array(16_385), fixtures().context)).rejects.toMatchObject({ code: 'COMMAND' }); });
  it('rejects shared command buffers', async () => { await expect(validateReviewCommand(new Uint8Array(new SharedArrayBuffer(1)), fixtures().context)).rejects.toMatchObject({ code: 'COMMAND' }); });
  it('rejects another project', async () => {
    const f = fixtures(); await expect(validateReviewCommand(bytes({ ...f.command, projectId: previousId }), f.context)).rejects.toMatchObject({ code: 'CONTEXT' });
  });
  it.each([['invalid revision', -1], ['fraction revision', 1.2], ['revision above cap', 301]])('rejects context %s', async (_, n) => {
    const f = fixtures(); f.context.revision = n; await expect(validateReviewCommand(bytes(f.command), f.context)).rejects.toMatchObject({ code: 'CONTEXT' });
  });
  it('rejects invalid current labels', async () => {
    const f = fixtures(); f.context.labels = bytes({}); await expect(validateReviewCommand(bytes(f.command), f.context)).rejects.toMatchObject({ code: 'CONTEXT' });
  });
  it('rejects invalid current manifest', async () => {
    const f = fixtures(); f.context.manifest.units = 'bad' as 'meters'; await expect(validateReviewCommand(bytes(f.command), f.context)).rejects.toMatchObject({ code: 'CONTEXT' });
  });
  it('rejects stale base revision', async () => {
    const f = fixtures(); f.context.revision = 1; await expect(validateReviewCommand(bytes(f.command), f.context)).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it('accepts revision 299 as candidate 300', async () => {
    const f = fixtures(); f.context.revision = f.command.baseRevision = 299; expect((await validateReviewCommand(bytes(f.command), f.context)).candidateRevision).toBe(300);
  });
  it('blocks new commands at revision 300', async () => {
    const f = fixtures(); f.context.revision = f.command.baseRevision = 300; await expect(validateReviewCommand(bytes(f.command), f.context)).rejects.toMatchObject({ code: 'LIMIT' });
  });
  it.each([['missing frame', { frameId: 'missing' }], ['missing occurrence', { objectId: 'missing' }], ['changed before', { before: [1e-12, ...val.slice(1)] }]])('rejects %s', async (_, change) => {
    const f = fixtures(); await expect(validateReviewCommand(bytes({ ...f.command, ...change }), f.context)).rejects.toMatchObject({ code: 'BEFORE' });
  });
  it('rejects an exact no-op', async () => {
    const f = fixtures(); f.command.after = [...val]; await expect(validateReviewCommand(bytes(f.command), f.context)).rejects.toMatchObject({ code: 'COMMAND' });
  });
  it('fails closed when WebCrypto is unavailable', async () => {
    vi.stubGlobal('crypto', undefined);
    try { const f = fixtures(); await expect(validateReviewCommand(bytes(f.command), f.context)).rejects.toMatchObject({ code: 'HASH' }); } finally { vi.unstubAllGlobals(); }
  });
});

describe('REV issue fingerprint invalidation', () => {
  it('accepts current keep issue and preserves its reason and fingerprint', async () => {
    const f = fixtures(), command = await keep(f), r = await validateReviewCommand(bytes(command), f.context);
    expect(r.issueFingerprint).toBe(command.fingerprint); expect(r.command.reason).toBe('other'); expect(Object.isFrozen((r.command as typeof command).issue.objectIds)).toBe(true);
  });
  it('rejects stale fingerprint', async () => {
    const f = fixtures(), command = await keep(f); f.labels.openlabel.frames['0'].objects['object-01'].object_data.cuboid[0].val[0] = .1; editedLabels(f); command.before[0] = .1;
    await expect(validateReviewCommand(bytes(command), f.context)).rejects.toMatchObject({ code: 'FINGERPRINT' });
  });
  it('excludes unrelated metadata from the geometry fingerprint', async () => {
    const f = fixtures(), old = await reviewIssueFingerprint(f.context, '0', issue); f.labels.openlabel.metadata.note = 'new note'; editedLabels(f);
    expect(await reviewIssueFingerprint(f.context, '0', issue)).toBe(old);
  });
  it('binds fingerprints to the source bundle', async () => {
    const f = fixtures(), old = await reviewIssueFingerprint(f.context, '0', issue); f.context.sourceBundleSha256 = 'b'.repeat(64);
    expect(await reviewIssueFingerprint(f.context, '0', issue)).not.toBe(old);
  });
  it('binds fingerprints to the project', async () => {
    const f = fixtures(), old = await reviewIssueFingerprint(f.context, '0', issue); f.context.projectId = previousId;
    expect(await reviewIssueFingerprint(f.context, '0', issue)).not.toBe(old);
  });
  it('binds fingerprints to the issue type', async () => {
    const f = fixtures(); expect(await reviewIssueFingerprint(f.context, '0', issue)).not.toBe(await reviewIssueFingerprint(f.context, '0', { ...issue, type: 'DIMENSION_JUMP' }));
  });
  it('sorts duplicate partner IDs without mutating their input', async () => {
    const f = fixtures(), pair = { type: 'DUPLICATE' as const, objectIds: ['partner', 'object-01'] };
    const a = await reviewIssueFingerprint(f.context, '0', pair); expect(pair.objectIds[0]).toBe('partner');
    expect(await reviewIssueFingerprint(f.context, '0', { ...pair, objectIds: [...pair.objectIds].reverse() })).toBe(a);
  });
  it('invalidates when an adjacent tracked box changes', async () => {
    const f = fixtures(); f.context.manifest.frames.push({ ...copy(f.context.manifest.frames[0]), id: '1', timestamp: .1, pcd: 'frames/001.pcd' });
    f.labels.openlabel.frames['1'] = copy(f.labels.openlabel.frames['0']); f.labels.openlabel.frames['1'].frame_properties.timestamp = .1; editedLabels(f);
    const old = await reviewIssueFingerprint(f.context, '0', issue); f.labels.openlabel.frames['1'].objects['object-01'].object_data.cuboid[0].val[7] = 3; editedLabels(f);
    expect(await reviewIssueFingerprint(f.context, '0', issue)).not.toBe(old);
  });
  it('invalidates when the tracked class changes', async () => {
    const f = fixtures(), old = await reviewIssueFingerprint(f.context, '0', issue); f.labels.openlabel.objects['object-01'].type = 'Changed'; editedLabels(f);
    expect(await reviewIssueFingerprint(f.context, '0', issue)).not.toBe(old);
  });
  it.each([
    ['unknown type', { type: 'GUESS', objectIds: ['object-01'] }], ['repeated IDs', { type: 'DUPLICATE', objectIds: ['object-01', 'object-01'] }],
    ['missing partner', { type: 'DUPLICATE', objectIds: ['object-01'] }], ['extra single ID', { type: 'LOW_SUPPORT', objectIds: ['object-01', 'partner'] }],
  ])('rejects malformed issue %s', async (_, bad) => {
    const f = fixtures(), command = await keep(f); await expect(validateReviewCommand(bytes({ ...command, issue: bad }), f.context)).rejects.toMatchObject({ code: 'COMMAND' });
  });
  it('rejects an issue that excludes the selected object', async () => {
    const f = fixtures(), command = await keep(f); command.issue = { type: 'LOW_SUPPORT', objectIds: ['partner'] };
    await expect(validateReviewCommand(bytes(command), f.context)).rejects.toMatchObject({ code: 'FINGERPRINT' });
  });
  it('rejects a missing issue partner even with a well formed fingerprint', async () => {
    const f = fixtures(), command = await keep(f);
    await expect(validateReviewCommand(bytes({ ...command, issue: { type: 'DUPLICATE', objectIds: ['object-01', 'absent'] } }), f.context)).rejects.toMatchObject({ code: 'BEFORE' });
  });
});

describe('REV duplicate command', () => {
  it('measures current oriented IoU and accepts only the selected occurrence command', async () => {
    const f = fixtures(), r = await validateReviewCommand(bytes(removal(f)), f.context);
    expect(r.duplicateIoU).toBeCloseTo(1.95 / 2.05, 12); expect(JSON.parse(new TextDecoder().decode(f.context.labels))).toEqual(f.labels);
  });
  it.each([
    ['unconfirmed removal', { confirmed: false }, 'COMMAND'], ['missing confirmation', { confirmed: undefined }, 'COMMAND'],
    ['supplied IoU', { iou: 1 }, 'COMMAND'], ['wrong reason', { reason: 'other' }, 'COMMAND'],
    ['self partner', { partnerId: 'object-01', partnerBefore: val }, 'DUPLICATE'], ['missing partner', { partnerId: 'absent' }, 'BEFORE'],
    ['changed partner before', { partnerBefore: val }, 'BEFORE'],
  ])('rejects %s', async (_, change, code) => {
    const f = fixtures(); await expect(validateReviewCommand(bytes({ ...removal(f), ...change }), f.context)).rejects.toMatchObject({ code });
  });
  it('rejects partners with different classes', async () => {
    const f = fixtures(); f.labels.openlabel.objects.partner.type = 'Other'; editedLabels(f);
    await expect(validateReviewCommand(bytes(removal(f)), f.context)).rejects.toMatchObject({ code: 'DUPLICATE' });
  });
  it('rejects overlap below the 0.90 threshold', async () => {
    const f = fixtures(), c = removal(f); c.partnerBefore[0] = .11; f.labels.openlabel.frames['0'].objects.partner.object_data.cuboid[0].val[0] = .11; editedLabels(f);
    await expect(validateReviewCommand(bytes(c), f.context)).rejects.toMatchObject({ code: 'DUPLICATE' });
  });
  it('rejects an AABB-looking rotated crossing using actual oriented overlap', async () => {
    const f = fixtures(), c = removal(f), a = [0, 0, 0, 0, 0, 0, 1, 8, 1, 2], b = [0, 0, 0, 0, 0, Math.SQRT1_2, Math.SQRT1_2, 8, 1, 2];
    c.before = a; c.partnerBefore = b; f.labels.openlabel.frames['0'].objects['object-01'].object_data.cuboid[0].val = a; f.labels.openlabel.frames['0'].objects.partner.object_data.cuboid[0].val = b; editedLabels(f);
    await expect(validateReviewCommand(bytes(c), f.context)).rejects.toMatchObject({ code: 'DUPLICATE' });
  });
});

describe('REV latest decision undo', () => {
  it.each(['updateCuboid', 'keepIssue', 'removeDuplicate'] as const)('accepts undo of latest %s', async operation => {
    const f = undoFixture(); f.context.lastMutation!.operation = operation;
    if (operation === 'removeDuplicate') { delete f.labels.openlabel.frames['0'].objects['object-01']; f.context.labels = bytes(f.labels); }
    expect((await validateReviewCommand(bytes(f.command), f.context)).candidateRevision).toBe(2);
  });
  it.each([
    ['no last mutation', 'missing'], ['earlier revision', 'revision'], ['another target', 'objectId'], ['another frame', 'frameId'],
    ['another project', 'projectId'], ['another request', 'requestId'], ['undo of undo', 'operation'],
  ])('rejects %s', async (_, field) => {
    const f = undoFixture();
    if (field === 'missing') f.context.lastMutation = undefined;
    else Object.assign(f.context.lastMutation!, { [field]: field === 'revision' ? 0 : field === 'operation' ? 'undo' : field === 'projectId' || field === 'requestId' ? requestId : 'other' });
    await expect(validateReviewCommand(bytes(f.command), f.context)).rejects.toMatchObject({ code: 'UNDO' });
  });
});

describe('REV receipt replay consistency', () => {
  async function replayFixture() {
    const f = fixtures(), r = await validateReviewCommand(bytes(f.command), f.context);
    f.context.revision = 1; f.context.priorRequest = { projectId, sourceBundleSha256, requestId, payloadSha256: r.payloadSha256, revision: 1 };
    return f;
  }
  it('recognizes the exact prior acknowledgement before stale before-values', async () => {
    const f = await replayFixture(); f.labels.openlabel.frames['0'].objects['object-01'].object_data.cuboid[0].val[0] = .1; editedLabels(f);
    expect(await validateReviewCommand(bytes(f.command), f.context)).toMatchObject({ disposition: 'replay', committedRevision: 1 });
  });
  it('recognizes a retry at the revision limit', async () => {
    const f = await replayFixture(); f.context.revision = 300;
    const r = await validateReviewCommand(bytes(f.command), f.context); expect(r.disposition).toBe('replay'); expect(r).not.toHaveProperty('candidateRevision');
  });
  it('uses canonical keys so reordered JSON is the same request', async () => {
    const f = await replayFixture(); const reversed = Object.fromEntries(Object.entries(f.command).reverse());
    expect((await validateReviewCommand(bytes(reversed), f.context)).disposition).toBe('replay');
  });
  it.each(['reason', 'after', 'baseRevision'])('rejects reuse of request ID with changed %s', async field => {
    const f = await replayFixture(), changed = { ...f.command, [field]: field === 'reason' ? 'occlusion' : field === 'after' ? [0.2, ...val.slice(1)] : 1 };
    await expect(validateReviewCommand(bytes(changed), f.context)).rejects.toMatchObject({ code: 'REPLAY' });
  });
  it.each(['projectId', 'sourceBundleSha256', 'requestId', 'payloadSha256', 'revision'])('rejects a mismatched stored %s receipt', async field => {
    const f = await replayFixture(); Object.assign(f.context.priorRequest!, { [field]: field === 'revision' ? 2 : field.endsWith('Sha256') ? 'c'.repeat(64) : previousId });
    await expect(validateReviewCommand(bytes(f.command), f.context)).rejects.toMatchObject({ code: 'REPLAY' });
  });
  it('binds payload hashes to source identity', async () => {
    const f = fixtures(), a = await validateReviewCommand(bytes(f.command), f.context); f.context.sourceBundleSha256 = 'b'.repeat(64);
    expect((await validateReviewCommand(bytes(f.command), f.context)).payloadSha256).not.toBe(a.payloadSha256);
  });
});
