import { createHash } from "node:crypto";
import { canonicalJson, launchIdentity } from "./index.mjs";

import { retries, safeAgentError } from "./errors.mjs";
export { safeAgentError } from "./errors.mjs";
export function retryDelay(error, now = Date.now()) {
  if (
    !error?.retryable &&
    !retries.has(error?.message) &&
    !["TypeError", "TimeoutError", "AbortError"].includes(error?.name)
  )
    return null;
  if (["daily_launch_limit", "daily_spend_limit", "image_daily_budget"].includes(error?.message)) {
    const tomorrow = new Date(now);
    tomorrow.setUTCHours(24, 0, 0, 0);
    return Math.max(1000, tomorrow.getTime() - now);
  }
  return Math.min(86400000, Math.max(1000, (Number(error?.retryAfter) || 5) * 1000));
}
export async function sleep(ms, signal) {
  for (let remaining = ms; remaining > 0; remaining -= Math.min(remaining, 1000)) {
    if (signal?.aborted) throw new Error("aborted");
    await new Promise((resolve) => setTimeout(resolve, Math.min(remaining, 1000)));
  }
}
export function deploymentKey(input, image = { mode: input.image ? "provided" : "none" }) {
  return `deploy:${createHash("sha256")
    .update(canonicalJson(launchIdentity(input, image)))
    .digest("hex")}`;
}
/** A single invocation runs publication, signing and receipt recovery to completion. */
export async function deployAndWait(
  agent,
  input,
  {
    intentKey,
    image,
    timeoutMs = 1800000,
    pollMs = 5000,
    signal,
    pause = sleep,
    now = Date.now,
  } = {},
) {
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 1000 ||
    timeoutMs > 86400000 ||
    !Number.isFinite(pollMs) ||
    pollMs < 1000 ||
    pollMs > 300000
  )
    throw new Error("invalid_wait_settings");
  intentKey ??= input.intentKey ?? deploymentKey(input, image);
  const deadline = now() + timeoutMs;
  let result;
  for (;;) {
    if (signal?.aborted) throw new Error("aborted");
    let delay = pollMs;
    try {
      result = await agent.deploy(input, { intentKey, ...(image ? { image } : {}) });
      if (result?.status === "confirmed") return result;
      if (result?.status === "skipped") return result;
      if (result?.status === "failed") throw new Error("launch_failed");
    } catch (error) {
      const wait = retryDelay(error, now());
      if (wait === null) throw error;
      delay = Math.max(delay, wait);
    }
    if (now() + delay >= deadline)
      return { status: "pending", intentKey, ...(result?.id ? { id: result.id } : {}) };
    await pause(delay, signal);
  }
}
/** Feed polling is bounded and honors server backoff; all recovery is inside tick(). */
export async function watchThemes(
  agent,
  config,
  { signal, onResult = () => {}, onError = () => {}, pause = sleep } = {},
) {
  const poll = config.pollSeconds ?? 30;
  if (!Number.isFinite(poll) || poll < 5 || poll > 300) throw new Error("invalid_wait_settings");
  while (!signal?.aborted) {
    let delay = poll * 1000;
    try {
      onResult(await agent.tick(config));
    } catch (error) {
      onError(safeAgentError(error));
      const wait = retryDelay(error);
      if (wait === null) throw error;
      delay = Math.max(delay, wait);
    }
    if (!signal?.aborted) await pause(delay, signal);
  }
}
