from __future__ import annotations

import io
import json
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from t3_sdk.client import CloudAgentsClient, CloudAgentsSdkError
from t3_sdk.sse import parse_sse, resume_sse
from t3_sdk.webhooks import sign_webhook, verify_webhook


FIXTURE = json.loads((Path(__file__).resolve().parents[2] / "fixtures" / "conformance.json").read_text())


class ConformanceTest(unittest.TestCase):
    def test_pagination_sse_and_webhooks(self) -> None:
        page = FIXTURE["pagination"]
        self.assertEqual(page["nextCursor"], "agent-0")
        self.assertEqual(len(page["items"]), 2)

        events = parse_sse("".join(FIXTURE["sse"]))
        self.assertEqual([event["event"] for event in events], ["status", "result"])
        resumed = resume_sse(events, "1000-0")
        self.assertEqual([event["event"] for event in resumed], ["result"])

        signature = sign_webhook(
            secret=FIXTURE["webhook"]["secret"],
            timestamp_seconds=FIXTURE["webhook"]["timestampSeconds"],
            body=FIXTURE["webhook"]["body"],
        )
        self.assertTrue(
            verify_webhook(
                secret=FIXTURE["webhook"]["secret"],
                timestamp_seconds=FIXTURE["webhook"]["timestampSeconds"],
                body=FIXTURE["webhook"]["body"],
                signature=signature,
                now_seconds=FIXTURE["webhook"]["timestampSeconds"] + 5,
            )
        )
        self.assertFalse(
            verify_webhook(
                secret=FIXTURE["webhook"]["secret"],
                timestamp_seconds=FIXTURE["webhook"]["timestampSeconds"],
                body=FIXTURE["webhook"]["body"],
                signature=signature,
                now_seconds=FIXTURE["webhook"]["timestampSeconds"] + 400,
            )
        )
        self.assertEqual(FIXTURE["error"]["code"], "rate_limited")

    def test_client_exposes_retry_after_and_sends_idempotency_key(self) -> None:
        client = CloudAgentsClient("http://controller.test", "t3ca_test")
        calls: list[object] = []

        def failing_urlopen(request, *args, **kwargs):
            calls.append(request)
            raise HTTPError(
                request.full_url,
                429,
                "Too Many Requests",
                {"Retry-After": "2"},
                io.BytesIO(json.dumps(FIXTURE["error"]).encode("utf-8")),
            )

        with patch("t3_sdk.client.urlopen", failing_urlopen):
            with self.assertRaises(CloudAgentsSdkError) as raised:
                client.create_agent("Add a README", idempotency_key=FIXTURE["idempotencyKey"])
        error = raised.exception
        self.assertEqual(error.code, "rate_limited")
        self.assertEqual(error.retry_after_seconds, 2)
        self.assertEqual(calls[0].get_header("Idempotency-key"), FIXTURE["idempotencyKey"])


if __name__ == "__main__":
    unittest.main()
