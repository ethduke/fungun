import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { initializeIpfsStore, IpfsStore } from './ipfs-store.mjs';
import { createIpfsWorker } from './ipfs-worker.mjs';
import { validateAssetInput } from './asset-service.mjs';
import { createAssetProxy } from '../../web/lib/asset-proxy.ts';
import { ensureLaunchArtwork } from '../../web/lib/launch-artwork.ts';
import { assetHash, assetWallet, assetErrorText } from '../../web/lib/asset-protocol.ts';
import { runLaunchFlow } from '../../web/lib/launch-flow.ts';
import { artworkHistory, rememberArtwork, ARTWORK_CACHE_TTL } from '../../web/lib/artwork-cache.ts';

async function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fungun-click-')));
  initializeIpfsStore(root);
  const origin = 'https://app.example.com', gateway = 'launch-assets.mypinata.cloud';
  const store = new IpfsStore({ root, appOrigin: origin, gateway });
  const wallet = privateKeyToAccount(generatePrivateKey()).address;
  const image = await sharp({create:{width:8,height:8,channels:3,background:'green'}}).webp().toBuffer();
  const draft = {name:'Moon',ticker:'MOON',description:''};
  const writes=[], requests=[], records=new Map();
  const worker = createIpfsWorker(store, {
    async pinObject(object) {writes.push(object.cid); return {id:crypto.randomUUID(),cid:object.cid,size:object.bytes.length,mime:object.mime};},
    async inspectPin(){}, async verifyObject(){}, async findPin(){assert.fail('Unexpected retry');},
  }, {enabled:true});
  t.after(async()=>{await worker.stop();store.close();rmSync(root,{recursive:true});});
  let loseResponse=false, delayedChecks=0, issue='verification_delayed', refuseOnce=false;
  const proxy=createAssetProxy(()=>({appOrigin:origin,serviceOrigin:'https://backend.example.com',publicOrigin:`https://${gateway}`,enabled:true,production:true}),async(url,options)=>{
    const kind=url.pathname.slice('/v1/asset-'.length); requests.push(kind);
    const input=validateAssetInput(kind,JSON.parse(options.body));
    if(kind==='launch-prepare')return Response.json({...await store.launchChallenge(input.wallet,image,input.draft),imageBase64:image.toString('base64'),width:8,height:8,serverTime:store.clock()});
    if(kind==='launch-publish'){
      assert.equal('signature' in JSON.parse(options.body),false);
      if(refuseOnce){refuseOnce=false;return Response.json({error:'asset_busy'},{status:429,headers:{'retry-after':'2'}});}
      let result;
      try { result=await store.acceptLaunch(input); }
      catch(error){return Response.json({error:error.code},{status:error.status,headers:{'retry-after':String(error.retryAfter||0)}});}
      worker.kick();await worker.idle();
      if(loseResponse)throw new TypeError('Simulated response loss');
      return Response.json(result);
    }
    assert.equal(kind,'status');
    let result;
    try { result=store.status(input); }
    catch(error) { return Response.json({error:error.code},{status:error.status}); }
    if(delayedChecks-->0)return Response.json({...result,status:'processing',progress:{image:'pinned',metadata:'ready'},issue,retryAt:store.clock()+2000});
    return Response.json(result);
  });
  const fetcher=(path,options)=>proxy(new Request(origin+path,{...options,headers:{...options.headers,origin}}),path.split('/').at(-1));
  const storage={getItem:key=>records.get(key)??null,setItem:(key,value)=>records.set(key,value),removeItem:key=>records.delete(key)};
  const run=(overrides={})=>ensureLaunchArtwork({bytes:image,wallet,draft,origin,storage,fetcher,isCurrent:()=>true,onProgress:()=>{},pause:async()=>worker.idle(),...overrides});
  return {run,store,wallet,image,draft,writes,requests,records,storage,setLoseResponse:value=>{loseResponse=value;},setDelayedChecks:value=>{delayedChecks=value;},setIssue:value=>{issue=value;},refuseNext:()=>{refuseOnce=true;}};
}

const recoveryKey = 'fungun.asset-publication.v1';
const bindingKey = 'fungun.launch-artwork.v1';
async function keys(wallet) {
 const suffix=await assetHash(new TextEncoder().encode(assetWallet(wallet)));
 return {recovery:`${recoveryKey}:${suffix}`,binding:`${bindingKey}:${suffix}`};
}
async function makeLegacy(f) {
 const scoped=await keys(f.wallet);
 for(const [from,to] of [[scoped.recovery,recoveryKey],[scoped.binding,bindingKey]]) {
  f.records.set(to,f.records.get(from));f.records.delete(from);
 }
}

