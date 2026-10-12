import { getValue, setValue, formatDesktopFile, tryParseDesktopFile } from './desktopEntry.ts'
import { ID_KEY, isLauncherName, launcherFileName, launcherFromText, launcherText, type Launcher } from './launcherFiles.ts'

// Launchers kept in the synced list (src/os/synced.ts, so they follow the account to every
// device through the server), shown as .desktop files. Without Seafile, home is kept in this
// browser, which no other device sees; so there the two launcher folders hold no real launcher
// files: data/browserfs.ts asks this module for the .desktop files in them, and hands it what is
// written, deleted, renamed or moved there. A launcher moved out to another folder becomes a
// plain file of the browser's and leaves the list; a .desktop file moved in joins it. With Seafile
// as home, launchers are real files in Seafile instead (see launchers.ts).
//
// Pure: the list and the two folders come in as functions, so scripts/launchers-check.ts runs
// this with two "devices" that sync through the real server.

/** A launcher as the list keeps it: its file's name and text too, so a file comes back as it was written. */
export type StoredLauncher = Omit<Launcher, 'file'> & { name?: string; text?: string; mtime?: number }

export type StoreEntry = { path: string; dir: false; size: number; mtime: number; type: string }

export type VirtualFiles = {
  /** Whether a .desktop file at this path (in the browser's store) would be kept in the list. */
  isPlace: (path: string) => boolean
  has: (path: string) => boolean
  /** The list's files in a folder. */
  list: (dir: string) => StoreEntry[]
  stat: (path: string) => StoreEntry | null
  text: (path: string) => string | null
  /** A file written here: true when it is a launcher and the list keeps it (not a launcher: a plain file). */
  write: (path: string, text: string) => boolean
  remove: (path: string) => boolean
  /** Moves or copies a file of the list's to another place of the list's (a rename, or to the other folder). */
  rename: (op: 'move' | 'copy', from: string, to: string) => boolean
}

const parentOf = (p: string) => p.replace(/\/[^/]*$/, '') || '/'
const nameOf = (p: string) => p.split('/').pop() || ''
const join = (dir: string, name: string) => (dir === '/' ? `/${name}` : `${dir}/${name}`)

export function virtualLaunchers(opts: {
  get: () => StoredLauncher[]
  set: (fn: (all: StoredLauncher[]) => StoredLauncher[]) => void
  /** The two folders, as paths in the browser's store ("/Desktop"); null when launchers are not kept this way now. */
  dirs: () => { desktop: string; apps: string } | null
  isApp?: (app: string) => boolean
  newId?: () => string
}): VirtualFiles {
  const newId = opts.newId ?? (() => crypto.randomUUID().slice(0, 8))
  const dirOf = (l: StoredLauncher, d: { desktop: string; apps: string }) => (l.desktop === false ? d.apps : d.desktop)

  /** Every launcher at its path: its own file name, or one made from its name (the same on every device). */
  function placed(): { path: string; l: StoredLauncher }[] {
    const d = opts.dirs()
    if (!d) return []
    const taken = new Map<string, Set<string>>([
      [d.desktop, new Set()],
      [d.apps, new Set()],
    ])
    const out: { path: string; l: StoredLauncher }[] = []
    for (const l of opts.get()) {
      const dir = dirOf(l, d)
      const names = taken.get(dir)!
      const name = l.name && isLauncherName(l.name) && !names.has(l.name) ? l.name : launcherFileName(l.label, names)
      names.add(name)
      out.push({ path: join(dir, name), l })
    }
    return out
  }
  const at = (path: string) => placed().find((p) => p.path === path) ?? null
  const textOf = (l: StoredLauncher) => launcherText(l, l.text)
  const entry = (path: string, l: StoredLauncher): StoreEntry => ({ path, dir: false, size: new TextEncoder().encode(textOf(l)).length, mtime: l.mtime ?? 0, type: 'text/plain' })

  const isPlace = (path: string) => {
    const d = opts.dirs()
    return !!d && isLauncherName(nameOf(path)) && (parentOf(path) === d.desktop || parentOf(path) === d.apps)
  }

  /** The list's launcher for a file's text at a path; null when the text is not a launcher. */
  function fromText(path: string, text: string, keepId: string | null): StoredLauncher | null {
    const d = opts.dirs()
    const l = d ? launcherFromText(text, path, { isApp: opts.isApp }) : null
    if (!d || !l) return null
    // Ids are one per launcher: a copy (or a file that says the id of another) gets its own.
    const others = opts.get().filter((x) => x.id !== keepId)
    let id = l.id
    let body = text
    if (others.some((x) => x.id === id) || !getValue(tryParseDesktopFile(text)!, ID_KEY)) {
      if (others.some((x) => x.id === id)) id = newId()
      body = formatDesktopFile(setValue(tryParseDesktopFile(text)!, ID_KEY, id))
    }
    const { file: _, ...rest } = l
    return { ...rest, id, desktop: parentOf(path) !== d.apps, name: nameOf(path), text: body, mtime: Date.now() }
  }

  return {
    isPlace,
    has: (path) => !!at(path),
    list: (dir) => placed().filter((p) => parentOf(p.path) === dir).map((p) => entry(p.path, p.l)),
    stat: (path) => {
      const p = at(path)
      return p ? entry(p.path, p.l) : null
    },
    text: (path) => {
      const p = at(path)
      return p ? textOf(p.l) : null
    },
    write(path, text) {
      if (!isPlace(path)) return false
      const here = at(path)
      const l = fromText(path, text, here?.l.id ?? null)
      if (!l) return false
      opts.set((all) => (here ? all.map((x) => (x.id === here.l.id ? l : x)) : [...all, l]))
      return true
    },
    remove(path) {
      const here = at(path)
      if (!here) return false
      opts.set((all) => all.filter((x) => x.id !== here.l.id))
      return true
    },
    rename(op, from, to) {
      const here = at(from)
      if (!here || !isPlace(to)) return false
      if (op === 'copy') return this.write(to, textOf(here.l).replace(/^X-MvL-Id=.*$/m, `X-MvL-Id=${newId()}`))
      const d = opts.dirs()!
      opts.set((all) => all.map((x) => (x.id === here.l.id ? { ...x, name: nameOf(to), desktop: parentOf(to) !== d.apps, mtime: Date.now() } : x)))
      return true
    },
  }
}
