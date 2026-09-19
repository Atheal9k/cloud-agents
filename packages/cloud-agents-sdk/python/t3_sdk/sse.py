from __future__ import annotations

import json


def parse_sse(body: str) -> list[dict]:
    events: list[dict] = []
    for chunk in body.split("\n\n"):
        if not chunk.strip():
            continue
        event = {"event": "message", "data": {}}
        data = ""
        for line in chunk.split("\n"):
            if line.startswith("id:"):
                event["id"] = line[3:].strip()
            elif line.startswith("event:"):
                event["event"] = line[6:].strip()
            elif line.startswith("data:"):
                data += line[5:].strip()
        if data:
            event["data"] = json.loads(data)
        events.append(event)
    return events


def resume_sse(events: list[dict], last_event_id: str | None) -> list[dict]:
    if last_event_id is None:
        return events
    for index, event in enumerate(events):
        if event.get("id") == last_event_id:
            return events[index + 1 :]
    return events
