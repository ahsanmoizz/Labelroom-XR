// LABELXR-REVIEW-ENTRY-v1
import {createClient} from 'npm:@supabase/supabase-js@2.117.3';
import {createReviewSdkHandler} from '../_shared/review-client.ts';
if(import.meta.main){
 let handler:(request:Request)=>Promise<Response>;
 try{handler=createReviewSdkHandler({url:Deno.env.get('SUPABASE_URL')??'',publishableKey:Deno.env.get('SUPABASE_PUBLISHABLE_KEY')??'',origin:Deno.env.get('ALLOWED_ORIGIN')??''},createClient)}
 catch{handler=async()=>Response.json({error:{code:'configuration',message:'Server configuration is unavailable.'}},{status:503,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}})}
 Deno.serve(handler);
}