test('one launch click publishes verified artwork with no wallet signature; subsequent clicks only read status',async t=>{
 const f=await fixture(t);const first=await f.run();assert.equal(first.status,'published');
 assert.equal(f.writes.length,2);assert.deepEqual(f.requests,['launch-prepare','launch-publish','status']);
 const serialized=JSON.stringify([...f.records.values()]);assert.equal(serialized.includes('uploadToken'),false);assert.equal(serialized.includes(f.wallet.toLowerCase()),false);
 const next=await f.run();assert.deepEqual(next,first);assert.equal(f.writes.length,2);assert.equal(f.requests.filter(x=>x==='launch-publish').length,1);
});

test('uncertain upload resumes through status and never repeats a write',async t=>{
 const f=await fixture(t);f.setLoseResponse(true);assert.equal((await f.run()).status,'published');
 f.setLoseResponse(false);assert.equal((await f.run()).status,'published');assert.equal(f.writes.length,2);assert.equal(f.requests.filter(x=>x==='launch-publish').length,1);
});

test('temporary verification failure continues automatically and checks promptly without another write',async t=>{
 const f=await fixture(t);f.setDelayedChecks(2);const delays=[];
 assert.equal((await f.run({pause:async ms=>{delays.push(ms);}})).status,'published');
 assert.deepEqual(delays,[3000,3000]);assert.equal(f.writes.length,2);
 assert.equal(f.requests.filter(x=>x==='launch-publish').length,1);
});

test('prolonged verification stays bounded and leaves recovery available without a forced cooldown',async t=>{
 const f=await fixture(t);f.setDelayedChecks(30);const delays=[];
 await assert.rejects(f.run({pause:async ms=>{delays.push(ms);}}),e=>e.code==='asset_publication_uncertain'&&e.retryAfter===0);
 assert.equal(f.requests.filter(x=>x==='status').length,27);
 assert.equal(delays.reduce((a,b)=>a+b,0),120000);
 assert.ok(f.records.get((await keys(f.wallet)).recovery));
 f.setDelayedChecks(0);assert.equal((await f.run()).status,'published');
 assert.equal(f.requests.filter(x=>x==='launch-publish').length,1);assert.equal(f.writes.length,2);
});

test('changing the draft during automatic status checks stops the launch',async t=>{
 const f=await fixture(t);f.setDelayedChecks(2);let current=true;
 await assert.rejects(f.run({isCurrent:()=>current,pause:async()=>{current=false;}}),{code:'asset_context_changed'});
 assert.equal(f.requests.filter(x=>x==='status').length,1);assert.equal(f.writes.length,2);
});

test('gateway access denial reports the service problem immediately and preserves recovery',async t=>{
 const f=await fixture(t);f.setDelayedChecks(1);f.setIssue('gateway_access_denied');
 await assert.rejects(f.run({pause:async()=>assert.fail('Do not wait on a configuration problem')}),{code:'asset_gateway_unavailable'});
 assert.ok(f.records.get((await keys(f.wallet)).recovery));
 assert.equal((await f.run()).status,'published');
 assert.equal(f.requests.filter(x=>x==='launch-publish').length,1);
});

test('changed context stops before publication and unavailable recovery storage prevents a write',async t=>{
 const f=await fixture(t);await assert.rejects(f.run({isCurrent:()=>false}),{code:'asset_context_changed'});assert.equal(f.requests.length,0);
 await assert.rejects(f.run({storage:{getItem:()=>null,setItem:()=>{throw new Error('blocked');},removeItem:()=>{}}}));
 assert.equal(f.requests.filter(x=>x==='launch-publish').length,0);assert.equal(f.writes.length,0);
});

test('upload capability binds bytes and wallet, expires, and cannot bypass legacy signatures',async t=>{
 const f=await fixture(t);const approval=await f.store.launchChallenge(f.wallet,f.image,f.draft);
 const input={id:approval.id,wallet:f.wallet,image:f.image,draft:f.draft,uploadToken:approval.uploadToken};
 const reopened=new IpfsStore({root:f.store.root,appOrigin:f.store.appOrigin,gateway:f.store.gateway});
 assert.equal(reopened.launchAdmission(approval.id),true);
 assert.equal(reopened.uploadToken(reopened.get(approval.id)),approval.uploadToken);
 reopened.close();
 await assert.rejects(f.store.acceptLaunch({...input,uploadToken:'f'.repeat(64)}),{code:'invalid_asset_approval'});
 await assert.rejects(f.store.acceptLaunch({...input,draft:{...f.draft,name:'Changed'}}),{code:'asset_approval_changed'});
 const other=privateKeyToAccount(generatePrivateKey()).address;
 await assert.rejects(f.store.acceptLaunch({...input,wallet:other}),{code:'asset_approval_changed'});
 const syntheticProof=`0x${'ab'.repeat(65)}`;
 await assert.rejects(f.store.accept({...input,signature:syntheticProof}),{code:'invalid_asset_approval'});
 const legacy=await f.store.challenge(other,f.image,f.draft);
 await assert.rejects(f.store.acceptLaunch({...input,id:legacy.id,wallet:other}),{code:'invalid_asset_approval'});
 f.store.now=()=>approval.expiresAt+1;
 await assert.rejects(f.store.acceptLaunch(input),{code:'asset_approval_expired'});
 assert.equal(f.writes.length,0);
});

