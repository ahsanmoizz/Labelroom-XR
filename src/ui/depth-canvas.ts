import type {DepthProjection} from '../xr/inspection';
/** Rasterize once per display-state change. The same source-axis drawing serves desktop and XR. */
export function paintDepthProjection(ctx:CanvasRenderingContext2D,p:DepthProjection,x:number,y:number,width:number,height:number){
 const w=Math.floor(width),h=Math.floor(height);if(w<160||h<120)throw Error('Depth projection area is too small.');
 const left=42,top=30,bottom=40,right=12,[minX,minY,maxX,maxY]=p.bounds;
 const spanX=Math.max(maxX-minX,.001),spanY=Math.max(maxY-minY,.001),scale=Math.min((w-left-right)/spanX,(h-top-bottom)/spanY),offsetX=left+(w-left-right-spanX*scale)/2,offsetY=top+(h-top-bottom-spanY*scale)/2;
 const image=ctx.createImageData(w,h);for(let i=0;i<image.data.length;i+=4){image.data[i]=8;image.data[i+1]=20;image.data[i+2]=29;image.data[i+3]=255;}
 const at=(a:number,b:number)=>[Math.round(offsetX+(a-minX)*scale),Math.round(offsetY+(maxY-b)*scale)] as const;
 const depthSpan=p.depthRange[1]-p.depthRange[0];
 for(let i=0;i<p.depth.length;i++){const [px,py]=at(p.points[i*2],p.points[i*2+1]);if(px<0||py<0||px>=w||py>=h)continue;const d=depthSpan?(p.depth[i]-p.depthRange[0])/depthSpan:.5,k=(py*w+px)*4;image.data[k]=Math.round(80+150*d);image.data[k+1]=Math.round(220-80*d);image.data[k+2]=230;}
 ctx.putImageData(image,x,y);ctx.save();
 function lines(edges:Float32Array,color:string,lineWidth:number){ctx.strokeStyle=color;ctx.lineWidth=lineWidth;ctx.beginPath();for(let i=0;i<edges.length;i+=4){const a=at(edges[i],edges[i+1]),b=at(edges[i+2],edges[i+3]);ctx.moveTo(x+a[0],y+a[1]);ctx.lineTo(x+b[0],y+b[1]);}ctx.stroke();}
 lines(p.edges,'#6bb8aa',1);lines(p.selectedEdges,'#ffcf82',2);
 ctx.fillStyle='#e8f4f8';ctx.textAlign='left';ctx.font=`${Math.max(12,Math.min(20,h/14))}px system-ui`;
 ctx.fillText(`${p.view.toUpperCase()} · ${p.axes[0]}/${p.axes[1]} metres`,x+12,y+21);
 ctx.fillText(`${p.axes[2]} depth ${p.depthRange[0].toFixed(2)} to ${p.depthRange[1].toFixed(2)} m · colour shows depth`,x+12,y+h-12);
 ctx.restore();
}
