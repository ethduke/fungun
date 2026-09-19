"""Telegram delivery from the existing FOMO event cache."""
from datetime import datetime, timezone
import hashlib
import html
import json
import math
import os
from pathlib import Path
import re
import threading
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import HTTPRedirectHandler, Request, build_opener


def settings(env_path=".env"):
    names = ("TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "TELEGRAM_MESSAGE_THREAD_ID",
             "FOMO_TELEGRAM_ENABLED")
    values = {}
    try:
        for line in Path(env_path).read_text().splitlines():
            key, sep, value = line.removeprefix("export ").partition("=")
            if sep and key.strip() in names:
                values[key.strip()] = value.strip().strip("\"'")
    except OSError:
        pass
    return {name: os.environ.get(name, values.get(name, "")) for name in names}


class DeliveryError(Exception):
    def __init__(self, code, retry_after=0, blocked=False):
        super().__init__(code)
        self.retry_after = retry_after
        self.blocked = blocked


def safe_delivery_error(error):
    # Enforce this at the SQLite/status sink even if a client bypasses the
    # transport wrapper. Truncation or a code-shaped string is not sanitization.
    message = str(error)
    allowed = {"Telegram response invalid", "Telegram transport or response error"}
    allowed.update(f"Telegram HTTP {code}" for code in range(100, 600))
    return message if message in allowed else "Telegram delivery failed"


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class TelegramClient:
    def __init__(self, token, chat_id, topic=None, request_fn=None):
        if not re.fullmatch(r"[0-9]+:[A-Za-z0-9_-]+", token):
            raise ValueError("Invalid TELEGRAM_BOT_TOKEN format")
        if not re.fullmatch(r"-?[0-9]+|@[A-Za-z0-9_]+", str(chat_id)):
            raise ValueError("Invalid TELEGRAM_CHAT_ID format")
        self.token, self.chat_id = token, str(chat_id)
        self.topic = int(topic) if topic else None
        if self.topic is not None and self.topic <= 0:
            raise ValueError("Invalid TELEGRAM_MESSAGE_THREAD_ID")
        self.request_fn = request_fn or build_opener(NoRedirect()).open
        identity = [token.split(":", 1)[0], self.chat_id, self.topic]
        self.destination = hashlib.sha256(json.dumps(identity).encode()).hexdigest()

    def send(self, body):
        payload = {"chat_id": self.chat_id, "text": body, "parse_mode": "HTML",
                   "link_preview_options": {"is_disabled": True}}
        if self.topic:
            payload["message_thread_id"] = self.topic
        request = Request(f"https://api.telegram.org/bot{self.token}/sendMessage",
                          data=json.dumps(payload).encode(), method="POST",
                          headers={"Content-Type": "application/json"})
        try:
            try:
                with self.request_fn(request, timeout=15) as response:
                    data = json.loads(response.read())
            except HTTPError as exc:
                try:
                    data = json.loads(exc.read())
                except (ValueError, OSError):
                    data = {}
                if not isinstance(data, dict):
                    data = {}
                data.update(ok=False, error_code=exc.code)
            if not isinstance(data, dict):
                raise DeliveryError("Telegram response invalid")
            if data.get("ok") is not True:
                code = int(data.get("error_code") or 502)
                params = data.get("parameters") or {}
                delay = float(params.get("retry_after", 0))
                if not math.isfinite(delay) or delay < 0:
                    delay = 0
                raise DeliveryError(f"Telegram HTTP {code}", retry_after=delay,
                                    blocked=code in (400, 401, 403, 404))
            message_id = data["result"]["message_id"]
            if not isinstance(message_id, int) or message_id <= 0:
                raise DeliveryError("Telegram response invalid")
            return message_id
        except DeliveryError:
            raise
        except (URLError, OSError, ValueError, TypeError, KeyError, AttributeError):
            # Request errors may embed the secret-bearing bot URL.
            raise DeliveryError("Telegram transport or response error") from None


