import { LIMITS, type Descriptor, type Mutation, type Snapshot, type WidgetInput } from './package'
let active = 0
let starts: number[] = []
const cancellations = new Set<() => void>()
if (typeof window !== 'undefined') for (const event of ['mvlos:account-changed', 'mvlos:forget']) window.addEventListener(event, () => { for (const cancel of [...cancellations]) cancel() })
/** No queue or persistent worker. Aggregate cap + watchdog covers VM/bootstrap failures too. */
export function execute(snapshot: Snapshot, input: WidgetInput, event?: string, signal?: AbortSignal): Promise<Descriptor | Mutation | null> {
  const now = performance.now()
  starts = starts.filter(time => now - time < 1000)
  if (starts.length >= 32 || active >= LIMITS.workers || signal?.aborted || new TextEncoder().encode(JSON.stringify(input)).length > LIMITS.outputBytes) return Promise.reject(new Error('Widget runtime busy or input exceeds limit'))
  starts.push(now)
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    active++
    let ended = false
    const finish = (error?: string, value?: Descriptor | Mutation | null) => {
      if (ended) return
      ended = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      cancellations.delete(abort)
      worker.terminate()
      active--
      if (error) reject(new Error(error)); else resolve(value ?? null)
    }
    const abort = () => finish('Widget transaction cancelled')
    cancellations.add(abort)
    const timer = setTimeout(() => finish('Widget watchdog terminated worker'), 3000)
    signal?.addEventListener('abort', abort, { once: true })
    worker.onerror = () => finish('Widget worker unavailable')
    worker.onmessage = e => e.data.ok ? finish(undefined, e.data.value) : finish(e.data.error)
    worker.postMessage({ snapshot, input, event })
  })
}
