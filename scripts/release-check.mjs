import { existsSync, readFileSync } from 'node:fs';
const path=process.argv[2]||'evidence/release.json';
if(!existsSync(path)){console.error('NOT READY: create evidence/release.json from the example, then supply real evidence.');process.exit(1);}
const x=JSON.parse(readFileSync(path,'utf8'));
const fields=['membershipAccepted','dataRightsVerified','realDataImported','roundTripExportPassed','handsEndToEndPassed','questPerformancePassed','privateAccessPassed','authDeliveryPassed','persistenceRecoveryPassed','liveAgentPassed','judgeAccessPassed','userValidationPassed','submissionReady'];
const failed=fields.filter(k=>x[k]?.passed!==true || typeof x[k]?.evidence!=='string' || x[k].evidence.trim().length<8);
if(!/^[a-f0-9]{40}$/.test(x.commit||'')) failed.push('commit');
if(!/^https:\/\//.test(x.productionUrl||'')) failed.push('productionUrl');
console.log(failed.length?'NOT READY: '+failed.join(', '):'Evidence checklist complete. Human must verify the referenced evidence before submission.');
process.exitCode=failed.length?1:0;
