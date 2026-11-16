export const displaySizes = [100, 115, 130] as const;
export type DisplaySize = typeof displaySizes[number];
export interface DisplayPreferences { readonly textSize: DisplaySize; readonly highContrast: boolean }
const key = 'labelxr-display-v1';
const defaults: DisplayPreferences = Object.freeze({textSize: 100, highContrast: false});
export function parseDisplayPreferences(raw: string | null): DisplayPreferences {
  if (!raw || raw.length > 256) return defaults;
  try {
    const value = JSON.parse(raw);
    if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'highContrast,textSize' ||
        !displaySizes.includes(value.textSize) || typeof value.highContrast !== 'boolean') return defaults;
    return Object.freeze({textSize: value.textSize, highContrast: value.highContrast});
  } catch { return defaults; }
}
export function createDisplayPreferences(storage?: Pick<Storage, 'getItem' | 'setItem'>) {
  let state = defaults, persisted = true;
  try { state = parseDisplayPreferences(storage?.getItem(key) ?? null); } catch { persisted = false; }
  const listeners = new Set<() => void>();
  return {
    read: () => state,
    persisted: () => persisted && !!storage,
    set(next: DisplayPreferences) {
      if (!displaySizes.includes(next.textSize) || typeof next.highContrast !== 'boolean') throw Error('Invalid display preference.');
      state = Object.freeze({textSize: next.textSize, highContrast: next.highContrast});
      try { storage?.setItem(key, JSON.stringify(state)); persisted = !!storage; } catch { persisted = false; }
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
  };
}
export type DisplayPreferenceStore = ReturnType<typeof createDisplayPreferences>;
const documents = new WeakMap<Document, DisplayPreferenceStore>();
export function displayPreferences(doc: Document): DisplayPreferenceStore {
  let store = documents.get(doc);
  if (!store) {
    let storage: Storage | undefined;
    try { storage = doc.defaultView?.localStorage; } catch { /* In-memory settings remain usable. */ }
    store = createDisplayPreferences(storage); documents.set(doc, store);
    const apply = () => {
      const value = store!.read();
      doc.documentElement?.setAttribute('data-labelxr-text', String(value.textSize));
      doc.documentElement?.setAttribute('data-labelxr-contrast', value.highContrast ? 'high' : 'normal');
    };
    store.subscribe(apply); apply();
  }
  return store;
}
/** Device preferences have no account, dataset, review or network capability. */
export function mountDisplaySettings(doc: Document) {
  const store = displayPreferences(doc), section = doc.createElement('details'), summary = doc.createElement('summary');
  summary.textContent = 'Display settings'; section.className = 'display-settings';
  const label = doc.createElement('label'), size = doc.createElement('select');
  label.textContent = 'Text and panel size'; size.setAttribute('aria-label', 'Text and panel size');
  for (const value of displaySizes) { const option = doc.createElement('option'); option.value = String(value); option.textContent = `${value}%`; size.append(option); }
  label.append(size);
  const contrastLabel = doc.createElement('label'), contrast = doc.createElement('input');
  contrastLabel.className = 'checkbox-field'; contrast.type = 'checkbox'; contrast.setAttribute('aria-label', 'High contrast');
  const contrastText = doc.createElement('span'); contrastText.textContent = 'High contrast'; contrastLabel.append(contrast, contrastText);
  const note = doc.createElement('p'); note.textContent = 'Larger text also enlarges the whole XR panel, including its buttons. Preferences apply on this browser. In XR, use the SELECT page to change them with either hand.';
  const status = doc.createElement('p'); status.setAttribute('role', 'status');
  const reset = doc.createElement('button'); reset.type = 'button'; reset.textContent = 'Reset display settings';
  function render() { const value = store.read(); size.value = String(value.textSize); contrast.checked = value.highContrast; status.textContent = store.persisted() ? 'Display settings are saved on this browser.' : 'Storage is unavailable. Display settings last while this page stays open.'; }
  function update() { store.set({textSize: Number(size.value) as DisplaySize, highContrast: contrast.checked}); }
  const restore = () => store.set(defaults);
  size.addEventListener('change', update); contrast.addEventListener('change', update); reset.addEventListener('click', restore);
  section.append(summary, label, contrastLabel, note, reset, status); const unsubscribe = store.subscribe(render); render();
  return {element: section, dispose() { unsubscribe(); size.removeEventListener('change', update); contrast.removeEventListener('change', update); reset.removeEventListener('click', restore); section.remove(); }};
}
