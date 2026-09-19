import { readFileSync } from "node:fs";
import { FomoStore, fomoUsers } from "./fomo-store.mjs";
import { FomoCollector } from "./fomo-collector.mjs";

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
  let stopped = false;
  // Keep the shared trader-event journal for relay consumers. The retired
  // website feed no longer needs a four-second all-token snapshot observer.
  return {
    start() {
      if (!enabled || stopped) return;
      collector.start();
    },
    snapshot() {
      const snapshot = collector.snapshot();
      return {
        ...snapshot,
        stream_highlights: snapshot.stream_highlights.filter((row) => users.has(row.handle)),
        stream_status: "disabled",
        stream_last_seen_at: null,
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
      await collector.stop();
    },
  };
}
