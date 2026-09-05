export function createIpfsWorker(store, publisher, { enabled = false, intervalMs = 1000 } = {}) {
  let closed = false;
  let running = null;
  let requested = false;
  async function drain() {
    for (const row of store.pending()) {
      if (closed) break;
      store.defer(row.id);
      try {
        if (row.state === "published") { store.cleanup(row.id); continue; }
        const bundle = await store.bundle(row);
        store.staged(row.id);
        for (const kind of ["image", "metadata"]) {
          if (closed) break;
          let object = store.objects(row.id).find((item) => item.kind === kind);
          const content = bundle[kind];
          if (kind === 'image' && object.state === 'ready' && store.reuseImage(row))
            object = store.objects(row.id).find((item) => item.kind === kind);
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
          if (object.state === "pinned") {
            debit();
            await publisher.inspectPin(object.provider_id, content);
            debit();
            await publisher.verifyObject(content);
            store.verified(row.id, kind);
          }
        }
        if (!closed) store.complete(row.id);
      } catch (error) {
        // Retain reservations and any uncertain POST; the next pass only reconciles it.
        store.failed(row.id, error);
      }
    }
  }
  const kick = () => {
    if (!enabled || closed) return;
    requested = true;
    if (running) return;
    running = (async () => {
      do { requested = false; await drain(); } while (requested && !closed);
    })().finally(() => { running = null; });
  };
  const timer = enabled ? setInterval(kick, intervalMs) : null;
  timer?.unref();
  return { kick, idle: async () => { await running; }, stop: async () => { closed = true; clearInterval(timer); await running; } };
}
