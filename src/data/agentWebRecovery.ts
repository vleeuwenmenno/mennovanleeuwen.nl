// A web page the reader could not retrieve (web_fetch failed): what the card shows about it and
// what a pasted copy of the page becomes in the message box. Pure, so scripts/agents-web-recovery.ts
// can run it without a browser. The client changes nothing about what the agent was told.

/** How much of an address the one-line label of a card shows. */
export const LABEL_URL_CHARS = 80

/** An address as a label shows it: no scheme or www, cut with an ellipsis (never silently) past `max`. */
export function labelUrl(url: string, max = LABEL_URL_CHARS): string {
  const bare = url.replace(/^https?:\/\/(www\.)?/, '')
  return bare.length > max ? `${bare.slice(0, max)}…` : bare
}

/** The address to open in a new tab: only http(s), as the URL parser writes it. Null for anything else. */
export function openableUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null
  try {
    const u = new URL(url.trim())
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null
  } catch {
    return null
  }
}

const NOT_THE_READER = /^(The user (declined|denied|did not allow)|Not run:|Only http\(s\) URLs)/

/** A web_fetch that failed: the address the agent asked for and the error as the server gave it. Null for any other call or a result that is fine (or not in yet). */
export function failedWebRead(call: { name: string; arguments?: Record<string, unknown> }, result: string | undefined): { url: string; error: string } | null {
  if (call.name !== 'web_fetch' || !result) return null
  const url = call.arguments?.url
  if (typeof url !== 'string' || !url) return null
  try {
    const r = JSON.parse(result) as unknown
    if (r && typeof r === 'object' && !Array.isArray(r) && 'error' in r) {
      const error = String((r as { error: unknown }).error)
      // Not the reader's doing: the user declined it, nobody answered, the run was cancelled, or it was never a web address.
      return NOT_THE_READER.test(error) ? null : { url, error }
    }
  } catch {
    /* not JSON: not a failure we know */
  }
  return null
}

/**
 * Pasted page text as the next message. The line naming the page counts toward the limits: it goes in
 * the box when the whole thing stays under `limit` characters and the box (what is typed already
 * plus it) under `room`; otherwise the text rides along as one file whose first line names the page.
 */
export function pageTextParts(url: string, pasted: string, limit: number, typed = 0, room = Infinity): { message: string; file?: string } {
  const text = pasted.replace(/\r\n?/g, '\n').trim()
  const intro = `The reader could not retrieve ${url}. This is the text of that page, copied by me:`
  const inline = `${intro}\n\n${text}`
  if (inline.length < limit && typed + inline.length + 2 <= room) return { message: inline }
  return { message: `${intro}\n(attached as a file)`, file: `Source: ${url}\n\n${text}\n` }
}

/** A message box's text with `add` after what is already typed (a blank line between), the draft kept. */
export const appendToDraft = (typed: string, add: string) => `${typed.trim() ? `${typed.trimEnd()}\n\n` : ''}${add}`
