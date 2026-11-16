import {fromDisplay,type XYZ} from '../domain/coordinates';
import type {BundleFrame} from '../data/bundle';
import type {FrameView,ViewBounds} from './frame-view';
export const depthViews=['scene','top','front','side'] as const;
export type DepthView=typeof depthViews[number];
export interface DepthProjection {view:Exclude<DepthView,'scene'>;axes:readonly[string,string,string];points:Float32Array;depth:Float32Array;edges:Float32Array;selectedEdges:Float32Array;bounds:readonly[number,number,number,number];depthRange:readonly[number,number]}
export interface InspectionPreferences {isolated:boolean;rotationDegrees:number;depthView:DepthView}
export interface InspectionState {version:number;frameId:string;objectId:string;isolated:boolean;canIsolate:boolean;rotationDegrees:number;depthView:DepthView;shownPoints:number;totalPoints:number;projection?:DepthProjection}
export interface InspectionPort {inspection():InspectionState;setIsolation(enabled:boolean):void;rotateView(deltaDegrees:number):void;setDepthView(view:DepthView):void}
export const ISOLATION_MARGIN_M=.5;
/** A display-only neighbourhood; this does not replace the worker's point-support measurement. */
export function isolateFrameView(frame:FrameView,box:BundleFrame['boxes'][number]['box']):FrameView {
 const out=new Float32Array(frame.positions.length),c=Math.cos(box.yaw),s=Math.sin(box.yaw);let size=0;
 for(let i=0;i<frame.positions.length;i+=3){const p=fromDisplay([frame.positions[i],frame.positions[i+1],frame.positions[i+2]]),x=p[0]-box.center[0],y=p[1]-box.center[1];
  if(Math.abs(c*x+s*y)<=box.size[0]/2+ISOLATION_MARGIN_M&&Math.abs(-s*x+c*y)<=box.size[1]/2+ISOLATION_MARGIN_M&&Math.abs(p[2]-box.center[2])<=box.size[2]/2+ISOLATION_MARGIN_M){out.set(frame.positions.subarray(i,i+3),size);size+=3;}}
 return {...frame,positions:out.subarray(0,size),pointCount:size/3};
}
export function edgeBounds(edges:Float32Array):ViewBounds {
 const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
 for(let i=0;i<edges.length;i++) {min[i%3]=Math.min(min[i%3],edges[i]);max[i%3]=Math.max(max[i%3],edges[i]);}
 if(!min.every(Number.isFinite)||!max.every(Number.isFinite))throw Error('Inspection bounds unavailable.');
 const center=min.map((v,i)=>(v+max[i])/2) as unknown as XYZ;
 return {min:min as unknown as XYZ,max:max as unknown as XYZ,center,radius:Math.hypot(...max.map((v,i)=>v-center[i]))};
}
/** Orthographic source-axis projections. No world camera, source point or box is changed. */
export function projectDepth(frame:FrameView,view:Exclude<DepthView,'scene'>,selectedEdges:Float32Array=new Float32Array()):DepthProjection {
 const map={top:[0,1,2],front:[0,2,1],side:[1,2,0]} as const,index=map[view];if(!index)throw Error('Unknown depth projection.');
 const points=new Float32Array(frame.pointCount*2),depth=new Float32Array(frame.pointCount);let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity,minD=Infinity,maxD=-Infinity;
 function project(data:Float32Array):Float32Array{const result=new Float32Array(data.length/3*2);for(let i=0;i<data.length;i+=3){const p=fromDisplay([data[i],data[i+1],data[i+2]]);result[i/3*2]=p[index[0]];result[i/3*2+1]=p[index[1]];minX=Math.min(minX,p[index[0]]);maxX=Math.max(maxX,p[index[0]]);minY=Math.min(minY,p[index[1]]);maxY=Math.max(maxY,p[index[1]]);minD=Math.min(minD,p[index[2]]);maxD=Math.max(maxD,p[index[2]]);}return result;}
 points.set(project(frame.positions));for(let i=0;i<frame.pointCount;i++)depth[i]=fromDisplay([frame.positions[i*3],frame.positions[i*3+1],frame.positions[i*3+2]])[index[2]];
 const edges=project(frame.boxEdges),selected=project(selectedEdges);if(![minX,minY,maxX,maxY,minD,maxD].every(Number.isFinite))throw Error('Empty depth projection.');
 return {view,axes:[['X','Y','Z'][index[0]],['X','Y','Z'][index[1]],['X','Y','Z'][index[2]]],points,depth,edges,selectedEdges:selected,bounds:[minX,minY,maxX,maxY],depthRange:[minD,maxD]};
}
