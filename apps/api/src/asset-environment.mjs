const names = [
  "NODE_ENV",
  "APP_ORIGIN",
  "ASSET_STORE_ROOT",
  "ASSET_PUBLIC_ORIGIN",
  "ASSET_DECODER_ORIGIN",
  "ASSET_UPLOADS",
  "ASSETS_MACHINE_ID",
  "FLY_MACHINE_ID",
  "IMAGE_GENERATION",
  "IMAGE_PAYMENT_RECIPIENT",
  "IMAGE_USDG_ADDRESS",
  "ROBINHOOD_RPC",
  "IMAGE_PRICE_USDG_BASE_UNITS",
  "OPENROUTER_API_KEY",
  "X402_FACILITATOR_URL",
  "X402_FACILITATOR_TOKEN",
];

export function assetEnvironment(inherited = {}, local = {}) {
  const selected = {};
  for (const name of names) {
    const source = Object.hasOwn(inherited, name) ? inherited : local;
    if (typeof source[name] === "string") selected[name] = source[name];
  }
  return selected;
}
