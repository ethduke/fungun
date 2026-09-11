import { decodeFunctionResult, encodeFunctionData, isAddress, keccak256, parseAbi, zeroAddress } from 'viem';
import { buildUnsignedLongLaunch, readLongLaunchProfile, LONG_CREATE_ABI } from '../web/lib/long-encoding/long-launch.mjs';
import { isCanonicalLongAsset, LONG_SALT_ATTEMPTS } from '../web/lib/long-encoding/long-salt.mjs';
export const LONGBOW_STATE_ABI = parseAbi([
  'function AIRLOCK() view returns (address)',
  'function TRUSTED_TOKEN_FACTORY() view returns (address)',
  'function RESERVATION_DURATION() view returns (uint48)',
  'function paused() view returns (bool)',
  'function isTickerAvailable(string) view returns (bool)',
  'function getModuleState(address) view returns (uint8)',
  'function decimals() view returns (uint8)',
]);
export const LONGBOW_ROLES = ['launcher', 'airlock', 'tokenFactory', 'governanceFactory', 'poolInitializer', 'liquidityMigrator', 'dopplerHook'];
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const check = (ok, code = 'launch_transaction_changed') => { if (!ok) throw new Error(code); };
export async function preflightLongbow(plan, input, published, trustedProfile, rpc, limits) {
  check(trustedProfile?.launchpad === 'longbow', 'contract_unverified');
  const trusted = readLongLaunchProfile(trustedProfile);
  check(input.chainId === 4663 && plan.chainId === 4663 && input.draft?.launchpad === 'longbow' && /^longbow-[A-Z0-9._-]{1,24}$/.test(input.pairId));
  const profile = readLongLaunchProfile({ ...trusted, quotes: trusted.quotes.filter(q => q.id === input.pairId) });
  check(JSON.stringify(readLongLaunchProfile(plan.profile)) === JSON.stringify(profile), 'contract_unverified');
  check(Number.isSafeInteger(plan.quotedAt) && Number.isSafeInteger(plan.expiresAt) && plan.quotedAt <= Date.now() && Date.now() < plan.expiresAt && plan.expiresAt - plan.quotedAt === 30000, 'quote_expired');
  check(/^[a-f0-9]{64}$/.test(plan.id) && /^[a-f0-9]{64}$/.test(plan.binding));
  check(plan.intentId === `${plan.id.slice(0,8)}-${plan.id.slice(8,12)}-${plan.id.slice(12,16)}-${plan.id.slice(16,20)}-${plan.id.slice(20,32)}` && Number.isInteger(plan.saltAttempt) && plan.saltAttempt >= 0 && plan.saltAttempt < LONG_SALT_ATTEMPTS);
  const rebuilt = buildUnsignedLongLaunch({ chainId: input.chainId, wallet: input.wallet, draft: input.draft, pairId: input.pairId,
    metadataUri: `ipfs://${published.ipfs.metadataCid}`, startingTick: plan.startingTick, intentId: plan.intentId }, profile, undefined, plan.saltAttempt);
  check(isCanonicalLongAsset(plan.predictedAsset) && rebuilt.binding === plan.binding && same(rebuilt.predictedAsset, plan.predictedAsset) && JSON.stringify(rebuilt.review) === JSON.stringify(plan.review));
  const tx = plan.transaction;
  check(tx && Object.keys(tx).sort().join(',') === 'chainId,data,from,gas,gasPrice,nonce,to,value');
  check(tx.chainId === '0x1237' && same(tx.from, input.wallet) && same(tx.to, rebuilt.transaction.to) && tx.data === rebuilt.transaction.data &&
    [tx.gas, tx.gasPrice, tx.nonce, tx.value].every(v => typeof v === 'string' && /^0x[0-9a-f]{1,64}$/i.test(v)) && BigInt(tx.value) === 0n && plan.launchpadFeeWei === '0');
  const nonce = BigInt(tx.nonce), gas = BigInt(tx.gas), price = BigInt(tx.gasPrice), cost = gas * price;
  check(nonce <= BigInt(Number.MAX_SAFE_INTEGER), 'nonce_limit');
  check(typeof plan.estimatedGas === 'string' && /^[1-9][0-9]{0,15}$/.test(plan.estimatedGas) && BigInt(plan.estimatedGas) >= 21000n &&
    gas === (BigInt(plan.estimatedGas) * 120n + 99n) / 100n && gas <= 3000000n && gas <= BigInt(limits.maxGas) && price > 0n && price <= 10n ** 12n &&
    price <= BigInt(limits.maxGasPriceWei) && cost <= BigInt(limits.maxTransactionWei) && cost <= 5n * 10n ** 16n && plan.maximumGasWei === String(cost), 'spend_limit');
  const request = (method, params = []) => rpc.request({ method, params });
  const call = async (to, functionName, args = []) => decodeFunctionResult({ abi: LONGBOW_STATE_ABI, functionName,
    data: await request('eth_call', [{ to, data: encodeFunctionData({ abi: LONGBOW_STATE_ABI, functionName, args }) }, 'latest']) });
  check(BigInt(await request('eth_chainId')) === 4663n, 'wrong_chain');
  const q = profile.quotes[0];
  for (const c of [...LONGBOW_ROLES.map(r => profile[r]), q.token, ...(q.oracle ? [q.oracle] : [])]) {
    const code = await request('eth_getCode', [c.address, 'latest']);
    check(code && code !== '0x' && same(keccak256(code), c.codeHash), 'contract_unverified');
  }
  check(same(await call(profile.launcher.address, 'AIRLOCK'), profile.airlock.address) &&
    same(await call(profile.launcher.address, 'TRUSTED_TOKEN_FACTORY'), profile.tokenFactory.address) &&
    Number(await call(profile.launcher.address, 'RESERVATION_DURATION')) === 86400 && !await call(profile.launcher.address, 'paused'), 'contract_unverified');
  for (const [i, role] of ['tokenFactory', 'governanceFactory', 'poolInitializer', 'liquidityMigrator'].entries())
    check(Number(await call(profile.airlock.address, 'getModuleState', [profile[role].address])) === i + 1, 'contract_unverified');
  check(Number(await call(q.token.address, 'decimals')) === q.decimals, 'contract_unverified');
  if (q.oracle) check(Number(await call(q.oracle.address, 'decimals')) === q.oracleDecimals, 'contract_unverified');
  check(await call(profile.launcher.address, 'isTickerAvailable', [input.draft.ticker]), 'ticker_reserved');
  check(await request('eth_getCode', [rebuilt.predictedAsset, 'latest']) === '0x', 'launch_already_exists');
  check(await request('eth_getCode', [input.wallet, 'latest']) === '0x', 'launch_eoa_required');
  check(BigInt(await request('eth_getTransactionCount', [input.wallet, 'pending'])) === nonce, 'nonce_changed');
  check(BigInt(await request('eth_getBalance', [input.wallet, 'pending'])) >= cost, 'insufficient_funds');
  const simulated = decodeFunctionResult({ abi: LONG_CREATE_ABI, functionName: 'create', data: await request('eth_call', [tx, 'pending']) });
  check(same(simulated[0], rebuilt.predictedAsset) && isAddress(plan.predictedPool) && !same(plan.predictedPool, zeroAddress) && same(simulated[1], plan.predictedPool), 'launch_simulation_failed');
  check(Date.now() < plan.expiresAt, 'quote_expired');
  return cost;
}
