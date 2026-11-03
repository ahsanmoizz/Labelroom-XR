// LABELXR-PROJECT-ADMIN-ENTRY-v1
import {createClient} from 'npm:@supabase/supabase-js@2.117.3';
import {createProjectAdminHandler} from '../_shared/projects.ts';
import {approvedOrigin} from '../_shared/http.ts';
import {serverApiKey} from '../_shared/environment.ts';
function start(){
 const url=Deno.env.get('SUPABASE_URL')??'',key=serverApiKey(name=>Deno.env.get(name)),origin=approvedOrigin(Deno.env.get('ALLOWED_ORIGIN')??''),u=new URL(url);
 if(u.origin!==url||u.protocol!=='https:'||!key||key.length>8192)throw Error('Configuration');
 const boundedFetch:typeof fetch=(input,init)=>{if(new URL(input instanceof Request?input.url:String(input)).origin!==u.origin)return Promise.reject(Error('Service origin'));const signals=[AbortSignal.timeout(8000)];if(init?.signal)signals.push(init.signal);return fetch(input,{...init,redirect:'error',signal:AbortSignal.any(signals)})};
 const client=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:boundedFetch}});
 return createProjectAdminHandler({origin,client,port:{
  async rpc(name,args){const{data,error}=await client.rpc(name,args);return{data,error:error?{code:error.code}:null}},
  async download(path){const{data,error}=await client.storage.from('project-data').download(path);if(error||!data||data.size<1||data.size>26214400)throw Error('Storage');const bytes=new Uint8Array(await data.arrayBuffer());if(bytes.length!==data.size)throw Error('Storage');return bytes},
  async remove(paths){const{error}=await client.storage.from('project-data').remove([...paths]);if(error)throw Error('Storage')},
 }});
}
if(import.meta.main){let handler:(request:Request)=>Promise<Response>;try{handler=start()}catch{handler=async()=>Response.json({error:{code:'configuration',message:'Server configuration is unavailable.'}},{status:503,headers:{'Cache-Control':'no-store'}})}Deno.serve(handler)}
