from io import BytesIO
import json
from pathlib import Path
import tempfile
import unittest
from urllib.error import URLError

from fomo_telegram import DeliveryError, FomoTelegram, TelegramClient
import sqlite3
import threading
from types import SimpleNamespace


class TelegramErrorTests(unittest.TestCase):
    def test_arbitrary_delivery_error_never_reaches_disk_or_status(self):
        marker = "_".join(["synthetic", "telegram", "credential"])
        for message in (marker, f"https://api.telegram.org/bot{marker}/sendMessage",
                        f"Telegram HTTP 401 {marker}"):
            with self.subTest(message=message), tempfile.TemporaryDirectory() as directory:
                tracker = SimpleNamespace(db=sqlite3.connect(Path(directory) / "state.sqlite"),
                                          lock=threading.RLock(), now=lambda: 100)
                tracker.db.row_factory = sqlite3.Row
                self.addCleanup(tracker.db.close)

                class Client:
                    destination = "fixture"

                    def send(self, body):
                        raise DeliveryError(message, retry_after=30, blocked=True)

                notifier = FomoTelegram(tracker, Client(), {})
                tracker.db.execute("""INSERT INTO telegram_outbox
                    VALUES ('fixture','event','body','pending',0,0,0,NULL,0,NULL,NULL)""")
                tracker.db.commit()
                self.assertFalse(notifier.tick())
                self.assertEqual(notifier.snapshot()["error"], "Telegram delivery failed")
                self.assertTrue(notifier.blocked)
                row = tracker.db.execute("SELECT error,next_attempt,status FROM telegram_outbox").fetchone()
                self.assertEqual(tuple(row), ("Telegram delivery failed", 130, "pending"))
                for path in Path(directory).iterdir():
                    self.assertNotIn(marker.encode(), path.read_bytes())
                tracker.db.close()

    def test_transport_url_and_upstream_description_are_discarded(self):
        token = "123:" + "synthetic" * 4

        def failing_request(request, **kwargs):
            raise URLError(request.full_url)

        client = TelegramClient(token, "123", request_fn=failing_request)
        with self.assertRaises(DeliveryError) as failure:
            client.send("test")
        self.assertEqual(str(failure.exception), "Telegram transport or response error")
        client.request_fn = lambda *args, **kwargs: BytesIO(json.dumps({
            "ok": False, "error_code": 429, "description": token,
            "parameters": {"retry_after": 30},
        }).encode())
        with self.assertRaises(DeliveryError) as failure:
            client.send("test")
        self.assertEqual(str(failure.exception), "Telegram HTTP 429")
        self.assertEqual(failure.exception.retry_after, 30)


if __name__ == "__main__":
    unittest.main()
