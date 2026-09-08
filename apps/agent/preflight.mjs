import { keccak256, parseTransaction, decodeFunctionResult, zeroAddress } from 'viem';
import { buildUnsignedLongLaunch, readLongLaunchProfile, LONG_CREATE_ABI } from '../web/lib/long-encoding/long-launch.mjs';
import { isCanonicalLongAsset } from '../web/lib/long-encoding/long-salt.mjs';
const same = (a,b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const check = (ok, code = 'launch_transaction_changed') => { if (!ok) throw new Error(code); };
export async function preflight(plan, input, published, trustedProfile, rpc, limits) {
  const trusted = readLongLaunchProfile(trustedProfile);
  const profile=readLongLaunchProfile({...trusted,quotes:trusted.quotes.filter(q=>q.id===input.pairId)});
  check(input.chainId === 4663 && plan.chainId === 4663 && input.pairId.startsWith('long-'));
  check(JSON.stringify(readLongLaunchProfile(plan.profile)) === JSON.stringify(profile), 'contract_unverified');
  check(Number.isSafeInteger(plan.expiresAt) && Date.now() < plan.expiresAt && plan.expiresAt - plan.quotedAt === 30000, 'quote_expired');
  check(/^[a-f0-9]{64}$/.test(plan.id) && /^[a-f0-9]{64}$/.test(plan.binding));
  const rebuilt = buildUnsignedLongLaunch({ chainId:input.chainId,wallet:input.wallet,draft:input.draft,pairId:input.pairId, metadataUri: `ipfs://${published.ipfs.metadataCid}`, startingTick: plan.startingTick, intentId: plan.intentId }, profile, undefined, plan.saltAttempt);
  const tx = plan.transaction;
  check(isCanonicalLongAsset(plan.predictedAsset));
  check(BigInt(tx.nonce)>=0n&&BigInt(tx.nonce)<=BigInt(Number.MAX_SAFE_INTEGER),'nonce_limit');
  check(rebuilt.binding === plan.binding && same(rebuilt.predictedAsset, plan.predictedAsset));
  check(Object.keys(tx).sort().join(',') === 'chainId,data,from,gas,gasPrice,nonce,to,value');
  check(tx.chainId === '0x1237' && same(tx.from,input.wallet) && same(tx.to,rebuilt.transaction.to) && tx.data === rebuilt.transaction.data && BigInt(tx.value) === BigInt(rebuilt.transaction.value));
  const gas=BigInt(tx.gas), price=BigInt(tx.gasPrice), value=BigInt(tx.value), cost=gas*price+value;
  check(gas >= 21000n && gas <= BigInt(limits.maxGas) && gas === (BigInt(plan.estimatedGas)*120n+99n)/100n && price > 0n && price <= BigInt(limits.maxGasPriceWei) && cost <= BigInt(limits.maxTransactionWei) && plan.maximumGasWei === String(gas*price) && value === 0n,'spend_limit');
  const request=(method,params=[])=>rpc.request({method,params});
  check(BigInt(await request('eth_chainId'))===4663n,'wrong_chain');
  for (const contract of [...['launcher','airlock','tokenFactory','governanceFactory','poolInitializer','liquidityMigrator','dopplerHook'].map(k=>profile[k]), ...profile.quotes.filter(q=>q.id===input.pairId).flatMap(q=>[q.token,...(q.oracle?[q.oracle]:[])])]) {
    const code=await request('eth_getCode',[contract.address,'latest']);
    check(code && code!=='0x' && same(keccak256(code),contract.codeHash),'contract_unverified');
  }
  check(BigInt(await request('eth_getTransactionCount',[input.wallet,'pending']))===BigInt(tx.nonce),'nonce_changed');
  check(BigInt(await request('eth_getBalance',[input.wallet,'pending']))>=cost,'insufficient_funds');
  const simulated=decodeFunctionResult({abi:LONG_CREATE_ABI,functionName:'create',data:await request('eth_call',[tx,'pending'])});
  check(same(simulated[0],rebuilt.predictedAsset)&&!same(simulated[1],zeroAddress)&&same(simulated[1],plan.predictedPool),'launch_simulation_failed');
  check(Date.now()<plan.expiresAt,'quote_expired');
  return cost;
}
export function validateSigned(raw, tx) {
  const signed=parseTransaction(raw);
  check(signed.chainId===4663 && same(signed.to,tx.to) && signed.data===tx.data && (signed.value??0n)===BigInt(tx.value) && signed.gas===BigInt(tx.gas) && signed.gasPrice===BigInt(tx.gasPrice) && BigInt(signed.nonce??0)===BigInt(tx.nonce));
  return keccak256(raw);
}
