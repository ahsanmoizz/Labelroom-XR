import { readFileSync, existsSync } from 'node:fs';
const contract=JSON.parse(readFileSync('build-contract.json','utf8'));
const tests=JSON.parse(readFileSync('test-contract.json','utf8'));
const ids=new Set(tests.map(t=>t.id));
const paths=new Set(contract.files.map(f=>f.path));
if(paths.size!==contract.applicationFileCount||paths.size!==contract.files.length)throw new Error('File-count contract mismatch');
for(const f of contract.files){for(const id of f.test.split(', ')){if(!ids.has(id))throw new Error('Unknown test '+id+' in '+f.path);}if(f.status!=='planned'&&!existsSync(f.path))throw new Error('Missing supplied file '+f.path);}
for(const f of contract.features){for(const id of f.tests.split(', ')){if(!ids.has(id))throw new Error('Unknown feature test '+id);}}
const current=JSON.parse(readFileSync('implementation-map.json','utf8'));
const mapped=new Set();
for(const item of current.entries){
  if(!paths.has(item.originalPath)||mapped.has(item.originalPath))throw new Error('Invalid implementation mapping '+item.originalPath);
  mapped.add(item.originalPath);
  if(!['replacement','partial','pending'].includes(item.status)||!item.note?.trim())throw new Error('Missing implementation scope '+item.originalPath);
  for(const path of item.currentPaths){if(!existsSync(path))throw new Error('Missing current implementation '+path);}
  if(item.status==='replacement'&&!item.currentPaths.length)throw new Error('Replacement requires actual files '+item.originalPath);
}
for(const f of contract.files){if(!existsSync(f.path)&&!mapped.has(f.path))throw new Error('Unmapped historical path '+f.path);}
const docs=['01-product.html','02-setup.html','03-phases.html','04-file-map.html','05-tests.html','06-release.html'];
for(const name of docs){const content=readFileSync('docs/'+name,'utf8');for(const h of content.matchAll(/href="([^"#]+)"/g)){if(!h[1].startsWith('http')&&!existsSync('docs/'+h[1]))throw new Error('Broken guide link '+h[1]);}}
console.log(`Pack contracts consistent: ${contract.features.length} features, ${paths.size} mapped application files, ${tests.length} test groups, 6 guides.`);
console.log(`Current path map: ${current.entries.length} historical paths reconciled; partial and pending work stays explicit.`);
console.log('This is a documentation consistency check, not product acceptance.');
