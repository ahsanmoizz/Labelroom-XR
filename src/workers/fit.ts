// LABELXR-REVIEW-SAFE-FIT-v1
import {containsPoint,type Box} from '../domain/geometry';
import {LIMITS} from '../domain/limits';
import {angleDelta,fitWithinBounds,type AnalysisBox,type FitResult} from './protocol';
import type {SpatialIndex} from './spatial-index';
const quantile=(sorted:Float64Array,p:number)=>{const at=(sorted.length-1)*p,low=Math.floor(at);return sorted[low]+(sorted[Math.min(sorted.length-1,low+1)]-sorted[low])*(at-low)};
const clone=(b:Box):Box=>({center:[...b.center] as [number,number,number],size:[...b.size] as [number,number,number],yaw:b.yaw});
/** A bounded proposal, never a committed edit. Missing surfaces do not justify forced shrinkage. */
export function proposeSafeFit(selected:AnalysisBox,others:readonly AnalysisBox[],index:SpatialIndex):FitResult{
 const original=selected.box,originalSupport=index.countBox(original),eligible=index.queryBox(original,0.5).filter(id=>!others.some(other=>other.id!==selected.id&&containsPoint(other.box,index.point(id)))),base={objectId:selected.id,original:clone(original),originalSupport,candidateSupport:0,eligiblePoints:eligible.length,robustPoints:0,centerMovementM:0,yawDeltaDegrees:0,sizeRatios:[1,1,1]};
 if(eligible.length<LIMITS.minFitPoints)return{...base,safe:false,reason:'SPARSE'};
 const points=eligible.map(id=>index.point(id)),z=Float64Array.from(points,p=>p[2]).sort(),loZ=quantile(z,.02),hiZ=quantile(z,.98);let best:FitResult|undefined,bestArea=Infinity,coverageFound=false;
 for(let step=-15;step<=15;step++){const yaw=original.yaw+step*Math.PI/180,c=Math.cos(yaw),s=Math.sin(yaw),xs=Float64Array.from(points,p=>c*(p[0]-original.center[0])+s*(p[1]-original.center[1])).sort(),ys=Float64Array.from(points,p=>-s*(p[0]-original.center[0])+c*(p[1]-original.center[1])).sort(),loX=quantile(xs,.02),hiX=quantile(xs,.98),loY=quantile(ys,.02),hiY=quantile(ys,.98),ranges=[hiX-loX,hiY-loY,hiZ-loZ];
  // A plane, one visible side or a severely incomplete extent cannot safely define a smaller box.
  if(ranges.some((n,i)=>n<original.size[i]*.8)||loX>0||hiX<0||loY>0||hiY<0||loZ>original.center[2]||hiZ<original.center[2])continue;coverageFound=true;
  const midX=(loX+hiX)/2,midY=(loY+hiY)/2,centre=[original.center[0]+c*midX-s*midY,original.center[1]+s*midX+c*midY,(loZ+hiZ)/2],delta=centre.map((n,i)=>n-original.center[i]),distance=Math.hypot(...delta),bounded=distance>.5?original.center.map((n,i)=>n+delta[i]*(.5/distance)):centre,candidate={center:bounded,size:ranges.map((n,i)=>Math.max(LIMITS.minBoxSize,Math.min(LIMITS.maxBoxSize,original.size[i]*1.2,Math.max(original.size[i]*.8,n)))),yaw} as unknown as Box;
  if(!fitWithinBounds(original,candidate))continue;
  let robust=0,contained=0;for(const p of points){const dx=p[0]-original.center[0],dy=p[1]-original.center[1],x=c*dx+s*dy,y=-s*dx+c*dy;if(x>=loX&&x<=hiX&&y>=loY&&y<=hiY&&p[2]>=loZ&&p[2]<=hiZ){robust++;if(containsPoint(candidate,p))contained++}}
  if(robust<Math.ceil(points.length*.8)||contained!==robust)continue;
  const movement=Math.hypot(...candidate.center.map((n,i)=>n-original.center[i])),yawDelta=angleDelta(candidate.yaw,original.yaw),ratios=candidate.size.map((n,i)=>n/original.size[i]);
  const area=candidate.size[0]*candidate.size[1];if(area<bestArea||area===bestArea&&Math.abs(yawDelta)<Math.abs((best?.yawDeltaDegrees??Infinity)*Math.PI/180)){bestArea=area;best={...base,safe:true,reason:'OK',candidate:clone(candidate),candidateSupport:index.countBox(candidate),robustPoints:robust,centerMovementM:movement,yawDeltaDegrees:yawDelta*180/Math.PI,sizeRatios:ratios}}
 }
 if(best&&best.candidate){const unchanged=best.centerMovementM<1e-9&&Math.abs(best.yawDeltaDegrees)<1e-9&&best.candidate.size.every((n,i)=>Math.abs(n-original.size[i])<1e-9),oldVolume=original.size.reduce((a,b)=>a*b,1),newVolume=best.candidate.size.reduce((a,b)=>a*b,1);if(unchanged||newVolume>=oldVolume&&best.candidateSupport<=originalSupport)return{...base,safe:false,reason:'UNCHANGED'}}
 return best??{...base,safe:false,reason:coverageFound?'BOUNDS':'OCCLUDED'};
}
