import { notify } from '../../os/notify'

// Doing one thing to many threads. The server has no bulk endpoint, so each thread goes through the
// same call a single one does, a few at a time; what failed is said in a notification, never dropped.

export type BulkResult<T> = { done: T[]; failed: { item: T; error: string }[] }

/** Runs `job` on every item, at most `limit` at once. A job that throws is a failure, the rest carry on. */
export async function runBulk<T>(items: T[], job: (item: T) => Promise<unknown>, limit = 4): Promise<BulkResult<T>> {
  const result: BulkResult<T> = { done: [], failed: [] }
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++]
      try {
        await job(item)
        result.done.push(item)
      } catch (e) {
        result.failed.push({ item, error: e instanceof Error ? e.message : String(e) })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return result
}

const threads = (n: number) => (n === 1 ? '1 thread' : `${n} threads`)

/**
 * Tells how a bulk action went: a short pop-up when all went well, and one that stays until
 * dismissed when some did not (naming the first few threads and why).
 */
export function reportBulk<T>(verb: string, result: BulkResult<T>, name: (item: T) => string) {
  const { done, failed } = result
  if (!failed.length) {
    if (done.length) notify({ title: `${verb} ${threads(done.length)}`, transient: true })
    return
  }
  const shown = failed.slice(0, 3).map((f) => `“${name(f.item)}”: ${f.error}`)
  if (failed.length > shown.length) shown.push(`and ${failed.length - shown.length} more`)
  notify({ title: `${verb} ${done.length} of ${done.length + failed.length} threads`, body: `${failed.length} failed. ${shown.join(' ')}`, transient: true, sticky: true })
}
