import { synced } from '../os/synced'

// Desktop launchers of your own: a label, a URL and an optional emoji. They sit on the desktop
// next to the built-in icons and show up in the launcher and Spotlight. Synced like notes.

export type Launcher = { id: string; label: string; url: string; glyph?: string; /** false: dock and menus only */ desktop?: boolean }

const store = synced<Launcher[]>('launchers', [], { normalize: (v) => (Array.isArray(v) ? v.filter((l) => l && typeof l.id === 'string' && typeof l.url === 'string') : []) })

export const useLaunchers = store.use
export const getLaunchers = store.get

/** Adds https:// when the scheme is missing; refuses anything that isn't http(s). */
export function cleanUrl(input: string): string | null {
  const raw = input.trim()
  if (!raw) return null
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
  } catch {
    return null
  }
}

export function addLauncher(l: Omit<Launcher, 'id'>): Launcher {
  const launcher = { ...l, id: crypto.randomUUID().slice(0, 8) }
  store.set((all) => [...all, launcher])
  return launcher
}

export const updateLauncher = (id: string, patch: Partial<Omit<Launcher, 'id'>>) => store.set((all) => all.map((l) => (l.id === id ? { ...l, ...patch } : l)))
export const removeLauncher = (id: string) => store.set((all) => all.filter((l) => l.id !== id))
export const moveLauncher = (id: string, by: number) =>
  store.set((all) => {
    const i = all.findIndex((l) => l.id === id)
    const j = Math.max(0, Math.min(all.length - 1, i + by))
    if (i < 0 || i === j) return all
    const next = all.slice()
    next.splice(j, 0, next.splice(i, 1)[0])
    return next
  })

export const launch = (l: Launcher) => window.open(l.url, '_blank', 'noopener')

/** The site's own favicon, straight from it (no third-party favicon service sees the URL). */
export const faviconOf = (url: string) => {
  try {
    return `${new URL(url).origin}/favicon.ico`
  } catch {
    return undefined
  }
}
