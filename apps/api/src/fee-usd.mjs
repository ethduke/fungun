import { formatUnits, parseUnits } from "viem";
import { ServiceError } from "./errors.mjs";
import { ReadCache } from "./upstream.mjs";

const PRICE_URL = "https://api.coinbase.com/v2/prices/ETH-USD/spot";
const TTL = 60_000;
const SCALE = 10n ** 18n;

export function parseEthUsd(body) {
  const data = body?.data;
  if (
    data?.base !== "ETH" ||
    data?.currency !== "USD" ||
    typeof data.amount !== "string" ||
    !/^(?:0|[1-9]\d{0,8})(?:\.\d{1,18})?$/.test(data.amount)
  )
    throw new ServiceError("price_unavailable");
  const scaled = parseUnits(data.amount, 18);
  if (scaled <= 0n) throw new ServiceError("price_unavailable");
  return { amount: data.amount, scaled };
}

export class FeeUsd {
  constructor(upstream, now = Date.now) {
    this.upstream = upstream;
    this.now = now;
    this.cache = new ReadCache(now, 1);
  }

  async estimate(wei) {
    try {
      const price = await this.cache.get("ETH-USD", TTL, async () => {
        // A fixed public pair request never includes a wallet, contract or API key.
        const body = await this.upstream.json(
          "market",
          PRICE_URL,
          { headers: { Accept: "application/json" } },
          4096,
        );
        return { ...parseEthUsd(body), observedAt: this.now() };
      });
      if (price.observedAt > this.now() || this.now() - price.observedAt >= TTL) return null;
      return {
        amount: formatUnits((wei * price.scaled) / SCALE, 18),
        ethPrice: price.amount,
        observedAt: price.observedAt,
        source: "coinbase",
      };
    } catch {
      // Price outages and exhausted market quota cannot prevent a valid claim.
      return null;
    }
  }
}
