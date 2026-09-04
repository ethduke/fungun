import { isAddress, keccak256, encodeAbiParameters, parseAbi, zeroAddress } from "viem";
import { ServiceError } from "./errors.mjs";

export const escrowAbi = parseAbi([
  "function owed(address recipient, address currency) view returns (uint256)",
  "function claimFor(address recipient, address currency)",
]);
export const legacyEscrowAbi = parseAbi([
  "function owed(address recipient, address currency) view returns (uint256)",
  "function claim(address recipient, address currency)",
]);
export const managerAbi = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "function getState(address asset) view returns (address numeraire, uint256 totalTokensOnBondingCurve, address dopplerHook, bytes graduationDopplerHookCalldata, uint8 status, PoolKey poolKey, int24 farTick)",
  "function getShares(bytes32 poolId, address beneficiary) view returns (uint256)",
  "function getCumulatedFees0(bytes32 poolId) view returns (uint256)",
  "function getCumulatedFees1(bytes32 poolId) view returns (uint256)",
  "function getLastCumulatedFees0(bytes32 poolId, address beneficiary) view returns (uint256)",
  "function getLastCumulatedFees1(bytes32 poolId, address beneficiary) view returns (uint256)",
  "function collectFees(bytes32 poolId) returns (uint128 fees0, uint128 fees1)",
]);
export const oracleAbi = parseAbi([
  "function getL1Fee(bytes transaction) view returns (uint256)",
  "function getOperatorFee(uint256 gasUsed) view returns (uint256)",
]);
export const sameAddress = (a, b) =>
  typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
export const validAddress = (value, native = false) =>
  typeof value === "string" && isAddress(value) && (native || !sameAddress(value, zeroAddress));
export const uint = (value) => {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9]\d{0,77})$/.test(value) ||
    BigInt(value) >= 1n << 256n
  )
    throw new ServiceError("invalid_response");
  return BigInt(value);
};
const hash = (value) => typeof value === "string" && /^0x[\da-f]{64}$/i.test(value);
const asset = (value) =>
  value &&
  validAddress(value.address, true) &&
  Number.isInteger(value.decimals) &&
  value.decimals >= 0 &&
  value.decimals <= 36 &&
  /^[A-Za-z0-9._-]{1,24}$/.test(value.symbol) &&
  (!sameAddress(value.address, zeroAddress) || (value.decimals === 18 && value.symbol === "ETH"));

export function readFeeContracts(raw = "{}") {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ServiceError("invalid_fee_configuration");
  }
  if (
    !value ||
    Array.isArray(value) ||
    typeof value !== "object" ||
    Object.keys(value).some((key) => !["o1", "long", "baseOracle"].includes(key))
  )
    throw new ServiceError("invalid_fee_configuration");
  const o1 = value.o1 ?? [];
  const long = value.long;
  const oracle = value.baseOracle;
  if (
    !Array.isArray(o1) ||
    o1.length > 32 ||
    o1.some(
      (entry) =>
        !entry ||
        ![8453, 4663].includes(entry.chainId) ||
        !validAddress(entry.escrow) ||
        !hash(entry.codeHash) ||
        (entry.version !== undefined && !["current", "legacy"].includes(entry.version)),
    ) ||
    new Set(o1.map((entry) => `${entry.chainId}:${entry.escrow.toLowerCase()}`)).size !== o1.length
  )
    throw new ServiceError("invalid_fee_configuration");
  if (
    long &&
    (!validAddress(long.manager) ||
      !hash(long.managerCodeHash) ||
      !validAddress(long.hook) ||
      !hash(long.hookCodeHash) ||
      (long.pools !== undefined && !Array.isArray(long.pools)) ||
      (long.pools ?? []).length > 256 ||
      (long.pools ?? []).some(
        (pool) =>
          !pool ||
          !validAddress(pool.asset) ||
          !asset(pool.currency0) ||
          !asset(pool.currency1) ||
          BigInt(pool.currency0.address) >= BigInt(pool.currency1.address) ||
          ![pool.currency0.address, pool.currency1.address].some((currency) =>
            sameAddress(currency, pool.asset),
          ) ||
          !Number.isInteger(pool.fee) ||
          pool.fee < 0 ||
          pool.fee >= 2 ** 24 ||
          !Number.isInteger(pool.tickSpacing) ||
          pool.tickSpacing <= 0 ||
          pool.tickSpacing >= 2 ** 23,
      ))
  )
    throw new ServiceError("invalid_fee_configuration");
  if (
    long &&
    new Set((long.pools ?? []).map((pool) => poolId(pool, long.manager))).size !==
      (long.pools ?? []).length
  )
    throw new ServiceError("invalid_fee_configuration");
  if (
    long?.discovery &&
    (typeof long.discovery !== "object" ||
      Array.isArray(long.discovery) ||
      Object.keys(long.discovery).some((key) => !["fromBlock", "blockRange"].includes(key)) ||
      !Number.isSafeInteger(long.discovery.fromBlock) ||
      long.discovery.fromBlock < 0 ||
      !Number.isInteger(long.discovery.blockRange ?? 2000) ||
      (long.discovery.blockRange ?? 2000) < 1 ||
      (long.discovery.blockRange ?? 2000) > 10000)
  )
    throw new ServiceError("invalid_fee_configuration");
  if (
    oracle &&
    (!validAddress(oracle.address) ||
      !hash(oracle.codeHash) ||
      !validAddress(oracle.implementation) ||
      !hash(oracle.implementationCodeHash))
  )
    throw new ServiceError("invalid_fee_configuration");
  return {
    o1,
    long: long
      ? {
          ...long,
          pools: long.pools ?? [],
          ...(long.discovery
            ? { discovery: { ...long.discovery, blockRange: long.discovery.blockRange ?? 2000 } }
            : {}),
        }
      : undefined,
    baseOracle: oracle,
  };
}

export function poolId(pool, manager) {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "uint24" },
        { type: "int24" },
        { type: "address" },
      ],
      [pool.currency0.address, pool.currency1.address, pool.fee, pool.tickSpacing, manager],
    ),
  );
}

export function beneficiaryFees(cumulative, collected, last, shares) {
  const max = (1n << 256n) - 1n;
  if (
    [cumulative, collected, last, shares].some((value) => value < 0n || value > max) ||
    shares > 10n ** 18n ||
    cumulative + collected > max ||
    last > cumulative + collected
  )
    throw new ServiceError("invalid_response");
  const product = (cumulative + collected - last) * shares;
  if (product > max) throw new ServiceError("invalid_response");
  return product / 10n ** 18n;
}
