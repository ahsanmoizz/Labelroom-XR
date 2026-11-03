// LABELXR-SERVER-ENV-v1
export type EnvironmentReader=(name:string)=>string|undefined;
const invalid=():never=>{throw Error('Configuration')};
function modern(value:unknown,kind:'publishable'|'secret'):string {
 if(typeof value!=='string'||value.length>512||!(kind==='publishable'?/^sb_publishable_[A-Za-z0-9_-]+$/:/^sb_secret_[A-Za-z0-9_-]+$/).test(value))return invalid();
 return value;
}
function named(read:EnvironmentReader,name:string,kind:'publishable'|'secret'):string|undefined {
 const raw=read(name);if(raw===undefined)return undefined;
 if(raw.length>32768)return invalid();
 let map:unknown;try{map=JSON.parse(raw)}catch{return invalid()}
 if(!map||typeof map!=='object'||Array.isArray(map)||!Object.prototype.hasOwnProperty.call(map,'default'))return invalid();
 return modern((map as Record<string,unknown>).default,kind);
}
/** Caller-scoped review clients always use a public key; no privileged fallback. */
export function publicApiKey(read:EnvironmentReader):string {
 const key=named(read,'SUPABASE_PUBLISHABLE_KEYS','publishable');
 return key??modern(read('SUPABASE_PUBLISHABLE_KEY'),'publishable');
}
/** The privileged key is resolved only inside the server-side project endpoint. */
export function serverApiKey(read:EnvironmentReader):string {
 const key=named(read,'SUPABASE_SECRET_KEYS','secret');if(key!==undefined)return key;
 const single=read('SUPABASE_SECRET_KEY');if(single!==undefined)return modern(single,'secret');
 const legacy=read('SUPABASE_SERVICE_ROLE_KEY');
 if(typeof legacy!=='string'||legacy.length>8192||!/^[-A-Za-z0-9_]+\.[-A-Za-z0-9_]+\.[-A-Za-z0-9_]+$/.test(legacy))return invalid();
 try{
  const encoded=legacy.split('.')[1].replace(/-/g,'+').replace(/_/g,'/');
  const payload:unknown=JSON.parse(atob(encoded.padEnd(Math.ceil(encoded.length/4)*4,'=')));
  if(!payload||typeof payload!=='object'||Array.isArray(payload)||(payload as {role?:unknown}).role!=='service_role')return invalid();
 }catch{return invalid()}
 // This is a configuration sanity check. Supabase still authenticates every request.
 return legacy;
}
