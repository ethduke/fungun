#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, http } from 'viem';
import { FungunAgent } from './index.mjs';
const [command,configPath,inputPath]=process.argv.slice(2);
if(!['deploy','watch','resume'].includes(command)||!configPath){console.error('Usage: fungun-agent deploy CONFIG.json INPUT.json | watch CONFIG.json | resume CONFIG.json');process.exitCode=1;}
else try {
  const config=JSON.parse(await readFile(configPath,'utf8'));
  const key=process.env.FUNGUN_PRIVATE_KEY,token=process.env.FUNGUN_AGENT_TOKEN,rpcUrl=process.env.FUNGUN_RPC_URL;
  if(!key||!token||!rpcUrl)throw new Error('Set FUNGUN_PRIVATE_KEY, FUNGUN_AGENT_TOKEN and FUNGUN_RPC_URL in the local runtime');
  const signer=privateKeyToAccount(key);delete process.env.FUNGUN_PRIVATE_KEY;
  let imageGenerator;
  if(config.image?.mode==='grok'){
    const {createGrokImageGenerator}=await import('./grok-x402.mjs');
    imageGenerator=createGrokImageGenerator({...config.image,signer});
  }
  const agent=new FungunAgent({...config,token,signer,rpc:createPublicClient({transport:http(rpcUrl)}),imageGenerator});
  if(command==='deploy'){
    if(!inputPath)throw new Error('Deploy requires INPUT.json');
    const input=JSON.parse(await readFile(inputPath,'utf8'));
    console.log(JSON.stringify(await agent.deploy(input,{intentKey:input.intentKey,image:config.image??{mode:input.image?'provided':'none'}})));
  }else if(command==='resume')console.log(JSON.stringify(await agent.resume()));
  else {
    let stop=false;process.on('SIGINT',()=>{stop=true;});process.on('SIGTERM',()=>{stop=true;});
    while(!stop){try{console.log(JSON.stringify(await agent.tick(config)));}catch(e){console.error(`Agent paused: ${safeError(e)}`);if(!e.retryable&&!['upstream_unavailable','timeout','fetch failed','asset_busy','busy','rate_limited'].includes(e.message))break;for(let n=0;n<Math.min(300,e.retryAfter??30)&&!stop;n++)await new Promise(r=>setTimeout(r,1000));}
      for(let n=0;n<Math.max(5,config.pollSeconds??30)&&!stop;n++)await new Promise(r=>setTimeout(r,1000));}
  }
}catch(e){console.error(safeError(e));process.exitCode=1;}
function safeError(e){const codes=new Set(['agent_configuration','unsupported_launchpad','journal_locked','daily_launch_limit','daily_spend_limit','unresolved_intent','quote_expired','contract_unverified','nonce_changed','insufficient_funds','intent_input_changed','spend_limit','wrong_chain','image_generator_required','response_size','rate_limited','upstream_unavailable']);return codes.has(e?.message)?e.message:'agent_failed';}
