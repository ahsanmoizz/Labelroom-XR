// LABELXR-ACCOUNT-ENTRY-v1
import { createApplicationHost } from './app/host.js';
import { createSupabaseInitializer } from './services/supabase.js';
import { createSupabaseAuthPort } from './services/auth.js';
import { createChallenge, loadTurnstile } from './services/captcha.js';
import { createDatasetWorkspace } from './app/dataset-workspace.js';
import { createGuestDemoService, createProjectsService, createSupabaseProjectsSessions } from './services/projects.js';
import { mountMemberReviewWorkspace, mountGuestReviewWorkspace } from './app/review-workspace.js';

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
  }, {
    guestDemo: import.meta.env.VITE_GUEST_DEMO === 'true' || (import.meta.env.VITE_STAGING_GUEST_DEMO === 'true' && window.location.origin !== 'https://labelroom-xr.pages.dev')
      ? async (context, signal) => {
        if (import.meta.env.VITE_GUEST_DEMO !== 'true' && context.config.supabaseUrl === 'https://weziynwzjzbsctxxqmus.supabase.co') throw new Error('Staging project required.');
        return createGuestDemoService(await connect(context.config), context.config).open(context.user.id, signal);
      } : undefined,
    resetGuestDemo: async(context,projectId,signal)=>createGuestDemoService(await connect(context.config),context.config).reset(context.user.id,projectId,signal),
    projects: async context => createProjectsService(createSupabaseProjectsSessions(await connect(context.config), context.config)),
    review: async (root, signal, context, result, presentation) => (context.user.kind==='guest'?mountGuestReviewWorkspace:mountMemberReviewWorkspace)(root, {
      client: await connect(context.config), config: context.config, ownerId: context.user.id,
      projectId: result.project.id, original: result.original, signal, ...presentation
    })
  }),
  reload: () => window.location.reload()
});
window.addEventListener('pagehide', () => application.dispose(), { once: true });
window.addEventListener('pageshow', event => { if (event.persisted) window.location.reload(); });
void application.start(import.meta.env, import.meta.env.DEV ? 'development' : 'production', window.location.origin);
