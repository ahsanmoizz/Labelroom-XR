import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadBundleBytes } from '../../src/data/bundle';
import { createGuestDemoService } from '../../src/services/projects';
import { createDemoProvisionHandler, DEMO_SEED } from '../../supabase/functions/_shared/demo-provision';

const owner = '11111111-1111-4111-8111-111111111111';
const stranger = '22222222-2222-4222-8222-222222222222';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const origin = 'https://private-staging.example.com';
const base = 'https://staging.supabase.co';
const path = owner + '/' + id + '/original.lrx.zip';
const token = 'test.guest.signature';
const row = {
  id, owner_id: owner, storage_prefix: owner + '/' + id, status: 'ready',
  source_hash: DEMO_SEED.sha256, source_bytes: DEMO_SEED.bytes, current_revision: 0,
};
const identity = { id: owner, role: 'authenticated', is_anonymous: true };
afterEach(() => vi.restoreAllMocks());

function fixture() {
  const getUser = vi.fn(async (value: string) => ({ data: { user: value === token ? identity : null }, error: null }));
  const rpc = vi.fn(async (_name: string, _args: Record<string, unknown>): Promise<{ data: unknown; error: { code: string } | null }> =>
    ({ data: row, error: null }));
  const download = vi.fn(async (_path: string) => new Uint8Array(1));
  const uploadOriginal = vi.fn(async (_path: string, _bytes: Uint8Array) => {});
  const handler = createDemoProvisionHandler({ origin, client: { auth: { getUser } }, port: { rpc, download, uploadOriginal } });
  return {
    getUser, rpc, download, uploadOriginal,
    call: (body = { operation: 'open' }, source = origin, bearer = token) => handler(new Request(origin, {
      method: 'POST', body: JSON.stringify(body),
      headers: { Origin: source, Authorization: 'Bearer ' + bearer, 'Content-Type': 'application/json' },
    })),
  };
}

describe('staging guest provision boundary', () => {
  it('returns an existing project without a storage write', async () => {
    const test = fixture();
    const response = await test.call();
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual(row);
    expect(test.rpc).toHaveBeenCalledExactlyOnceWith('labelroom_demo_reserve', { p_owner: owner });
    expect(test.download).not.toHaveBeenCalled();
    expect(test.uploadOriginal).not.toHaveBeenCalled();
  });

  it('uses no provider for the wrong origin', async () => {
    const test = fixture();
    expect((await test.call(undefined, 'https://other.example.com')).status).toBe(403);
    expect(test.getUser).not.toHaveBeenCalled();
    expect(test.rpc).not.toHaveBeenCalled();
  });

  it('denies a forged bearer or a permanent account before RPC', async () => {
    const test = fixture();
    expect((await test.call(undefined, origin, 'bad.guest.signature')).status).toBe(401);
    test.getUser.mockResolvedValueOnce({ data: { user: { ...identity, is_anonymous: false } }, error: null });
    expect((await test.call()).status).toBe(403);
    expect(test.rpc).not.toHaveBeenCalled();
  });

  it.each([{ operation: 'reset' }, { operation: 'open', ownerId: stranger }, { operation: 'open', projectId: id }])
    ('rejects an unsupported request %j before RPC', async body => {
      const test = fixture();
      expect((await test.call(body)).status).toBe(400);
      expect(test.rpc).not.toHaveBeenCalled();
    });

  it('rejects another owner returned by a provider', async () => {
    const test = fixture();
    test.rpc.mockResolvedValueOnce({ data: { ...row, owner_id: stranger }, error: null });
    expect((await test.call()).status).toBe(503);
    expect(test.download).not.toHaveBeenCalled();
  });

  it('maps an expired reservation to conflict without storage', async () => {
    const test = fixture();
    test.rpc.mockResolvedValueOnce({ data: null, error: { code: '40001' } });
    expect((await test.call()).status).toBe(409);
    expect(test.download).not.toHaveBeenCalled();
  });

  it.each([1, DEMO_SEED.bytes])('blocks a wrong seed of %i bytes before uploading', async size => {
    const test = fixture();
    test.rpc.mockResolvedValueOnce({ data: { ...row, status: 'staging' }, error: null });
    test.download.mockResolvedValueOnce(new Uint8Array(size));
    expect((await test.call()).status).toBe(422);
    expect(test.download).toHaveBeenCalledExactlyOnceWith(DEMO_SEED.path);
    expect(test.uploadOriginal).not.toHaveBeenCalled();
    expect(test.rpc).toHaveBeenCalledTimes(1);
  });
});

