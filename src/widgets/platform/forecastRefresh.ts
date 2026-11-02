/** Refresh from cache age, not time since mounting. One cancellable timer and request per visible widget. */
export const FORECAST_REFRESH_MS = 15 * 60_000
export type RefreshClock = { now: () => number; set: (run: () => void, ms: number) => unknown; clear: (timer: unknown) => void }
const clock: RefreshClock = { now: () => Date.now(), set: (run, ms) => setTimeout(run, ms), clear: timer => clearTimeout(timer as ReturnType<typeof setTimeout>) }
export function startForecastRefresh(load: (signal: AbortSignal) => Promise<{ at: number }>, eligible: () => boolean, time: RefreshClock = clock) {
  const abort = new AbortController()
  let timer: unknown
  const run = async () => {
    timer = undefined
    if (abort.signal.aborted || !eligible()) return
    let at = time.now()
    try { at = (await load(abort.signal)).at } catch { /* caller projects the error */ }
    if (!abort.signal.aborted && eligible()) timer = time.set(() => void run(), Math.max(1000, at + FORECAST_REFRESH_MS - time.now()))
  }
  void run()
  return () => { abort.abort(); if (timer !== undefined) time.clear(timer) }
}
