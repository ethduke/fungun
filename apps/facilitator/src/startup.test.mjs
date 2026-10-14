import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

test("startup logs exclude wallet identities and arbitrary config or provider errors", () => {
  // Execute the actual entry point with inert dependencies. No wallet or RPC is used.
  const harness = `
    import { readFile } from "node:fs/promises";
    import vm from "node:vm";
    const source = await readFile(new URL("./index.mjs", "file://" + process.cwd() + "/"), "utf8");
    const { safeStartupReason } = await import("./diagnostics.mjs");
    const marker = ["synthetic", "startup", "credential"].join("_");
    const results = [];
    for (const scenario of ["ready", "configuration", "provider", "known"]) {
      const logs = [];
      const context = vm.createContext({
        console: { info: value => logs.push(value), error: value => logs.push(value) },
        process: { once() {}, exitCode: 0 },
      });
      const module = new vm.SourceTextModule(source, { context });
      await module.link(async name => {
        const values = name.endsWith("config.mjs") ? {
          readFacilitatorConfig() {
            if (scenario === "configuration") throw new Error(marker);
            if (scenario === "known") throw new Error("missing_robinhood_rpc");
            return { port: 8788 };
          },
        } : name.endsWith("facilitator.mjs") ? {
          async createPrivateFacilitator() {
            if (scenario === "provider") throw new Error(marker);
            return { relayerAddress: marker, arbitrary: marker };
          },
        } : name.endsWith("diagnostics.mjs") ? { safeStartupReason } : {
          createFacilitatorServer() { return { listen(_port, _host, ready) { ready(); } }; },
        };
        return new vm.SyntheticModule(Object.keys(values), function () {
          for (const [key, value] of Object.entries(values)) this.setExport(key, value);
        }, { context });
      });
      await module.evaluate();
      results.push({ scenario, logs, exitCode: context.process.exitCode,
        exposed: JSON.stringify(logs).includes(marker) });
    }
    console.log(JSON.stringify(results));
  `;
  const results = JSON.parse(execFileSync(process.execPath,
    ["--experimental-vm-modules", "--input-type=module", "--eval", harness], {
      cwd: new URL(".", import.meta.url), env: {}, encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"], timeout: 10_000,
    }));
  assert.ok(results.every(value => !value.exposed));
  assert.deepEqual(results[0].logs, [{
    event: "facilitator_started", port: 8788, network: "eip155:4663",
  }]);
  for (const value of results.slice(1)) {
    assert.equal(value.exitCode, 1);
    assert.deepEqual(value.logs, [{ event: "facilitator_start_failed",
      code: value.scenario === "known" ? "missing_robinhood_rpc" : "startup_validation_failed" }]);
  }
});
