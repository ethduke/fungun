import WebSocket from "ws";

// One instance owned by the single-machine read service, never by an HTTP request.
export class FomoCollector {
  constructor(
    store,
    {
      key = "",
      enabled = false,
      now = Date.now,
      socketFactory = (url, options) => new WebSocket(url, options),
      schedule = setTimeout,
      cancel = clearTimeout,
    } = {},
  ) {
    Object.assign(this, { store, key, enabled, now, socketFactory, schedule, cancel });
    this.status = {
      connected: false,
      delay_seconds: null,
      realtime: null,
      last_message_at: null,
      state: enabled ? (key ? "connecting" : "not_configured") : "disabled",
    };
    this.running = false;
    this.backoff = 60_000;
  }

  start() {
    if (this.running || !this.enabled || !this.key) return;
    this.running = true;
    this.connect();
  }

  later(ms) {
    this.timer = this.schedule(() => this.connect(), Math.max(1000, ms));
    this.timer?.unref?.();
  }

  connect() {
    if (!this.running || this.socket) return;
    const reservation = this.store.reserveConnection();
    if (!reservation.allowed) {
      this.status.state = this.store.attempts() >= 12 ? "budget_exhausted" : "reconnecting";
      this.later(reservation.retryAt - this.now());
      return;
    }
    this.status.state = "connecting";
    this.status.delay_seconds = null;
    this.status.realtime = null;
    const url = new URL("wss://api.fomoapi.io/ws/alerts");
    url.searchParams.set("key", this.key);
    url.searchParams.set("chain", "robinhood");
    let socket;
    try {
      socket = this.socketFactory(url, {
        handshakeTimeout: 20_000,
        maxPayload: 256 * 1024,
        followRedirects: false,
      });
    } catch {
      this.retry(0);
      return;
    } // Never log exception messages: URLs contain the key.
    this.socket = socket;
    let openedAt = 0,
      pong = true;
    socket.on("open", () => {
      openedAt = this.now();
      this.status.connected = true;
      this.status.state = "connected";
      const ping = () => {
        if (this.socket !== socket || !this.running) return;
        if (!pong) {
          socket.terminate();
          return;
        }
        pong = false;
        socket.ping();
        this.pingTimer = this.schedule(ping, 20_000);
        this.pingTimer?.unref?.();
      };
      this.pingTimer = this.schedule(ping, 20_000);
      this.pingTimer?.unref?.();
    });
    socket.on("pong", () => {
      pong = true;
    });
    socket.on("message", (raw) => {
      this.status.last_message_at = this.now() / 1000;
      let message;
      try {
        message = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (message?.type === "welcome") {
        this.status.delay_seconds =
          Number.isFinite(message.delaySeconds) && message.delaySeconds >= 0
            ? message.delaySeconds
            : null;
        this.status.realtime = typeof message.realtime === "boolean" ? message.realtime : null;
      } else {
        try {
          this.store.ingest(message);
        } catch {
          this.status.state = "storage_error";
          this.running = false;
          socket.terminate();
        }
      }
    });
    socket.on("unexpected-response", (request, response) => {
      if ([401, 403, 429].includes(response.statusCode)) {
        this.status.state = "access_denied";
        this.store.defer(this.now() + 86_400_000);
        this.running = false;
      }
      response.resume();
      request.destroy();
      socket.terminate();
    });
    socket.on("error", () => {}); // Close drives bounded retries; do not expose raw errors.
    socket.on("close", (code) => {
      this.cancel(this.pingTimer);
      this.socket = null;
      this.status.connected = false;
      if (!this.running) return;
      if (code === 1008) {
        this.status.state = "access_denied";
        this.store.defer(this.now() + 86_400_000);
        this.running = false;
        return;
      }
      this.retry(openedAt ? this.now() - openedAt : 0);
    });
  }

  retry(duration) {
    this.status.connected = false;
    this.status.state = "reconnecting";
    if (duration >= 300_000) this.backoff = 60_000;
    const delay = this.backoff;
    this.backoff = Math.min(3_600_000, this.backoff * 2);
    this.store.defer(this.now() + delay);
    if (this.running) this.later(delay);
  }

  snapshot() {
    return {
      ...this.status,
      connections_24h: this.store.attempts(),
      stream_tokens_checked: this.store.tokenCount(),
      history_complete: false,
      stream_highlights: this.store.highlights(),
    };
  }

  stop() {
    this.running = false;
    this.cancel(this.timer);
    this.cancel(this.pingTimer);
    this.status.connected = false;
    const socket = this.socket;
    if (!socket) return Promise.resolve();
    return new Promise((resolve) => {
      socket.once("close", resolve);
      socket.terminate();
    });
  }
}
