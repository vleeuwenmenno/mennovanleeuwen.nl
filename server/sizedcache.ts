// A FIFO cache with a hard cap on entries and on estimated bytes. Oldest entries go first, so memory
// stays bounded however many unique keys arrive. An entry counts as 0 bytes until `settle` gives its size.

interface Slot<T> {
  value: T
  at: number
  bytes: number
}

export interface SizedCache<T> {
  get(key: string): { value: T; at: number } | undefined
  set(key: string, value: T): void
  /** Records the real size of an entry once known; evicts the oldest while over the byte cap. */
  settle(key: string, value: T, bytes: number): void
  delete(key: string, value?: T): void
  size(): number
  bytes(): number
}

export function sizedCache<T>(opts: { maxEntries: number; maxBytes: number; now?: () => number }): SizedCache<T> {
  const now = opts.now ?? Date.now
  const slots = new Map<string, Slot<T>>()
  let total = 0

  const drop = (key: string) => {
    const s = slots.get(key)
    if (!s) return
    total -= s.bytes
    slots.delete(key)
  }
  const trim = (keep: number) => {
    for (const k of slots.keys()) {
      if (slots.size <= keep && total <= opts.maxBytes) break
      drop(k)
    }
  }

  return {
    get: (key) => slots.get(key),
    set(key, value) {
      drop(key)
      trim(opts.maxEntries - 1)
      slots.set(key, { value, at: now(), bytes: 0 })
    },
    settle(key, value, bytes) {
      const s = slots.get(key)
      if (!s || s.value !== value) return
      if (bytes > opts.maxBytes) return drop(key) // too big to keep at all
      total += bytes - s.bytes
      s.bytes = bytes
      trim(opts.maxEntries)
    },
    delete(key, value) {
      if (value !== undefined && slots.get(key)?.value !== value) return
      drop(key)
    },
    size: () => slots.size,
    bytes: () => total,
  }
}
