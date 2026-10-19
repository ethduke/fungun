import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PublicRpc, hex, quantity } from './public-rpc.mjs';
import { ownerRefresh } from './publish-snapshot.mjs';
import { uniqueLogs } from './collect-snapshot.mjs';
import { validateSnapshot, buildSnapshotSite } from './snapshot-site.mjs';
import { LiveSession } from './live-session.mjs';
import { loadFixture } from './fixture-source.mjs';

const owner={GITHUB_REPOSITORY:'ethduke/farmgun-dashboard',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REF:'refs/heads/main',
  GITHUB_ACTOR_ID:'2248185',GITHUB_ACTOR:'ethduke',GITHUB_TRIGGERING_ACTOR:'ethduke'};
test('manual refresh refuses other users, rerun actors, branches, events and repositories',()=>{
  assert.equal(ownerRefresh(owner),true);
  for(const [key,value] of Object.entries({GITHUB_REPOSITORY:'someone/farmgun-dashboard',GITHUB_EVENT_NAME:'push',GITHUB_REF:'refs/heads/other',
    GITHUB_ACTOR_ID:'123',GITHUB_ACTOR:'someone',GITHUB_TRIGGERING_ACTOR:'someone'}))assert.equal(ownerRefresh({...owner,[key]:value}),false);
});
test('RPC client only accepts reviewed keyless HTTPS endpoints and read methods',async()=>{
  for(const endpoint of ['http://rpc.mainnet.chain.robinhood.com',['https://user','@example.invalid'].join(''),'https://rpc.mainnet.chain.robinhood.com/?key=REDACTED','https://example.invalid'])
    assert.throws(()=>new PublicRpc(endpoint));
  const rpc=new PublicRpc('https://rpc.mainnet.chain.robinhood.com',{wait:async()=>{}});
  await assert.rejects(rpc.call('eth_sendRawTransaction',['REDACTED']),/INVALID_READ_REQUEST/);
});
test('RPC batch responses are matched by ID and provider diagnostics never escape',async()=>{
  const rpc=new PublicRpc('https://rpc.mainnet.chain.robinhood.com',{wait:async()=>{},fetcher:async()=>new Response(JSON.stringify([
    {jsonrpc:'2.0',id:1,result:'second'},{jsonrpc:'2.0',id:0,result:'first'}]))});
  assert.deepEqual(await rpc.batch([{method:'eth_chainId',params:[]},{method:'eth_chainId',params:[]}]),['first','second']);
  rpc.fetcher=async()=>new Response(JSON.stringify([{jsonrpc:'2.0',id:0,error:{message:'SENSITIVE_SENTINEL'}}]));
  await assert.rejects(rpc.call('eth_chainId'),error=>error.message==='RPC_QUERY_REJECTED'&&!String(error).includes('SENSITIVE_SENTINEL'));
});
test('RPC retries transient reads but refuses malformed quantities and duplicate IDs',async()=>{
  let calls=0;const rpc=new PublicRpc('https://rpc.mainnet.chain.robinhood.com',{wait:async()=>{},fetcher:async()=>{
    calls++;return calls<3?new Response('',{status:429}):new Response(JSON.stringify([{jsonrpc:'2.0',id:0,result:'0x1'}]));}});
  assert.equal(await rpc.call('eth_chainId'),'0x1');assert.equal(calls,3);
  for(const value of ['1','0x01','0x10000000000000000',null])assert.throws(()=>quantity(value));
  rpc.fetcher=async()=>new Response(JSON.stringify([{jsonrpc:'2.0',id:0,result:'a'},{jsonrpc:'2.0',id:0,result:'b'}]));
  await assert.rejects(rpc.batch([{method:'eth_chainId',params:[]},{method:'eth_chainId',params:[]}]),/RPC_INVALID_RESPONSE/);
});

