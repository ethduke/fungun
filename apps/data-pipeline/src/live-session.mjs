import { mkdirSync, readFileSync, writeFileSync, existsSync, openSync, closeSync, unlinkSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { STREAM, uniqueLogs, logsInRange, findFirstBlock, digest, time } from './collect-snapshot.mjs';
import { PublicRpc, quantity, hex, hash, stop } from './public-rpc.mjs';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';

const safeCodes=new Set(['RPC_QUERY_REJECTED','RPC_HTTP_REJECTED','RPC_INVALID_RESPONSE','PUBLIC_RPC_UNAVAILABLE',
 'RPC_RESPONSE_TOO_LARGE','FINALIZED_SOURCE_CHANGED','RECEIPTS_INCOMPLETE','LOG_RECEIPT_CONFLICT','INVALID_WINDOW',
 'WRONG_CHAIN','TOKEN_METADATA_MISMATCH','LIVE_SOURCE_STALE','CONFLICTING_RPC_LOG']);
export const sessionCode=e=>safeCodes.has(e?.message)?e.message:'COLLECTION_FAILED';
export class LiveSession {
 constructor(directory,{rpc=new PublicRpc(STREAM.endpoints[0]),stream=STREAM,now=()=>new Date().toISOString(),progress=()=>{}}={}){
  this.directory=directory;this.rpc=rpc;this.stream=stream;this.now=now;this.progress=progress;mkdirSync(directory,{recursive:true});
  this.path=join(directory,'snapshot.sqlite');this.identity=digest({...stream,mode:'range-replay-receipt-samples-v1'});
 }
 async header(height){const row=await this.rpc.call('eth_getBlockByNumber',[typeof height==='string'?height:hex(height),false]);
  if(!row||!Array.isArray(row.transactions))stop('INVALID_WINDOW');return row;}
 async initialize(){
  if(quantity(await this.rpc.call('eth_chainId'))!==this.stream.chainId)stop('WRONG_CHAIN');
  const head=await this.header('finalized'),tipTime=quantity(head.timestamp),tip=quantity(head.number);
  if(Math.abs(Date.parse(this.now())/1000-tipTime)>7200)stop('LIVE_SOURCE_STALE');
  const decimals=await this.rpc.call('eth_call',[{to:this.stream.token.address,data:'0x313ce567'},'latest']);
  if(!/^0x[0-9a-f]{64}$/i.test(decimals)||BigInt(decimals)!==BigInt(this.stream.token.decimals))stop('TOKEN_METADATA_MISMATCH');
  const saved=existsSync(join(this.directory,'session.json'))?JSON.parse(readFileSync(join(this.directory,'session.json'),'utf8')):null;
  if(saved&&saved.identity!==this.identity)stop('INVALID_WINDOW');
  const start=saved?.start??tipTime-900,first=saved?.first??await findFirstBlock(this.rpc,tip,start);
  this.meta=saved??{identity:this.identity,start,end:start+86400,first,startedAt:this.now(),status:'collecting',intervalMinutes:15,codeCommit:process.env.COLLECTOR_COMMIT??null};
  this.db=new DatabaseSync(this.path);this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000');
  if(!saved){this.db.exec(readFileSync(new URL('../snapshot-schema.sql',import.meta.url),'utf8'));
   const anchor=await this.header(first-1);if(quantity(anchor.timestamp)>start)stop('INVALID_WINDOW');
   this.db.prepare('INSERT INTO chains VALUES (?,?)').run(this.stream.chainId,this.stream.name);
   this.db.prepare('INSERT INTO tokens VALUES (?,?,?,?)').run(this.stream.chainId,this.stream.token.address,this.stream.token.symbol,this.stream.token.decimals);
   this.db.prepare('INSERT INTO checkpoints VALUES (?,?,?,?)').run(this.stream.chainId,first,first-1,hash(anchor.hash));
   this.db.prepare('INSERT INTO snapshot_metadata VALUES (1,?)').run(JSON.stringify(this.meta));
   writeFileSync(join(this.directory,'session.json'),JSON.stringify(this.meta,null,2)+'\n');
  }else{this.db.exec('PRAGMA foreign_keys=ON');const stored=this.db.prepare('SELECT payload FROM snapshot_metadata WHERE id=1').get();
   if(!stored||!isDeepStrictEqual(JSON.parse(stored.payload),this.meta))stop('INVALID_WINDOW');}
  this.pipeline={db:this.db,chainId:this.stream.chainId,startHeight:first,checkpoint:()=>this.checkpoint(),canonical:()=>this.db.prepare('SELECT * FROM canonical_blocks ORDER BY height').all()};
  return this;
 }
 checkpoint(){return this.db.prepare('SELECT * FROM checkpoints WHERE chain_id=?').get(this.stream.chainId);}
 close(){this.db?.close();this.db=null;}
 storedRows(first,last){return this.db.prepare(`SELECT b.height,e.block_hash,e.log_index,e.tx_hash,x.tx_index,e.token_address,t.sender,t.recipient,t.amount_raw,h.hour
  FROM event_logs e JOIN blocks b ON b.chain_id=e.chain_id AND b.hash=e.block_hash
  JOIN transactions x ON x.chain_id=e.chain_id AND x.block_hash=e.block_hash AND x.tx_hash=e.tx_hash
  JOIN transfers t USING(chain_id,block_hash,log_index) JOIN event_hours h USING(chain_id,block_hash,log_index)
  WHERE e.chain_id=? AND b.height BETWEEN ? AND ? ORDER BY b.height,e.log_index`).all(this.stream.chainId,first,last);}
 async tick(){
  const cp=this.checkpoint(),head=await this.header('finalized'),headTime=quantity(head.timestamp),headHeight=quantity(head.number);
  if(Math.abs(Date.parse(this.now())/1000-headTime)>7200)stop('LIVE_SOURCE_STALE');
  const target=headTime>this.meta.end?(await findFirstBlock(this.rpc,headHeight,this.meta.end))-1:headHeight;
  if(target<cp.last_height)stop('FINALIZED_SOURCE_CHANGED');
  const prior=await this.header(cp.last_height),expected=this.db.prepare('SELECT last_hash FROM live_batches ORDER BY last_height DESC LIMIT 1').get()?.last_hash??cp.anchor_hash;
  if(hash(prior.hash)!==expected)stop('FINALIZED_SOURCE_CHANGED');
  for(let first=cp.last_height+1;first<=target;){
   const firstHeader=await this.header(first),hour=Math.floor((quantity(firstHeader.timestamp)-this.meta.start-1)/3600);
   if(hour<0||hour>23)stop('INVALID_WINDOW');
   let last=Math.min(first+1999,target),endHeader=await this.header(last);
   if(quantity(endHeader.timestamp)>this.meta.start+(hour+1)*3600){last=(await findFirstBlock(this.rpc,last,this.meta.start+(hour+1)*3600))-1;endHeader=await this.header(last);}
   const a=await logsInRange(this.rpc,first,last,this.stream),b=await logsInRange(this.rpc,first,last,this.stream);
   const merged=new Map();let recovered=0;
   for(const row of [...a.rows,...b.rows]){const key=`${row.height}:${row.index}`,old=merged.get(key);if(old&&!isDeepStrictEqual(old,row))stop('LOG_RECEIPT_CONFLICT');merged.set(key,row);}
   if(!isDeepStrictEqual(a.rows,b.rows)){
    const replay=await logsInRange(this.rpc,first,last,this.stream),union=[...merged.values()].sort((a,b)=>a.height-b.height||a.index-b.index);
    if(!isDeepStrictEqual(replay.rows,union))stop('LOG_RECEIPT_CONFLICT');recovered=union.length-Math.min(a.rows.length,b.rows.length);
   }
   const sampleHeights=[...new Set([Math.floor((first+last)/2),[...merged.values()][0]?.height].filter(Number.isInteger))],headers=new Map([[first,firstHeader],[last,endHeader]]);
   for(const height of sampleHeights){
    const header=headers.get(height)??await this.header(height),receipts=await this.rpc.call('eth_getBlockReceipts',[hex(height)]);headers.set(height,header);
    if(!Array.isArray(receipts)||receipts.length!==header.transactions.length)stop('RECEIPTS_INCOMPLETE');
    const seen=new Set(),raw=[];
    for(const receipt of receipts){const index=quantity(receipt.transactionIndex);
     if(index>=header.transactions.length||seen.has(index)||hash(receipt.transactionHash)!==hash(header.transactions[index])||hash(receipt.blockHash)!==hash(header.hash)||
       quantity(receipt.blockNumber)!==height||!Array.isArray(receipt.logs))stop('RECEIPTS_INCOMPLETE');seen.add(index);
     for(const log of receipt.logs)if(log.address?.toLowerCase()===this.stream.token.address&&log.topics?.[0]?.toLowerCase()===this.stream.transferTopic){
      if(quantity(log.transactionIndex)!==index||hash(log.transactionHash)!==hash(receipt.transactionHash)||quantity(log.blockNumber)!==height||hash(log.blockHash)!==hash(header.hash))stop('RECEIPTS_INCOMPLETE');raw.push(log);}
    }
    const verified=uniqueLogs(raw,this.stream).rows,lookup=new Map(verified.map(row=>[`${row.height}:${row.index}`,row]));
    for(const row of merged.values())if(row.height===height&&!isDeepStrictEqual(lookup.get(`${height}:${row.index}`),row))stop('LOG_RECEIPT_CONFLICT');
    for(const row of verified){const key=`${height}:${row.index}`;if(!merged.has(key)){merged.set(key,row);recovered++;}}
   }
   if(hash((await this.header(last)).hash)!==hash(endHeader.hash))stop('FINALIZED_SOURCE_CHANGED');
   const events=[...merged.values()].sort((a,b)=>a.height-b.height||a.index-b.index),chain=this.stream.chainId;
   this.db.exec('BEGIN IMMEDIATE');try{
    if(this.checkpoint().last_height!==first-1)stop('FINALIZED_SOURCE_CHANGED');
    const block=(height,blockHash,header)=>{
     this.db.prepare('INSERT OR IGNORE INTO blocks VALUES (?,?,?,?,?,?)').run(chain,blockHash,height,header?hash(header.parentHash):null,header?quantity(header.timestamp):null,null);
     this.db.prepare('INSERT OR IGNORE INTO canonical_blocks VALUES (?,?,?)').run(chain,height,blockHash);
     const existing=this.db.prepare('SELECT block_hash FROM canonical_blocks WHERE chain_id=? AND height=?').get(chain,height);if(existing.block_hash!==blockHash)stop('FINALIZED_SOURCE_CHANGED');
    };
    for(const [height,header]of headers)block(height,hash(header.hash),header);
    for(const row of events){block(row.height,row.blockHash,headers.get(row.height));
     this.db.prepare('INSERT OR IGNORE INTO transactions VALUES (?,?,?,?)').run(chain,row.blockHash,row.txHash,row.txIndex);
     this.db.prepare('INSERT INTO event_logs VALUES (?,?,?,?,?)').run(chain,row.blockHash,row.index,row.txHash,row.token);
     this.db.prepare('INSERT INTO transfers VALUES (?,?,?,?,?,?)').run(chain,row.blockHash,row.index,row.sender,row.recipient,row.amountRaw);
     this.db.prepare('INSERT INTO event_hours VALUES (?,?,?,?)').run(chain,row.blockHash,row.index,hour);
    }
    this.db.prepare('INSERT INTO live_batches(first_height,last_height,last_hash,verified_at,event_count,query_duplicates,recovered_omissions,capture_digest,hour,sampled_blocks) VALUES (?,?,?,?,?,?,?,?,?,?)')
     .run(first,last,hash(endHeader.hash),this.now(),events.length,a.duplicates+b.duplicates,recovered,digest(events),hour,sampleHeights.length);
    this.db.prepare('UPDATE checkpoints SET last_height=? WHERE chain_id=?').run(last,chain);this.db.exec('COMMIT');
   }catch(error){this.db.exec('ROLLBACK');throw error;}
   if(!existsSync(join(this.directory,'snapshot-report.json')))this.exportReport();
   this.progress({phase:'verified_range',blockHeights:last-first+1,events:events.length,sampledBlocks:sampleHeights.length,duplicates:a.duplicates+b.duplicates,omissionsRecovered:recovered});first=last+1;
   if(statSync(this.path).size>2*1024**3)stop('DATABASE_SIZE_LIMIT');
  }
  this.db.prepare('INSERT INTO live_checks(checked_at,status,checkpoint) VALUES (?,?,?)').run(this.now(),'verified',this.checkpoint().last_height);
  if(headTime>this.meta.end&&this.checkpoint().last_height===target){this.meta.status='complete';this.db.prepare('UPDATE snapshot_metadata SET payload=? WHERE id=1').run(JSON.stringify(this.meta));writeFileSync(join(this.directory,'session.json'),JSON.stringify(this.meta,null,2)+'\n');}
  return this.exportReport();
 }
 recordFailure(error){this.db.prepare('INSERT INTO live_checks(checked_at,status,checkpoint,code) VALUES (?,?,?,?)').run(this.now(),'failed',this.checkpoint().last_height,sessionCode(error));}
 exportReport(){
  const cp=this.checkpoint(),db=this.db,chain=this.stream.chainId,batches=db.prepare('SELECT * FROM live_batches ORDER BY first_height').all();if(!batches.length)stop('INVALID_WINDOW');
  let next=this.meta.first,projection=true;const all=[];
  for(const batch of batches){if(batch.first_height!==next)stop('INVALID_WINDOW');next=batch.last_height+1;
   const rows=this.storedRows(batch.first_height,batch.last_height);if(rows.some(r=>r.hour!==batch.hour))projection=false;
   const source=rows.map(r=>({height:r.height,blockHash:r.block_hash,index:r.log_index,txHash:r.tx_hash,txIndex:r.tx_index,token:r.token_address,sender:r.sender,recipient:r.recipient,amountRaw:r.amount_raw}));
   if(digest(source)!==batch.capture_digest)projection=false;all.push(...rows);
  }
  const endHeader=db.prepare('SELECT timestamp FROM blocks WHERE chain_id=? AND hash=?').get(chain,batches.at(-1).last_hash),end=this.meta.status==='complete'?this.meta.end:endHeader.timestamp;
  const hours=Array.from({length:24},(_,i)=>({start:time(this.meta.start+i*3600),end:time(this.meta.start+(i+1)*3600),observed:this.meta.start+i*3600<end,transfers:0,amountRaw:'0'}));
  const addresses=new Set(),transactions=new Set(),amounts=[];let total=0n;
  for(const row of all){const n=BigInt(row.amount_raw);hours[row.hour].transfers++;hours[row.hour].amountRaw=String(BigInt(hours[row.hour].amountRaw)+n);total+=n;amounts.push(n);transactions.add(row.tx_hash);for(const address of [row.sender,row.recipient])if(BigInt(address)!==0n)addresses.add(address);}
  amounts.sort((a,b)=>a<b?-1:a>b?1:0);const mid=Math.floor(amounts.length/2),median=!amounts.length?0n:amounts.length%2?amounts[mid]:(amounts[mid-1]+amounts[mid])/2n;
  const analysis={capturedAt:this.now(),start:time(this.meta.start),end:time(end),startHeight:this.meta.first,endHeight:cp.last_height,blocks:cp.last_height-this.meta.first+1,
   transfers:all.length,transactions:transactions.size,activeAddresses:addresses.size,amountRaw:String(total),medianRaw:String(median),largestRaw:String(amounts.at(-1)??0n),hours,peakHour:hours.reduce((a,b)=>b.transfers>a.transfers?b:a).start};
  const checks=[['No skipped queried block ranges',next===cp.last_height+1],['Repeated log queries reconciled',true],['Unique events and SQL projection match capture',projection],
   ['Sampled block receipts and transactions verified',true],['Foreign keys and SQLite integrity',db.prepare('PRAGMA foreign_key_check').all().length===0&&db.prepare('PRAGMA integrity_check').all().every(r=>r.integrity_check==='ok')],
   ['Exact integer totals match hourly buckets',String(hours.reduce((sum,h)=>sum+BigInt(h.amountRaw),0n))===analysis.amountRaw],['Checkpoint matches last verified query range',batches.at(-1).last_height===cp.last_height]].map(([name,passed])=>({name,passed}));
  if(checks.some(c=>!c.passed))stop('INVALID_WINDOW');
  const report={schemaVersion:1,kind:'chain-snapshot',chain:this.stream.name,chainId:chain,symbol:this.stream.token.symbol,decimals:this.stream.token.decimals,finality:'finalized',healthy:true,analysis,checks,
   sources:this.stream.endpoints.map(s=>new URL(s).hostname),session:{status:this.meta.status,targetEnd:time(this.meta.end),intervalMinutes:15,capturedSeconds:end-this.meta.start,targetSeconds:86400},
   duplicatesIgnored:batches.reduce((s,b)=>s+b.query_duplicates,0),missingEventsRecovered:batches.reduce((s,b)=>s+b.recovered_omissions,0),receiptBlocksVerified:batches.reduce((s,b)=>s+b.sampled_blocks,0),
   failedChecks:db.prepare("SELECT count(*) AS n FROM live_checks WHERE status='failed'").get().n,verifiedIntervals:db.prepare("SELECT count(*) AS n FROM live_checks WHERE status='verified'").get().n,
   blockHashDigest:digest(db.prepare('SELECT block_hash FROM canonical_blocks ORDER BY height').all().map(r=>r.block_hash)),captureDigest:digest(batches.map(b=>b.capture_digest)),collectorCommit:this.meta.codeCommit,
   scope:'Canonical USDG Transfer stream on Robinhood Chain; complete query-range coverage with sampled receipt audits.',
   verification:'One public RPC: every event range is re-read and selected block receipts are audited. Consistent provider omissions outside sampled blocks are not ruled out; block headers are stored only where observed or sampled.'};
  const frozen=join(this.directory,'frozen.sqlite');if(existsSync(frozen))unlinkSync(frozen);db.prepare('VACUUM INTO ?').run(frozen);report.databaseSha256=createHash('sha256').update(readFileSync(frozen)).digest('hex');
  writeFileSync(join(this.directory,'snapshot-report.json'),JSON.stringify(report,null,2)+'\n');return report;
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
