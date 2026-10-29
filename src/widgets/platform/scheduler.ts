/** One fair, bounded queue for the tab. Rate/concurrency saturation waits; invalid input never queues. */
export class RuntimeFailure extends Error {
  readonly code: 'cancelled' | 'input' | 'capacity' | 'execution'
  constructor(code: RuntimeFailure['code'], message: string) { super(message); this.code = code }
}
export type SchedulerClock = { now: () => number; set: (callback: () => void, ms: number) => unknown; clear: (timer: unknown) => void }
const clock: SchedulerClock = { now: () => performance.now(), set: (callback, ms) => setTimeout(callback, ms), clear: timer => clearTimeout(timer as ReturnType<typeof setTimeout>) }
type Job = { owner: string; start: () => void; cancel: () => void }
export class FairScheduler {
  private queues = new Map<string, Job[]>()
  private owners: string[] = []
  private running = new Set<Job>()
  private starts: number[] = []
  private timer: unknown
  private pending = 0
  private suspended = false
  constructor(privateClock: SchedulerClock = clock, concurrency = 8, rate = 32, maxPending = 256) {
    this.clock = privateClock; this.concurrency = concurrency; this.rate = rate; this.maxPending = maxPending
  }
  private clock: SchedulerClock
  private concurrency: number
  private rate: number
  private maxPending: number
  get counts() { return { active: this.running.size, pending: this.pending, timer: this.timer !== undefined } }
  submit<T>(owner: string, work: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal, eligible: () => boolean = () => true): Promise<T> {
    if (signal?.aborted || !eligible()) return Promise.reject(new RuntimeFailure('cancelled', 'Widget transaction cancelled'))
    if (this.pending >= this.maxPending || (this.queues.get(owner)?.length ?? 0) >= 2) return Promise.reject(new RuntimeFailure('capacity', 'Widget queue capacity exceeded'))
    return new Promise<T>((resolve, reject) => {
      let ended = false, started = false
      const controller = new AbortController()
      const finish = (error: unknown, value?: T) => {
        if (ended) return
        ended = true
        signal?.removeEventListener('abort', job.cancel)
        if (started) this.running.delete(job)
        else {
          const queue = this.queues.get(owner)
          if (queue?.includes(job)) { queue.splice(queue.indexOf(job), 1); this.pending-- }
          if (!queue?.length) { this.queues.delete(owner); this.owners = this.owners.filter(key => key !== owner) }
        }
        if (error) reject(error); else resolve(value as T)
        this.pump()
      }
      const job: Job = { owner,
        cancel: () => { controller.abort(); finish(new RuntimeFailure('cancelled', 'Widget transaction cancelled')) },
        start: () => {
          if (ended) return
          if (!eligible()) { job.cancel(); return }
          started = true
          this.running.add(job)
          this.starts.push(this.clock.now())
          try { work(controller.signal).then(value => eligible() ? finish(null, value) : job.cancel(), error => finish(error)) }
          catch (error) { finish(error) }
        },
      }
      let queue = this.queues.get(owner)
      if (!queue) { this.queues.set(owner, queue = []); this.owners.push(owner) }
      queue.push(job); this.pending++
      signal?.addEventListener('abort', job.cancel, { once: true })
      this.pump()
    })
  }
  cancelAll() {
    this.suspended = true
    if (this.timer !== undefined) { this.clock.clear(this.timer); this.timer = undefined }
    for (const job of [...this.running, ...[...this.queues.values()].flat()]) job.cancel()
    this.suspended = false
  }
  private pump() {
    if (this.suspended) return
    if (this.timer !== undefined) { this.clock.clear(this.timer); this.timer = undefined }
    const now = this.clock.now()
    this.starts = this.starts.filter(start => now - start < 1000)
    while (this.owners.length && this.running.size < this.concurrency && this.starts.length < this.rate) {
      const owner = this.owners.shift()!
      const queue = this.queues.get(owner)!
      const job = queue.shift()!
      this.pending--
      if (queue.length) this.owners.push(owner); else this.queues.delete(owner)
      job.start()
    }
    if (this.owners.length && this.running.size < this.concurrency && this.starts.length >= this.rate) this.timer = this.clock.set(() => { this.timer = undefined; this.pump() }, Math.max(1, this.starts[0] + 1000 - now))
  }
}
