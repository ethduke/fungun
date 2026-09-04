export function createIpfsWorker(store, publisher, { enabled = false, intervalMs = 60000 } = {}) {
  let closed = false;
  let running = null;
  async function drain() {
    for (const row of store.pending()) {
      if (closed) break;
      store.defer(row.id);
      try {
        const bundle = await store.bundle(row);
        store.staged(row.id);
        for (const kind of ["image", "metadata"]) {
          if (closed) break;
          let object = store.objects(row.id).find((item) => item.kind === kind);
          const content = bundle[kind];
          const debit = () => store.budget.debit([["pinata-requests", 20, 60000], ["pinata-requests", 500, 86400000]]);
          if (object.state === "ready") {
            debit();
            if (!store.begin(row.id, kind)) break;
            const receipt = await publisher.pinObject(content);
            store.pinned(row.id, kind, receipt);
          } else if (object.state === "sending") {
            debit();
            const receipt = await publisher.findPin(content);
            store.pinned(row.id, kind, receipt);
          }
          object = store.objects(row.id).find((item) => item.kind === kind);
          if (object.state === "pinned" || object.state === "verified") {
            debit();
            await publisher.inspectPin(object.provider_id, content);
            debit();
            await publisher.verifyObject(content);
            store.verified(row.id, kind);
          }
        }
        if (!closed) store.complete(row.id);
      } catch {
        // Retain reservations and any uncertain POST; the next pass only reconciles it.
      }
    }
  }
  const kick = () => {
    if (!enabled || closed || running) return;
    running = drain().finally(() => { running = null; });
  };
  const timer = enabled ? setInterval(kick, intervalMs) : null;
  timer?.unref();
  return { kick, idle: async () => { await running; }, stop: async () => { closed = true; clearInterval(timer); await running; } };
}