function guestClient(user = identity) {
  return { auth: {
    async getSession() { return { data: { session: { access_token: token } }, error: null }; },
    async getUser() { return { data: { user }, error: null }; },
  } };
}

describe('staging guest browser service', () => {
  const config = { supabaseUrl: base, supabasePublishableKey: 'sb_publishable_fixture' };

  it('opens a saved guest revision with one caller bearer and private object GET', async () => {
    const bytes = new Uint8Array(await readFile('fixtures/contract-example.zip'));
    const bundle = await loadBundleBytes(bytes);
    const project = { ...row, source_hash: bundle.bundleSha256, source_bytes: bytes.length, current_revision: 1 };
    const calls: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      calls.push(url.pathname);
      expect(url.origin).toBe(base);
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer ' + token);
      if (url.pathname === '/functions/v1/demo-provision') {
        expect(init?.method).toBe('POST');
        expect(init?.body).toBe('{"operation":"open"}');
        return Response.json({ data: project });
      }
      if (url.pathname === '/rest/v1/projects') {
        expect(url.searchParams.get('kind')).toBe('eq.demo');
        expect(url.searchParams.get('owner_id')).toBe('eq.' + owner);
        return Response.json([project]);
      }
      if (url.pathname === '/storage/v1/object/authenticated/project-data/' + path) {
        expect(init?.method).toBe('GET');
        return new Response(bytes);
      }
      if (url.pathname === '/rest/v1/label_versions') {
        expect(url.searchParams.get('revision')).toBe('eq.1');
        return Response.json([{ project_id: id, revision: 1, label_doc: bundle.labelsDocument }]);
      }
      throw Error('Unexpected request');
    };
    const service = createGuestDemoService(guestClient(), config, fetcher);
    const result = await service.open(owner, new AbortController().signal);
    expect(result.project).toEqual(project);
    expect(result.original.bundleSha256).toBe(bundle.bundleSha256);
    expect(calls).toEqual([
      '/functions/v1/demo-provision', '/rest/v1/projects', '/storage/v1/object/authenticated/project-data/' + path,
      '/rest/v1/label_versions', '/rest/v1/projects',
    ]);
  });

  it('rejects an account switch before provisioning', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const service = createGuestDemoService(guestClient(), config, fetcher);
    await expect(service.open(stranger, new AbortController().signal)).rejects.toMatchObject({ code: 'AUTH' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects a permanent account before provisioning', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const service = createGuestDemoService(guestClient({ ...identity, is_anonymous: false }), config, fetcher);
    await expect(service.open(owner, new AbortController().signal)).rejects.toMatchObject({ code: 'AUTH' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

it.skipIf(!process.env.LABELXR_DEMO_SEED_FILE)('provisions the native pinned sample after a lost upload acknowledgement', async () => {
  const original = new Uint8Array(await readFile(process.env.LABELXR_DEMO_SEED_FILE!));
  const test = fixture();
  test.rpc.mockResolvedValueOnce({ data: { ...row, status: 'staging' }, error: null });
  test.download.mockResolvedValue(original);
  test.uploadOriginal.mockRejectedValueOnce(new Error('Synthetic lost acknowledgement'));
  const response = await test.call();
  expect(response.status).toBe(200);
  expect(test.uploadOriginal).toHaveBeenCalledOnce();
  expect(test.download.mock.calls).toEqual([[DEMO_SEED.path], [path]]);
  expect(test.rpc).toHaveBeenLastCalledWith('labelroom_demo_finalize', {
    p_owner: owner, p_id: id,
    p_manifest: expect.objectContaining({ frames: expect.arrayContaining([expect.objectContaining({ id: '00' })]) }),
    p_labels: expect.objectContaining({ openlabel: expect.any(Object) }),
  });
}, 30000);
