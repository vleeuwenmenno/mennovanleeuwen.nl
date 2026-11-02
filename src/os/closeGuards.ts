export type CloseGuard = () => Promise<boolean> | boolean

/** Each mounted participant owns one registration, even when several share a window PID. */
export class CloseGuards {
  private guards = new Map<number, Map<symbol, CloseGuard>>()

  register(pid: number, guard: CloseGuard): () => void {
    const token = Symbol()
    const entries = this.guards.get(pid) ?? new Map<symbol, CloseGuard>()
    this.guards.set(pid, entries)
    entries.set(token, guard)
    return () => {
      entries.delete(token)
      if (!entries.size && this.guards.get(pid) === entries) this.guards.delete(pid)
    }
  }

  has(pid: number): boolean { return this.guards.has(pid) }

  /** Ask in mount order, one dialog at a time. A refusal cancels the entire close attempt. */
  async allow(pid: number): Promise<boolean> {
    const visited = new Set<symbol>()
    for (;;) {
      // Re-read after each answer: ignore unmounted participants and include newly mounted ones.
      const next = [...(this.guards.get(pid) ?? [])].find(([token]) => !visited.has(token))
      if (!next) return true
      const [token, guard] = next
      visited.add(token)
      try { if (!await guard()) return false }
      catch { /* Preserve the existing behavior for a failed guard; still ask the other owners. */ }
    }
  }
}

export const closeGuards = new CloseGuards()
/** Return this cleanup from the participant's effect; it removes only that registration. */
export const setCloseGuard = (pid: number, guard: CloseGuard): (() => void) => closeGuards.register(pid, guard)
