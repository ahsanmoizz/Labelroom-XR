// LABELXR-STARTUP-GATE-v1
import { validatePublicConfig } from './config.js';
import type { PublicAppConfig, PublicConfigMode } from './config.js';
import type { StartupView } from '../ui/setup.js';

export interface StartupDependencies {
  readonly render: (view: StartupView) => void;
  readonly connect: (config: Readonly<PublicAppConfig>) => Promise<unknown>;
  readonly startWorld: () => Promise<unknown>;
}
export type StartupOutcome = StartupView['status'];

/** Validation and origin matching happen before any SDK load or 3D initialization. */
export function createStartup(dependencies: StartupDependencies) {
  let pending: Promise<StartupOutcome> | undefined;
  return (environment: unknown, mode: PublicConfigMode, pageOrigin: string): Promise<StartupOutcome> => {
    if (pending) return pending;
    // Defer work one microtask so even reentrant/repeated startup calls share the same promise.
    pending = Promise.resolve().then(async (): Promise<StartupOutcome> => {
      const settings = validatePublicConfig(environment, mode);
      if (settings.status === 'setup-required') { dependencies.render(settings); return settings.status; }
      if (pageOrigin !== settings.config.appOrigin) {
        dependencies.render({ status: 'origin-mismatch' }); return 'origin-mismatch';
      }
      dependencies.render({ status: 'connecting' });
      try { await dependencies.connect(settings.config); }
      catch { dependencies.render({ status: 'connection-failed' }); return 'connection-failed'; }
      dependencies.render({ status: 'starting' });
      try { await dependencies.startWorld(); }
      catch { dependencies.render({ status: 'world-failed' }); return 'world-failed'; }
      dependencies.render({ status: 'ready' }); return 'ready';
    });
    return pending;
  };
}
