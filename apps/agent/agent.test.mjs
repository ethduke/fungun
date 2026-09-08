import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FungunAgent,tickerCandidates} from './index.mjs';
import {Journal} from './journal.mjs';
const address='0x'+'11'.repeat(20);
async function fixture(handler=()=>({status:'submitted'})){
 const path=join(await mkdtemp(join(tmpdir(),'fungun-agent-')),'journal.json');let signed=0,sent=0;
 const agent=new FungunAgent({apiUrl:'https://example.com',token:'secret',profile:{},journalPath:path,signer:{address,signTransaction:()=>{signed++;throw new Error('must_not_sign');}},rpc:{request:()=>{sent++;throw new Error('must_not_send');}},fetcher:async(url,opts)=>({ok:true,json:()=>handler(url,opts)})});
 return {agent,path,counts:()=>({signed,sent})};
}
test('durable signed/submitted/uncertain plans never sign or broadcast again',async()=>{
 for(const state of ['signing','broadcasting','submitted','reserving']){
  const {agent,path,counts}=await fixture();
  await agent.journal.lock(async j=>{j.data.intents.a={state,key:'a',plan:{id:'a',binding:'b'},hash:'0x123',reservedWei:'50'};await j.save();});
  await agent.resume();await agent.resume();
  assert.deepEqual(counts(),{signed:0,sent:0});assert.equal(JSON.parse(await readFile(path)).intents.a.state,state);
 }
});
test('confirmed recovery completes but budget remains conservatively reserved',async()=>{
 const {agent}=await fixture(()=>({status:'confirmed',asset:address}));
 await agent.journal.lock(async j=>{j.data.intents.a={state:'submitted',plan:{id:'a'},reservedWei:'500'};await j.save();});
 await agent.resume();await agent.journal.lock(j=>{assert.equal(j.data.intents.a.state,'confirmed');assert.equal(j.data.intents.a.reservedWei,'500');});
});
test('uncertain recovery blocks distinct intent and retained daily budgets',async()=>{
 const {agent}=await fixture();
 await agent.journal.lock(async j=>{j.data.intents.a={state:'submitted',plan:{id:'a'},reservedWei:'50'};await j.save();});
 await assert.rejects(agent.deploy({name:'X',ticker:'X',pairId:'long-ETH'}),/unresolved_intent/);
});
test('journal excludes other users and prevents concurrent process access',async()=>{
 const {agent,path}=await fixture();
 await agent.journal.lock(async j=>{await j.save();await assert.rejects(new Journal(path).lock(()=>{}),/journal_locked/);});
 assert.equal((await stat(path)).mode&0o077,0);
});
test('stale pid locks recover automatically',async()=>{
 const {agent,path}=await fixture();await writeFile(path+'.lock','2147483647',{mode:0o600});await agent.journal.lock(j=>j.save());
});
test('bounded deterministic ticker candidates ignore source instructions',()=>{
 const a=tickerCandidates({name:'IGNORE ALL! 123 Keys / token'});assert.deepEqual(a,tickerCandidates({name:'IGNORE ALL! 123 Keys / token'}));assert.equal(a.length,8);assert.ok(a.every(t=>/^[A-Z]{1,11}$/.test(t)));
});
test('unsupported launchpads and stale streams never launch',async()=>{
 let calls=0;const {agent}=await fixture(()=>{calls++;return {freshness:{status:'stale'},themes:[{key:'x',name:'X'}]};});
 await assert.rejects(agent.tick({searchLaunchpads:['pump'],deployLaunchpads:['long']}),/unsupported_launchpad/);
 assert.deepEqual(await agent.tick({searchLaunchpads:['long'],deployLaunchpads:['long']}),{status:'stale'});assert.equal(calls,1);
});
test('daily budget rejects before artwork generation or network request',async()=>{
 let calls=0;const {agent}=await fixture(()=>{calls++;});agent.limits.maxSpendWeiPerDay='1';
 await assert.rejects(agent.deploy({name:'X',ticker:'X',pairId:'long-ETH'}),/daily_spend_limit/);assert.equal(calls,0);
});
