import { z } from 'zod';
import { reviewHash, reviewUuid } from '../domain/review-snapshot';

const bookmarkSchema = z.strictObject({
  schema: z.literal('labelxr-open-workspace/v1'),
  kind: z.enum(['local', 'saved']), projectId: reviewUuid.optional(),
  sourceHash: reviewHash, reviewOpen: z.boolean(),
  frameId: z.string().min(1).max(256), objectId: z.string().max(256).optional(),
  scale: z.number().min(0.02).max(0.20),
}).refine(v => v.kind === 'saved' ? !!v.projectId : !v.projectId && !v.reviewOpen);
export type WorkspaceBookmark = z.infer<typeof bookmarkSchema>;
export interface WorkspaceCache {
  read(): WorkspaceBookmark | undefined;
  write(value: WorkspaceBookmark): void;
  clear(): void;
  loadLocal(): Promise<Uint8Array>;
  saveLocal(bytes: Uint8Array): Promise<void>;
}

/** A view bookmark, never authentication, a saved revision or permission to replay a mutation. */
export function createWorkspaceCache(scope: { backend: string; ownerId: string; kind: 'guest' | 'member' }, storage: Storage, factory: IDBFactory): WorkspaceCache {
  reviewUuid.parse(scope.ownerId);
  const backend = new URL(scope.backend);
  if (backend.origin !== scope.backend || backend.protocol !== 'https:') throw Error('Workspace scope differs.');
  const key = 'labelxr-open-workspace/v1/' + backend.host + '/' + scope.kind + '/' + scope.ownerId;
  async function local<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    if (!factory) throw Error('Local preview recovery is unavailable.');
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open('labelxr-open-workspaces', 1);
      let done = false;
      const timer = setTimeout(fail, 5000);
      function fail() { if (done) return; done = true; clearTimeout(timer); reject(Error('Local preview recovery is unavailable.')); }
      request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('sources')) request.result.createObjectStore('sources'); };
      request.onerror = request.onblocked = fail;
      request.onsuccess = () => { if (done) { request.result.close(); return; } done = true; clearTimeout(timer); request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    });
    return new Promise<T>((resolve, reject) => {
      let tx: IDBTransaction;
      try { tx = db.transaction('sources', mode); } catch { db.close(); reject(Error('Local preview recovery is unavailable.')); return; }
      const timer = setTimeout(() => { try { tx.abort(); } catch { /* Completion wins. */ } }, 5000);
      let request: IDBRequest<T>;
      try { request = work(tx.objectStore('sources')); }
      catch { clearTimeout(timer); try { tx.abort(); } catch { /* The transaction may already have aborted. */ } db.close(); reject(Error('Local preview recovery is unavailable.')); return; }
      tx.oncomplete = () => { clearTimeout(timer); db.close(); resolve(request.result); };
      tx.onabort = tx.onerror = () => { clearTimeout(timer); db.close(); reject(Error('Local preview recovery is unavailable.')); };
    });
  }
  return {
    read() { const value = storage.getItem(key); if (value === null) return; if (value.length > 2048) throw Error('Workspace bookmark is invalid.'); return bookmarkSchema.parse(JSON.parse(value)); },
    write(value) { storage.setItem(key, JSON.stringify(bookmarkSchema.parse(value))); },
    clear() { storage.removeItem(key); void local('readwrite', store => store.delete(key)).catch(() => {}); },
    async saveLocal(bytes) { if (!(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > 25 * 1024 * 1024) throw Error('Local preview size differs.'); await local('readwrite', store => store.put(new Uint8Array(bytes), key)); },
    async loadLocal() { const bytes = await local<unknown>('readonly', store => store.get(key)); if (!(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > 25 * 1024 * 1024) throw Error('Local preview recovery differs.'); return bytes; },
  };
}