def buy_message(event, label):
    address = str(event["token"])
    if not re.fullmatch(r"0x[0-9a-fA-F]{40}", address):
        raise ValueError("Invalid token address")
    address = address.lower()
    symbol = str(event["symbol"] or address[:10] + "…")[:100]
    user = html.escape(str(label)[:100].lstrip("@"))
    when = datetime.fromtimestamp(event["ts"], timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    lines = ["🟢 <b>FOMO BUY · Robinhood</b>",
             f'@{user} bought <a href="https://gmgn.ai/robinhood/token/{address}">{html.escape(symbol)}</a>']
    usd = event.get("usd")
    if usd is not None and math.isfinite(float(usd)) and float(usd) >= 0:
        lines.append(f"Size: ${float(usd):,.2f}")
    lines.extend([f"<code>{address}</code>", when,
                  f'<a href="https://fomo.family/profile/{quote(event["handle"], safe="")}">FOMO profile</a>'])
    return "\n".join(lines)


class FomoTelegram:
    def __init__(self, tracker, client, watchlist):
        self.tracker, self.client, self.watchlist = tracker, client, dict(watchlist)
        self.db, self.lock, self.now = tracker.db, tracker.lock, tracker.now
        self.destination = client.destination
        self.thread = None
        self.blocked = False
        self.error = None
        with self.lock:
            self.db.executescript("""
                CREATE TABLE IF NOT EXISTS telegram_subscriptions (
                    destination TEXT PRIMARY KEY, armed_at REAL, next_send_at REAL);
                CREATE TABLE IF NOT EXISTS telegram_outbox (
                    destination TEXT, event_id TEXT, body TEXT, status TEXT,
                    attempts INTEGER, next_attempt REAL, lease_until REAL,
                    message_id INTEGER, created_at REAL, sent_at REAL, error TEXT,
                    PRIMARY KEY(destination,event_id));
                CREATE INDEX IF NOT EXISTS telegram_due
                    ON telegram_outbox(destination,status,next_attempt);
            """)
            self.db.execute("INSERT OR IGNORE INTO telegram_subscriptions VALUES (?,?,?)",
                            (self.destination, self.now(), 0))
            self.db.commit()

    def enqueue(self):
        if not self.watchlist:
            return 0
        placeholders = ",".join("?" for _ in self.watchlist)
        with self.lock, self.db:
            rows = self.db.execute(f"""SELECT e.* FROM events e
                JOIN telegram_subscriptions s ON s.destination=?
                LEFT JOIN telegram_outbox o ON o.destination=s.destination AND o.event_id=e.id
                WHERE e.chain_id=4663 AND e.side='buy' AND e.source='ws_alert'
                  AND e.ts>=s.armed_at AND e.handle IN ({placeholders}) AND o.event_id IS NULL
                ORDER BY e.ts,e.id LIMIT 200""", (self.destination, *self.watchlist)).fetchall()
            for row in rows:
                event = dict(row)
                self.db.execute("""INSERT OR IGNORE INTO telegram_outbox
                    VALUES (?,?,?,'pending',0,0,0,NULL,?,NULL,NULL)""",
                                (self.destination, event["id"],
                                 buy_message(event, self.watchlist[event["handle"]]), self.now()))
        return len(rows)

    def claim(self):
        now = self.now()
        with self.lock:
            self.db.execute("BEGIN IMMEDIATE")
            try:
                subscription = self.db.execute(
                    "SELECT next_send_at FROM telegram_subscriptions WHERE destination=?",
                    (self.destination,)).fetchone()
                row = None
                if subscription[0] <= now:
                    row = self.db.execute("""SELECT * FROM telegram_outbox
                        WHERE destination=? AND ((status='pending' AND next_attempt<=?)
                            OR (status='sending' AND lease_until<=?))
                        ORDER BY created_at,event_id LIMIT 1""", (self.destination, now, now)).fetchone()
                if row:
                    self.db.execute("""UPDATE telegram_outbox SET status='sending',
                        attempts=attempts+1,lease_until=? WHERE destination=? AND event_id=?""",
                                    (now + 60, self.destination, row["event_id"]))
                    self.db.execute("UPDATE telegram_subscriptions SET next_send_at=? WHERE destination=?",
                                    (now + 3.1, self.destination))
                self.db.commit()
                return dict(row) if row else None
            except Exception:
                self.db.rollback()
                raise

    def tick(self):
        self.enqueue()
        if self.blocked:
            return False
        row = self.claim()
        if not row:
            return False
        try:
            message_id = self.client.send(row["body"])
        except DeliveryError as exc:
            self.blocked = exc.blocked
            self.error = safe_delivery_error(exc)
            delay = max(exc.retry_after, min(3600, 5 * 2 ** min(row["attempts"] + 1, 10)))
            with self.lock:
                self.db.execute("""UPDATE telegram_outbox SET status='pending',
                    next_attempt=?,lease_until=0,error=? WHERE destination=? AND event_id=?""",
                                (self.now() + delay, self.error, self.destination, row["event_id"]))
                self.db.execute("UPDATE telegram_subscriptions SET next_send_at=? WHERE destination=?",
                                (self.now() + delay, self.destination))
                self.db.commit()
            return False
        with self.lock:
            self.db.execute("""UPDATE telegram_outbox SET status='sent',message_id=?,
                sent_at=?,lease_until=0,error=NULL WHERE destination=? AND event_id=?""",
                            (message_id, self.now(), self.destination, row["event_id"]))
            self.db.commit()
            self.error = None
        return True

    def snapshot(self):
        with self.lock:
            counts = dict(self.db.execute("SELECT status,COUNT(*) FROM telegram_outbox WHERE destination=? GROUP BY status",
                                          (self.destination,)).fetchall())
            last = self.db.execute("SELECT MAX(sent_at) FROM telegram_outbox WHERE destination=?",
                                   (self.destination,)).fetchone()[0]
            return {"configured": True, "running": bool(self.thread and self.thread.is_alive()),
                    "blocked": self.blocked, "error": self.error,
                    "pending": counts.get("pending", 0) + counts.get("sending", 0),
                    "sent": counts.get("sent", 0), "last_sent_at": last}

    def run(self):
        while not self.tracker.stop_event.is_set():
            try:
                self.tick()
            except Exception as exc:
                with self.lock:
                    self.error = type(exc).__name__
                self.tracker.stop_event.wait(5)
            self.tracker.stop_event.wait(0.5)

    def start(self):
        if self.thread is None:
            self.thread = threading.Thread(target=self.run, daemon=True, name="fomo-telegram")
            self.thread.start()


def configured_telegram(tracker, watchlist, env_path=".env"):
    config = settings(env_path)
    if config["FOMO_TELEGRAM_ENABLED"] == "0":
        return None
    token, chat = config["TELEGRAM_BOT_TOKEN"], config["TELEGRAM_CHAT_ID"]
    if not token and not chat:
        return None
    if not token or not chat:
        raise ValueError("Telegram bot token and destination chat are both required")
    notifier = FomoTelegram(tracker, TelegramClient(token, chat, config["TELEGRAM_MESSAGE_THREAD_ID"]), watchlist)
    notifier.start()
    return notifier
