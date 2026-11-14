// Actual SDK auth/host/review controllers; explicitly synthetic provider, source and scene adapter.
import {createClient,createSupabaseAuthPort,createApplicationHost,createDatasetWorkspace,mountReviewWorkspace,loadBundleBytes,validateReviewSnapshot} from './focus-bridge.mjs';
const guest='22222222-2222-4222-8222-222222222222',other='33333333-3333-4333-8333-333333333333',project=crypto.randomUUID();
let owner=guest,deny=false,sequence=0,reviewNode,reviewResource;
const counts={workspaceOpens:0,workspaceDisposals:0,demoOpens:0,commits:0,userRequests:0,refreshRequests:0,visibilityDispatches:0,sdkEvents:[]};
const user=()=>({id:owner,role:'authenticated',is_anonymous:true,aud:'authenticated',email:'',app_metadata:{provider:'anonymous',providers:['anonymous']},user_metadata:{},created_at:'2026-01-01T00:00:00Z'});
const encode=value=>btoa(JSON.stringify(value)).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
function session(){const expires=Math.floor(Date.now()/1000)+3600;return{access_token:encode({alg:'HS256',typ:'JWT'})+'.'+encode({sub:owner,role:'authenticated',is_anonymous:true,exp:expires,iat:expires-3600,sequence:sequence++})+'.c3ludGhldGlj',refresh_token:'synthetic-refresh-token-'+sequence,expires_at:expires,expires_in:3600,token_type:'bearer',user:user()}}
localStorage.setItem('labelxr-focus-sdk-session',JSON.stringify(session()));
const client=createClient('https://focus-fixture.supabase.co','sb_publishable_synthetic_focus_fixture',{
 auth:{storageKey:'labelxr-focus-sdk-session',persistSession:true,autoRefreshToken:true,detectSessionInUrl:false},
 global:{fetch:async(input,init)=>{const url=new URL(typeof input==='string'?input:input.url??String(input));if(url.origin!=='https://focus-fixture.supabase.co')throw Error('Unexpected fixture origin');
  if(url.pathname==='/auth/v1/user'){counts.userRequests++;return deny?Response.json({code:'bad_jwt',message:'Synthetic expired session'},{status:401}):Response.json(user())}
  if(url.pathname==='/auth/v1/token'&&init?.method==='POST'){counts.refreshRequests++;return Response.json(session())}
  if(url.pathname==='/auth/v1/logout'&&init?.method==='POST')return new Response(null,{status:204});
  throw Error('Unexpected fixture auth request');
 }}
});
const subscription=client.auth.onAuthStateChange(event=>{counts.sdkEvents.push(event)}).data.subscription;
const original=await loadBundleBytes(new Uint8Array(await(await fetch('/source.zip')).arrayBuffer()));
const port=createSupabaseAuthPort(client);
const open=createDatasetWorkspace(async()=>async container=>{
 counts.workspaceOpens++;const canvas=document.createElement('div');canvas.textContent='Synthetic scene adapter — no GPU/XR claim';container.append(canvas);
 return{exitXR(){},destroy(){counts.workspaceDisposals++},createTransformEntity(){throw Error('No synthetic scene entities')},renderer:{domElement:canvas,dispose(){}}};
},{createView:()=>({showFrame(){},setScale(){},resetView(){},dispose(){}}),guestDemo:async context=>{counts.demoOpens++;return{original,project:{id:project,owner_id:context.user.id,status:'ready',source_hash:original.bundleSha256,source_bytes:original.getOriginalZipBytes().length,current_revision:0},labels:{document:original.labelsDocument}}},
 review(root,signal,context,_result,presentation){
  const scope={ownerId:context.user.id,projectId:project,sourceBundleSha256:original.bundleSha256};
  const head={id:project,owner_id:context.user.id,status:'ready',source_hash:original.bundleSha256,source_bytes:original.getOriginalZipBytes().length,current_revision:0};
  const snapshot=validateReviewSnapshot(scope,original,head,{project_id:project,revision:0,label_doc:original.labelsDocument,review_verdicts:{}},[]);
  reviewResource=mountReviewWorkspace(root,{scope,original,signal,load:async()=>snapshot,commit:async()=>{counts.commits++;throw Error('Synthetic focus test must not commit')},...presentation});
  reviewNode=root.querySelector('.review-panel');return reviewResource;
 }});
const host=createApplicationHost({statusRoot:document.getElementById('setup-status'),accountRoot:document.getElementById('account-container'),privateRoot:document.getElementById('scene-container'),connect:async()=>port,
 challenge(){return{getState:()=>({status:'idle'}),subscribe:()=>()=>{},async start(){},async reset(){},takeToken(){return null},pause(){},dispose(){}}},openWorkspace:open,reload(){location.reload()}});
void host.start({VITE_SUPABASE_URL:'https://focus-fixture.supabase.co',VITE_SUPABASE_PUBLISHABLE_KEY:'sb_publishable_synthetic_focus_fixture',VITE_TURNSTILE_SITE_KEY:'synthetic_focus_site_key',VITE_APP_ORIGIN:location.origin},'development',location.origin);
window.labelxrFocus={
 state(){return{...structuredClone(counts),reviewSameNode:!!reviewNode&&reviewNode===document.querySelector('.review-panel'),reviewConnected:!!reviewNode?.isConnected,phase:reviewResource?.store.state().phase??null,accountState:document.getElementById('account-container').getAttribute('data-account-state')}},
 visibility(){counts.visibilityDispatches++;window.dispatchEvent(new Event('visibilitychange'))},
 async refresh(){await client.auth.refreshSession()},
 async switchOwner(){owner=other;const next=session();await client.auth.setSession({access_token:next.access_token,refresh_token:next.refresh_token})},
 failVerification(){deny=true},
 downloadReceipt(){const url=URL.createObjectURL(new Blob([JSON.stringify({schema:'synthetic-read-only-receipt/v1',testSaves:0})],{type:'application/json'})),anchor=document.createElement('a');anchor.href=url;anchor.download='synthetic-focus-receipt.json';anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000)},
 async dispose(){host.dispose();subscription.unsubscribe();await client.auth.stopAutoRefresh()}
};
window.addEventListener('pagehide',()=>host.dispose(),{once:true});
