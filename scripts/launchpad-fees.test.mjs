import assert from "node:assert/strict";
import test from "node:test";
import { FEE_INFO_REVIEWED, launchpadFeeInfo } from "../apps/web/lib/launchpad-fees.ts";

test("Long shows the reviewed LP split only for Robinhood RWA launches", () => {
  const info = launchpadFeeInfo({ id: "long", chainId: 4663, route: "rwa" });
  assert.equal(info.label, "Your LP fee share");
  assert.equal(info.creatorPercent, 95);
  assert.equal(info.remainder, "5% protocol");
  assert.match(info.details, /Separate hook fees are not included/);
  assert.match(info.details, /not a universal Long fee split/);
  assert.equal(new URL(info.sourceUrl).hostname, "docs.doppler.lol");
  for (const [chainId, route] of [
    [8453, "rwa"],
    [4663, "standard"],
  ]) {
    assert.equal(launchpadFeeInfo({ id: "long", chainId, route }), undefined);
  }
});

test("O1 states referral and anti-snipe exceptions on both chains and routes", () => {
  for (const chainId of [4663, 8453]) {
    for (const route of ["standard", "rwa"]) {
      const info = launchpadFeeInfo({ id: "o1", chainId, route });
      assert.equal(info.creatorPercent, 50);
      assert.equal(info.remainder, "50% platform / referrals");
      assert.match(info.details, /normal 1% trading fee/);
      assert.match(info.details, /platform receives 30% and the referrer 20%/);
      assert.match(info.details, /without one, the platform receives 50%/);
      assert.match(info.details, /first 20 seconds goes to the platform/);
      assert.equal(new URL(info.sourceUrl).hostname, "docs.o1.exchange");
    }
  }
});

test("Longbow describes independent hook and LP shares", () => {
  const info = launchpadFeeInfo({ id: "longbow", chainId: 4663, route: "rwa" });
  assert.equal(info.creatorPercent, 65);
  assert.match(info.details, /95% of the 0.1% LP fee/);
  assert.match(info.details, /full supply goes on the curve/);
  assert.match(info.details, /wallet or a compatible vault/);
  assert.equal(info.sourceUrl, "https://longbow.gg/launch?route=longbow");
  assert.equal(launchpadFeeInfo({ id: "longbow", chainId: 8453, route: "rwa" }), undefined);
});

test("fee information has public HTTPS sources and a review date", () => {
  assert.match(FEE_INFO_REVIEWED, /^\d{4}-\d{2}-\d{2}$/);
  for (const id of ["long", "o1", "longbow"]) {
    const info = launchpadFeeInfo({ id, chainId: 4663, route: "rwa" });
    const source = new URL(info.sourceUrl);
    assert.equal(source.protocol, "https:");
    assert.equal(source.username + source.password, "");
    assert.equal(source.search, id === "longbow" ? "?route=longbow" : "");
  }
});
