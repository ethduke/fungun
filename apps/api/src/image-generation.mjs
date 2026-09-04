import { isAddress, zeroAddress } from "viem";
import { buildGrokImageRequest, ImagePromptError } from "./image-prompt.mjs";
import { ServiceError } from "./errors.mjs";

export function validateImageOperation(value) {
  const fields = ["requestId", "wallet", "name", "ticker", "prompt"];
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== fields.length ||
    fields.some((key) => !Object.hasOwn(value, key)) ||
    typeof value.requestId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value.requestId,
    ) ||
    typeof value.wallet !== "string" ||
    !isAddress(value.wallet) ||
    value.wallet.toLowerCase() === zeroAddress
  )
    throw new ServiceError("invalid_image_request", 400);
  try {
    buildGrokImageRequest({ name: value.name, ticker: value.ticker, prompt: value.prompt });
  } catch (error) {
    if (error instanceof ImagePromptError) throw new ServiceError("invalid_image_request", 400);
    throw error;
  }
  return {
    requestId: value.requestId,
    wallet: value.wallet.toLowerCase(),
    name: value.name.trim(),
    ticker: value.ticker.trim(),
    prompt: value.prompt.trim(),
  };
}

export function imageJobResult(job) {
  return {
    requestId: job.id,
    status: job.state,
    payment: {
      status: job.accounting,
      transaction: job.transaction_hash || job.settlement_transaction,
      network: "eip155:4663",
    },
    ...(job.error ? { error: job.error } : {}),
    ...(job.state === "completed"
      ? {
          image: {
            base64: Buffer.from(job.image).toString("base64"),
            mimeType: "image/webp",
            sha256: job.image_hash,
            width: job.width,
            height: job.height,
            filename: `${job.image_hash}.webp`,
          },
        }
      : {}),
  };
}

export function createImageWorker(store, provider, processor, payments, settlementReader = null) {
  let working = false;
  let wake = false;
  let closed = false;
  let running = Promise.resolve();
  async function drain() {
    if (closed) return running;
    if (working) {
      wake = true;
      return running;
    }
    working = true;
    running = (async () => {
      try {
        const attempted = new Set();
        do {
          wake = false;
          for (const next of store.pending()) {
            if (attempted.has(next.id)) continue;
            attempted.add(next.id);
            if (closed) break;
            let job = store.get(next.id);
            try {
              if (job.state === "authorized") {
                if (!store.claim(job.id)) continue;
                const { name, ticker, prompt } = JSON.parse(job.input);
                const result = await provider.generate({ name, ticker, prompt });
                const quotedAmount = JSON.parse(job.requirements).amount;
                if (
                  typeof result.costAmount !== "string" ||
                  !/^[1-9][0-9]{0,7}$/.test(result.costAmount) ||
                  BigInt(result.costAmount) > BigInt(quotedAmount)
                )
                  throw new ServiceError("image_price_changed", 503);
                store.generated(job.id, result.bytes);
                job = store.get(job.id);
              }
              if (job.state === "generated") {
                const image = await processor.process(Buffer.from(job.raw_image));
                if (image.width !== image.height) throw new ServiceError("image_not_square", 502);
                store.stageImage(job.id, image);
              }
              job = store.get(job.id);
              if (job.state === "settlement_pending") {
                if (settlementReader && job.settlement_attempts > 0) {
                  if (!store.beginReconciliation(job.id)) continue;
                  const proof = JSON.parse(job.payment_proof);
                  const requirements = JSON.parse(job.requirements);
                  const recovered = await settlementReader.recover(
                    proof,
                    requirements,
                    job.settlement_transaction || "",
                  );
                  if (recovered) store.complete(job.id, recovered);
                  else if (await settlementReader.expired?.(proof, requirements))
                    store.failSettlement(job.id, "image_payment_expired");
                  // A lost settlement response is reconciled on chain; never blindly resubmit.
                  continue;
                }
                if (!store.beginSettlement(job.id)) continue;
                const settlement = await payments.settle(
                  JSON.parse(job.payment_proof),
                  JSON.parse(job.requirements),
                );
                if (settlementReader) {
                  store.settlementPending(job.id, settlement.transaction);
                  const confirmed = await settlementReader.recover(
                    JSON.parse(job.payment_proof),
                    JSON.parse(job.requirements),
                    settlement.transaction,
                  );
                  if (confirmed) store.complete(job.id, confirmed);
                  continue;
                }
                store.complete(job.id, settlement);
              }
            } catch (error) {
              if (store.get(job.id)?.state === "settlement_pending") {
                if (error?.code === "image_settlement_failed") store.failSettlement(job.id);
                else store.settlementPending(job.id, error?.transactionHash, error?.code);
                continue;
              }
              const code = /^[a-z0-9_]{1,64}$/.test(error?.code ?? "")
                ? error.code
                : "image_outcome_unknown";
              store.fail(job.id, code, code.includes("unknown") || code.includes("timeout"));
            }
          }
        } while (wake && !closed);
      } finally {
        working = false;
      }
    })();
    return running;
  }
  return {
    kick: () => {
      void drain();
    },
    idle: () => running,
    stop: async () => {
      closed = true;
      await running;
    },
  };
}