test('signature-free publication still honors the shared daily spending limit',async t=>{
 const f=await fixture(t);const approval=await f.store.launchChallenge(f.wallet,f.image,f.draft);
 f.store.budget.debit([['ipfs-publications',30,86400000]],30);
 await assert.rejects(f.store.acceptLaunch({id:approval.id,wallet:f.wallet,image:f.image,draft:f.draft,uploadToken:approval.uploadToken}),{code:'artwork_service_limit'});
 assert.equal(f.store.get(approval.id).state,'pending');assert.equal(f.writes.length,0);
});

test('publication quota rejection returns immediately instead of polling unsubmitted artwork',async t=>{
 const f=await fixture(t);
 f.store.budget.debit([[`ipfs-owner:${f.store.owner(f.wallet)}`,20,86400000]],20);
 await assert.rejects(runLaunchFlow({artwork:()=>f.run({pause:async()=>assert.fail('Do not poll an unsubmitted upload')}),quote:async()=>assert.fail('Quota must stop before the quote'),wallet:async()=>assert.fail('Quota must stop before the wallet'),isCurrent:()=>true,onProgress:()=>{},pause:async()=>assert.fail('Daily cap must not retry')}),e=>{
  assert.equal(e.code,'artwork_daily_limit');assert.ok(e.retryAfter>0);
  assert.equal(assetErrorText(e),'Daily artwork limit reached: 20 per wallet. Try again after the daily reset.');return true;
 });
 assert.equal(f.requests.filter(x=>x==='status').length,1);assert.equal(f.writes.length,0);
 const id=JSON.parse(f.records.get((await keys(f.wallet)).recovery)).id;
 assert.equal(f.store.get(id).state,'pending');
 f.store.db.prepare('DELETE FROM counters WHERE scope LIKE ?').run(`ipfs-owner:${f.store.owner(f.wallet)}:%`);
 const resumed=await f.run({pause:async()=>assert.fail('Pending recovery should resume immediately')});
 assert.equal(resumed.id,id);assert.equal(resumed.status,'published');assert.equal(f.writes.length,2);
});

test('temporary refusal resumes the same publication and reaches the wallet within one launch action',async t=>{
 const f=await fixture(t);f.refuseNext();let walletCalls=0,clock=0;
 await runLaunchFlow({artwork:()=>f.run(),quote:async artwork=>artwork,wallet:async artwork=>{assert.equal(artwork.status,'published');walletCalls++;},isCurrent:()=>true,onProgress:()=>{},now:()=>clock,pause:async ms=>{clock+=ms;}});
 assert.equal(walletCalls,1);assert.equal(f.writes.length,2);
 assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM ipfs_publications').get().n,1);
 assert.equal(f.requests.filter(x=>x==='launch-publish').length,2);
});

test('a wallet can publish beyond the former three-artwork limit',async t=>{
 const f=await fixture(t);
 f.store.budget.debit([[`ipfs-owner:${f.store.owner(f.wallet)}`,20,86400000]],3);
 assert.equal((await f.run()).status,'published');assert.equal(f.writes.length,2);
});

test('returning to a recent draft reuses its published id with only a status read',async t=>{
 const f=await fixture(t);const first=await f.run();
 const second=await f.run({draft:{name:'Sun',ticker:'SUN',description:''}});
 assert.notEqual(second.id,first.id);
 const before=f.requests.length;
 const restored=await f.run();
 assert.equal(restored.id,first.id);
 assert.deepEqual(f.requests.slice(before),['status']);
 assert.equal(f.writes.length,3); // One image, two metadata documents.
 assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM ipfs_publications').get().n,2);
});

test('cached artwork remains usable while a different draft is pending without erasing its recovery',async t=>{
 const f=await fixture(t);const first=await f.run();f.refuseNext();
 await assert.rejects(f.run({draft:{name:'Sun',ticker:'SUN',description:''}}),{code:'asset_busy'});
 const key=(await keys(f.wallet)).recovery, pending=f.records.get(key), before=f.requests.length;
 assert.equal((await f.run()).id,first.id);assert.equal(f.records.get(key),pending);
 assert.deepEqual(f.requests.slice(before),['status']);assert.equal(f.writes.length,2);
});

