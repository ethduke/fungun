#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http } from "viem";
import { FungunAgent } from "./index.mjs";
import { deployAndWait, watchThemes, safeAgentError } from "./run.mjs";
import { safeAgentResult } from "./errors.mjs";
const [command, configPath, inputPath] = process.argv.slice(2);
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => controller.abort());
let imageGenerator;
try {
  if (!["deploy", "watch", "resume"].includes(command) || !configPath) {
    console.error(
      "Usage: fungun-agent deploy CONFIG.json INPUT.json | watch CONFIG.json | resume CONFIG.json",
    );
    process.exitCode = 1;
  } else {
    const config = JSON.parse(await readFile(configPath, "utf8"));
    const key = process.env.FUNGUN_PRIVATE_KEY,
      token = process.env.FUNGUN_AGENT_TOKEN,
      rpcUrl = process.env.FUNGUN_RPC_URL;
    if (!key || !token || !rpcUrl) throw new Error("invalid_runtime");
    const signer = privateKeyToAccount(key);
    delete process.env.FUNGUN_PRIVATE_KEY;
    if (config.profileFile) config.profile = JSON.parse(await readFile(config.profileFile, "utf8"));
    if (config.image?.mode === "grok") {
      const { createGrokImageGenerator } = await import("./grok-x402.mjs");
      imageGenerator = createGrokImageGenerator({ ...config.image, signer });
    }
    const agent = new FungunAgent({
      ...config,
      token,
      signer,
      rpc: createPublicClient({ transport: http(rpcUrl, { retryCount: 0 }) }),
      imageGenerator,
    });
    if (command === "deploy") {
      if (!inputPath) throw new Error("invalid_input");
      const input = JSON.parse(await readFile(inputPath, "utf8"));
      if (input.imageFile) {
        input.image = (await readFile(input.imageFile)).toString("base64");
        delete input.imageFile;
      }
      const result = await deployAndWait(
        agent,
        { ...input, pairId: input.pairId ?? config.pairId },
        {
          intentKey: input.intentKey,
          image: config.image ?? { mode: input.image ? "provided" : "none" },
          timeoutMs: config.waitTimeoutMs ?? 1800000,
          signal: controller.signal,
        },
      );
      console.log(JSON.stringify(safeAgentResult(result)));
      if (result.status !== "confirmed") process.exitCode = 2;
    } else if (command === "resume") {
      console.log(JSON.stringify(safeAgentResult(await agent.resume())));
    } else {
      await watchThemes(agent, config, {
        signal: controller.signal,
        onResult: (value) => console.log(JSON.stringify(safeAgentResult(value))),
        onError: (code) => console.error(`Agent waiting: ${code}`),
      });
    }
  }
} catch (error) {
  if (!controller.signal.aborted) {
    console.error(safeAgentError(error));
    process.exitCode = 1;
  }
} finally {
  try {
    imageGenerator?.close();
  } catch (error) {
    console.error(safeAgentError(error));
    process.exitCode = 1;
  }
}
