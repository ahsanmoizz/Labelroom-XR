// LABELXR-REVIEW-ACTIONS-v1
import {reviewCommandSchema,reviewIssueFingerprint,type ReviewCommand} from './revision';
import type {ReviewSnapshot} from './review-snapshot';
export type ReviewReason='occlusion'|'valid-geometry'|'duplicate'|'other';
export interface ManualBox {x:number;y:number;z:number;sizeX:number;sizeY:number;sizeZ:number;yawDegrees:number}
function occurrence(snapshot:ReviewSnapshot,frameId:string,objectId:string):number[]{
 const root=snapshot.labelsDocument.openlabel as {frames:Record<string,{objects?:Record<string,{object_data:{cuboid:{val:readonly number[]}[]}}>}>};
 const frame=root.frames[frameId],item=frame?.objects&&Object.prototype.hasOwnProperty.call(frame.objects,objectId)?frame.objects[objectId]:undefined;if(!item)throw Error('Selected occurrence is missing.');return[...item.object_data.cuboid[0].val];
}
export function manualReviewCommand(snapshot:ReviewSnapshot,frameId:string,objectId:string,values:ManualBox,reason:ReviewReason,requestId:string):ReviewCommand {
 if(Object.values(values).some(v=>!Number.isFinite(v))||Math.abs(values.yawDegrees)>180)throw Error('Use finite source metres and yaw between -180 and180 degrees.');const angle=values.yawDegrees*Math.PI/180,before=occurrence(snapshot,frameId,objectId),oldYaw=2*Math.atan2(before[5],before[6]),sameYaw=Math.abs(Math.atan2(Math.sin(angle-oldYaw),Math.cos(angle-oldYaw)))<1e-12,rotation=sameYaw?before.slice(3,7):[0,0,Math.sin(angle/2),Math.cos(angle/2)];
 return reviewCommandSchema.parse({projectId:snapshot.projectId,requestId,baseRevision:snapshot.revision,operation:'updateCuboid',frameId,objectId,before,after:[values.x,values.y,values.z,...rotation,values.sizeX,values.sizeY,values.sizeZ],reason});
}
export interface DuplicateConfirmation {projectId:string;sourceBundleSha256:string;revision:number;frameId:string;objectId:string;partnerId:string}
export function duplicateReviewCommand(snapshot:ReviewSnapshot,confirmation:DuplicateConfirmation,requestId:string):ReviewCommand {
 const c=confirmation;if(c.projectId!==snapshot.projectId||c.sourceBundleSha256!==snapshot.sourceBundleSha256||c.revision!==snapshot.revision||c.partnerId===c.objectId)throw Error('Duplicate confirmation is stale.');return reviewCommandSchema.parse({projectId:snapshot.projectId,requestId,baseRevision:snapshot.revision,operation:'removeDuplicate',frameId:c.frameId,objectId:c.objectId,partnerId:c.partnerId,before:occurrence(snapshot,c.frameId,c.objectId),partnerBefore:occurrence(snapshot,c.frameId,c.partnerId),confirmed:true,reason:'duplicate'});
}
export async function keepReviewCommand(snapshot:ReviewSnapshot,frameId:string,objectId:string,issue:{type:'LOW_SUPPORT'|'DUPLICATE'|'DIMENSION_JUMP';objectIds:string[]},reason:ReviewReason,requestId:string):Promise<ReviewCommand>{const context=snapshot.contextFor(),fingerprint=await reviewIssueFingerprint(context,frameId,issue);return reviewCommandSchema.parse({projectId:snapshot.projectId,requestId,baseRevision:snapshot.revision,operation:'keepIssue',frameId,objectId,before:occurrence(snapshot,frameId,objectId),issue,fingerprint,reason})}
export function selectedBox(snapshot:ReviewSnapshot,frameId:string,objectId:string):ManualBox{const v=occurrence(snapshot,frameId,objectId);return{x:v[0],y:v[1],z:v[2],yawDegrees:((2*Math.atan2(v[5],v[6])*180/Math.PI+180)%360+360)%360-180,sizeX:v[7],sizeY:v[8],sizeZ:v[9]}}
