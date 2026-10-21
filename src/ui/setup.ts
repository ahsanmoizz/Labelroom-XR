// LABELXR-SETUP-VIEW-v1
import type { PublicConfigIssue } from '../app/config.js';

export type StartupView =
  { readonly status: 'setup-required'; readonly issues: readonly PublicConfigIssue[] } |
  { readonly status: 'origin-mismatch' | 'connecting' | 'starting' | 'ready' | 'connection-failed' | 'world-failed' };
const FIELDS: Record<PublicConfigIssue['field'], string> = {
  VITE_SUPABASE_URL: 'Data service address', VITE_SUPABASE_PUBLISHABLE_KEY: 'Public connection key',
  VITE_TURNSTILE_SITE_KEY: 'Verification site key', VITE_APP_ORIGIN: 'Application address',
  PUBLIC_ENVIRONMENT: 'Application settings'
};
const CODES: Record<PublicConfigIssue['code'], string> = {
  missing: 'is missing', invalid: 'needs correction', 'private-value': 'contains an unsupported private value',
  'test-key': 'uses a development key in a production build'
};
const COPY = {
  'origin-mismatch': ['Application address does not match', 'Open the configured application address, or ask the owner to correct its settings.'],
  connecting: ['Preparing the connection', 'Loading the account client.'],
  starting: ['Starting the workspace', 'Connection settings passed. Preparing the 3D workspace.'],
  ready: ['Workspace scaffold ready', 'The account client and 3D scaffold started. Email sign-in, guest access and review controls are not available in this build yet.'],
  'connection-failed': ['Connection client could not start', 'Reload to try again. If this continues, ask the application owner to check its setup.'],
  'world-failed': ['3D workspace could not start', 'Reload to try again in a supported browser. Account access and review remain unavailable.']
} as const;

/** Render fixed copy and field/code labels only. Never interpolate settings, tokens or SDK errors. */
export function renderStartup(host: HTMLElement, view: StartupView, reload: () => void): void {
  const doc = host.ownerDocument;
  const card = doc.createElement('section'); card.className = 'setup-card';
  card.setAttribute('aria-labelledby', 'startup-title');
  const title = doc.createElement('h1'); title.id = 'startup-title';
  const message = doc.createElement('p'); message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite');
  if (view.status === 'setup-required') {
    title.textContent = 'LabelRoom XR needs configuration';
    message.textContent = 'The application owner needs to finish connection settings before you can continue.';
    const list = doc.createElement('ul');
    for (const issue of view.issues) {
      const item = doc.createElement('li'); item.textContent = `${FIELDS[issue.field]} ${CODES[issue.code]}.`; list.append(item);
    }
    card.append(title, message, list);
  } else {
    const copy = COPY[view.status]; title.textContent = copy[0]; message.textContent = copy[1]; card.append(title, message);
  }
  if (!['connecting', 'starting', 'ready'].includes(view.status)) {
    const button = doc.createElement('button'); button.type = 'button'; button.textContent = 'Reload application';
    button.addEventListener('click', reload); card.append(button);
  }
  host.replaceChildren(card);
}
