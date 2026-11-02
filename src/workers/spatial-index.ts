// LABELXR-REVIEW-SPATIAL-INDEX-v1
import type {Box} from '../domain/geometry';
import {LIMITS} from '../domain/limits';
import {AnalysisError,box as checkedBox,finite} from './protocol';
const CELL=2,MIN=-125,MAX=125,key=(x:number,y:number)=>(x+128)*257+y+128;
/** This frame and its point array belong only to one worker epoch. */
export function createSpatialIndex(points:Float32Array){
 if(!(points instanceof Float32Array)||!(points.buffer instanceof ArrayBuffer)||points.length%3||points.length/3>LIMITS.maxPointsPerFrame)throw new AnalysisError('INPUT');
 const cells=new Map<number,number[]>();for(let i=0;i<points.length;i+=3){const x=finite(points[i],-250,250),y=finite(points[i+1],-250,250);finite(points[i+2],-250,250);const cell=key(Math.floor(x/CELL),Math.floor(y/CELL)),list=cells.get(cell);if(list)list.push(i/3);else cells.set(cell,[i/3])}
 function visit(input:Box,margin:number,fn:(id:number)=>void){const b=checkedBox(input);finite(margin,0,0.5);const c=Math.cos(b.yaw),s=Math.sin(b.yaw),hx=b.size[0]/2+margin+1e-6,hy=b.size[1]/2+margin+1e-6,hz=b.size[2]/2+margin+1e-6,ax=Math.abs(c)*hx+Math.abs(s)*hy,ay=Math.abs(s)*hx+Math.abs(c)*hy,minX=Math.max(MIN,Math.floor((b.center[0]-ax)/CELL)),maxX=Math.min(MAX,Math.floor((b.center[0]+ax)/CELL)),minY=Math.max(MIN,Math.floor((b.center[1]-ay)/CELL)),maxY=Math.min(MAX,Math.floor((b.center[1]+ay)/CELL));for(let x=minX;x<=maxX;x++)for(let y=minY;y<=maxY;y++)for(const id of cells.get(key(x,y))??[]){const at=id*3,dx=points[at]-b.center[0],dy=points[at+1]-b.center[1];if(Math.abs(c*dx+s*dy)<=hx&&Math.abs(-s*dx+c*dy)<=hy&&Math.abs(points[at+2]-b.center[2])<=hz)fn(id)}}
 return{pointCount:points.length/3,cellCount:cells.size,point(id:number):readonly[number,number,number]{if(!Number.isSafeInteger(id)||id<0||id>=points.length/3)throw new AnalysisError('INPUT');return[points[id*3],points[id*3+1],points[id*3+2]]},countBox(b:Box){let count=0;visit(b,0,()=>count++);return count},queryBox(b:Box,margin=0){const ids:number[]=[];visit(b,margin,id=>ids.push(id));return ids.sort((a,b)=>a-b)}};
}
export type SpatialIndex=ReturnType<typeof createSpatialIndex>;
