import { existsSync, readFileSync } from 'node:fs';
const required=['package-lock.json','iwsdk.config.json','docs/01-product.html','docs/02-setup.html','docs/03-phases.html','docs/04-file-map.html','docs/05-tests.html','docs/06-release.html'];
let ok=true;for(const f of required){if(!existsSync(f)){console.error('MISSING',f);ok=false;}}
const p=JSON.parse(readFileSync('package.json','utf8'));
if(p.dependencies['@iwsdk/core']!=='1.0.1') { console.error('SDK pin changed');ok=false; }
console.log('Scaffold only. Membership, real data, hands, security and full-product gates need external evidence.');
if(!ok)process.exitCode=1;
