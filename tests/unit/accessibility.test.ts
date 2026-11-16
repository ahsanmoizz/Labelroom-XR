import {describe, it, expect} from 'vitest';
import {createDisplayPreferences, parseDisplayPreferences} from '../../src/ui/accessibility';

describe('device display preferences', () => {
  it.each([null, '', '{}', '[]', '{', '{"textSize":100,"highContrast":true,"ownerId":"no"}', '{"textSize":200,"highContrast":true}', '{"textSize":115,"highContrast":"yes"}', ' '.repeat(257)])('refuses invalid or unrelated stored data: %s', raw => {
    expect(parseDisplayPreferences(raw)).toEqual({textSize:100,highContrast:false});
  });
  it('persists only bounded display values and restores them on a fresh page', () => {
    const values = new Map<string,string>();
    const storage = {getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);}};
    const first = createDisplayPreferences(storage);
    first.set({textSize:130,highContrast:true});
    expect(values.size).toBe(1); expect(first.persisted()).toBe(true);
    expect(createDisplayPreferences(storage).read()).toEqual({textSize:130,highContrast:true});
    expect(Object.keys(JSON.parse([...values.values()][0])).sort()).toEqual(['highContrast','textSize']);
  });
  it('keeps settings usable without browser storage or after a quota error', () => {
    const store = createDisplayPreferences({getItem(){throw Error('denied');},setItem(){throw Error('quota');}});
    store.set({textSize:115,highContrast:true});
    expect(store.read()).toEqual({textSize:115,highContrast:true}); expect(store.persisted()).toBe(false);
    const memory = createDisplayPreferences(); memory.set({textSize:130,highContrast:false}); expect(memory.read().textSize).toBe(130); expect(memory.persisted()).toBe(false);
  });
  it('notifies current views once per change and stops after unsubscribe', () => {
    const store = createDisplayPreferences(); let calls = 0; const stop = store.subscribe(()=>calls++);
    store.set({textSize:115,highContrast:false}); expect(calls).toBe(1); stop();
    store.set({textSize:100,highContrast:false}); expect(calls).toBe(1);
    expect(Object.isFrozen(store.read())).toBe(true);
  });
  it('rejects unsupported changes before writing or notifying', () => {
    let writes=0;const store=createDisplayPreferences({getItem:()=>null,setItem(){writes++;}});let notified=0;store.subscribe(()=>notified++);
    expect(()=>store.set({textSize:200 as 100,highContrast:true})).toThrow();
    expect(writes).toBe(0);expect(notified).toBe(0);expect(store.read().textSize).toBe(100);
  });
});
