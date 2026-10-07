/**
 * Server-sent events from a streamed body (`ApiClient.stream`), for `chat send`. Transport only:
 * it yields each frame's `data` and parses nothing — the caller validates it (AG-UI frames carry
 * the type inside the JSON and no `event:` line). The same framing rules as the web UI's
 * `ui/lib/sse.ts`: frames end at a blank line, `\r\n` is normalised, several `data:` lines join
 * with `\n`, a `:` comment is ignored, one optional space after the colon is stripped, and a frame
 * split across chunks (mid-line included) is reassembled.
 */

/** One frame's `data`, or null for a frame with none (a comment / keep-alive). Pure. */
export function sseFrameData(raw: string): string | null {
  const data: string[] = []
  for (const line of raw.split('\n')) {
    if (!line || line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') data.push(value)
  }
  return data.length === 0 ? null : data.join('\n')
}

/** Each frame's `data` as the body arrives; whatever is left when it closes is the last frame. */
export async function* readSseData(body: AsyncIterable<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of body) {
    // Normalised after joining, so a `\r` | `\n` split across two chunks still pairs up.
    buffer = (buffer + decoder.decode(chunk, { stream: true })).replace(/\r\n/g, '\n')
    let sep = buffer.indexOf('\n\n')
    while (sep !== -1) {
      const data = sseFrameData(buffer.slice(0, sep))
      buffer = buffer.slice(sep + 2)
      if (data !== null) yield data
      sep = buffer.indexOf('\n\n')
    }
  }
  buffer = (buffer + decoder.decode()).replace(/\r\n/g, '\n')
  if (buffer.trim()) {
    const data = sseFrameData(buffer)
    if (data !== null) yield data
  }
}