function mockCapture(){
  const fixture=loadFixture(),end=1800000000;
  const stream={chainId:fixture.chain.chainId,name:'Test Chain',token:fixture.chain.tokens[0],transferTopic:'0x'+'e'.repeat(64),endpoints:['https://rpc.mainnet.chain.robinhood.com']};
  const blocks=fixture.original.map(b=>({...b,timestamp:end-(111-b.height)*75}));
  const logs=blocks.flatMap(b=>b.events.map(e=>({removed:false,address:e.token,topics:[stream.transferTopic,'0x'+'0'.repeat(24)+e.sender.slice(2),'0x'+'0'.repeat(24)+e.recipient.slice(2)],
    data:'0x'+BigInt(e.amountRaw).toString(16).padStart(64,'0'),blockNumber:hex(b.height),blockHash:b.hash,logIndex:hex(e.index),transactionHash:e.txHash,
    transactionIndex:hex(b.transactions.find(t=>t.hash===e.txHash).index)})));
  const raw=b=>({number:hex(b.height),hash:b.hash,parentHash:b.parentHash,timestamp:hex(b.timestamp),transactions:b.transactions.map(t=>t.hash)});
  const answer=(method,params)=>{
    if(method==='eth_chainId')return hex(stream.chainId);
    if(method==='eth_call')return hex(stream.token.decimals);
    if(method==='eth_getBlockByNumber'){
      if(params[0]==='finalized')return raw(blocks.at(-1));
      const height=quantity(params[0]);const b=blocks.find(b=>b.height===height);
      return b?raw(b):{number:hex(height),timestamp:hex(end-200000),hash:'0x'+'a'.repeat(64),parentHash:'0x'+'b'.repeat(64),transactions:[]};
    }
    if(method==='eth_getLogs'){const p=params[0];return logs.filter(l=>quantity(l.blockNumber)>=quantity(p.fromBlock)&&quantity(l.blockNumber)<=quantity(p.toBlock));}
    if(method==='eth_getBlockReceipts'){const b=blocks.find(b=>b.height===quantity(params[0]));return b.transactions.map(tx=>({transactionHash:tx.hash,transactionIndex:hex(tx.index),blockHash:b.hash,blockNumber:hex(b.height),status:'0x1',logs:logs.filter(l=>l.transactionHash===tx.hash)}));}
    if(method==='eth_getTransactionReceipt')return {transactionHash:params[0],status:'0x1',logs:logs.filter(l=>l.transactionHash===params[0])};
    throw new Error('Unexpected test method');
  };
  const rpc=()=>({call:async(m,p=[])=>answer(m,p),batch:async requests=>requests.map(r=>answer(r.method,r.params))});
  return{stream,logs,rpc:rpc(),now:()=>new Date((end+600)*1000).toISOString()};
}
function temp(t){const path=mkdtempSync(join(tmpdir(),'real-snapshot-test-'));t.after(()=>rmSync(path,{recursive:true,force:true}));return path;}
test('live session verifies all receipts, saves SQLite and exports an honest partial snapshot',async t=>{
  const mocks=mockCapture(),root=temp(t),session=await new LiveSession(join(root,'capture'),mocks).initialize();t.after(()=>session.close());
  const report=await session.tick();assert.equal(report.healthy,true);assert.equal(report.analysis.transfers,23);
  assert.equal(report.analysis.blocks,12);assert.equal(report.session.status,'collecting');assert.equal(report.session.capturedSeconds,900);
  assert.equal(validateSnapshot(report),report);assert.equal(/0x[a-f0-9]{40,}/i.test(JSON.stringify(report)),false);
  assert.ok(readFileSync(join(root,'capture/frozen.sqlite')).subarray(0,16).toString().startsWith('SQLite format 3'));
  await buildSnapshotSite(join(root,'site'),join(root,'capture/snapshot-report.json'));
  assert.deepEqual(readdirSync(join(root,'site')).sort(),['.nojekyll','dashboard.css','dashboard.mjs','index.html','quality-report.json','recovery.html','snapshot-report.json','snapshot.mjs']);
  assert.throws(()=>validateSnapshot({...report,analysis:{...report.analysis,amountRaw:'0'}}));
  const rerun=await session.tick();assert.equal(rerun.analysis.transfers,23);assert.equal(session.pipeline.canonical().length,12);
  session.pipeline.db.prepare('UPDATE transfers SET amount_raw=? WHERE amount_raw=?').run('999','100000000000000000000');
  // A direct SQL corruption must not pass by comparing derived totals to themselves.
  session.pipeline.db.prepare('UPDATE transfers SET amount_raw=? WHERE rowid=(SELECT min(rowid) FROM transfers)').run('999');
  assert.throws(()=>session.exportReport(),/INVALID_WINDOW/);
});
test('missing query events are recovered from complete receipts; duplicate deliveries are idempotent',async t=>{
  const mocks=mockCapture(),call=mocks.rpc.call,root=temp(t);
  mocks.rpc.call=async(m,p)=>{const result=await call(m,p);return m==='eth_getLogs'?result.slice(1).concat(result.slice(1,2)):result;};
  const session=await new LiveSession(root,mocks).initialize();t.after(()=>session.close());
  const r=await session.tick();assert.equal(r.analysis.transfers,23);assert.equal(r.missingEventsRecovered,1);assert.equal(r.duplicatesIgnored,1);
  assert.throws(()=>uniqueLogs([mocks.logs[0],{...mocks.logs[0],data:'0x'+'0'.repeat(64)}],mocks.stream),/CONFLICTING_RPC_LOG/);
});
test('incomplete receipts cannot advance the checkpoint and retry fills the missing range',async t=>{
  const mocks=mockCapture(),batch=mocks.rpc.batch,root=temp(t);
  const session=await new LiveSession(root,mocks).initialize();t.after(()=>session.close());
  mocks.rpc.batch=async requests=>requests[0].method==='eth_getBlockReceipts'?(await batch(requests)).map(()=>[]):batch(requests);
  await assert.rejects(session.tick(),/RECEIPTS_INCOMPLETE/);assert.equal(session.pipeline.checkpoint().last_height,99);
  mocks.rpc.batch=batch;assert.equal((await session.tick()).analysis.transfers,23);
});
test('conflicting log payloads and changed finalized anchors stop collection',async t=>{
  const mocks=mockCapture(),call=mocks.rpc.call,root=temp(t);
  const session=await new LiveSession(root,mocks).initialize();t.after(()=>session.close());
  mocks.rpc.call=async(m,p)=>{const result=await call(m,p);return m==='eth_getLogs'?result.map((l,i)=>i?l:{...l,data:'0x'+'0'.repeat(64)}):result;};
  await assert.rejects(session.tick(),/LOG_RECEIPT_CONFLICT/);
  mocks.rpc.call=call;await session.tick();
  mocks.rpc.call=async(m,p)=>m==='eth_getBlockByNumber'&&p[0]===hex(111)?{...(await call(m,p)),hash:'0x'+'f'.repeat(64)}:call(m,p);
  await assert.rejects(session.tick(),/FINALIZED_SOURCE_CHANGED/);
});
