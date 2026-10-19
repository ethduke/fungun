import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { validateSnapshot } from './snapshot-site.mjs';
import { stop } from './public-rpc.mjs';

export function ownerRefresh(context) {
  return context.GITHUB_REPOSITORY==='ethduke/farmgun-dashboard' && context.GITHUB_EVENT_NAME==='workflow_dispatch' &&
    context.GITHUB_REF==='refs/heads/main' && context.GITHUB_ACTOR_ID==='2248185' &&
    context.GITHUB_ACTOR==='ethduke' && context.GITHUB_TRIGGERING_ACTOR==='ethduke';
}
export async function freezeSnapshot(context=process.env, fetcher=fetch) {
  if(!ownerRefresh(context)||!context.GH_TOKEN||!/^[a-f0-9]{40}$/.test(context.COLLECTOR_COMMIT))stop('OWNER_REFRESH_REQUIRED');
  const bytes=readFileSync(context.SNAPSHOT_REPORT);if(bytes.length>1024*1024)stop('REPORT_TOO_LARGE');
  const report=validateSnapshot(JSON.parse(bytes));
  if(report.chainId!==4663||report.symbol!=='USDG'||report.collectorCommit!==context.COLLECTOR_COMMIT)stop('SNAPSHOT_SOURCE_MISMATCH');
  const api=async(path,method='GET',body)=>{
    const headers=new Headers({accept:'application/vnd.github+json','x-github-api-version':'2022-11-28','content-type':'application/json'});
    headers.set('authorization',['Bearer',context.GH_TOKEN].join(' '));
    const response=await fetcher(`https://api.github.com/repos/ethduke/farmgun-dashboard/${path}`,{
      method,redirect:'error',signal:AbortSignal.timeout(15000),headers,
      ...(body?{body:JSON.stringify(body)}:{})});
    if(response.status===404&&method==='GET')return null;
    if(!response.ok)stop('SNAPSHOT_GITHUB_OPERATION_FAILED');
    return response.status===204?null:response.json();
  };
  const pin=await api('contents/source.json?ref=main');
  if(!pin||JSON.parse(Buffer.from(pin.content,'base64')).commit!==context.COLLECTOR_COMMIT)stop('SOURCE_PIN_CHANGED');
  const prior=await api('contents/snapshot-report.json?ref=main');
  await api('contents/snapshot-report.json','PUT',{message:'Freeze verified 24-hour real-chain snapshot',branch:'main',
    content:bytes.toString('base64'),...(prior?{sha:prior.sha}:{})});
  // A GITHUB_TOKEN push does not trigger push workflows; explicit dispatch does.
  await api('actions/workflows/pages.yml/dispatches','POST',{ref:'main'});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{await freezeSnapshot();console.log('Verified aggregate snapshot saved; Pages publication dispatched.');}
  catch{console.error('Snapshot save or publication dispatch failed; inspect the manual workflow. No raw diagnostics are logged.');process.exitCode=1;}
}
