// LABELXR-STARTUP-ENTRY-v1
import { createStartup } from './app/startup.js';
import { createSupabaseInitializer } from './services/supabase.js';
import { renderStartup } from './ui/setup.js';

const host = document.getElementById('setup-status');
const container = document.getElementById('scene-container');
if (!host || !(container instanceof HTMLDivElement)) throw new Error('Required application containers are missing.');
const startup = createStartup({
  render: view => renderStartup(host, view, () => window.location.reload()),
  connect: createSupabaseInitializer(() => import('@supabase/supabase-js')),
  startWorld: async () => {
    const [{ World }, { default: options }] = await Promise.all([
      import('@iwsdk/core'), import('virtual:iwsdk-project')
    ]);
    await World.create(container, options);
  }
});
void startup(import.meta.env, import.meta.env.DEV ? 'development' : 'production', window.location.origin);
