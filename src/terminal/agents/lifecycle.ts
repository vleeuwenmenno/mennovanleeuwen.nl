/** Owns calls from before their asynchronous claim until their result is delivered. Shared by all
 * executors, so Stop, unmount, thread changes and clientDone have identical cancellation semantics. */
export class ClientCalls {
  private calls = new Map<string, AbortController>()
  private closed = false
  private thread: string | null = null

  activate(thread: string | null = this.thread) { this.closed = false; this.select(thread) }

  select(thread: string | null) {
    if (thread !== this.thread) this.stop()
    this.thread = thread
  }
  stop() { for (const ctl of this.calls.values()) ctl.abort() }
  done(id: string) { this.calls.get(id)?.abort() }
  close() { this.closed = true; this.stop() }

  async run<T>(id: string, claim: () => Promise<boolean>, execute: (signal: AbortSignal) => Promise<T>, deliver: (result: T) => Promise<unknown>, outer?: AbortSignal) {
    if (this.closed || this.calls.has(id) || outer?.aborted) return
    const ctl = new AbortController()
    this.calls.set(id, ctl)
    const cancel = () => ctl.abort()
    outer?.addEventListener('abort', cancel, { once: true })
    try {
      if (!(await claim()) || ctl.signal.aborted) return
      const result = await execute(ctl.signal)
      if (!ctl.signal.aborted) await deliver(result)
    } finally {
      outer?.removeEventListener('abort', cancel)
      this.calls.delete(id)
    }
  }
}
