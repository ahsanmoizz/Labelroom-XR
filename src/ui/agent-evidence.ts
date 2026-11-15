import type {AiAssessment, AiEvidence} from '../ai/protocol';
import type {AnalysisIssue, FitResult} from '../workers/protocol';

export interface EvidenceDescription {title:string;summary:string;rows:string[];note?:string}
const count=(n:number)=>n.toLocaleString('en-US');
const decimal=(n:number)=>n.toLocaleString('en-US',{maximumFractionDigits:3});
const object=(id:string)=>id.length>16?id.slice(0,8)+'…':id;

function describeIssue(issue:AnalysisIssue):string {
 const ids=issue.objectIds.map(object).join(' / '),e=issue.evidence;
 if(issue.type==='LOW_SUPPORT')return `Object ${ids}: ${count(e.support!)} supporting points out of ${count(e.pointCount!)} frame points. Flagged because support is below 5 points.`;
 if(issue.type==='DUPLICATE')return `Objects ${ids}: overlap IoU ${decimal(e.iou!)}. Possible duplicate; inspect both boxes before deciding.`;
 return `Object ${ids}: size changed relative to frame ${e.previousFrameId} over ${decimal(e.dtSeconds!)} seconds; size ratios ${e.sizeRatios!.map(decimal).join(' × ')}.`;
}

/** Wording is derived from validated tool measurements, never invented model prose. */
export function describeAiEvidence(value:AiEvidence):EvidenceDescription {
 const frame=value.call.args.frameId;
 switch(value.call.name){
  case 'listIssues':{
   const result=value.result as {total:number;cursor:number;next:number|null;issues:AnalysisIssue[]};
   const showing=result.issues.length===0?'No candidates were returned by these checks.':result.cursor===0&&result.next===null?`Showing all ${count(result.issues.length)}.`:`Showing ${count(result.cursor+1)}–${count(result.cursor+result.issues.length)}.`;
   return {title:`Potential issues · frame ${frame}`,summary:`Found ${count(result.total)} potential issue${result.total===1?'':'s'} in frame ${frame}. ${showing}`,rows:result.issues.map(describeIssue),note:'These flags need manual inspection; they are not confirmed label errors. Severity is a ranking score, not an error probability.'};
  }
  case 'inspectBoxSupport':{
   const result=value.result as {objectId:string;support:number;pointCount:number};
   return {title:`Point support · frame ${frame}`,summary:`Object ${object(result.objectId)} has ${count(result.support)} supporting points out of ${count(result.pointCount)} frame points.`,rows:[],note:'Point support is a measurement, not a verdict that the label is correct or incorrect.'};
  }
  case 'compareTrack':{
   const result=value.result as {objectId:string;frames:{frameId:string;timestamp:number;present:boolean;size:number[]|null}[]};
   return {title:`Adjacent frames · object ${object(result.objectId)}`,summary:`Compared the object across ${count(result.frames.length)} frame${result.frames.length===1?'':'s'}.`,rows:result.frames.map(f=>f.present?`Frame ${f.frameId}: size ${f.size!.map(decimal).join(' × ')} metres.`:`Frame ${f.frameId}: this object is not present.`),note:'Check changes against the scan; an absent label is not proof that the object is physically absent.'};
  }
  case 'proposeFit':{
   const result=value.result as FitResult;
   const reason={OK:'A measured fit is available for your review.',SPARSE:'Too few usable points for a safe fit.',OCCLUDED:'The measured points do not support a safe fit.',BOUNDS:'The candidate exceeds the allowed movement, size or yaw bounds.',UNCHANGED:'No supported change was found.'}[result.reason];
   return {title:`Measured fit · frame ${frame}`,summary:`Object ${object(result.objectId)}: ${reason}`,rows:[`Current support: ${count(result.originalSupport)} points.`,...(result.safe?[`Candidate support: ${count(result.candidateSupport)} points.`,`Centre movement: ${decimal(result.centerMovementM)} metres; yaw change: ${decimal(result.yawDeltaDegrees)} degrees.`]:[])],note:result.safe?'Use Preview measured fit to inspect it. A separate approval is required to save.':'No fit has been applied. Continue manual review.'};
  }
  case 'focusObject':
   return {title:`Object focus · frame ${frame}`,summary:`Focused object ${object(value.call.args.objectId)} for inspection.`,rows:[],note:'This changes the view, not the saved label.'};
 }
}

export function describeAiAssessment(answer:AiAssessment,values:readonly AiEvidence[]):string {
 const introduction={
  'review-measurements':'Inspection complete. Review the measured evidence.',
  'cannot-suggest-safely':'Inspection complete. The AI cannot suggest a safe change.',
  'no-change-recommended':'Inspection complete. The AI recommends no change; review the measurements before deciding.',
  'needs-user-review':'Inspection complete. The model requests your review.'
 }[answer.assessment];
 const cited=new Set(answer.evidenceIds),summaries=values.filter(v=>cited.has(v.call.id)).map(v=>describeAiEvidence(v).summary);
 return [introduction,...summaries,'No edit was applied. Any change requires your preview and separate approval to save.'].join(' ');
}

/** Keep full provenance available without making raw JSON the default answer. */
export function renderAiEvidence(doc:Document,value:AiEvidence,scope:{revision:number;sourceBundleSha256:string}):HTMLLIElement {
 const description=describeAiEvidence(value),item=doc.createElement('li'),title=doc.createElement('h4'),summary=doc.createElement('p');
 item.className='ai-evidence-card';item.setAttribute('data-ai-evidence-id',value.call.id);title.textContent=description.title;summary.textContent=description.summary;item.append(title,summary);
 if(description.rows.length){const rows=doc.createElement('ul');rows.className='ai-measurements';for(const text of description.rows){const row=doc.createElement('li');row.textContent=text;rows.append(row);}item.append(rows);}
 if(description.note){const note=doc.createElement('p');note.className='ai-evidence-note';note.textContent=description.note;item.append(note);}
 const details=doc.createElement('details'),toggle=doc.createElement('summary'),provenance=doc.createElement('p'),raw=doc.createElement('pre');
 details.className='ai-technical-evidence';toggle.textContent='Technical evidence';provenance.textContent=`Tool: ${value.call.name} · frame ${value.call.args.frameId} · saved revision ${scope.revision} · source ${scope.sourceBundleSha256} · evidence ${value.call.id}`;raw.textContent=JSON.stringify(value,null,2);details.append(toggle,provenance,raw);item.append(details);return item;
}
