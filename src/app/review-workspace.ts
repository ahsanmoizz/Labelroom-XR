// LABELXR-REVIEW-WORKSPACE-v1
import type {AgentService} from '../services/agent';
import {createReviewStore,type ReviewStoreOptions,type ReviewPhase} from './store';
import {createReviewService,createSupabaseReviewSessions} from '../services/reviews';
import {createReviewSnapshotService,createSupabaseReviewSnapshotSessions} from '../services/review-snapshots';
import {createIndexedDbDraftCache,type ReviewDraftCache} from '../data/draft-cache';
import {createIndexedDbFormCache,type ReviewFormCache} from '../data/form-draft-cache';
import type {ProjectsAuthClient} from '../services/projects';
import type {PublicAppConfig} from './config';
import type {BundleSource} from '../data/bundle';
import {createReviewAnalysisClient,type ReviewAnalysisClient} from '../services/analysis';
import {mountReviewControls,type ReviewControlsOptions} from '../ui/review-controls';
import type {BundleFrame} from '../data/bundle';
import type {ReviewCommand} from '../domain/revision';
import type {ReviewSnapshot} from '../domain/review-snapshot';
export function reviewFrameSource(snapshot:ReviewSnapshot){const frames:BundleFrame[]=snapshot.original.frames.map((frame,index)=>{const labels=snapshot.frames[index];if(frame.id!==labels?.id||frame.timestamp!==labels.timestamp)throw Error('Saved frame identity differs.');return Object.freeze({...frame,boxes:labels.boxes})});return Object.freeze({frames:Object.freeze(frames),getFramePoints:(id:string)=>snapshot.original.getFramePoints(id)})}
export function reviewProposalFrameSource(snapshot:ReviewSnapshot,command:ReviewCommand){
 if(command.projectId!==snapshot.projectId||command.baseRevision!==snapshot.revision)throw Error('Proposal source/revision differs.');
 const saved=reviewFrameSource(snapshot);return Object.freeze({...saved,frames:Object.freeze(saved.frames.map(frame=>frame.id!==command.frameId?frame:Object.freeze({...frame,boxes:Object.freeze(frame.boxes.flatMap(box=>{if(box.id!==command.objectId)return[box];if(command.operation==='removeDuplicate')return[];if(command.operation!=='updateCuboid')return[box];const v=command.after;return[Object.freeze({...box,box:Object.freeze({center:Object.freeze(v.slice(0,3)),size:Object.freeze(v.slice(7,10)),yaw:2*Math.atan2(v[5],v[6])})})]}))})))});
}
/** Account ownership, service, recovery and desktop controls share one disposable controller. */
export function mountReviewWorkspace(root:HTMLElement,options:ReviewStoreOptions&Pick<ReviewControlsOptions,'focus'|'download'>&{present?(snapshot:ReviewSnapshot):void;preview?(snapshot:ReviewSnapshot,command:ReviewCommand|null):void;phase?(phase:ReviewPhase):void;agent?:AgentService;analysis?:ReviewAnalysisClient;formCache?:ReviewFormCache}){
 const store=createReviewStore(options),panel=mountReviewControls(root,{formCache:options.formCache??(globalThis.indexedDB?createIndexedDbFormCache():undefined),store,signal:options.signal,newId:options.newId,focus:options.focus,download:options.download,analysis:options.analysis,agent:options.agent,compareOriginal(show){const s=store.snapshot(),state=store.state();if(s&&state.phase==='proposed'&&state.command)options.preview?.(s,show?null:state.command as ReviewCommand)}});let seen:ReviewSnapshot|undefined,previewKey='',closed=false;
 const unsubscribe=store.subscribe(()=>{const state=store.state(),s=store.snapshot();if(closed)return;try{options.phase?.(state.phase);if(!s)return;if(state.phase==='proposed'&&state.command){const key=state.requestId??'';if(key!==previewKey){options.preview?.(s,state.command as ReviewCommand);previewKey=key}}else if(state.phase==='ready'){if(previewKey){options.preview?.(s,null);previewKey=''}if(s!==seen){options.present?.(s);seen=s}}}catch{store.close();panel.block('Saved review could not be displayed. Reload this workspace before continuing.')}});
 function dispose(){if(closed)return;closed=true;options.signal.removeEventListener('abort',dispose);unsubscribe();store.close();panel.dispose();seen=undefined}
 options.signal.addEventListener('abort',dispose,{once:true});if(options.signal.aborted)dispose();else void store.reload();return{store,dispose,selectFrame:panel.selectFrame,spatial:panel.spatial};
}

export interface MemberReviewWorkspaceOptions {
 client:ProjectsAuthClient;config:Readonly<PublicAppConfig>;ownerId:string;projectId:string;original:BundleSource;signal:AbortSignal;cache?:ReviewDraftCache;
 analysis?:ReviewAnalysisClient;phase?(phase:ReviewPhase):void;present?(snapshot:ReviewSnapshot):void;preview?(snapshot:ReviewSnapshot,command:ReviewCommand|null):void;focus?(frameId:string,objectId:string):void;
 download?(bytes:Uint8Array,name:string,type:string):void;
}
/** The verified account host supplies the owner and abort signal; both services reverify the caller. */
export function mountMemberReviewWorkspace(root:HTMLElement,options:MemberReviewWorkspaceOptions){
 return mountSavedReviewWorkspace(root,options,'private');
}
export function mountGuestReviewWorkspace(root:HTMLElement,options:MemberReviewWorkspaceOptions){
 return mountSavedReviewWorkspace(root,options,'demo');
}
function mountSavedReviewWorkspace(root:HTMLElement,options:MemberReviewWorkspaceOptions,kind:'private'|'demo'){
 const{client,config,original}=options,scope={ownerId:options.ownerId,projectId:options.projectId,sourceBundleSha256:original.bundleSha256},reviews=createReviewService(createSupabaseReviewSessions(client,config)),snapshots=createReviewSnapshotService(createSupabaseReviewSnapshotSessions(client,config,globalThis.fetch,kind));
 return mountReviewWorkspace(root,{scope,original,signal:options.signal,cache:options.cache??createIndexedDbDraftCache(),load:signal=>snapshots.load(scope,original,signal),audit:(snapshot,signal)=>snapshots.audit(snapshot,signal),commit:(bytes,context,signal)=>reviews.commit(bytes,context,signal),phase:options.phase,present:options.present,preview:options.preview,focus:options.focus,download:options.download,agent:{async request(input,signal){const {createAgentService}=await import('../services/agent');return createAgentService(client,config,options.ownerId).request(input,signal)}},analysis:options.analysis??createReviewAnalysisClient()});
}
