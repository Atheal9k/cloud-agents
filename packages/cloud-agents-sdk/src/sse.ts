import type { StreamEvent } from "./types.ts";

export function parseSse(body: string): ReadonlyArray<StreamEvent> {
  const events: StreamEvent[] = [];
  for (const chunk of body.split("\n\n")) {
    if (chunk.trim().length === 0) continue;
    let id: string | undefined;
    let event = "message";
    let data = "";
    for (const line of chunk.split("\n")) {
      if (line.startsWith("id:")) id = line.slice(3).trim();
      else if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    events.push({
      ...(id === undefined ? {} : { id }),
      event,
      data: data.length === 0 ? {} : (JSON.parse(data) as unknown),
    });
  }
  return events;
}

export function resumeSse(
  events: ReadonlyArray<StreamEvent>,
  lastEventId: string | undefined,
): ReadonlyArray<StreamEvent> {
  if (lastEventId === undefined) return events;
  const index = events.findIndex((event) => event.id === lastEventId);
  return index === -1 ? events : events.slice(index + 1);
}
