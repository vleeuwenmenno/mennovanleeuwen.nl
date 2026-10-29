import { LIMITS, type Descriptor, type Mutation, type Snapshot, type WidgetInput } from './package'
import { FairScheduler, RuntimeFailure } from './scheduler'
const scheduler = new FairScheduler()
let request = 0
if (typeof window !== 'undefined') {
  for (const event of ['mvlos:account-changed', 'mvlos:forget']) window.addEventListener(event, () => scheduler.cancelAll())
  document.addEventListener('visibilitychange', () => { if (document.visibilityState !== 'visible') scheduler.cancelAll() })
}
export function execute(snapshot: Snapshot, input: WidgetInput, event?: string, signal?: AbortSignal, options: { owner?: string; eligible?: () => boolean } = {}): Promise<Descriptor | Mutation | null> {
  try {
    if (new TextEncoder().encode(JSON.stringify(input)).length > LIMITS.outputBytes) return Promise.reject(new RuntimeFailure('input', 'Widget input exceeds limit'))
  } catch { return Promise.reject(new RuntimeFailure('input', 'Invalid widget input')) }
  return scheduler.submit(options.owner ?? `preview:${request++}`, workerSignal => new Promise((resolve, reject) => {
    let worker: Worker | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let ended = false
    const finish = (error?: Error, value?: Descriptor | Mutation | null) => {
      if (ended) return
      ended = true
      clearTimeout(timer)
      workerSignal.removeEventListener('abort', abort)
      worker?.terminate()
      if (error) reject(error); else resolve(value ?? null)
    }
    const abort = () => finish(new RuntimeFailure('cancelled', 'Widget transaction cancelled'))
    workerSignal.addEventListener('abort', abort, { once: true })
    try {
      worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
      timer = setTimeout(() => finish(new RuntimeFailure('execution', 'Widget watchdog terminated worker')), 3000)
      worker.onerror = () => finish(new RuntimeFailure('execution', 'Widget worker unavailable'))
      worker.onmessage = e => e.data.ok ? finish(undefined, e.data.value) : finish(new RuntimeFailure('execution', e.data.error))
      worker.postMessage({ snapshot, input, event })
    } catch { finish(new RuntimeFailure('execution', 'Widget worker could not start')) }
  }), signal, options.eligible ?? (() => document.visibilityState === 'visible'))
}
