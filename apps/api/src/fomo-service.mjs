import { readFileSync } from "node:fs";
import { FomoStore, fomoUsers } from "./fomo-store.mjs";
import { FomoCollector } from "./fomo-collector.mjs";
import { NarrativeStore } from "./narrative-store.mjs";
import { createTrackedFeedHandler } from "../../web/lib/tracked-feed-handler.mjs";
import { getO1Hooks, getStableAssets } from "../../web/lib/tracked-feed-registry.mjs";

export function createFomoService(db, env = process.env) {
  const users = fomoUsers(
    JSON.parse(
      readFileSync(env.FOMO_USERS_PATH || new URL("./fomo-users.json", import.meta.url), "utf8"),
    ),
  );
  const relayUsers = fomoUsers(
    JSON.parse(readFileSync(new URL("./fomo-relay-users.json", import.meta.url), "utf8")),
  );
  const store = new FomoStore(
    db, new Map([...relayUsers, ...users]), Date.now, env.FOMO_MAX_CONNECTIONS_5M,
  );
  const enabled = env.FOMO_ENABLED === "1";
  const collector = new FomoCollector(store, { enabled, key: env.FOMO_API_KEY || "" });
  const narratives = new NarrativeStore(db);
  const handleFeed = createTrackedFeedHandler({
    loadHookRegistry: getO1Hooks,
    loadStableRegistry: getStableAssets,
    onSnapshot: (snapshot) => {
      store.register(snapshot.pools.map((row) => ({ ...row, chain_id: 4663 })));
      narratives.observe(snapshot.pools);
    },
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
      const snapshot = collector.snapshot();
      return {
        ...snapshot,
        narratives: narratives.snapshot(),
        stream_highlights: snapshot.stream_highlights.filter((row) => users.has(row.handle)),
        stream_status: streamStatus,
        stream_last_seen_at: streamLastSeenAt,
      };
    },
    journal(after) {
      const { connected, state, delay_seconds, realtime, retry_at, last_message_at } = collector.status;
      return {
        ...store.journal(after),
        collector: { connected, state, delay_seconds, realtime, retry_at, last_message_at },
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
