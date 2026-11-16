import {createClient} from 'npm:@supabase/supabase-js@2.117.3';
import {serverApiKey} from '../_shared/environment.ts';
import {createProjectCleanupHandler} from '../_shared/project-cleanup.ts';
function start(){
  const url=Deno.env.get('SUPABASE_URL')??'';
  if(!/^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(url))throw Error('Configuration');
  const client=createClient(url,serverApiKey(name=>Deno.env.get(name)),{
    auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},
    global:{fetch(input,init){if(new URL(input instanceof Request?input.url:String(input)).origin!==url)return Promise.reject(Error('Origin'));return fetch(input,{...init,redirect:'error',signal:AbortSignal.timeout(15000)});}}
  });
  return createProjectCleanupHandler(Deno.env.get('PROJECT_CLEANUP_TOKEN')??'',{
    async rpc(name,args){const{data,error}=await client.rpc(name,args);return{data,error};},
    async remove(paths){const{error}=await client.storage.from('project-data').remove([...paths]);if(error)throw Error('Storage');}
  });
}
if(import.meta.main){
  let handler:(request:Request)=>Promise<Response>;
  try{handler=start();}catch{handler=async()=>Response.json({error:{code:'configuration'}},{status:503,headers:{'Cache-Control':'no-store'}});}
  Deno.serve(handler);
}
