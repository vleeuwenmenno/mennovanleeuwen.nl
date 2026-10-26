import { useCallback, useEffect, useState } from 'react'
import type { Thread } from '../../data/agents'
import { accountStorage } from '../../os/accountSpace'

// Which threads have an answer that was not looked at yet. The server keeps no such thing, so each
// browser remembers when it last showed each thread; anything older than the first time this
// browser ran Agents counts as read, or every thread would start out unread.

const KEY = 'mvlos.agents.seen'
type Seen = { since: number; at: Record<string, number> }
const KEEP = 400

function read(): Seen {
  try {
    const v = JSON.parse(accountStorage.get(KEY) ?? 'null') as Partial<Seen> | null
    if (v && typeof v.since === 'number' && v.at && typeof v.at === 'object') return { since: v.since, at: v.at }
  } catch {
    /* start over */
  }
  return { since: Date.now(), at: {} }
}
function write(s: Seen) {
  try {
    accountStorage.set(KEY, JSON.stringify(s))
  } catch {
    /* not remembered */
  }
}

/** `watching`: the thread on screen now, which counts as seen as it changes. */
export function useUnread(threads: Thread[], watching: string | null) {
  const [seen, setSeen] = useState<Seen>(() => {
    const s = read()
    write(s)
    return s
  })
  useEffect(() => {
    const t = watching ? threads.find((x) => x.id === watching) : undefined
    if (!t || (seen.at[t.id] ?? 0) >= t.updatedAt) return
    setSeen((prev) => {
      const at = { ...prev.at, [t.id]: t.updatedAt }
      const ids = Object.keys(at)
      if (ids.length > KEEP) for (const id of ids.sort((a, b) => at[a] - at[b]).slice(0, ids.length - KEEP)) delete at[id]
      const next = { since: prev.since, at }
      write(next)
      return next
    })
  }, [threads, watching, seen])
  return useCallback((t: Thread) => !t.archived && !t.running && t.id !== watching && t.updatedAt > Math.max(seen.since, seen.at[t.id] ?? 0), [seen, watching])
}