test('published history is bounded, expires after 24 hours, and excludes other wallets or malformed entries',async t=>{
 const f=await fixture(t);await f.run();
 const walletHash=await assetHash(new TextEncoder().encode(assetWallet(f.wallet)));
 const key=`fungun.artwork-history.v1:${walletHash}`;
 const entries=JSON.parse(f.records.get(key)), first=entries[0];
 const scoped={...f.storage,getItem:k=>f.storage.getItem(`${k}:${walletHash}`),setItem:(k,v)=>f.storage.setItem(`${k}:${walletHash}`,v)};
 const origin=first.ticket.appOrigin, now=first.savedAt;
 assert.equal(artworkHistory(scoped,origin,walletHash,now+ARTWORK_CACHE_TTL-1).length,1);
 assert.equal(artworkHistory(scoped,origin,walletHash,now+ARTWORK_CACHE_TTL).length,0);
 assert.equal(artworkHistory(scoped,origin,'f'.repeat(64),now).length,0);
 for(let i=0;i<25;i++)rememberArtwork(scoped,i.toString(16).padStart(64,'0'),{...first.ticket,id:i.toString(16).padStart(48,'0')},now+i);
 assert.equal(artworkHistory(scoped,origin,walletHash,now+25).length,20);
 assert.equal(f.records.get(key).includes('uploadToken'),false);
 f.records.set(key,JSON.stringify([{...first,ticket:{...first.ticket,uploadToken:'private'}}]));
 assert.equal(artworkHistory(scoped,origin,walletHash,now).length,0);
 f.records.set(key,'not json');assert.equal(artworkHistory(scoped,origin,walletHash,now).length,0);
});

test('switching wallets and refreshing keeps each publication separate and resumes without duplicate uploads',async t=>{
 const f=await fixture(t);const first=await f.run();
 const other=privateKeyToAccount(generatePrivateKey()).address;
 const second=await f.run({wallet:other,cached:first});
 assert.equal(second.status,'published');assert.notEqual(second.id,first.id);
 const before=f.requests.filter(x=>x==='launch-publish').length;
 // A fresh storage facade represents another page load, with only persisted data.
 const reloaded={...f.storage};
 assert.equal((await f.run({storage:reloaded})).id,first.id);
 assert.equal((await f.run({wallet:other,storage:reloaded})).id,second.id);
 assert.equal(f.requests.filter(x=>x==='launch-publish').length,before);
 assert.equal(f.writes.length,4);
 assert.ok(f.records.get((await keys(f.wallet)).recovery));
 assert.ok(f.records.get((await keys(other)).recovery));
 assert.equal(JSON.stringify([...f.records]).includes(other.toLowerCase()),false);
});

test('legacy artwork from another wallet does not block launch and remains recoverable for its owner',async t=>{
 const f=await fixture(t);const first=await f.run();await makeLegacy(f);
 const saved=f.records.get(recoveryKey),binding=f.records.get(bindingKey);
 const other=privateKeyToAccount(generatePrivateKey()).address;
 const second=await f.run({wallet:other,cached:first});
 assert.notEqual(second.id,first.id);assert.equal(second.status,'published');
 assert.equal(f.records.get(recoveryKey),saved);assert.equal(f.records.get(bindingKey),binding);
 assert.equal((await f.run()).id,first.id);
 assert.equal(f.requests.filter(x=>x==='launch-publish').length,2);
});

test('an uncertain legacy upload survives switching wallets and is only checked when its owner returns',async t=>{
 const f=await fixture(t);f.setDelayedChecks(30);
 await assert.rejects(f.run(),{code:'asset_publication_uncertain'});await makeLegacy(f);
 const firstId=JSON.parse(f.records.get(recoveryKey)).id;
 const other=privateKeyToAccount(generatePrivateKey()).address;f.setDelayedChecks(0);
 assert.equal((await f.run({wallet:other})).status,'published');
 assert.equal((await f.run()).id,firstId);
 assert.equal(f.requests.filter(x=>x==='launch-publish').length,2);assert.equal(f.writes.length,4);
});

test('failed legacy migration cannot discard the recovery or issue a new upload',async t=>{
 const f=await fixture(t);const first=await f.run();await makeLegacy(f);
 const original=f.records.get(recoveryKey),before=f.requests.length;
 await assert.rejects(f.run({storage:{...f.storage,setItem:()=>{throw new Error('Storage full');}}}));
 assert.equal(f.records.get(recoveryKey),original);assert.equal(f.requests.length,before);
 assert.equal((await f.run()).id,first.id);assert.equal(f.writes.length,2);
});
