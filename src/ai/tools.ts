// LABELXR-INSPECTION-TOOLS-v1
import{toolCallSchema,validateToolResult,type AiToolCall,type AiEvidence}from'./protocol';
import type{ReviewAnalysisClient}from'../services/analysis';import type{ReviewSnapshot}from'../domain/review-snapshot';
/** Only measured inspection and focus capabilities are supplied. No store save/delete capability exists here. */
export function createInspectionTools(options:{snapshot:ReviewSnapshot;current():boolean;analysis:ReviewAnalysisClient;focus(frameId:string,objectId:string):boolean;signal:AbortSignal}){
 let used=0,busy=false;const seen=new Set<string>();
 function current(){if(options.signal.aborted||!options.current())throw Error('AI context changed');}
 return{async execute(input:AiToolCall):Promise<AiEvidence>{current();if(busy||used>=8)throw Error('Tool limit');const call=toolCallSchema.parse(input),frame=options.snapshot.frames.find(f=>f.id===call.args.frameId);if(!frame||call.name!=='listIssues'&&!frame.boxes.some(b=>b.id===call.args.objectId)||seen.has(call.id))throw Error('Unknown orrepeated tool target');seen.add(call.id);used++;busy=true;try{let result:unknown;
  if(call.name==='focusObject'){if(!options.focus(call.args.frameId,call.args.objectId))throw Error('Focus unavailable');result={focused:true,frameId:call.args.frameId,objectId:call.args.objectId};}
  else{await options.analysis.setFrame(options.snapshot,call.args.frameId);current();if(call.name==='listIssues')result=await options.analysis.listIssues(call.args.cursor,call.args.limit);else if(call.name==='inspectBoxSupport')result=await options.analysis.inspectBoxSupport(call.args.objectId);else if(call.name==='compareTrack')result=await options.analysis.compareTrack(call.args.objectId);else result=(await options.analysis.proposeFit(call.args.objectId)).fit;}
  current();return{call,result:validateToolResult(call,result)};
 }finally{busy=false}},get used(){return used;}};
}
