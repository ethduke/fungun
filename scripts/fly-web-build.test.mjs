import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { assertNoBuildEnvFiles, webBuildEnvironment } from "../apps/web/scripts/build-fly.mjs";

test("Fly web builds receive no provider, wallet, public build or process injection secrets", () => {
  const inherited = {
    PRIVATE_KEY: "EXAMPLE",
    O1_API_KEY: "EXAMPLE",
    O1_WALLET_LAUNCH: "true",
    O1_LAUNCH_PROFILE_JSON: "EXAMPLE",
    O1_LAUNCH_TOKENS_JSON: "EXAMPLE",
    LONG_EXTRA_QUOTES_JSON: "EXAMPLE",
    ROBINHOOD_RPC: "EXAMPLE",
    NEXT_PUBLIC_O1_API_KEY: "EXAMPLE",
    VITE_PRIVATE_KEY: "EXAMPLE",
    NODE_OPTIONS: "EXAMPLE",
    APP_ORIGIN: "EXAMPLE",
    READ_SERVICE_ORIGIN: "EXAMPLE",
    PATH: "/usr/bin",
    NODE_ENV: "development",
  };
  assert.deepEqual(webBuildEnvironment(inherited), {
    NODE_ENV: "production",
    FUNGUN_WEB_TARGET: "fly",
    PATH: "/usr/bin",
  });
  assert.equal(inherited.NODE_ENV, "development");
});

test("local web environment files cannot enter a production build through automatic dotenv loading", () => {
  assert.doesNotThrow(() => assertNoBuildEnvFiles([".env.example", "app", "public"]));
  for (const name of [".env", ".env.local", ".env.production", ".env.production.local"])
    assert.throws(() => assertNoBuildEnvFiles([name]));
});

test("Fly packaging separates the web runtime from API source and operational files", () => {
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const docker = read("apps/web/Dockerfile");
  const ignore = read(".dockerignore");
  assert.ok(docker.includes("COPY --from=build --chown=node:node /service/dist/standalone ./"));
  assert.ok(docker.includes("USER node"));
  assert.ok(!/COPY\s+\.\s/.test(docker));
  assert.ok(!/apps\/api|ARG\s/.test(docker));
  for (const pattern of [
    "**/.env*",
    "**/*.test.*",
    "**/local/**",
    "**/*.sqlite*",
    "**/private/**",
    "**/credentials/**",
    "**/keys/**",
    "**/wallets/**",
    "**/*.key",
    "**/*.pem",
    "**/*.seed",
  ])
    assert.ok(ignore.includes(pattern));
  assert.ok(read("fly.web.toml").includes('path = "/healthz"'));
  assert.ok(!read("fly.web.toml").includes("READ_UPSTREAMS"));
  assert.ok(read("apps/web/vite.config.ts").includes("plugins: [vinext()]"));
  const pkg = JSON.parse(read("apps/web/package.json"));
  assert.ok(pkg.scripts["start:fly"].startsWith("NODE_ENV=production "));
});
