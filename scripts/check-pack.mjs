import { readFileSync, existsSync } from 'node:fs';
const contract=JSON.parse(readFileSync('build-contract.json','utf8'));
const tests=JSON.parse(readFileSync('test-contract.json','utf8'));
const ids=new Set(tests.map(t=>t.id));
const paths=new Set(contract.files.map(f=>f.path));
if(paths.size!==contract.applicationFileCount||paths.size!==contract.files.length)throw new Error('File-count contract mismatch');
for(const f of contract.files){for(const id of f.test.split(', ')){if(!ids.has(id))throw new Error('Unknown test '+id+' in '+f.path);}if(f.status!=='planned'&&!existsSync(f.path))throw new Error('Missing supplied file '+f.path);}
for(const f of contract.features){for(const id of f.tests.split(', ')){if(!ids.has(id))throw new Error('Unknown feature test '+id);}}
const docs=['01-product.html','02-setup.html','03-phases.html','04-file-map.html','05-tests.html','06-release.html'];
for(const name of docs){const content=readFileSync('docs/'+name,'utf8');for(const h of content.matchAll(/href="([^"#]+)"/g)){if(!h[1].startsWith('http')&&!existsSync('docs/'+h[1]))throw new Error('Broken guide link '+h[1]);}}
console.log(`Pack contracts consistent: ${contract.features.length} features, ${paths.size} mapped application files, ${tests.length} test groups, 6 guides.`);
console.log('This is a documentation consistency check, not product acceptance.');
