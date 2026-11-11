import { loadBundleBytes } from '../../../src/data/bundle.ts';
import { createVerifiedJsonHandler, type AuthenticationClient } from './auth.ts';
import { HttpProblem } from './http.ts';
import type { ProjectAdminPort, ProjectRecord } from './projects.ts';

export const DEMO_SEED = Object.freeze({
  path: 'demo-seeds/pandaset-v1/original.lrx.zip',
  bytes: 11404047,
  sha256: 'a23c36b9a243e7d8d9bace94c44caf40e8467c5dd1d8f10ed9e7f60834addc9b',
});

interface DemoPort extends Pick<ProjectAdminPort, 'rpc' | 'download'> {
  remove?(paths:readonly string[]):Promise<void>;
  uploadOriginal(path: string, bytes: Uint8Array<ArrayBuffer>): Promise<void>;
}

function projectRow(value: unknown, owner: string, deleting=false): ProjectRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpProblem('projectUnavailable');
  const project = value as ProjectRecord;
  if (typeof project.id !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(project.id)
      || project.owner_id !== owner || project.storage_prefix !== owner + '/' + project.id
      || !(deleting?['deleting']:['staging', 'ready']).includes(project.status)
      || project.source_bytes !== DEMO_SEED.bytes || project.source_hash !== DEMO_SEED.sha256
      || !Number.isSafeInteger(project.current_revision) || project.current_revision < 0 || project.current_revision > 300
      || (project.status === 'staging' && project.current_revision !== 0)) {
    throw new HttpProblem('projectUnavailable');
  }
  return {
    id: project.id, owner_id: owner, status: project.status, source_hash: project.source_hash,
    source_bytes: project.source_bytes, storage_prefix: project.storage_prefix, current_revision: project.current_revision,
  };
}

async function demoRpc(port: DemoPort, name: string, args: Record<string, unknown>) {
  let result: Awaited<ReturnType<DemoPort['rpc']>>;
  try {
    result = await port.rpc(name, args);
  } catch {
    throw new HttpProblem('projectUnavailable');
  }
  if (result.error) {
    const code = result.error.code;
    throw new HttpProblem(code === '42501' ? 'projectAccess' : code === '40001' ? 'projectConflict' : 'projectUnavailable');
  }
  return result.data;
}

async function verifiedSeedBytes(port: DemoPort, path: string): Promise<Uint8Array<ArrayBuffer>> {
  let bytes: Uint8Array;
  try {
    bytes = await port.download(path);
  } catch {
    throw new HttpProblem('projectUnavailable');
  }
  if (!(bytes.buffer instanceof ArrayBuffer) || bytes.length !== DEMO_SEED.bytes) throw new HttpProblem('projectData');
  const buffer = bytes as Uint8Array<ArrayBuffer>;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
  const hash = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
  if (hash !== DEMO_SEED.sha256) throw new HttpProblem('projectData');
  return buffer;
}

export function createDemoProvisionHandler(options: { origin: string; client: AuthenticationClient; port: DemoPort }) {
  const { origin, client, port } = options;
  return createVerifiedJsonHandler({ origin, client, access: 'authenticated' }, async (guest, body) => {
    if (guest.kind !== 'guest') throw new HttpProblem('projectAccess');
    if(body.operation==='reset'){
      if(body.confirmed!==true||Object.keys(body).some(k=>!['operation','projectId','confirmed'].includes(k))||(body.projectId!==undefined&&(typeof body.projectId!=='string'||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(body.projectId))))throw new HttpProblem('projectInput');
      if(!port.remove)throw new HttpProblem('projectUnavailable');
      let id=typeof body.projectId==='string'?body.projectId:null;
      const removed=(value:unknown)=>!!value&&typeof value==='object'&&(value as {id?:unknown}).id===id&&(value as {deleted?:unknown}).deleted===true;
      const state=await demoRpc(port,'labelroom_demo_begin_reset',{p_owner:guest.id,p_id:id});
      if(!removed(state)){
        const retiring=projectRow(state,guest.id,true);
        if(id!==null&&retiring.id!==id)throw new HttpProblem('projectUnavailable');
        id=retiring.id;
        const paths=[retiring.storage_prefix+'/original.lrx.zip'];
        for(let revision=0;revision<=300;revision++)paths.push(retiring.storage_prefix+'/exports/revision'+revision+'.lrx.zip');
        try{for(let offset=0;offset<paths.length;offset+=100)await port.remove(paths.slice(offset,offset+100));}catch{throw new HttpProblem('projectUnavailable');}
        if(!removed(await demoRpc(port,'labelroom_demo_finish_reset',{p_owner:guest.id,p_id:id})))throw new HttpProblem('projectUnavailable');
      }
    }else if (Object.keys(body).length !== 1 || body.operation !== 'open') throw new HttpProblem('projectInput');
    const project = projectRow(await demoRpc(port, 'labelroom_demo_reserve', { p_owner: guest.id }), guest.id);
    if (project.status === 'ready') return project;

    const original = await verifiedSeedBytes(port, DEMO_SEED.path);
    let source: Awaited<ReturnType<typeof loadBundleBytes>>;
    try {
      source = await loadBundleBytes(original);
    } catch {
      throw new HttpProblem('projectData');
    }
    const path = project.storage_prefix + '/original.lrx.zip';
    try {
      await port.uploadOriginal(path, original);
    } catch {
      // A concurrent open or lost acknowledgement may have created the immutable original.
      await verifiedSeedBytes(port, path);
    }
    const ready = projectRow(await demoRpc(port, 'labelroom_demo_finalize', {
      p_owner: guest.id, p_id: project.id, p_manifest: source.manifest, p_labels: source.labelsDocument,
    }), guest.id);
    if (ready.id !== project.id || ready.status !== 'ready') throw new HttpProblem('projectUnavailable');
    return ready;
  });
}
