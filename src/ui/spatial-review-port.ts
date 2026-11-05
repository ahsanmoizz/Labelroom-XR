// LABELXR-SPATIAL-REVIEW-PORT-v1
import type { ReviewStore } from './review-controls';
export const spatialFields = ['x','y','z','sizeX','sizeY','sizeZ','yawDegrees'] as const;
export type SpatialField = typeof spatialFields[number];
const fieldLabels = ['X (metres)','Y (metres)','Z (metres)','Length (metres)','Width (metres)','Height (metres)','Yaw (degrees)'];
export const spatialActions = {
  preview:'Preview edit',approve:'Approve and save',reject:'Reject preview',undo:'Preview last-edit undo',
  keep:'Preview keep with reason',duplicate:'Remove duplicate…',compare:'Compare original',
  retry:'Retry same request',reload:'Reload saved state',restore:'Restore typed edit',discard:'Discard typed edit…'
} as const;
export type SpatialAction = keyof typeof spatialActions;
export type SpatialChoice = 'frame'|'object'|'reason'|'issue'|'partner';
const choiceLabels = {frame:'Review frame',object:'Review object',reason:'Review reason',issue:'Reviewed issue type',partner:'Duplicate partner'} as const;
/** Both surfaces invoke the existing guarded controls and their recovery listeners. No service calls. */
export function createSpatialReviewPort(panel: HTMLElement, store: ReviewStore, signal: AbortSignal) {
  const input = (name: SpatialField) => panel.querySelector<HTMLInputElement>('input[aria-label="'+fieldLabels[spatialFields.indexOf(name)]+'"]');
  const choice = (name: SpatialChoice) => panel.querySelector<HTMLSelectElement>('select[aria-label="'+choiceLabels[name]+'"]');
  function action(name: SpatialAction) {
    const labels: string[] = [spatialActions[name]];
    if (name==='duplicate') labels.push('Confirm duplicate removal');
    if (name==='compare') labels.push('Show proposed change');
    if (name==='discard') labels.push('Confirm typed edit discard');
    return [...panel.querySelectorAll<HTMLButtonElement>('button')].find(b=>labels.includes(b.textContent??''));
  }
  const live = () => !signal.aborted && store.state().phase !== 'closed';
  function event(el: HTMLElement, type: string) { const EventClass=panel.ownerDocument.defaultView?.Event; if (!EventClass) throw Error('Document event support is unavailable.'); el.dispatchEvent(new EventClass(type,{bubbles:true})); }
  function choose(name: SpatialChoice, value: string) {
    const el=choice(name); if (!live() || !el || el.disabled || ![...el.options].some(o=>o.value===value)) return false;
    el.value=value; event(el,'change'); return true;
  }
  return {
    read() {
      const state=store.state();
      return {phase:state.phase,revision:state.revision,requestId:state.requestId,message:state.message,
        fields:Object.fromEntries(spatialFields.map(n=>[n,{value:input(n)?.value??'',disabled:!live()||!input(n)||input(n)!.disabled}])) as Record<SpatialField,{value:string;disabled:boolean}>,
        choices:Object.fromEntries((Object.keys(choiceLabels) as SpatialChoice[]).map(n=>{const el=choice(n);return[n,{value:el?.value??'',disabled:!live()||!el||el.disabled}]})) as Record<SpatialChoice,{value:string;disabled:boolean}>,
        actions:Object.fromEntries((Object.keys(spatialActions) as SpatialAction[]).map(n=>{const el=action(n);return[n,{label:el?.textContent??spatialActions[n],disabled:!live()||!el||el.disabled||el.hidden}]})) as Record<SpatialAction,{label:string;disabled:boolean}>};
    },
    cycle(name: SpatialChoice, delta: -1|1) {
      const el=choice(name);if(!el||!el.options.length)return false;
      return choose(name,el.options[(el.selectedIndex+delta+el.options.length)%el.options.length].value);
    },
    select(frameId:string, objectId:string) {
      const f=choice('frame'),o=choice('object'); if (!live()||!f||!o||f.disabled||o.disabled) return false;
      if(f.value!==frameId&&!choose('frame',frameId))return false;
      return choose('object',objectId);
    },
    nudge(name: SpatialField, delta: -1|1) {
      const el=input(name); if(!live()||!el||el.disabled||!el.value.trim())return false;
      const old=Number(el.value),step=name==='yawDegrees'?1:0.01,value=Number((old+delta*step).toFixed(6));
      if(!Number.isFinite(old)||!Number.isFinite(value)||name==='yawDegrees'&&Math.abs(value)>180||name.startsWith('size')&&value<=0)return false;
      el.value=String(value);event(el,'input');return true;
    },
    activate(name: SpatialAction) {const el=action(name);if(!live()||!el||el.disabled||el.hidden)return false;el.click();return true;}
  };
}
export type SpatialReviewPort = ReturnType<typeof createSpatialReviewPort>;
