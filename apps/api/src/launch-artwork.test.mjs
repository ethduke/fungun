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
  let loseResponse=false;
  const proxy=createAssetProxy(()=>({appOrigin:origin,serviceOrigin:'https://backend.example.com',publicOrigin:`https://${gateway}`,enabled:true,production:true}),async(url,options)=>{
    const kind=url.pathname.slice('/v1/asset-'.length); requests.push(kind);
    const input=validateAssetInput(kind,JSON.parse(options.body));
    if(kind==='launch-prepare')return Response.json({...await store.launchChallenge(input.wallet,image,input.draft),imageBase64:image.toString('base64'),width:8,height:8,serverTime:store.clock()});
    if(kind==='launch-publish'){
      assert.equal('signature' in JSON.parse(options.body),false);
      const result=await store.acceptLaunch(input);worker.kick();await worker.idle();
      if(loseResponse)throw new TypeError('Simulated response loss');
      return Response.json(result);
    }
    assert.equal(kind,'status');return Response.json(store.status(input));
  });
  const fetcher=(path,options)=>proxy(new Request(origin+path,{...options,headers:{...options.headers,origin}}),path.split('/').at(-1));
  const storage={getItem:key=>records.get(key)??null,setItem:(key,value)=>records.set(key,value),removeItem:key=>records.delete(key)};
  const run=(overrides={})=>ensureLaunchArtwork({bytes:image,wallet,draft,origin,storage,fetcher,isCurrent:()=>true,onProgress:()=>{},pause:async()=>worker.idle(),...overrides});
  return {run,store,wallet,image,draft,writes,requests,records,setLoseResponse:value=>{loseResponse=value;}};
}

test('one launch click publishes verified artwork with no wallet signature; subsequent clicks only read status',async t=>{
 const f=await fixture(t);const first=await f.run();assert.equal(first.status,'published');
 assert.equal(f.writes.length,2);assert.deepEqual(f.requests,['launch-prepare','launch-publish','status']);
 const serialized=JSON.stringify([...f.records.values()]);assert.equal(serialized.includes('uploadToken'),false);assert.equal(serialized.includes(f.wallet.toLowerCase()),false);
 const next=await f.run();assert.deepEqual(next,first);assert.equal(f.writes.length,2);assert.equal(f.requests.filter(x=>x==='launch-publish').length,1);
});

test('uncertain upload resumes through status and never repeats a write',async t=>{
 const f=await fixture(t);f.setLoseResponse(true);await assert.rejects(f.run(),{code:'asset_publication_uncertain'});
 f.setLoseResponse(false);assert.equal((await f.run()).status,'published');assert.equal(f.writes.length,2);assert.equal(f.requests.filter(x=>x==='launch-publish').length,1);
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
 await assert.rejects(f.store.acceptLaunch({id:approval.id,wallet:f.wallet,image:f.image,draft:f.draft,uploadToken:approval.uploadToken}),{code:'rate_limited'});
 assert.equal(f.store.get(approval.id).state,'pending');assert.equal(f.writes.length,0);
});
