import type { Budget } from './limits'
import { CmdError } from './types'

export type BoundContext = { signal?: AbortSignal; budget?: Budget; policy?: unknown }
/** Synchronous adapters have a small, explicit input ceiling as well as shared accounting.
 * Units conservatively include retained strings, byte conversions, line arrays and markup;
 * they are not a measurement of the JavaScript heap. Streaming adapters charge separately. */
export const SYNC_TEXT_LIMIT = 64 * 1024
export function reserve(ctx: BoundContext, size: number, held = 0) {
  ctx.signal?.throwIfAborted()
  if (ctx.policy && !ctx.budget) throw new CmdError('msh: agent budget required', false, 126)
  if (!ctx.budget) return
  const stopped = ctx.budget.step() ?? (!Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(held) || held < 0
    ? ctx.budget.stop('memory') : ctx.budget.write(size, held))
  if (stopped) throw new CmdError(`msh: shared budget ${stopped}`)
}
export function textWork(ctx: BoundContext, length: number, factor = 64) {
  reserve(ctx, 0)
  if (ctx.budget && length > SYNC_TEXT_LIMIT) {
    ctx.budget.stop('memory')
    throw new CmdError('msh: synchronous input exceeds 65536 characters')
  }
  reserve(ctx, length * factor)
}
export function singleInput(ctx: BoundContext, count: number) {
  reserve(ctx, 0)
  if (ctx.policy && count > 1) throw new CmdError('msh: agent text/byte/hash commands accept one input; use separate commands', false, 126)
}
