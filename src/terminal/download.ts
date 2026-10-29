import { CmdError, type Ctx } from './types'

/** Check before retaining response data or handing it to a filesystem mutation. */
export function checkDownload(ctx: Pick<Ctx, 'signal' | 'budget' | 'policy'>, signal = ctx.signal) {
  signal.throwIfAborted()
  if (ctx.policy && !ctx.budget) throw new CmdError('download: agent budget required')
  const why = ctx.budget?.step()
  if (why) throw new CmdError(`download: shared budget ${why}`)
}

/** Account for both incoming bytes and retained UTF-16 text before decoding/accumulation.
 * Content-Length is not trusted. A file download uses the same limits as stdout; no partial
 * file is persisted. TextDecoder matches Response.text's UTF-8 replacement semantics. */
export async function downloadText(response: Response, ctx: Pick<Ctx, 'signal' | 'budget' | 'policy'>, signal = ctx.signal): Promise<string> {
  checkDownload(ctx, signal)
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = '', bytes = 0, chunks = 0
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  const append = (part: string) => {
    checkDownload(ctx, signal)
    const why = ctx.budget?.write(part.length, text.length)
    if (why) throw new CmdError(`download: shared budget ${why}`)
    text += part
  }
  try {
    while (true) {
      // Let cancellation and deadline timers run even with immediately available tiny chunks.
      if (++chunks % 64 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0))
      checkDownload(ctx, signal)
      const next = await reader.read()
      checkDownload(ctx, signal)
      if (next.done) break
      const why = ctx.budget?.write(next.value.byteLength, bytes)
      if (why) throw new CmdError(`download: shared budget ${why}`)
      bytes += next.value.byteLength
      append(decoder.decode(next.value, { stream: true }))
    }
    append(decoder.decode())
    return text
  } finally {
    signal.removeEventListener('abort', cancel)
    cancel()
    reader.releaseLock()
  }
}
