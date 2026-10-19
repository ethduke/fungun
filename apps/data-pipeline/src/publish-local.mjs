import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { validateSnapshot } from './snapshot-site.mjs';
export async function publishLocal(reportPath){
  const report=readFileSync(reportPath,'utf8');validateSnapshot(JSON.parse(report));
  const run=(args,input)=>new Promise((resolve,reject)=>{
    const child=spawn('gh',args,{env:Object.fromEntries(['PATH','HOME','USER','TMPDIR','XDG_CONFIG_HOME'].filter(k=>process.env[k]).map(k=>[k,process.env[k]])),stdio:['pipe','pipe','pipe']});
    const output=[];child.stdout.on('data',data=>output.push(data));child.stderr.resume();
    child.on('error',()=>reject(new Error('GITHUB_CLI_UNAVAILABLE')));
    child.on('close',code=>code===0?resolve(Buffer.concat(output).toString('utf8')):reject(new Error('GITHUB_OPERATION_FAILED')));
    child.stdin.end(input);
  });
  const owner=JSON.parse(await run(['api','user']));
  if(owner.id!==2248185||owner.login!=='ethduke')throw new Error('OWNER_ONLY');
  await run(['workflow','run','refresh.yml','--repo','ethduke/farmgun-dashboard','--ref','main','--json'],JSON.stringify({snapshot:report}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{const args=process.argv.slice(2);if(args.length!==2||args[0]!=='--report')throw new Error('INVALID_ARGUMENTS');await publishLocal(args[1]);console.log('Owner-authorized static publication requested. Check the dashboard Actions run.');}
  catch{console.error('Manual publication failed. Sign in as the repository owner and use a verified saved report.');process.exitCode=1;}
}
