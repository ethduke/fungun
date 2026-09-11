import { decodeFunctionResult, encodeFunctionData, isAddress, keccak256, zeroAddress } from 'viem';
import { buildUnsignedPonsLaunch, readPonsLaunchProfile, PONS_ABI, PONS_ROLES } from '../web/lib/long-encoding/pons-launch.mjs';
import { normalizeLaunchDetails } from '../web/lib/long-encoding/launch-metadata.mjs';
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const check = (ok, code = 'launch_transaction_changed') => { if (!ok) throw new Error(code); };
export async function preflightPons(plan, input, published, trustedProfile, rpc, limits) {
  const profile = readPonsLaunchProfile(trustedProfile);
  check(input.chainId === 4663 && plan.chainId === 4663 && input.pairId === 'pons-native');
  check(JSON.stringify(readPonsLaunchProfile(plan.profile)) === JSON.stringify(profile), 'contract_unverified');
  check(Number.isSafeInteger(plan.quotedAt) && Number.isSafeInteger(plan.expiresAt) && plan.quotedAt <= Date.now()
    && Date.now() < plan.expiresAt && plan.expiresAt - plan.quotedAt === 30000, 'quote_expired');
  check(/^[a-f0-9]{64}$/.test(plan.id) && /^[a-f0-9]{64}$/.test(plan.binding) && plan.ponsBuildInput?.intentId === plan.id);
  const request = (method, params = []) => rpc.request({ method, params });
  const call = async (functionName, args = []) => decodeFunctionResult({ abi: PONS_ABI, functionName,
    data: await request('eth_call', [{ to: profile.launcher.address, data: encodeFunctionData({ abi: PONS_ABI, functionName, args }) }, 'latest']) });
  check(BigInt(await request('eth_chainId')) === 4663n, 'wrong_chain');
  for (const role of PONS_ROLES) {
    const contract = profile[role], code = await request('eth_getCode', [contract.address, 'latest']);
    check(code && code !== '0x' && same(keccak256(code), contract.codeHash), 'contract_unverified');
  }
  for (const role of PONS_ROLES.slice(1)) check(same(await call(role), profile[role].address), 'contract_unverified');
  const config = await call('getLaunchConfig', [BigInt(profile.launchConfigId)]);
  check(config.enabled, 'pons_launch_disabled');
  check(config.supply > 0n, 'contract_unverified');
  check(await call('canLaunch', [input.wallet]), 'pons_launch_restricted');
  const economics = await call('previewLaunchEconomics', [BigInt(profile.launchConfigId), zeroAddress]);
  const fee = await call('launchFee');
  const buildInput = { wallet: input.wallet, draft: input.draft, pairId: input.pairId,
    imageUri: `ipfs://${published.ipfs.imageCid}`, metadataUri: `ipfs://${published.ipfs.metadataCid}`,
    expectedEconomics: economics, totalSupply: config.supply.toString(), launchpadFeeWei: fee.toString(), intentId: plan.id };
  const rebuilt = buildUnsignedPonsLaunch(buildInput, profile);
  check(Object.keys(buildInput).every(key => key === 'wallet' ? same(buildInput.wallet, plan.ponsBuildInput.wallet) : key === 'draft'
    ? JSON.stringify(normalizeLaunchDetails(buildInput.draft)) === JSON.stringify(normalizeLaunchDetails(plan.ponsBuildInput.draft))
    : JSON.stringify(buildInput[key]) === JSON.stringify(plan.ponsBuildInput[key]))
    && Object.keys(buildInput).length === Object.keys(plan.ponsBuildInput).length);
  check(rebuilt.binding === plan.binding && JSON.stringify(rebuilt.review) === JSON.stringify(plan.review)
    && plan.graduationThreshold === config.graduationThreshold.toString() && plan.launchpadFeeWei === fee.toString());
  const tx = plan.transaction;
  check(tx && Object.keys(tx).sort().join(',') === 'chainId,data,from,gas,gasPrice,nonce,to,value');
  check(tx.chainId === '0x1237' && same(tx.from, input.wallet) && same(tx.to, rebuilt.transaction.to)
    && tx.data === rebuilt.transaction.data && [tx.gas, tx.gasPrice, tx.nonce, tx.value].every(v => typeof v === 'string' && /^0x[0-9a-f]{1,64}$/i.test(v))
    && BigInt(tx.value) === fee);
  const nonce = BigInt(tx.nonce), gas = BigInt(tx.gas), price = BigInt(tx.gasPrice), cost = gas * price + fee;
  check(nonce <= BigInt(Number.MAX_SAFE_INTEGER), 'nonce_limit');
  check(BigInt(plan.estimatedGas) >= 21000n && gas === (BigInt(plan.estimatedGas) * 120n + 99n) / 100n
    && gas <= 8000000n && gas <= BigInt(limits.maxGas) && price > 0n && price <= 10n ** 12n && price <= BigInt(limits.maxGasPriceWei)
    && cost <= 5n * 10n ** 16n && cost <= BigInt(limits.maxTransactionWei) && plan.maximumGasWei === String(gas * price), 'spend_limit');
  check(await request('eth_getCode', [input.wallet, 'latest']) === '0x', 'launch_eoa_required');
  check(BigInt(await request('eth_getTransactionCount', [input.wallet, 'pending'])) === nonce, 'nonce_changed');
  check(BigInt(await request('eth_getBalance', [input.wallet, 'pending'])) >= cost, 'insufficient_funds');
  const simulated = decodeFunctionResult({ abi: PONS_ABI, functionName: 'launchToken', data: await request('eth_call', [tx, 'pending']) });
  check([plan.predictedAsset, plan.predictedPool].every(a => isAddress(a) && !same(a, zeroAddress))
    && !same(plan.predictedAsset, plan.predictedPool) && same(simulated[0], plan.predictedAsset)
    && same(simulated[1], plan.predictedPool), 'launch_simulation_failed');
  check(Date.now() < plan.expiresAt, 'quote_expired');
  return cost;
}
