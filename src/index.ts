// LABELXR-ACCOUNT-ENTRY-v1
import { createApplicationHost } from './app/host.js';
import { createSupabaseInitializer } from './services/supabase.js';
import { createSupabaseAuthPort } from './services/auth.js';
import { createChallenge, loadTurnstile } from './services/captcha.js';
import { createDatasetWorkspace } from './app/dataset-workspace.js';

const statusRoot = document.getElementById('setup-status');
const accountRoot = document.getElementById('account-container');
const privateRoot = document.getElementById('scene-container');
if (!statusRoot || !accountRoot || !privateRoot) throw new Error('Required application containers are missing.');
const connect = createSupabaseInitializer(() => import('@supabase/supabase-js'));
const application = createApplicationHost({
  statusRoot, accountRoot, privateRoot,
  connect: async config => createSupabaseAuthPort(await connect(config)),
  challenge: (element, siteKey) => createChallenge(element, siteKey, () => loadTurnstile(window)),
  openWorkspace: createDatasetWorkspace(async () => {
    const [{ World }, { default: options }] = await Promise.all([
      import('@iwsdk/core'), import('virtual:iwsdk-project')
    ]);
    return container => World.create(container, options);
  }),
  reload: () => window.location.reload()
});
window.addEventListener('pagehide', () => application.dispose(), { once: true });
window.addEventListener('pageshow', event => { if (event.persisted) window.location.reload(); });
void application.start(import.meta.env, import.meta.env.DEV ? 'development' : 'production', window.location.origin);
