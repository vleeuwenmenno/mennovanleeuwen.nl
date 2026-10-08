import { useSyncExternalStore } from 'react'

// Desktop notifications, Omarchy (mako) style: a short stack in the top-right corner that fades
// out on its own. Anything can post one.

export type Notice = { id: number; title: string; body?: string; icon?: string; onClick?: () => void; at: number; /** Stays until dismissed. */ sticky?: boolean }

const LIFETIME_MS = 7000
const MAX = 4
let notices: Notice[] = []
let nextId = 1
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

export function notify(n: Omit<Notice, 'id' | 'at'>) {
  const id = nextId++
  notices = [...notices, { ...n, id, at: Date.now() }].slice(-MAX)
  emit()
  if (!n.sticky) setTimeout(() => dismiss(id), LIFETIME_MS)
}

export function dismiss(id: number) {
  if (!notices.some((n) => n.id === id)) return
  notices = notices.filter((n) => n.id !== id)
  emit()
}

export function useNotices() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => notices,
  )
}
