import { createClient } from 'npm:@supabase/supabase-js@2.117.3';
import { createDemoProvisionHandler, DEMO_SEED } from '../_shared/demo-provision.ts';
import { serverApiKey } from '../_shared/environment.ts';
import { approvedOrigin } from '../_shared/http.ts';

function start() {
  const url = Deno.env.get('SUPABASE_URL') ?? '';
  const origin = approvedOrigin(Deno.env.get('DEMO_ALLOWED_ORIGIN') ?? Deno.env.get('DEMO_STAGING_ORIGIN') ?? '');
  const service = new URL(url);
  if((!Deno.env.get('DEMO_PROJECT_URL')||!Deno.env.get('DEMO_ALLOWED_ORIGIN'))
    &&(service.hostname==='weziynwzjzbsctxxqmus.supabase.co'||origin==='https://labelroom-xr.pages.dev'))throw Error('Explicit release configuration required');
  if ((Deno.env.get('DEMO_PROJECT_URL') ?? Deno.env.get('DEMO_STAGING_PROJECT_URL')) !== url || Deno.env.get('DEMO_PROVISION_ENABLED') !== 'true'
      || service.origin !== url || !/^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(url)
      ) throw Error('Configuration');

  const boundedFetch: typeof fetch = (input, init) => {
    if (new URL(input instanceof Request ? input.url : String(input)).origin !== service.origin) {
      return Promise.reject(Error('Service origin'));
    }
    const timeout = AbortSignal.timeout(15000);
    return fetch(input, {
      ...init, redirect: 'error',
      signal: init?.signal ? AbortSignal.any([timeout, init.signal]) : timeout,
    });
  };
  const client = createClient(url, serverApiKey(name => Deno.env.get(name)), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: boundedFetch },
  });
  const storage = client.storage.from('project-data');
  return createDemoProvisionHandler({
    origin, client, port: {
      async rpc(name, args) {
        const { data, error } = await client.rpc(name, args);
        return { data, error: error ? { code: error.code } : null };
      },
      async download(path) {
        const { data, error } = await storage.download(path);
        if (error || !data || data.size > DEMO_SEED.bytes) throw Error('Storage');
        return new Uint8Array(await data.arrayBuffer());
      },
      async uploadOriginal(path, bytes) {
        const { error } = await storage.upload(path, bytes, { contentType: 'application/zip', cacheControl: '0', upsert: false });
        if (error) throw Error('Storage');
      },
      async remove(paths){const{error}=await storage.remove([...paths]);if(error)throw Error('Storage');},
    },
  });
}

if (import.meta.main) {
  let handler: (request: Request) => Promise<Response>;
  try {
    handler = start();
  } catch {
    handler = async () => Response.json({ error: { code: 'configuration' } }, {
      status: 503, headers: { 'Cache-Control': 'no-store' },
    });
  }
  Deno.serve(handler);
}
