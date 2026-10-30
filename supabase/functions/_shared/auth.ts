// LABELXR-SERVER-AUTH-v1
import { HttpProblem, approvedOrigin, checkRequest, jsonResponse, problemResponse, readJsonObject, requestDeadline } from './http.ts';

/** A server-created Supabase client with auth.getUser(token); no caller-supplied user. */
export interface AuthenticationClient {
  auth: { getUser(token: string): Promise<{ data: { user: unknown }; error: unknown }> };
}
export interface VerifiedIdentity { readonly id: string; readonly kind: 'member' | 'guest' }

export async function requireVerifiedUser(request: Request, client: AuthenticationClient, timeoutMs = 8000): Promise<Readonly<VerifiedIdentity>> {
  requestDeadline(timeoutMs);
  const authorization = request.headers.get('Authorization');
  if (!authorization || authorization.length > 8200) throw new HttpProblem('authentication');
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(authorization);
  if (!match || match[1].length > 8192) throw new HttpProblem('authentication');
  if (request.signal.aborted) throw new HttpProblem('authentication');
  const deadline = Date.now() + timeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeAbort: (() => void) | undefined;
  try {
    const denied = new Promise<never>((_, reject) => {
      const abort = () => reject(new HttpProblem('authentication'));
      request.signal.addEventListener('abort', abort, { once: true });
      removeAbort = () => request.signal.removeEventListener('abort', abort);
      timer = setTimeout(() => reject(new HttpProblem('authUnavailable')), timeoutMs);
    });
    // No JWT payload or local session is accepted as proof. getUser performs the verification.
    const result = await Promise.race([client.auth.getUser(match[1]), denied]);
    if (Date.now() >= deadline) throw new HttpProblem('authUnavailable');
    if (request.signal.aborted || result.error || !result.data?.user || typeof result.data.user !== 'object') throw new HttpProblem('authentication');
    const user = result.data.user as Record<string, unknown>;
    if (typeof user.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(user.id) ||
      user.role !== 'authenticated' || typeof user.is_anonymous !== 'boolean') throw new HttpProblem('authentication');
    return Object.freeze({ id: user.id, kind: user.is_anonymous ? 'guest' : 'member' });
  } catch (error) {
    if (error instanceof HttpProblem) throw error;
    throw new HttpProblem('authUnavailable');
  } finally { clearTimeout(timer); removeAbort?.(); }
}

export interface VerifiedJsonOptions {
  origin: string;
  client: AuthenticationClient;
  access: 'member' | 'authenticated';
  bodyTimeoutMs?: number;
  authTimeoutMs?: number;
}
/** Shared browser endpoint boundary; deployment must also retain gateway verify_jwt=true. */
export function createVerifiedJsonHandler(options: VerifiedJsonOptions,
  operation: (identity: Readonly<VerifiedIdentity>, body: Record<string, unknown>) => Promise<unknown>) {
  const origin = approvedOrigin(options.origin), access = options.access, client = options.client;
  if (access !== 'member' && access !== 'authenticated') throw new HttpProblem('configuration');
  const bodyTimeout = requestDeadline(options.bodyTimeoutMs ?? 5000), authTimeout = requestDeadline(options.authTimeoutMs ?? 8000);
  return async (request: Request): Promise<Response> => {
    const id = crypto.randomUUID();
    try {
      const preflight = checkRequest(request, origin, id); if (preflight) return preflight;
      const body = await readJsonObject(request, bodyTimeout);
      const identity = await requireVerifiedUser(request, client, authTimeout);
      if (access === 'member' && identity.kind !== 'member') throw new HttpProblem('member');
      if (request.signal.aborted) throw new HttpProblem('authentication');
      return jsonResponse(request, origin, id, await operation(identity, body));
    } catch (error) { return problemResponse(request, origin, id, error); }
  };
}
