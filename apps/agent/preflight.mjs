import { safeSdkError } from "./errors.mjs";
import { keccak256, parseTransaction, decodeFunctionResult, encodeFunctionData, serializeTransaction, parseAbi, isAddress, zeroAddress } from "viem";
import {
  buildUnsignedLongLaunch,
  readLongLaunchProfile,
  LONG_CREATE_ABI,
  isNativeLongQuote,
} from "../web/lib/long-encoding/long-launch.mjs";
import { isCanonicalLongAsset } from "../web/lib/long-encoding/long-salt.mjs";
import { buildUnsignedStonxLaunch, readStonxProfile, STONX_ABI, STONX_ROLES } from "../web/lib/long-encoding/stonx-launch.mjs";
const baseOracleAbi = parseAbi(["function getL1Fee(bytes) view returns (uint256)", "function getOperatorFee(uint256) view returns (uint256)"]);
const same = (a, b) =>
  typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const check = (ok, code = "launch_transaction_changed") => {
  if (!ok) throw new Error(code);
};
async function preflightPlan(plan, input, published, trustedProfile, rpc, limits, baseFeeOracle) {
  if (trustedProfile.launchpad === "stonx") return preflightStonx(plan, input, published, trustedProfile, rpc, limits, baseFeeOracle);
  const trusted = readLongLaunchProfile(trustedProfile);
  const profile = readLongLaunchProfile({
    ...trusted,
    quotes: trusted.quotes.filter((q) => q.id === input.pairId),
  });
  check(input.chainId === 4663 && plan.chainId === 4663 && input.pairId.startsWith("long-"));
  check(
    JSON.stringify(readLongLaunchProfile(plan.profile)) === JSON.stringify(profile),
    "contract_unverified",
  );
  check(
    Number.isSafeInteger(plan.expiresAt) &&
      Date.now() < plan.expiresAt &&
      plan.expiresAt - plan.quotedAt === 30000,
    "quote_expired",
  );
  check(/^[a-f0-9]{64}$/.test(plan.id) && /^[a-f0-9]{64}$/.test(plan.binding));
  const rebuilt = buildUnsignedLongLaunch(
    {
      chainId: input.chainId,
      wallet: input.wallet,
      draft: input.draft,
      pairId: input.pairId,
      metadataUri: `ipfs://${published.ipfs.metadataCid}`,
      startingTick: plan.startingTick,
      intentId: plan.intentId,
    },
    profile,
    undefined,
    plan.saltAttempt,
  );
  const tx = plan.transaction;
  check(isCanonicalLongAsset(plan.predictedAsset));
  check(
    BigInt(tx.nonce) >= 0n && BigInt(tx.nonce) <= BigInt(Number.MAX_SAFE_INTEGER),
    "nonce_limit",
  );
  check(rebuilt.binding === plan.binding && same(rebuilt.predictedAsset, plan.predictedAsset));
  check(Object.keys(tx).sort().join(",") === "chainId,data,from,gas,gasPrice,nonce,to,value");
  check(
    tx.chainId === "0x1237" &&
      same(tx.from, input.wallet) &&
      same(tx.to, rebuilt.transaction.to) &&
      tx.data === rebuilt.transaction.data &&
      BigInt(tx.value) === BigInt(rebuilt.transaction.value),
  );
  const gas = BigInt(tx.gas),
    price = BigInt(tx.gasPrice),
    value = BigInt(tx.value),
    cost = gas * price + value;
  check(
    gas >= 21000n &&
      gas <= BigInt(limits.maxGas) &&
      gas === (BigInt(plan.estimatedGas) * 120n + 99n) / 100n &&
      price > 0n &&
      price <= BigInt(limits.maxGasPriceWei) &&
      cost <= BigInt(limits.maxTransactionWei) &&
      plan.maximumGasWei === String(gas * price) &&
      value === 0n,
    "spend_limit",
  );
  const request = (method, params = []) => rpc.request({ method, params });
  check(BigInt(await request("eth_chainId")) === 4663n, "wrong_chain");
  for (const contract of [
    ...[
      "launcher",
      "airlock",
      "tokenFactory",
      "governanceFactory",
      "poolInitializer",
      "liquidityMigrator",
      "dopplerHook",
    ].map((k) => profile[k]),
    ...profile.quotes
      .filter((q) => q.id === input.pairId)
      .flatMap((q) => [...(isNativeLongQuote(q) ? [] : [q.token]), ...(q.oracle ? [q.oracle] : [])]),
  ]) {
    const code = await request("eth_getCode", [contract.address, "latest"]);
    check(code && code !== "0x" && same(keccak256(code), contract.codeHash), "contract_unverified");
  }
  check(
    BigInt(await request("eth_getTransactionCount", [input.wallet, "pending"])) ===
      BigInt(tx.nonce),
    "nonce_changed",
  );
  check(
    BigInt(await request("eth_getBalance", [input.wallet, "pending"])) >= cost,
    "insufficient_funds",
  );
  const simulated = decodeFunctionResult({
    abi: LONG_CREATE_ABI,
    functionName: "create",
    data: await request("eth_call", [tx, "pending"]),
  });
  check(
    same(simulated[0], rebuilt.predictedAsset) &&
      !same(simulated[1], zeroAddress) &&
      same(simulated[1], plan.predictedPool),
    "launch_simulation_failed",
  );
  check(Date.now() < plan.expiresAt, "quote_expired");
  return cost;
}
async function preflightStonx(plan, input, published, trustedProfile, rpc, limits, oracle) {
  const trusted = readStonxProfile(trustedProfile);
  const profile = readStonxProfile({ ...trusted, quotes: trusted.quotes.filter(q => q.id === input.pairId) });
  check(input.chainId === 8453 && plan.chainId === 8453 && /^stonx-[a-f0-9]{24}$/.test(input.pairId));
  check(JSON.stringify(readStonxProfile(plan.profile)) === JSON.stringify(profile), "contract_unverified");
  check(Number.isSafeInteger(plan.quotedAt) && Number.isSafeInteger(plan.expiresAt) &&
    plan.quotedAt <= Date.now() && Date.now() < plan.expiresAt && plan.expiresAt - plan.quotedAt === 30000, "quote_expired");
  check(/^[a-f0-9]{64}$/.test(plan.id) && /^[a-f0-9]{64}$/.test(plan.binding));
  check(plan.stonxBuildInput?.intentId === plan.id && Number.isInteger(plan.saltAttempt) && plan.saltAttempt >= 0 && plan.saltAttempt < 200000);
  const rebuilt = buildUnsignedStonxLaunch({ wallet: input.wallet, draft: input.draft, pairId: input.pairId,
    metadataUri: `ipfs://${published.ipfs.metadataCid}`, quotePriceUsd: plan.stonxBuildInput.quotePriceUsd, intentId: plan.id }, profile, plan.saltAttempt);
  check(rebuilt.binding === plan.binding && same(rebuilt.predictedAsset, plan.predictedAsset) &&
    same(rebuilt.predictedPool, plan.predictedPool) && JSON.stringify(rebuilt.review) === JSON.stringify(plan.review));
  const tx = plan.transaction;
  check(tx && Object.keys(tx).sort().join(",") === "chainId,data,from,gas,gasPrice,nonce,to,value");
  check(tx.chainId === "0x2105" && same(tx.from, input.wallet) && same(tx.to, rebuilt.transaction.to) && tx.data === rebuilt.transaction.data &&
    [tx.gas, tx.gasPrice, tx.nonce, tx.value].every(v => typeof v === "string" && /^0x[0-9a-f]{1,64}$/i.test(v)) && BigInt(tx.value) === 0n && plan.launchpadFeeWei === "0");
  const nonce = BigInt(tx.nonce), gas = BigInt(tx.gas), price = BigInt(tx.gasPrice);
  check(nonce <= BigInt(Number.MAX_SAFE_INTEGER), "nonce_limit");
  check(plan.baseFees && Object.keys(plan.baseFees).sort().join(",") === "l1DataFeeWei,operatorFeeWei" &&
    Object.values(plan.baseFees).every(v => typeof v === "string" && /^(0|[1-9][0-9]{0,16})$/.test(v)), "spend_limit");
  const l1 = BigInt(plan.baseFees.l1DataFeeWei), operator = BigInt(plan.baseFees.operatorFeeWei), cost = gas * price + l1 + operator;
  check(BigInt(plan.estimatedGas) >= 21000n && gas === (BigInt(plan.estimatedGas) * 120n + 99n) / 100n &&
    gas <= 8000000n && gas <= BigInt(limits.maxGas) && price > 0n && price <= BigInt(limits.maxGasPriceWei) &&
    cost <= BigInt(limits.maxTransactionWei) && plan.maximumGasWei === String(cost), "spend_limit");
  const request = (method, params = []) => rpc.request({ method, params });
  const call = async (to, abi, functionName, args = []) => decodeFunctionResult({ abi, functionName,
    data: await request("eth_call", [{ to, data: encodeFunctionData({ abi, functionName, args }) }, "latest"]) });
  check(BigInt(await request("eth_chainId")) === 8453n, "wrong_chain");
  check(oracle && isAddress(oracle.address) && !same(oracle.address, zeroAddress) && /^0x[a-f0-9]{64}$/i.test(oracle.codeHash), "contract_unverified");
  const q = profile.quotes[0];
  for (const c of [...STONX_ROLES.map(r => profile[r]), q.token, q.beacon, q.implementation, oracle]) {
    const code = await request("eth_getCode", [c.address, "latest"]);
    check(code && code !== "0x" && same(keccak256(code), c.codeHash), "contract_unverified");
  }
  for (const [target, method, expected] of [[q.beacon.address, "implementation", q.implementation.address],
    [profile.launcher.address, "owner", profile.protocolBeneficiary], [profile.poolInitializer.address, "airlock", profile.launcher.address],
    [profile.dopplerHook.address, "poolManager", profile.poolManager.address]])
    check(same(await call(target, STONX_ABI, method), expected), "contract_unverified");
  for (const [index, role] of ["tokenFactory", "governanceFactory", "poolInitializer", "liquidityMigrator"].entries())
    check(Number(await call(profile.launcher.address, STONX_ABI, "getModuleState", [profile[role].address])) === index + 1, "contract_unverified");
  check(await call(q.token.address, STONX_ABI, "symbol") === q.symbol && Number(await call(q.token.address, STONX_ABI, "decimals")) === q.decimals, "contract_unverified");
  const encoded = serializeTransaction({ chainId: 8453, type: "legacy", nonce: Number(nonce), to: tx.to, data: tx.data, value: 0n, gas, gasPrice: price });
  const freshL1 = await call(oracle.address, baseOracleAbi, "getL1Fee", [encoded]);
  const freshOperator = await call(oracle.address, baseOracleAbi, "getOperatorFee", [gas]);
  check(l1 >= (freshL1 * 120n + 99n) / 100n && operator >= freshOperator, "spend_limit");
  check(BigInt(await request("eth_getTransactionCount", [input.wallet, "pending"])) === nonce, "nonce_changed");
  check(BigInt(await request("eth_getBalance", [input.wallet, "pending"])) >= cost, "insufficient_funds");
  const simulated = decodeFunctionResult({ abi: STONX_ABI, functionName: "create", data: await request("eth_call", [tx, "pending"]) });
  check(same(simulated[0], rebuilt.predictedAsset) && same(simulated[1], rebuilt.predictedAsset), "launch_simulation_failed");
  check(Date.now() < plan.expiresAt, "quote_expired");
  return cost;
}
function validateSignedTransaction(raw, tx) {
  const signed = parseTransaction(raw);
  check(
    [4663, 8453].includes(Number(BigInt(tx.chainId))) &&
      signed.chainId === Number(BigInt(tx.chainId)) &&
      signed.type === "legacy" &&
      same(signed.to, tx.to) &&
      signed.data === tx.data &&
      (signed.value ?? 0n) === BigInt(tx.value) &&
      signed.gas === BigInt(tx.gas) &&
      signed.gasPrice === BigInt(tx.gasPrice) &&
      BigInt(signed.nonce ?? 0) === BigInt(tx.nonce),
  );
  return keccak256(raw);
}

export async function preflight(...args) {
  try {
    return await preflightPlan(...args);
  } catch (error) {
    throw safeSdkError(error);
  }
}
export function validateSigned(...args) {
  try {
    return validateSignedTransaction(...args);
  } catch (error) {
    throw safeSdkError(error);
  }
}
