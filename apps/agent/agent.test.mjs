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
test('real Long ticker result launches once and acknowledges cursor after durable completion',async()=>{
 const {agent}=await fixture(url=>url.pathname.endsWith('/ticker')?{results:{long:{status:'unreserved'}}}:{freshness:{status:'fresh'},themes:[{key:'moon',name:'Moon'}],events:[],nextCursor:'next'});
 let starts=0;agent.start=async(j,input,opts)=>{starts++;assert.equal(input.ticker,'MOON');j.data.intents[opts.intentKey]={themeKey:opts.themeKey,state:'confirmed'};await j.save();};
 const config={searchLaunchpads:['long'],deployLaunchpads:['long'],pairId:'long-EXAMPLE'};
 await agent.tick(config);await agent.tick(config);assert.equal(starts,1);
 await agent.journal.lock(j=>assert.equal(j.data.cursor,'next'));
});
test('uncertain theme intent persists without acknowledging cursor',async()=>{
 const {agent}=await fixture(url=>url.pathname.endsWith('/ticker')?{results:{long:{status:'unreserved'}}}:{freshness:{status:'fresh'},themes:[],events:[{theme:{key:'moon',name:'Moon'}}],nextCursor:'next'});
 agent.start=async(j,input,opts)=>{j.data.intents[opts.intentKey]={themeKey:opts.themeKey,state:'signing'};await j.save();throw new Error('uncertain');};
 await assert.rejects(agent.tick({searchLaunchpads:['long'],deployLaunchpads:['long'],pairId:'long-EXAMPLE'}),/uncertain/);
 await agent.journal.lock(j=>{assert.equal(j.data.cursor,null);assert.equal(Object.values(j.data.intents)[0].state,'signing');});
});
test('none, provided and Grok choices are durably stored before artwork requests',async()=>{
 for(const mode of ['none','provided','grok']){
  const {agent}=await fixture(()=>{throw new Error('artwork_unavailable');});let generated=0;
  agent.imageGenerator=async({intentKey})=>{assert.equal(intentKey,'intent');generated++;return 'generated';};
  await assert.rejects(agent.deploy({name:'Moon',ticker:'MOON',pairId:'long-EXAMPLE',...(mode==='provided'?{image:'provided'}:{})},{intentKey:'intent',image:{mode}}),/artwork_unavailable/);
  await agent.journal.lock(j=>{assert.ok(j.data.intents.intent.imageBase64);assert.equal(j.data.intents.intent.image.mode,mode);});
  assert.equal(generated,mode==='grok'?1:0);
 }
});
test('reused idempotency key rejects changed launch details',async()=>{
 const {agent}=await fixture(()=>{throw new Error('stop');});const input={name:'Moon',ticker:'MOON',pairId:'long-EXAMPLE'};
 await assert.rejects(agent.deploy(input,{intentKey:'same'}),/stop/);
 await assert.rejects(agent.deploy({...input,ticker:'SUN'},{intentKey:'same'}),/intent_input_changed/);
});
test('journal binds wallet API website and trusted profile across restarts',async()=>{
 const {agent,path}=await fixture();await agent.journal.lock(j=>j.save());
 await assert.rejects(new Journal(path,'different-wallet-or-profile').lock(()=>{}),/journal_identity_changed/);
});
test('journal rejects symlinks and oversized files',async()=>{
 const {symlink,truncate}=await import('node:fs/promises');const {agent,path}=await fixture();
 const target=path+'.target';await writeFile(target,'{}',{mode:0o600});await symlink(target,path);
 await assert.rejects(agent.journal.lock(()=>{}),/journal_symlink/);
 const other=path+'.large';await writeFile(other,'',{mode:0o600});await truncate(other,67108865);
 await assert.rejects(new Journal(other).lock(()=>{}),/journal_size/);
});
