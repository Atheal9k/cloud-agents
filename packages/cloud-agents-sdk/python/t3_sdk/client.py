from __future__ import annotations

import json
from urllib.error import HTTPError
from urllib.request import Request, urlopen


class CloudAgentsSdkError(Exception):
    def __init__(self, code: str, message: str, status: int, retry_after_seconds: int | None = None):
        super().__init__(message)
        self.code = code
        self.status = status
        self.retry_after_seconds = retry_after_seconds


class CloudAgentsClient:
    """Workflow client for durable agents and runs. Not a chat-completions API."""

    def __init__(self, base_url: str, api_key: str, stability: str = "v1"):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.stability = stability

    def create_agent(self, prompt: str, *, idempotency_key: str | None = None) -> dict:
        return self._request("POST", "/agents", {"prompt": {"text": prompt}}, idempotency_key)

    def list_agents(self, *, limit: int | None = None, cursor: str | None = None) -> dict:
        query = []
        if limit is not None:
            query.append(f"limit={limit}")
        if cursor is not None:
            query.append(f"cursor={cursor}")
        suffix = f"?{'&'.join(query)}" if query else ""
        return self._request("GET", f"/agents{suffix}")

    def create_run(self, agent_id: str, prompt: str, *, idempotency_key: str | None = None) -> dict:
        return self._request(
            "POST",
            f"/agents/{agent_id}/runs",
            {"prompt": {"text": prompt}},
            idempotency_key,
        )

    def stream_run(self, agent_id: str, run_id: str, *, last_event_id: str | None = None) -> str:
        headers = self._headers()
        if last_event_id:
            headers["Last-Event-ID"] = last_event_id
        request = Request(self._url(f"/agents/{agent_id}/runs/{run_id}/stream"), headers=headers)
        with urlopen(request) as response:
            return response.read().decode("utf-8")

    def create_webhook(self, url: str, events: list[str] | None = None) -> dict:
        body: dict = {"url": url}
        if events is not None:
            body["events"] = events
        return self._request("POST", "/webhooks", body)

    def _url(self, path: str) -> str:
        return f"{self.base_url}/{self.stability}{path}"

    def _headers(self, idempotency_key: str | None = None) -> dict[str, str]:
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "T3-Api-Version": "2026-09-19",
        }
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        return headers

    def _request(self, method: str, path: str, body: dict | None = None, idempotency_key: str | None = None):
        data = None if body is None else json.dumps(body).encode("utf-8")
        request = Request(self._url(path), data=data, headers=self._headers(idempotency_key), method=method)
        try:
            with urlopen(request) as response:
                payload = response.read().decode("utf-8")
                return json.loads(payload) if payload else None
        except HTTPError as error:
            raw = error.read().decode("utf-8")
            retry_after = error.headers.get("Retry-After") if error.headers else None
            code = "internal_error"
            message = raw
            try:
                parsed = json.loads(raw)
                code = parsed.get("code", code)
                message = parsed.get("message", message)
            except json.JSONDecodeError:
                pass
            raise CloudAgentsSdkError(
                code,
                message,
                error.code,
                int(retry_after) if retry_after else None,
            ) from error
