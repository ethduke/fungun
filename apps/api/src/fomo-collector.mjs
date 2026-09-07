import WebSocket from "ws";

// Never log arbitrary provider text, URLs, error messages/stacks or close reasons.
const errorCodes = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_HAS_EXPIRED",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH",
  "WS_ERR_INVALID_UTF8",
]);
const safeErrorCode = (error) => (errorCodes.has(error?.code) ? error.code : "UNKNOWN");

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
      logger = (entry) => console.info(JSON.stringify(entry)),
    } = {},
  ) {
    Object.assign(this, { store, key, enabled, now, socketFactory, schedule, cancel, logger });
    this.status = {
      connected: false,
      delay_seconds: null,
      realtime: null,
      last_message_at: null,
      retry_at: null,
      state: enabled ? (key ? "connecting" : "not_configured") : "disabled",
    };
    this.running = false;
    this.backoff = 60_000;
  }

  log(event, fields = {}) {
    try {
      this.logger({ component: "fomo", event, at: this.now(), ...fields });
    } catch {
      /* Diagnostics must never interrupt collection or retries. */
    }
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
      this.status.state = reservation.reason;
      this.status.retry_at = reservation.retryAt / 1000;
      this.log("connection_deferred", {
        reason: reservation.reason,
        retry_at: this.status.retry_at,
        connections_24h: this.store.attempts(),
        max_connections_24h: this.store.maxConnections24h,
      });
      this.later(reservation.retryAt - this.now());
      return;
    }
    this.status.state = "connecting";
    this.status.retry_at = null;
    this.log("connection_attempt", {
      connections_24h: this.store.attempts(),
      max_connections_24h: this.store.maxConnections24h,
    });
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
    } catch (error) {
      this.log("disconnected", {
        reason: "socket_creation_failed",
        error_code: safeErrorCode(error),
        duration_ms: 0,
      });
      this.retry(0);
      return;
    }
    this.socket = socket;
    let openedAt = null,
      welcomed = false,
      pong = true,
      disconnectReason = "remote_close",
      errorCode = null,
      httpStatus = null;
    socket.on("open", () => {
      openedAt = this.now();
      this.status.connected = true;
      this.status.state = "connected";
      this.log("connected");
      const ping = () => {
        if (this.socket !== socket || !this.running) return;
        if (!pong) {
          disconnectReason = "pong_timeout";
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
        welcomed = true;
        this.status.delay_seconds =
          Number.isFinite(message.delaySeconds) && message.delaySeconds >= 0
            ? message.delaySeconds
            : null;
        this.status.realtime = typeof message.realtime === "boolean" ? message.realtime : null;
      } else {
        try {
          this.store.ingest(message);
        } catch {
          disconnectReason = "storage_error";
          this.status.state = "storage_error";
          this.running = false;
          socket.terminate();
        }
      }
    });
    socket.on("unexpected-response", (request, response) => {
      httpStatus =
        Number.isInteger(response.statusCode) &&
        response.statusCode >= 100 &&
        response.statusCode <= 599
          ? response.statusCode
          : null;
      disconnectReason = "http_error";
      if ([401, 403, 429].includes(httpStatus)) {
        this.status.state = "access_denied";
        this.store.defer(this.now() + 86_400_000);
        this.running = false;
      }
      response.resume();
      request.destroy();
      socket.terminate();
    });
    socket.on("error", (error) => {
      errorCode = safeErrorCode(error);
      if (disconnectReason === "remote_close") disconnectReason = "socket_error";
    }); // Close drives bounded retries; only allowlisted codes reach the log.
    socket.on("close", (code) => {
      this.cancel(this.pingTimer);
      this.socket = null;
      this.status.connected = false;
      this.status.delay_seconds = null;
      this.status.realtime = null;
      const duration = openedAt === null ? 0 : Math.max(0, this.now() - openedAt);
      this.log("disconnected", {
        reason:
          code === 1008
            ? "policy_denied"
            : !this.running && disconnectReason === "remote_close"
              ? "stopped"
              : disconnectReason,
        close_code: Number.isInteger(code) && code >= 1000 && code <= 4999 ? code : null,
        error_code: errorCode,
        http_status: httpStatus,
        duration_ms: duration,
      });
      if (!this.running) return;
      if (code === 1008) {
        this.status.state = "access_denied";
        this.store.defer(this.now() + 86_400_000);
        this.running = false;
        return;
      }
      this.retry(duration, welcomed);
    });
  }

  retry(duration, welcomed = false) {
    this.status.connected = false;
    this.status.state = "reconnecting";
    if (duration >= 300_000) this.backoff = 60_000;
    // A working app feed that flaps is different from a failed handshake.
    // Keep recovery bounded after a welcome; the durable daily cap still applies.
    const delay = Math.min(this.backoff, welcomed ? 300_000 : 3_600_000);
    this.backoff = Math.min(3_600_000, this.backoff * 2);
    const retryAt = this.now() + delay;
    this.store.defer(retryAt);
    this.status.retry_at = retryAt / 1000;
    this.log("retry_scheduled", { delay_ms: delay, retry_at: this.status.retry_at });
    if (this.running) this.later(delay);
  }

  snapshot() {
    return {
      ...this.status,
      connections_24h: this.store.attempts(),
      max_connections_24h: this.store.maxConnections24h,
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
