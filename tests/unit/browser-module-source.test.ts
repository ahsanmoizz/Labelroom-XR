import {describe,it,expect} from 'vitest';
import {build} from 'esbuild';
import {browserModuleSource} from '../../scripts/browser-module-source.mjs';

describe('browser harness module paths round-trip through the JavaScript parser',()=>{
 for(const [name,file] of [
  ['exact stopped Windows candidate',String.raw`C:\Users\hanan\AppData\Local\LabelRoomXR\Runs\AI-READABLE-02492e80dd01434d828471cd65449046\candidate\src\ui\agent.ts`],
  ['Windows separators that resemble newline and tab escapes',String.raw`C:\new\test\workspace\src\ui\agent.ts`],
  ['Windows path with spaces and Unicode',String.raw`C:\Users\Review User\LabelRoom XR\نمونہ\src\ui\agent.ts`],
  ['POSIX checkout','/workspace/LabelRoom XR/src/ui/agent.ts']
 ])it(name,async()=>{
  const resolved:string[]=[];
  await expect(build({stdin:{contents:browserModuleSource(file),resolveDir:process.cwd()},bundle:true,write:false,format:'esm',logLevel:'silent',plugins:[{name:'capture-specifier',setup(build){build.onResolve({filter:/.*/},args=>{resolved.push(args.path);return {path:args.path,namespace:'fixture'}});build.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const mountAgentPanel = () => null;',loader:'js'}));}}]})).resolves.toBeDefined();
  expect(resolved).toEqual([file]);
 });
});
