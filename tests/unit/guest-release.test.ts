import {describe,it,expect,vi} from 'vitest';
import {createSupabaseReviewSnapshotSessions} from '../../src/services/review-snapshots';
import {createDemoProvisionHandler,DEMO_SEED} from '../../supabase/functions/_shared/demo-provision';
import {createProjectCleanupHandler} from '../../supabase/functions/_shared/project-cleanup';
const owner='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',fresh='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const token='fixture.guest.signature',origin='https://staging.example.com',config={supabaseUrl:'https://example.supabase.co',supabasePublishableKey:'sb_publishable_fixture'};
const user={id:owner,role:'authenticated',is_anonymous:true};
function auth(guest=true){return{auth:{getSession:vi.fn(async()=>({data:{session:{access_token:token}},error:null})),getUser:vi.fn(async()=>({data:{user:{...user,is_anonymous:guest}},error:null}))}};}
describe('guest saved review scope',()=>{
 it('reads only the remotely verified demo scope and rechecks account kind',async()=>{
  const client=auth(),fetcher=vi.fn(async(url,options)=>{const u=new URL(String(url));expect(u.searchParams.get('kind')).toBe('eq.demo');expect(u.searchParams.get('owner_id')).toBe('eq.'+owner);expect(new Headers(options.headers).get('Authorization')).toBe('Bearer '+token);return Response.json([]);});
  const session=await createSupabaseReviewSnapshotSessions(client,config,fetcher as typeof fetch,'demo')(new AbortController().signal);
  await session.head(id);expect(await session.current()).toBe(true);
  client.auth.getUser.mockResolvedValueOnce({data:{user:{...user,is_anonymous:false}},error:null});expect(await session.current()).toBe(false);
 });
 it.each([[true,'private'],[false,'demo']] as const)('rejects guest=%s from %s before a data read',async(guest,kind)=>{
  const fetcher=vi.fn();await expect(createSupabaseReviewSnapshotSessions(auth(guest),config,fetcher,kind)(new AbortController().signal)).rejects.toMatchObject({code:'AUTH'});expect(fetcher).not.toHaveBeenCalled();
 });
});
function demo(){
 const row={id,owner_id:owner,status:'deleting',source_hash:DEMO_SEED.sha256,source_bytes:DEMO_SEED.bytes,storage_prefix:owner+'/'+id,current_revision:3};
 const rpc=vi.fn(async(name,args)=>({data:name==='labelroom_demo_begin_reset'?row:name==='labelroom_demo_finish_reset'?{id,deleted:true}:{...row,id:fresh,status:'ready',storage_prefix:owner+'/'+fresh,current_revision:0},error:null}));
 const remove=vi.fn(async()=>{}),download=vi.fn(),uploadOriginal=vi.fn();
 const handler=createDemoProvisionHandler({origin,client:auth(),port:{rpc,remove,download,uploadOriginal}});
 const call=(body:unknown)=>handler(new Request(origin,{method:'POST',headers:{Origin:origin,Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)}));
 return{rpc,remove,download,uploadOriginal,call};
}
describe('explicit guest reset',()=>{
 it('retires only the verified guest project, removes bounded paths, then opens a new revision zero',async()=>{
  const f=demo(),response=await f.call({operation:'reset',projectId:id,confirmed:true});expect(response.status).toBe(200);expect((await response.json()).data.id).toBe(fresh);
  expect(f.rpc.mock.calls.map(v=>v[0])).toEqual(['labelroom_demo_begin_reset','labelroom_demo_finish_reset','labelroom_demo_reserve']);expect(f.rpc.mock.calls[0][1]).toEqual({p_owner:owner,p_id:id});
  expect(f.remove).toHaveBeenCalledTimes(4);const paths=f.remove.mock.calls.flatMap(v=>v[0]);expect(paths).toHaveLength(302);expect(paths.every(p=>p.startsWith(owner+'/'+id+'/'))).toBe(true);expect(f.uploadOriginal).not.toHaveBeenCalled();
 });
 it.each([{operation:'reset',projectId:id},{operation:'reset',projectId:id,confirmed:false},{operation:'reset',projectId:id,confirmed:true,ownerId:other}])('requires confirmation and exact request shape %j',async(body)=>{const f=demo();expect((await f.call(body)).status).toBe(400);expect(f.rpc).not.toHaveBeenCalled();});
 it('does not finish or reopen after a storage removal failure',async()=>{const f=demo();f.remove.mockRejectedValueOnce(Error('private detail'));expect((await f.call({operation:'reset',projectId:id,confirmed:true})).status).toBe(503);expect(f.rpc).toHaveBeenCalledTimes(1);});
 it('delegates a confirmed expired-session restart to the owner-bound SQL lookup',async()=>{const f=demo();const response=await f.call({operation:'reset',confirmed:true});expect(response.status).toBe(200);expect(f.rpc.mock.calls[0]).toEqual(['labelroom_demo_begin_reset',{p_owner:owner,p_id:null}]);expect((await response.json()).data.id).toBe(fresh);});
 it('refuses another owner or wrong project before removing storage',async()=>{const f=demo();f.rpc.mockResolvedValueOnce({data:{id,owner_id:other,status:'deleting',source_hash:DEMO_SEED.sha256,source_bytes:DEMO_SEED.bytes,storage_prefix:other+'/'+id,current_revision:0},error:null});expect((await f.call({operation:'reset',projectId:id,confirmed:true})).status).toBe(503);expect(f.remove).not.toHaveBeenCalled();});
});
describe('cron-only cleanup',()=>{
 const secret='test_cleanup_token_012345678901234567890123456789';
 function fixture(){const rpc=vi.fn(async(name,args)=>({data:name==='labelroom_cleanup_candidates'?[{id,owner_id:owner,storage_prefix:owner+'/'+id}]:name==='labelroom_cleanup_begin'?{id,owner_id:owner,storage_prefix:owner+'/'+id,status:'deleting'}:{id,deleted:true},error:null}));const remove=vi.fn(async()=>{}),handler=createProjectCleanupHandler(secret,{rpc,remove});return{rpc,remove,handler,call:(body:unknown={limit:10},bearer=secret,source?:string)=>handler(new Request('https://example.supabase.co/functions/v1/project-cleanup',{method:'POST',headers:{Authorization:'Bearer '+bearer,'Content-Type':'application/json',...(source?{Origin:source}:{})},body:JSON.stringify(body)}))};}
 it('performs bounded deletion and returns aggregate counts without owner data',async()=>{const f=fixture(),r=await f.call();expect(r.status).toBe(200);expect(await r.json()).toEqual({schema:'labelxr-project-cleanup/v1',selected:1,completed:1,failed:0});expect(f.remove).toHaveBeenCalledTimes(4);});
 it('denies browser and public credentials before privileged calls',async()=>{const f=fixture();expect((await f.call(undefined,'sb_publishable_fixture')).status).toBe(401);expect((await f.call(undefined,secret,origin)).status).toBe(403);expect(f.rpc).not.toHaveBeenCalled();expect(f.remove).not.toHaveBeenCalled();});
 it.each([{limit:0},{limit:26},{limit:1.5},{limit:10,projectId:id},{ownerId:owner}])('rejects unbounded or targeted request %j',async(body)=>{const f=fixture();expect((await f.call(body)).status).toBe(400);expect(f.rpc).not.toHaveBeenCalled();});
 it('never deletes storage if the database says the candidate is no longer eligible',async()=>{const f=fixture();f.rpc.mockResolvedValueOnce({data:[{id,owner_id:owner,storage_prefix:owner+'/'+id}],error:null}).mockResolvedValueOnce({data:null,error:{code:'42501'}});const r=await f.call();expect(r.status).toBe(503);expect((await r.json()).failed).toBe(1);expect(f.remove).not.toHaveBeenCalled();});
 it('retains deleting state and reports failure when storage fails',async()=>{const f=fixture();f.remove.mockRejectedValueOnce(Error('private error '+secret));const r=await f.call();expect(r.status).toBe(503);const text=await r.text();expect(text).not.toContain(secret);expect(text).not.toContain('private');expect(f.rpc.mock.calls.map(v=>v[0])).toEqual(['labelroom_cleanup_candidates','labelroom_cleanup_begin']);});
});
