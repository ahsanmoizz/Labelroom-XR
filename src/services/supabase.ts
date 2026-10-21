// LABELXR-SUPABASE-CLIENT-v1
import type { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { PublicAppConfig } from '../app/config.js';

type ClientModule = { createClient: typeof createClient };
export type SupabaseLoader = () => Promise<ClientModule>;

/** One lazy client per application lifetime. No sign-in, account lookup or privileged key. */
export function createSupabaseInitializer(load: SupabaseLoader) {
  let pending: Promise<SupabaseClient> | undefined;
  let identity: string | undefined;
  return (config: Readonly<PublicAppConfig>): Promise<SupabaseClient> => {
    const next = JSON.stringify([config.supabaseUrl, config.supabasePublishableKey,
      config.turnstileSiteKey, config.appOrigin]);
    if (identity !== undefined && identity !== next) {
      return Promise.reject(new Error('Connection settings changed. Reload the application.'));
    }
    if (pending) return pending;
    identity = next;
    pending = Promise.resolve().then(load).then(module => module.createClient(
      config.supabaseUrl, config.supabasePublishableKey,
      { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, flowType: 'pkce' } }
    ));
    // Keep a rejected promise cached: retries require a page reload, avoiding duplicate clients.
    return pending;
  };
}
