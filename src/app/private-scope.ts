// LABELXR-PRIVATE-SCOPE-v1
import { createAuthService, type AuthPort } from '../services/auth.js';

/** Own disposable private resources and invalidate asynchronous results on reset. */
export function createPrivateScope() {
  let version = 0, clearing = false, blocked = false, disposed = false;
  const resources = new Set<{ active: boolean; clear: () => void }>();
  function reset() {
    if (disposed || clearing) throw new Error('Private workspace is unavailable.');
    version++; clearing = true; let failed = false;
    const current = [...resources]; resources.clear();
    try { for (const resource of current) { if (!resource.active) continue; resource.active = false; try { resource.clear(); } catch { failed = true; } } }
    finally { clearing = false; }
    if (failed) blocked = true;
    if (blocked) throw new Error('Private workspace could not be cleared.');
  }
  return {
    reset,
    ticket() {
      const at = version;
      return Object.freeze({ current: () => !disposed && !clearing && !blocked && version === at });
    },
    own(clear: () => void) {
      if (disposed || clearing || blocked) throw new Error('Private workspace is unavailable.');
      const resource = { active: true, clear }; resources.add(resource);
      return () => { if (!resource.active) return; resource.active = false; resources.delete(resource); try { clear(); } catch { blocked = true; version++; throw new Error('Private workspace could not be cleared.'); } };
    },
    dispose() { if (disposed) return; try { reset(); } finally { disposed = true; version++; } }
  };
}

export function createAccountWorkspace(port: AuthPort, clearPrivateView: () => void) {
  const scope = createPrivateScope();
  const auth = createAuthService(port, { clearPrivateData() {
    let failed = false;
    try { scope.reset(); } catch { failed = true; }
    try { clearPrivateView(); } catch { failed = true; }
    if (failed) throw new Error('Private workspace could not be cleared.');
  } });
  return { auth, scope, dispose() { try { auth.dispose(); } finally { scope.dispose(); } } };
}
