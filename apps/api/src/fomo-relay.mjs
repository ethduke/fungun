import { createHash, timingSafeEqual } from "node:crypto";

const digest = (value) => createHash("sha256").update(value).digest();

// A bounded journal read for the Telegram worker. It never creates an upstream socket.
export function createFomoRelayHandler(fomo, token, next) {
  const expected = typeof token === "string" && token.length >= 32 ? digest(`Bearer ${token}`) : null;
  return (req, res) => {
    const path = (req.url || "").split("?")[0];
    if (path !== "/internal/fomo/events") return next(req, res);
    res.setHeader("cache-control", "no-store");
    res.setHeader("content-type", "application/json");
    const reply = (status, body) => { res.writeHead(status); res.end(JSON.stringify(body)); };
    if (!expected) return reply(404, { error: "not_found" });
    if (req.method !== "GET") return reply(405, { error: "method_not_allowed" });
    const authorization = req.headers.authorization;
    if (typeof authorization !== "string" || !timingSafeEqual(expected, digest(authorization)))
      return reply(401, { error: "unauthorized" });
    try {
      const params = new URL(req.url, "http://localhost").searchParams;
      const after = params.get("after") ?? "0";
      if ([...params.keys()].some((key) => key !== "after") || params.getAll("after").length > 1 ||
          !/^(0|[1-9]\d*)$/.test(after) || !Number.isSafeInteger(Number(after)))
        return reply(400, { error: "invalid_cursor" });
      return reply(200, fomo.journal(Number(after)));
    } catch {
      return reply(503, { error: "journal_unavailable" });
    }
  };
}
