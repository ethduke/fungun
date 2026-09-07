import { readFileSync } from "node:fs";
import { FomoStore, fomoUsers } from "./fomo-store.mjs";
import { FomoCollector } from "./fomo-collector.mjs";
import { createTrackedFeedHandler } from "../../web/lib/tracked-feed-handler.mjs";
import { getO1Hooks, getStableAssets } from "../../web/lib/tracked-feed-registry.mjs";

export function createFomoService(db, env = process.env) {
  const users = fomoUsers(
    JSON.parse(
      readFileSync(env.FOMO_USERS_PATH || new URL("./fomo-users.json", import.meta.url), "utf8"),
    ),
  );
  const store = new FomoStore(db, users, Date.now, env.FOMO_MAX_CONNECTIONS_24H);
  const enabled = env.FOMO_ENABLED === "1";
  const collector = new FomoCollector(store, { enabled, key: env.FOMO_API_KEY || "" });
  const handleFeed = createTrackedFeedHandler({
    loadHookRegistry: getO1Hooks,
    loadStableRegistry: getStableAssets,
    onSnapshot: (snapshot) =>
      store.register(snapshot.pools.map((row) => ({ ...row, chain_id: 4663 }))),
  });
  let stopped = false,
    timer,
    pending;
  let streamStatus = enabled ? "connecting" : "disabled";
  let streamLastSeenAt = null;
  async function observe() {
    try {
      store.prune();
      const response = await handleFeed(new Request("http://localhost/api/tracked-feed"));
      if (response.ok) {
        streamStatus = "connected";
        streamLastSeenAt = Date.now() / 1000;
      } else streamStatus = "unavailable";
    } catch {
      streamStatus = "unavailable";
    }
    if (!stopped) {
      timer = setTimeout(kick, 4000);
      timer.unref();
    }
  }
  function kick() {
    pending = observe();
  }
  return {
    start() {
      if (!enabled || stopped || pending) return;
      collector.start();
      kick();
    },
    snapshot() {
      return {
        ...collector.snapshot(),
        stream_status: streamStatus,
        stream_last_seen_at: streamLastSeenAt,
      };
    },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await collector.stop();
      await pending;
    },
  };
}
