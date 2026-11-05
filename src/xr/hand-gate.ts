// LABELXR-HAND-INTENT-GATE-v1
export type Hand = 'left' | 'right';
export interface HandSample { tracked: boolean; open: boolean }
export interface HandEnvironment { visible: boolean; viewerTracked: boolean; left: HandSample; right: HandSample }
/** Loss never resumes or replays a pinch. Begin/end must address one current target. */
export function createHandIntentGate() {
  let closed = false, paused = true, reason = 'Choose Resume with an open, tracked hand.', epoch = 0;
  let environment: HandEnvironment = {visible:false,viewerTracked:false,left:{tracked:false,open:false},right:{tracked:false,open:false}};
  const primed = {left:false,right:false};
  const armed = new Map<Hand,{target:string;context:string;epoch:number}>();
  function pause(message = 'Paused. Choose Resume to continue.') {
    if (closed) return; paused = true; reason = message; epoch++; armed.clear(); primed.left = primed.right = false;
  }
  function available(hand: Hand) { return !closed && environment.visible && environment.viewerTracked && environment[hand].tracked; }
  return {
    sample(next: HandEnvironment) {
      if (closed) return;
      const lost = (['left','right'] as const).some(h => environment[h].tracked && !next[h].tracked);
      const hidden = !next.visible || !next.viewerTracked;
      if (lost || hidden && (environment.visible && environment.viewerTracked || armed.size > 0)) pause(hidden ? 'Session or head tracking paused. Choose Resume when tracking returns.' : 'Hand tracking was lost. Release your pinch, then choose Resume.');
      environment = next;
      for (const h of ['left','right'] as const) if (available(h) && next[h].open) primed[h] = true;
    },
    begin(hand: Hand, target: string, context: string) {
      if (!available(hand) || !primed[hand] || armed.size || !target || paused && target !== 'resume') return false;
      primed[hand] = false; armed.set(hand,{target,context,epoch}); return true;
    },
    end(hand: Hand, target: string, context: string): string | undefined {
      const intent = armed.get(hand); armed.delete(hand);
      if (!intent || !available(hand) || intent.epoch !== epoch || intent.target !== target || intent.context !== context) return;
      if (paused) { if (target !== 'resume') return; paused = false; reason = ''; epoch++; armed.clear(); return 'resume'; }
      return target;
    },
    cancel(hand: Hand) { armed.delete(hand); primed[hand] = false; },
    pause,
    state: () => ({closed,paused,reason,epoch}),
    dispose() { if (closed) return; pause('Closed.'); closed = true; }
  };
}
