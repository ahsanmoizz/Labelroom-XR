export interface CleanupPort {
  rpc(name:string,args:Record<string,unknown>):Promise<{data:unknown;error:unknown}>;
  remove(paths:readonly string[]):Promise<void>;
}
const uuid=(x:unknown):x is string=>typeof x==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x);
const object=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x);
const deleted=(x:unknown,id:string)=>object(x)&&x.id===id&&x.deleted===true;
/** Deployment/cron secret is separate from all browser and Supabase API keys. */
export function createProjectCleanupHandler(token:string,port:CleanupPort){
  if(!/^[A-Za-z0-9_-]{32,256}$/.test(token))throw Error('Configuration');
  const response=(body:unknown,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
  async function rpc(name:string,args:Record<string,unknown>){const result=await port.rpc(name,args);if(result.error)throw Error('RPC');return result.data;}
  async function authenticated(value:string|null){
    if(!value||value.length>263||!value.startsWith('Bearer '))return false;
    const hash=async(v:string)=>new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(v)));
    const expected=await hash(token),actual=await hash(value.slice(7));let difference=0;
    for(let i=0;i<expected.length;i++)difference|=expected[i]^actual[i];return difference===0;
  }
  return async(request:Request):Promise<Response>=>{
    if(request.method!=='POST')return response({error:{code:'method'}},405);
    if(!await authenticated(request.headers.get('Authorization')))return response({error:{code:'authentication'}},401);
    if(request.headers.has('Origin'))return response({error:{code:'origin'}},403);
    if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type')??''))return response({error:{code:'input'}},400);
    let body:unknown;
    try{
      if(!request.body)throw Error();const reader=request.body.getReader();const chunks:Uint8Array[]=[];let count=0;
      let timer:ReturnType<typeof setTimeout>|undefined,abort:()=>void=()=>{};
      const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error()),5000);abort=()=>reject(Error());request.signal.addEventListener('abort',abort,{once:true});if(request.signal.aborted)abort();});
      try{for(;;){const part=await Promise.race([reader.read(),timeout]);if(part.done)break;count+=part.value.length;if(count>128)throw Error();chunks.push(part.value);}}
      finally{clearTimeout(timer);request.signal.removeEventListener('abort',abort);await reader.cancel().catch(()=>{});reader.releaseLock();}
      const bytes=new Uint8Array(count);let at=0;for(const part of chunks){bytes.set(part,at);at+=part.length;}
      body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
    }catch{return response({error:{code:'input'}},400);}
    if(!object(body)||Object.keys(body).length!==1||!Number.isInteger(body.limit)||(body.limit as number)<1||(body.limit as number)>25)return response({error:{code:'input'}},400);
    const limit=body.limit as number;
    try{
      const candidates=await rpc('labelroom_cleanup_candidates',{p_limit:limit});
      if(!Array.isArray(candidates)||candidates.length>limit)throw Error('Candidates');
      let completed=0,failed=0;
      for(const candidate of candidates){
        try{
          if(!object(candidate)||!uuid(candidate.id)||!uuid(candidate.owner_id)||candidate.storage_prefix!==candidate.owner_id+'/'+candidate.id)throw Error('Candidate');
          const id=candidate.id,state=await rpc('labelroom_cleanup_begin',{p_id:id});
          if(deleted(state,id)){completed++;continue;}
          if(!object(state)||state.id!==id||state.owner_id!==candidate.owner_id||state.storage_prefix!==candidate.storage_prefix||state.status!=='deleting')throw Error('State');
          const paths=[state.storage_prefix+'/original.lrx.zip'];for(let rev=0;rev<=300;rev++)paths.push(state.storage_prefix+'/exports/revision'+rev+'.lrx.zip');
          for(let at=0;at<paths.length;at+=100)await port.remove(paths.slice(at,at+100));
          if(!deleted(await rpc('labelroom_cleanup_finish',{p_id:id}),id))throw Error('Finish');completed++;
        }catch{failed++;}
      }
      return response({schema:'labelxr-project-cleanup/v1',selected:candidates.length,completed,failed},failed?503:200);
    }catch{return response({error:{code:'cleanup_unavailable'}},503);}
  };
}
