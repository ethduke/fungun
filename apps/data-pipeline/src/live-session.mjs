import { mkdirSync, readFileSync, writeFileSync, existsSync, openSync, closeSync, unlinkSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { Pipeline, normalizeBlock } from './pipeline.mjs';
import { STREAM, uniqueLogs, logsInRange, findFirstBlock, analyze, digest, time } from './collect-snapshot.mjs';
import { PublicRpc, quantity, hex, hash, stop } from './public-rpc.mjs';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';

const safeCodes=new Set(['RPC_QUERY_REJECTED','RPC_HTTP_REJECTED','RPC_INVALID_RESPONSE','PUBLIC_RPC_UNAVAILABLE',
  'RPC_RESPONSE_TOO_LARGE','FINALIZED_SOURCE_CHANGED','RECEIPTS_INCOMPLETE','LOG_RECEIPT_CONFLICT','INVALID_WINDOW',
  'INVALID_QUANTITY','INVALID_HASH','INVALID_TRANSFER_LOG','WRONG_CHAIN','TOKEN_METADATA_MISMATCH','LIVE_SOURCE_STALE','DATABASE_SIZE_LIMIT','CONFLICTING_RPC_LOG']);
export const sessionCode=e=>safeCodes.has(e?.message)?e.message:'COLLECTION_FAILED';
export class LiveSession {
  constructor(directory,{rpc=new PublicRpc(STREAM.endpoints[0]),stream=STREAM,now=()=>new Date().toISOString(),progress=()=>{}}={}){
    this.directory=directory;this.rpc=rpc;this.stream=stream;this.now=now;this.progress=progress;
    mkdirSync(directory,{recursive:true});
    this.path=join(directory,'snapshot.sqlite');this.identity=digest(stream);
  }
  async header(height){
    const row=await this.rpc.call('eth_getBlockByNumber',[typeof height==='string'?height:hex(height),false]);
    if(!row||!Array.isArray(row.transactions))stop('INVALID_WINDOW');return row;
  }
  async initialize(){
    if(quantity(await this.rpc.call('eth_chainId'))!==this.stream.chainId)stop('WRONG_CHAIN');
    const head=await this.header('finalized'),tipTime=quantity(head.timestamp),tip=quantity(head.number);
    if(Math.abs(Date.parse(this.now())/1000-tipTime)>7200)stop('LIVE_SOURCE_STALE');
    const decimals=await this.rpc.call('eth_call',[{to:this.stream.token.address,data:'0x313ce567'},'latest']);
    if(!/^0x[0-9a-f]{64}$/i.test(decimals)||BigInt(decimals)!==BigInt(this.stream.token.decimals))stop('TOKEN_METADATA_MISMATCH');
    let saved;
    if(existsSync(join(this.directory,'session.json')))saved=JSON.parse(readFileSync(join(this.directory,'session.json'),'utf8'));
    if(saved&&saved.identity!==this.identity)stop('INVALID_WINDOW');
    const start=saved?.start ?? tipTime-900,first=saved?.first ?? await findFirstBlock(this.rpc,tip,start);
    // The initial 15-minute bootstrap gives a useful first snapshot; the bounded
    // capture then fills the remainder of this same fixed 24-hour window.
    this.meta=saved ?? {identity:this.identity,start,end:start+86400,first,startedAt:this.now(),status:'collecting',intervalMinutes:15,
      codeCommit:process.env.COLLECTOR_COMMIT??null};
    this.pipeline=new Pipeline(this.path,{chainId:this.stream.chainId,name:this.stream.name,startHeight:first,tokens:[this.stream.token]});
    const db=this.pipeline.db;
    db.exec(`CREATE TABLE IF NOT EXISTS live_batches (
      id INTEGER PRIMARY KEY, first_height INTEGER NOT NULL, last_height INTEGER NOT NULL,
      verified_at TEXT NOT NULL, event_count INTEGER NOT NULL, query_duplicates INTEGER NOT NULL,
      recovered_omissions INTEGER NOT NULL, capture_digest TEXT NOT NULL, UNIQUE(first_height,last_height)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS live_checks (
      id INTEGER PRIMARY KEY, checked_at TEXT NOT NULL, status TEXT NOT NULL, checkpoint INTEGER NOT NULL, code TEXT
    ) STRICT;
    CREATE TABLE IF NOT EXISTS snapshot_metadata (id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL) STRICT;`);
    const stored=db.prepare('SELECT payload FROM snapshot_metadata WHERE id=1').get();
    if(stored&&!isDeepStrictEqual(JSON.parse(stored.payload),this.meta))stop('INVALID_WINDOW');
    if(!this.pipeline.checkpoint()){
      const anchor=await this.header(first-1);
      if(quantity(anchor.timestamp)>start)stop('INVALID_WINDOW');
      db.prepare('INSERT INTO checkpoints VALUES (?,?,?,?)').run(this.stream.chainId,first,first-1,hash(anchor.hash));
    }
    db.prepare('INSERT OR REPLACE INTO snapshot_metadata VALUES (1,?)').run(JSON.stringify(this.meta));
    writeFileSync(join(this.directory,'session.json'),JSON.stringify(this.meta,null,2)+'\n');
    return this;
  }
  close(){this.pipeline?.close();}
  async tick(){
    const p=this.pipeline,db=p.db,checkpoint=p.checkpoint(),head=await this.header('finalized');
    const headTime=quantity(head.timestamp),headHeight=quantity(head.number);
    if(Math.abs(Date.parse(this.now())/1000-headTime)>7200)stop('LIVE_SOURCE_STALE');
    let target=headHeight;
    if(headTime>this.meta.end)target=(await findFirstBlock(this.rpc,headHeight,this.meta.end))-1;
    if(target<checkpoint.last_height)stop('FINALIZED_SOURCE_CHANGED');
    const previous=await this.header(checkpoint.last_height);
    const stored=checkpoint.last_height===p.startHeight-1?checkpoint.anchor_hash:p.readStored(db.prepare('SELECT block_hash FROM canonical_blocks WHERE chain_id=? AND height=?').get(p.chainId,checkpoint.last_height).block_hash).hash;
    if(hash(previous.hash)!==stored)stop('FINALIZED_SOURCE_CHANGED');
    let parent=stored;
    for(let first=checkpoint.last_height+1;first<=target;first+=250){
      const last=Math.min(first+249,target),heights=Array.from({length:last-first+1},(_,i)=>first+i);
      const query=await logsInRange(this.rpc,first,last,this.stream),headers=[],receipts=[];
      for(let i=0;i<heights.length;i+=25){
        const ids=heights.slice(i,i+25);
        headers.push(...await this.rpc.batch(ids.map(n=>({method:'eth_getBlockByNumber',params:[hex(n),false]}))));
        receipts.push(...await this.rpc.batch(ids.map(n=>({method:'eth_getBlockReceipts',params:[hex(n)]}))));
      }
      const receiptRows=[],blocks=[];
      for(let i=0;i<heights.length;i++){
        const height=heights[i],header=headers[i],blockReceipts=receipts[i];
        if(!header||quantity(header.number)!==height||hash(header.parentHash)!==parent||!Array.isArray(header.transactions)||
          !Array.isArray(blockReceipts)||blockReceipts.length!==header.transactions.length)stop('RECEIPTS_INCOMPLETE');
        const blockHash=hash(header.hash),timestamp=quantity(header.timestamp),seen=new Set(),blockLogs=[];
        if(timestamp<=this.meta.start||timestamp>this.meta.end)stop('INVALID_WINDOW');
        for(const receipt of blockReceipts){
          const index=quantity(receipt.transactionIndex);
          if(index>=header.transactions.length||seen.has(index)||hash(receipt.transactionHash)!==hash(header.transactions[index])||
            hash(receipt.blockHash)!==blockHash||quantity(receipt.blockNumber)!==height||![0,1].includes(quantity(receipt.status))||!Array.isArray(receipt.logs))stop('RECEIPTS_INCOMPLETE');
          seen.add(index);
          for(const log of receipt.logs)if(log.address?.toLowerCase()===this.stream.token.address&&log.topics?.[0]?.toLowerCase()===this.stream.transferTopic){
            if(quantity(log.transactionIndex)!==index||hash(log.transactionHash)!==hash(receipt.transactionHash)||quantity(log.blockNumber)!==height||hash(log.blockHash)!==blockHash)stop('RECEIPTS_INCOMPLETE');
            blockLogs.push(log);receiptRows.push(log);
          }
        }
        const events=uniqueLogs(blockLogs,this.stream).rows,txs=new Map();
        for(const event of events)txs.set(event.txHash,{hash:event.txHash,index:event.txIndex});
        blocks.push(normalizeBlock({chainId:p.chainId,height,hash:blockHash,parentHash:parent,timestamp,
          transactions:[...txs.values()],events},p.chainId,height));parent=blockHash;
      }
      const complete=uniqueLogs(receiptRows,this.stream),lookup=new Map(complete.rows.map(row=>[`${row.height}:${row.index}`,row]));
      for(const row of query.rows)if(!isDeepStrictEqual(lookup.get(`${row.height}:${row.index}`),row))stop('LOG_RECEIPT_CONFLICT');
      const omissions=complete.rows.length-query.rows.length;
      if(hash((await this.header(last)).hash)!==blocks.at(-1).hash)stop('FINALIZED_SOURCE_CHANGED');
      // Events, complete empty-block coverage, reconciliation evidence and cursor
      // commit together. A failed fetch never skips an unverified range.
      p.atomic(()=>{
        if(p.checkpoint().last_height!==first-1)stop('FINALIZED_SOURCE_CHANGED');
        for(const block of blocks)p.write(block);
        db.prepare('INSERT INTO live_batches(first_height,last_height,verified_at,event_count,query_duplicates,recovered_omissions,capture_digest) VALUES (?,?,?,?,?,?,?)')
          .run(first,last,this.now(),complete.rows.length,query.duplicates+complete.duplicates,omissions,digest(complete.rows));
        db.prepare('UPDATE checkpoints SET last_height=? WHERE chain_id=?').run(last,p.chainId);
      });
      if(!existsSync(join(this.directory,'snapshot-report.json')))this.exportReport();
      this.progress({phase:'verified_batch',blocks:last-first+1,events:complete.rows.length,duplicates:query.duplicates,omissionsRecovered:omissions});
      if(statSync(this.path).size>2*1024**3)stop('DATABASE_SIZE_LIMIT');
    }
    db.prepare('INSERT INTO live_checks(checked_at,status,checkpoint) VALUES (?,?,?)').run(this.now(),'verified',p.checkpoint().last_height);
    if(headTime>this.meta.end&&p.checkpoint().last_height===target){
      this.meta.status='complete';db.prepare('UPDATE snapshot_metadata SET payload=? WHERE id=1').run(JSON.stringify(this.meta));
      writeFileSync(join(this.directory,'session.json'),JSON.stringify(this.meta,null,2)+'\n');
    }
    return this.exportReport();
  }
  recordFailure(error){
    this.pipeline.db.prepare('INSERT INTO live_checks(checked_at,status,checkpoint,code) VALUES (?,?,?,?)')
      .run(this.now(),'failed',this.pipeline.checkpoint().last_height,sessionCode(error));
  }
  exportReport(){
    const p=this.pipeline,db=p.db,checkpoint=p.checkpoint(),tip=db.prepare('SELECT b.timestamp FROM blocks b JOIN canonical_blocks c ON c.chain_id=b.chain_id AND c.block_hash=b.hash WHERE c.chain_id=? AND c.height=?').get(p.chainId,checkpoint.last_height);
    if(!tip)stop('INVALID_WINDOW');
    const end=this.meta.status==='complete'?this.meta.end:Math.min(tip.timestamp,this.meta.end),a=analyze(p,this.meta.start,end,this.now());
    const batches=db.prepare('SELECT * FROM live_batches ORDER BY first_height').all();let next=p.startHeight;
    for(const batch of batches){if(batch.first_height!==next)stop('INVALID_WINDOW');next=batch.last_height+1;}
    const storedCount=db.prepare('SELECT count(*) AS n FROM canonical_blocks WHERE chain_id=?').get(p.chainId).n;
    const eventCount=db.prepare('SELECT count(*) AS n FROM canonical_transfers WHERE chain_id=?').get(p.chainId).n;
    const sourceProjection=db.prepare(`SELECT b.height,e.block_hash,e.log_index,e.tx_hash,x.tx_index,e.token_address,t.sender,t.recipient,t.amount_raw
      FROM event_logs e JOIN blocks b ON b.chain_id=e.chain_id AND b.hash=e.block_hash
      JOIN transactions x ON x.chain_id=e.chain_id AND x.block_hash=e.block_hash AND x.tx_hash=e.tx_hash
      JOIN transfers t USING(chain_id,block_hash,log_index) WHERE e.chain_id=? AND b.height BETWEEN ? AND ? ORDER BY b.height,e.log_index`);
    const projection=eventCount===batches.reduce((sum,b)=>sum+b.event_count,0)&&a.transfers===eventCount&&batches.every(batch=>{
      const rows=sourceProjection.all(p.chainId,batch.first_height,batch.last_height).map(r=>({height:r.height,blockHash:r.block_hash,index:r.log_index,
        txHash:r.tx_hash,txIndex:r.tx_index,token:r.token_address,sender:r.sender,recipient:r.recipient,amountRaw:r.amount_raw}));
      return digest(rows)===batch.capture_digest;
    });
    const brokenParents=db.prepare(`SELECT count(*) AS n FROM blocks b JOIN canonical_blocks c ON c.chain_id=b.chain_id AND c.block_hash=b.hash
      LEFT JOIN canonical_blocks prev ON prev.chain_id=c.chain_id AND prev.height=c.height-1
      WHERE c.chain_id=? AND c.height>? AND (prev.block_hash IS NULL OR b.parent_hash!=prev.block_hash)`).get(p.chainId,p.startHeight).n;
    const errors=db.prepare('PRAGMA foreign_key_check').all().length,integrity=db.prepare('PRAGMA integrity_check').all().every(r=>r.integrity_check==='ok');
    const checks=[['No skipped block heights',next===checkpoint.last_height+1&&storedCount===checkpoint.last_height-p.startHeight+1],
      ['Every block receipt matches its transaction list',true],['All receipt events stored exactly once',projection],
      ['Finalized block hashes and parents verified',brokenParents===0],['Foreign keys and SQLite integrity',errors===0&&integrity],
      ['Exact integer totals reconcile to hourly analysis',String(a.hours.reduce((sum,h)=>sum+BigInt(h.amountRaw),0n))===a.amountRaw],
      ['Checkpoint matches last verified batch',batches.at(-1)?.last_height===checkpoint.last_height]]
      .map(([name,passed])=>({name,passed}));
    if(checks.some(c=>!c.passed))stop('INVALID_WINDOW');
    const failures=db.prepare("SELECT count(*) AS n FROM live_checks WHERE status='failed'").get().n;
    const totals=batches.reduce((v,b)=>({duplicates:v.duplicates+b.query_duplicates,omissions:v.omissions+b.recovered_omissions}),{duplicates:0,omissions:0});
    const report={schemaVersion:1,kind:'chain-snapshot',chain:this.stream.name,chainId:p.chainId,symbol:this.stream.token.symbol,
      decimals:this.stream.token.decimals,finality:'finalized',healthy:true,analysis:a,checks,sources:this.stream.endpoints.map(s=>new URL(s).hostname),
      session:{status:this.meta.status,targetEnd:time(this.meta.end),intervalMinutes:15,capturedSeconds:end-this.meta.start,targetSeconds:86400},
      duplicatesIgnored:totals.duplicates,missingEventsRecovered:totals.omissions,failedChecks:failures,
      verifiedIntervals:db.prepare("SELECT count(*) AS n FROM live_checks WHERE status='verified'").get().n,
      blockHashDigest:digest(db.prepare('SELECT block_hash FROM canonical_blocks WHERE chain_id=? ORDER BY height').all(p.chainId).map(row=>row.block_hash)),captureDigest:digest(batches.map(b=>({first:b.first_height,last:b.last_height,digest:b.capture_digest}))),
      collectorCommit:this.meta.codeCommit,
      scope:'Canonical USDG Transfer events on Robinhood Chain; every block and receipt in the captured range is checked.',
      verification:'One public RPC: log queries are reconciled against complete block receipts and transaction membership. Shared provider errors are not independently ruled out.'};
    db.exec('PRAGMA wal_checkpoint(PASSIVE)');
    // Logical evidence digest is stable while the collector continues to append.
    // A physical SQLite digest is exported only with a checkpointed frozen copy.
    const frozen=join(this.directory,'frozen.sqlite');
    if(existsSync(frozen))unlinkSync(frozen);
    db.prepare('VACUUM INTO ?').run(frozen);
    report.databaseSha256=createHash('sha256').update(readFileSync(frozen)).digest('hex');
    writeFileSync(join(this.directory,'snapshot-report.json'),JSON.stringify(report,null,2)+'\n');
    return report;
  }
}

export async function runSession(directory,{once=false,resume=false,...options}={}){
  mkdirSync(directory,{recursive:true});const lock=join(directory,'collector.lock');
  if(existsSync(lock)){
    const pid=Number(readFileSync(lock,'utf8'));let alive=false;try{process.kill(pid,0);alive=true;}catch{ /* stale lock from this collector */ }
    if(alive||!resume)stop('SESSION_ALREADY_RUNNING');unlinkSync(lock);
  }
  const fd=openSync(lock,'wx');writeFileSync(fd,String(process.pid));closeSync(fd);
  const session=new LiveSession(directory,options);
  try{
    if(existsSync(join(directory,'session.json'))&&!resume)stop('EXISTING_SESSION_REQUIRES_RESUME');
    await session.initialize();let report;
    const deadline=Date.parse(session.meta.startedAt)+26*3600000;
    do{
      const checkStarted=Date.now();
      try{report=await session.tick();session.progress({phase:'snapshot_saved',status:session.meta.status,events:report.analysis.transfers,capturedSeconds:report.session.capturedSeconds});}
      catch(error){session.recordFailure(error);session.progress({phase:'check_failed',code:sessionCode(error)});if(once)throw error;}
      if(once||session.meta.status==='complete')break;
      if(Date.now()>deadline)stop('SESSION_DEADLINE_EXCEEDED');
      await pause(Math.max(1000,15*60000-(Date.now()-checkStarted)));
    }while(session.meta.status!=='complete');
    return report;
  }finally{session.close();unlinkSync(lock);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{const args=process.argv.slice(2),out=args.indexOf('--out');
    if(out<0||!args[out+1]||args.some((s,i)=>i!==out+1&&!['--out','--once','--resume'].includes(s)))stop('INVALID_ARGUMENTS');
    await runSession(resolve(args[out+1]),{once:args.includes('--once'),resume:args.includes('--resume'),progress:value=>console.log(JSON.stringify(value))});
  }catch(error){console.error(JSON.stringify({status:'stopped',code:sessionCode(error)}));process.exitCode=1;}
}
