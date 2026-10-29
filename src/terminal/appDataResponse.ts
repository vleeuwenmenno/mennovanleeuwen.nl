import { safeJq, SAFE_JQ_LIMITS, type SafeJqBudget } from './jq-safe'

/** Bound bytes before parsing, including error responses; do not trust Content-Length. */
export async function appDataResponse(response: Response, context: { signal: AbortSignal; budget?: SafeJqBudget; policy?: unknown }): Promise<unknown> {
  context.signal.throwIfAborted()
  if (context.policy && !context.budget) throw new Error('mvl: agent budget required')
  if (!response.body) throw new Error('mvl: missing response body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let bytes = 0, text = '', chunks = 0
  const cancel = () => { void reader.cancel().catch(() => {}) }
  context.signal.addEventListener('abort', cancel, { once: true })
  try {
    while (true) {
      if (++chunks % 64 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0))
      context.signal.throwIfAborted()
      if (chunks > 4096) throw new Error('mvl: response chunk limit')
      const next = await reader.read()
      context.signal.throwIfAborted()
      const stopped = context.budget?.step()
      if (stopped) throw new Error(`mvl: shared budget ${stopped}`)
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > SAFE_JQ_LIMITS.text) {
        context.budget?.stop('memory')
        throw new Error('mvl: response exceeds 65536 bytes; narrow the request')
      }
      const limited = context.budget?.write(next.value.byteLength, text.length)
      if (limited) throw new Error(`mvl: shared budget ${limited}`)
      text += decoder.decode(next.value, { stream: true })
    }
    text += decoder.decode()
  } finally {
    context.signal.removeEventListener('abort', cancel)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  // safeJq preflights depth before JSON.parse, validates nodes/size, and yields while processing.
  return JSON.parse(await safeJq(['-c', '.'], text, context))
}
