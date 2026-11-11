// LABELXR-PROJECT-CLEANUP-BUNDLE-v1
// Generated from reviewed service-only cleanup source.

// supabase/functions/project-cleanup/entry.ts
import { createClient } from "npm:@supabase/supabase-js@2.117.3";

// supabase/functions/_shared/environment.ts
var invalid = () => {
  throw Error("Configuration");
};
function modern(value, kind) {
  if (typeof value !== "string" || value.length > 512 || !(kind === "publishable" ? /^sb_publishable_[A-Za-z0-9_-]+$/ : /^sb_secret_[A-Za-z0-9_-]+$/).test(value)) return invalid();
  return value;
}
function named(read, name, kind) {
  const raw = read(name);
  if (raw === void 0) return void 0;
  if (raw.length > 32768) return invalid();
  let map;
  try {
    map = JSON.parse(raw);
  } catch {
    return invalid();
  }
  if (!map || typeof map !== "object" || Array.isArray(map) || !Object.prototype.hasOwnProperty.call(map, "default")) return invalid();
  return modern(map.default, kind);
}
function serverApiKey(read) {
  const key = named(read, "SUPABASE_SECRET_KEYS", "secret");
  if (key !== void 0) return key;
  const single = read("SUPABASE_SECRET_KEY");
  if (single !== void 0) return modern(single, "secret");
  const legacy = read("SUPABASE_SERVICE_ROLE_KEY");
  if (typeof legacy !== "string" || legacy.length > 8192 || !/^[-A-Za-z0-9_]+\.[-A-Za-z0-9_]+\.[-A-Za-z0-9_]+$/.test(legacy)) return invalid();
  try {
    const encoded = legacy.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=")));
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || payload.role !== "service_role") return invalid();
  } catch {
    return invalid();
  }
  return legacy;
}

// supabase/functions/_shared/project-cleanup.ts
var uuid = (x) => typeof x === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x);
var object = (x) => !!x && typeof x === "object" && !Array.isArray(x);
var deleted = (x, id) => object(x) && x.id === id && x.deleted === true;
function createProjectCleanupHandler(token, port) {
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw Error("Configuration");
  const response = (body, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  async function rpc(name, args) {
    const result = await port.rpc(name, args);
    if (result.error) throw Error("RPC");
    return result.data;
  }
  async function authenticated(value) {
    if (!value || value.length > 263 || !value.startsWith("Bearer ")) return false;
    const hash = async (v) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v)));
    const expected = await hash(token), actual = await hash(value.slice(7));
    let difference = 0;
    for (let i = 0; i < expected.length; i++) difference |= expected[i] ^ actual[i];
    return difference === 0;
  }
  return async (request) => {
    if (request.method !== "POST") return response({ error: { code: "method" } }, 405);
    if (!await authenticated(request.headers.get("Authorization"))) return response({ error: { code: "authentication" } }, 401);
    if (request.headers.has("Origin")) return response({ error: { code: "origin" } }, 403);
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("Content-Type") ?? "")) return response({ error: { code: "input" } }, 400);
    let body;
    try {
      if (!request.body) throw Error();
      const reader = request.body.getReader();
      const chunks = [];
      let count = 0;
      let timer, abort = () => {
      };
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error()), 5e3);
        abort = () => reject(Error());
        request.signal.addEventListener("abort", abort, { once: true });
        if (request.signal.aborted) abort();
      });
      try {
        for (; ; ) {
          const part = await Promise.race([reader.read(), timeout]);
          if (part.done) break;
          count += part.value.length;
          if (count > 128) throw Error();
          chunks.push(part.value);
        }
      } finally {
        clearTimeout(timer);
        request.signal.removeEventListener("abort", abort);
        await reader.cancel().catch(() => {
        });
        reader.releaseLock();
      }
      const bytes = new Uint8Array(count);
      let at = 0;
      for (const part of chunks) {
        bytes.set(part, at);
        at += part.length;
      }
      body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      return response({ error: { code: "input" } }, 400);
    }
    if (!object(body) || Object.keys(body).length !== 1 || !Number.isInteger(body.limit) || body.limit < 1 || body.limit > 25) return response({ error: { code: "input" } }, 400);
    const limit = body.limit;
    try {
      const candidates = await rpc("labelroom_cleanup_candidates", { p_limit: limit });
      if (!Array.isArray(candidates) || candidates.length > limit) throw Error("Candidates");
      let completed = 0, failed = 0;
      for (const candidate of candidates) {
        try {
          if (!object(candidate) || !uuid(candidate.id) || !uuid(candidate.owner_id) || candidate.storage_prefix !== candidate.owner_id + "/" + candidate.id) throw Error("Candidate");
          const id = candidate.id, state = await rpc("labelroom_cleanup_begin", { p_id: id });
          if (deleted(state, id)) {
            completed++;
            continue;
          }
          if (!object(state) || state.id !== id || state.owner_id !== candidate.owner_id || state.storage_prefix !== candidate.storage_prefix || state.status !== "deleting") throw Error("State");
          const paths = [state.storage_prefix + "/original.lrx.zip"];
          for (let rev = 0; rev <= 300; rev++) paths.push(state.storage_prefix + "/exports/revision" + rev + ".lrx.zip");
          for (let at = 0; at < paths.length; at += 100) await port.remove(paths.slice(at, at + 100));
          if (!deleted(await rpc("labelroom_cleanup_finish", { p_id: id }), id)) throw Error("Finish");
          completed++;
        } catch {
          failed++;
        }
      }
      return response({ schema: "labelxr-project-cleanup/v1", selected: candidates.length, completed, failed }, failed ? 503 : 200);
    } catch {
      return response({ error: { code: "cleanup_unavailable" } }, 503);
    }
  };
}

// supabase/functions/project-cleanup/entry.ts
function start() {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  if (!/^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(url)) throw Error("Configuration");
  const client = createClient(url, serverApiKey((name) => Deno.env.get(name)), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch(input, init) {
      if (new URL(input instanceof Request ? input.url : String(input)).origin !== url) return Promise.reject(Error("Origin"));
      return fetch(input, { ...init, redirect: "error", signal: AbortSignal.timeout(15e3) });
    } }
  });
  return createProjectCleanupHandler(Deno.env.get("PROJECT_CLEANUP_TOKEN") ?? "", {
    async rpc(name, args) {
      const { data, error } = await client.rpc(name, args);
      return { data, error };
    },
    async remove(paths) {
      const { error } = await client.storage.from("project-data").remove([...paths]);
      if (error) throw Error("Storage");
    }
  });
}
if (import.meta.main) {
  let handler;
  try {
    handler = start();
  } catch {
    handler = async () => Response.json({ error: { code: "configuration" } }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  Deno.serve(handler);
}
