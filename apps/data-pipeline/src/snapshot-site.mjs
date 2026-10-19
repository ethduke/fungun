import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildDashboard } from './demo.mjs';
import { stop } from './public-rpc.mjs';

export function validateSnapshot(report) {
  const a=report?.analysis, count=value=>Number.isSafeInteger(value)&&value>=0;
  const amount=value=>typeof value==='string'&&/^(0|[1-9][0-9]{0,90})$/.test(value);
  if (report?.schemaVersion!==1||report.kind!=='chain-snapshot'||report.healthy!==true||!Number.isSafeInteger(report.chainId)||
    !/^[A-Za-z ]{1,40}$/.test(report.chain)||!/^[A-Z0-9]{1,12}$/.test(report.symbol)||!Number.isInteger(report.decimals)||report.decimals<0||report.decimals>36||
    !a||!(Date.parse(a.end)>Date.parse(a.start)&&Date.parse(a.end)-Date.parse(a.start)<=86400000)||report.session?.targetSeconds!==86400||report.session?.intervalMinutes!==15||!['collecting','complete'].includes(report.session?.status)||Date.parse(report.session.targetEnd)-Date.parse(a.start)!==86400000||!Number.isFinite(Date.parse(a.capturedAt))||Date.parse(a.capturedAt)<Date.parse(a.end)||
    !count(a.startHeight)||!count(a.endHeight)||a.endHeight<a.startHeight||a.blocks!==a.endHeight-a.startHeight+1||
    ![a.transfers,a.transactions,a.activeAddresses].every(count)||a.transactions>a.transfers||
    ![a.amountRaw,a.medianRaw,a.largestRaw].every(amount)||BigInt(a.largestRaw)>BigInt(a.amountRaw)||
    !Array.isArray(a.hours)||a.hours.length!==24||!Array.isArray(report.checks)||report.checks.length<4||
    !report.checks.every(c=>c.passed===true&&typeof c.name==='string'&&c.name.length<100)||
    new Set(report.checks.map(c=>c.name)).size!==report.checks.length||!Array.isArray(report.sources)||report.sources.length!==1||
    !report.sources.every(s=>/^[a-z0-9.-]{1,100}$/.test(s))||new Set(report.sources).size!==1||
    !['databaseSha256','blockHashDigest','captureDigest'].every(key=>/^[a-f0-9]{64}$/.test(report[key]))||
    /0x[a-f0-9]{40,}/i.test(JSON.stringify(report))) stop('INVALID_AGGREGATE_SNAPSHOT');
  let transfers=0,total=0n;
  a.hours.forEach((hour,i)=>{
    if(Date.parse(hour.start)!==Date.parse(a.start)+i*3600000||Date.parse(hour.end)!==Date.parse(hour.start)+3600000||
      !count(hour.transfers)||!amount(hour.amountRaw))stop('INVALID_HOURLY_AGGREGATE');
    transfers+=hour.transfers;total+=BigInt(hour.amountRaw);
  });
  if(transfers!==a.transfers||String(total)!==a.amountRaw||!a.hours.some(h=>h.start===a.peakHour))stop('INCONSISTENT_AGGREGATES');
  return report;
}
export async function buildSnapshotSite(output, reportPath) {
  const report=validateSnapshot(JSON.parse(readFileSync(reportPath,'utf8')));
  await buildDashboard(output);
  renameSync(join(output,'index.html'),join(output,'recovery.html'));
  writeFileSync(join(output,'index.html'),readFileSync(new URL('../dashboard/snapshot.html',import.meta.url)));
  writeFileSync(join(output,'snapshot.mjs'),readFileSync(new URL('../dashboard/snapshot.mjs',import.meta.url)));
  writeFileSync(join(output,'snapshot-report.json'),JSON.stringify(report,null,2)+'\n');
  return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{const args=process.argv.slice(2);if(args.length!==4||args[0]!=='--out'||args[2]!=='--report')stop('INVALID_ARGUMENTS');
    const r=await buildSnapshotSite(resolve(args[1]),resolve(args[3]));console.log(JSON.stringify({status:'verified',transfers:r.analysis.transfers}));
  }catch{console.error('Static snapshot validation failed; publication stopped.');process.exitCode=1;}
}
