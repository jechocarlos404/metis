/**
 * POST + parse an SSE stream (EventSource can't POST). Yields {event, data}.
 * Handles \n and \r\n framing plus ':' comment/ping lines.
 */
export async function* sseStream(url, body, { signal } = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      detail = (await res.json()).detail ?? detail;
    } catch {
      /* not json */
    }
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const boundary = /\r?\n\r?\n/;

  const parse = (frame) => {
    let event = "message";
    let data = "";
    for (const rawLine of frame.split(/\r?\n/)) {
      if (!rawLine || rawLine.startsWith(":")) continue;
      if (rawLine.startsWith("event:")) event = rawLine.slice(6).trim();
      else if (rawLine.startsWith("data:")) data += (data ? "\n" : "") + rawLine.slice(5).trim();
    }
    return data ? { event, data: JSON.parse(data) } : null;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let match;
      while ((match = boundary.exec(buffer)) !== null) {
        const frame = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const parsed = parse(frame);
        if (parsed) yield parsed;
      }
    }
    const parsed = buffer.trim() ? parse(buffer) : null;
    if (parsed) yield parsed;
  } finally {
    reader.releaseLock();
  }
}
