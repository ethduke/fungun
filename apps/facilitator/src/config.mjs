import { getAddress, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const INTEGER = /^[1-9][0-9]{0,77}$/;
const PRIVATE_KEY = /^0x[0-9a-f]{64}$/i;
export const CANONICAL_USDG_ADDRESS = getAddress(
  `0x${"5fc5360D0400a0Fd4f2a"}${"f552ADD042D716F1d168"}`,
);

function required(env, key) {
  const value = env[key];
  if (typeof value !== "string" || !value.length) throw new Error(`missing_${key.toLowerCase()}`);
  return value;
}

function address(env, key) {
  const value = required(env, key);
  if (!isAddress(value) || /^0x0{40}$/i.test(value)) throw new Error(`invalid_${key.toLowerCase()}`);
  return getAddress(value);
}

export function readFacilitatorConfig(env = process.env) {
  const privateKey = required(env, "X402_FACILITATOR_PRIVATE_KEY");
  if (!PRIVATE_KEY.test(privateKey)) throw new Error("invalid_x402_facilitator_private_key");
  const bearerToken = required(env, "X402_FACILITATOR_BEARER_TOKEN");
  if (!/^[\x21-\x7e]{32,256}$/.test(bearerToken))
    throw new Error("invalid_x402_facilitator_bearer_token");
  const rpcUrl = required(env, "ROBINHOOD_RPC");
  try {
    const url = new URL(rpcUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error();
  } catch {
    throw new Error("invalid_robinhood_rpc");
  }
  const maxAmountValue = required(env, "IMAGE_MAX_PRICE_USDG_BASE_UNITS");
  if (!INTEGER.test(maxAmountValue) || BigInt(maxAmountValue) > 10_000_000n)
    throw new Error("invalid_image_max_price_usdg_base_units");
  const account = privateKeyToAccount(privateKey);
  const payTo = address(env, "IMAGE_PAYMENT_RECIPIENT");
  if (payTo === getAddress(account.address)) throw new Error("relayer_must_not_receive_payments");
  const asset = address(env, "IMAGE_USDG_ADDRESS");
  if (asset !== CANONICAL_USDG_ADDRESS) throw new Error("invalid_image_usdg_address");
  return Object.freeze({
    bearerToken,
    rpcUrl,
    asset,
    payTo,
    maxAmount: BigInt(maxAmountValue),
    account,
    port: 8788,
  });
}
