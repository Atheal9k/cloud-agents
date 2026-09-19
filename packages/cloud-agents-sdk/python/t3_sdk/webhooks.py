from __future__ import annotations

import hashlib
import hmac


REPLAY_WINDOW_SECONDS = 300


def sign_webhook(*, secret: str, timestamp_seconds: int, body: str) -> str:
    digest = hmac.new(
        secret.encode("utf-8"),
        f"{timestamp_seconds}.{body}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return f"sha256={digest}"


def verify_webhook(
    *,
    secret: str,
    timestamp_seconds: int,
    body: str,
    signature: str | None,
    now_seconds: int,
    replay_window_seconds: int = REPLAY_WINDOW_SECONDS,
) -> bool:
    if timestamp_seconds <= 0:
        return False
    if abs(now_seconds - timestamp_seconds) > replay_window_seconds:
        return False
    if signature is None or not signature.lower().startswith("sha256="):
        return False
    expected = sign_webhook(secret=secret, timestamp_seconds=timestamp_seconds, body=body)
    actual = signature.lower().encode("utf-8")
    wanted = expected.encode("utf-8")
    return len(actual) == len(wanted) and hmac.compare_digest(actual, wanted)
