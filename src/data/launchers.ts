import { useSyncExternalStore } from 'react'
import { openLink } from './links'
import { synced } from '../os/synced'
import { getAccount, subscribeAccount } from '../os/account'
import { appHere } from '../os/cvMode'
import { notify } from '../os/notify'
import type { AppId } from '../os/wm'
import { HOME } from '../terminal/vfs'
import { lookup, makeDir, prepare, readFileText, removePath, transfer, writeFile } from '../terminal/fs'
import { browserFilesState, browserText, listBrowser, readBrowserText, subscribeBrowserFiles } from './browserfs'
import { posixOf, subscribeMounts, whereIs } from './mounts'
import { cachedDir, isSf, listDir, readText, refreshDirs, subscribeDirs, type Entry } from './seafile'
import { idForPath, idInText, isLauncherName, launcherFileName, launcherFromText, launcherText, migrateLaunchers, type Launcher, type LauncherPort } from './launcherFiles'

// Launchers of your own: a web address (or an MvL OS app), a name and an optional emoji or
// picture. They are .desktop files (src/data/launcherFiles.ts), wherever home is: those in
// ~/Desktop sit on the desktop, those in ~/.local/share/applications are for the dock, All apps
// and Spotlight only, as on Linux. Home is Seafile's when it is mounted on ~, else the files kept
// in this browser (src/data/browserfs.ts).
//
// Visitors have no home to write to: theirs stay a list in this browser (synced.ts), as all
// launchers were before. Signed in, that same list is synced and is turned into files once per
// home (migrateLaunchers); it is never emptied, so a home that comes later (another browser, or
// Seafile linked later) gets them too.

export type { Launcher } from './launcherFiles'
export { cleanUrl } from './launcherFiles'

type Legacy = Omit<Launcher, 'file'>
const legacy = synced<Legacy[]>('launchers', [], { normalize: (v) => (Array.isArray(v) ? v.filter((l) => l && typeof l.id === 'string' && (typeof l.url === 'string' || typeof l.app === 'string')).map((l) => ({ ...l, url: l.url ?? '' })) : []) })
/** The order Settings → Launchers put them in (ids); the rest follow by name. */
const order = synced<string[]>('launcher-order', [], { normalize: (v) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []) })

/** Apps a launcher may open (X-MvL-App): the ones in this build, and on this page. */
const APP_IDS = new Set<string>(
  (
    ['terminal', 'files', 'viewer', 'preview', 'player', 'pdf', 'archive', 'newdoc', 'newsheet', 'newslides', 'notes', 'keys', 'projects', 'recents', 'cv', 'contact', 'games', 'zed', 'trash', 'notebook', 'settings', 'mcserver', 'calendar', 'agents', 'amp', 'tasks', 'contacts', 'photos'] satisfies AppId[]
  ).filter((a) => appHere(a)),
)
export const isLauncherApp = (app: string) => APP_IDS.has(app)

const DESKTOP = () => `${HOME}/Desktop`
const APPS = () => `${HOME}/.local/share/applications`
const languages = () => (typeof navigator === 'undefined' ? [] : navigator.languages ?? [])
const nameOf = (p: string) => p.split('/').pop() || ''

/** Where launchers live right now: files (and where), the old list, or not known yet. */
type Home = { kind: 'files'; desktop: string; apps: string } | { kind: 'local' } | { kind: 'pending' }

/** A filesystem folder as Files has it: its Seafile path, or (in this browser) the path itself. */
function folderOf(abs: string): { at: string; sf: boolean } | null | 'pending' {
  const w = whereIs(abs)
  if (w.kind === 'sf') return w.ro ? null : { at: w.sf, sf: true }
  if (w.kind === 'browser') {
    const s = browserFilesState()
    // 'off' only until the store starts opening for the account that just signed in.
    return s === 'ready' ? { at: abs, sf: false } : s === 'error' ? null : 'pending'
  }
  if (w.kind === 'missing') return w.loading ? 'pending' : null
  return null
}

function home(): Home {
  const a = getAccount()
  if (a.status === 'loading') return { kind: 'pending' }
  if (a.status !== 'user') return { kind: 'local' }
  const desktop = folderOf(DESKTOP())
  const apps = folderOf(APPS())
  if (desktop === 'pending' || apps === 'pending') return { kind: 'pending' }
  if (!desktop || !apps) return { kind: 'local' }
  return { kind: 'files', desktop: desktop.at, apps: apps.at }
}

/** Whether launchers are files now (signed in, with a home to keep them in). */
export const launchersAreFiles = () => home().kind === 'files'

// --- reading the files ---------------------------------------------------------------------------

/** .desktop texts read from Seafile, by path, with the mtime they were read at (null: just written). */
const texts = new Map<string, { mtime: number | null; text: string }>()
const reading = new Set<string>()
/** A folder's last listing, kept while it is fetched again (refreshDirs empties the cache). */
const lastEntries = new Map<string, Entry[]>()
const listing = new Set<string>()
let fileVersion = 0
const fileListeners = new Set<() => void>()
const emitFiles = () => {
  fileVersion++
  fileListeners.forEach((l) => l())
  schedule()
}

/** Asks Seafile for a folder when it is not in the cache (or is older than `maxAge`). */
function fetchFolder(sf: string, maxAge = 30_000) {
  if (listing.has(sf)) return
  const hit = cachedDir(sf)
  if (hit && maxAge > 0) return
  listing.add(sf)
  listDir(sf, maxAge)
    .then((l) => lastEntries.set(sf, l.entries))
    .catch(() => lastEntries.set(sf, []))
    .finally(() => {
      listing.delete(sf)
      emitFiles()
    })
}

/** The entries of a folder (Seafile path or one in this browser), as far as known. */
function entriesOf(at: string): { name: string; dir: boolean; mtime: number }[] {
  if (!isSf(at)) {
    const w = whereIs(at)
    return w.kind === 'browser' ? listBrowser(w.path).map((e) => ({ name: nameOf(e.path), dir: e.dir, mtime: e.mtime })) : []
  }
  const hit = cachedDir(at)
  if (hit?.listing) {
    lastEntries.set(at, hit.listing.entries)
    return hit.listing.entries
  }
  fetchFolder(at)
  return lastEntries.get(at) ?? []
}

/** A .desktop file's text: undefined while it is being fetched. */
function textOf(at: string, mtime: number): string | undefined {
  if (!isSf(at)) {
    const w = whereIs(at)
    if (w.kind !== 'browser') return ''
    const t = browserText(w.path)
    if (t !== null) return t
    if (!reading.has(at)) {
      reading.add(at)
      void readBrowserText(w.path)
        .then((text) => texts.set(at, { mtime, text }))
        .catch(() => texts.set(at, { mtime, text: '' }))
        .finally(() => (reading.delete(at), emitFiles()))
    }
    return texts.get(at)?.text
  }
  const hit = texts.get(at)
  if (hit && hit.mtime === null) hit.mtime = mtime
  if (hit && hit.mtime === mtime) return hit.text
  if (!reading.has(at)) {
    reading.add(at)
    readText(at)
      .then((text) => texts.set(at, { mtime, text }))
      .catch(() => texts.set(at, { mtime, text: '' }))
      .finally(() => (reading.delete(at), emitFiles()))
  }
  return hit?.text
}

/**
 * The launcher a .desktop file anywhere is (Files and the desktop show it as one): null when it
 * is not one, undefined while its text is on its way. `mtime` is the file's, from its folder's listing.
 */
export function launcherAt(at: string, mtime = 0): Launcher | null | undefined {
  if (!isLauncherName(nameOf(at))) return null
  const text = textOf(at, mtime)
  if (text === undefined) return undefined
  return launcherFromText(text, at, { languages: languages(), isApp: isLauncherApp })
}

/** Re-renders when a launcher file's text arrives. */
export const useLauncherFiles = () =>
  useSyncExternalStore(
    (l) => {
      fileListeners.add(l)
      return () => fileListeners.delete(l)
    },
    () => fileVersion,
  )

// --- the list -----------------------------------------------------------------------------------

let current: Launcher[] = []
const listeners = new Set<() => void>()
/** Changes on their way to the files, shown until the files say the same. */
const adding = new Map<string, Launcher>()
const patching = new Map<string, Partial<Launcher>>()
const removing = new Set<string>()
const CACHE = 'mvlos.launchers.files'

function readCache(): Launcher[] | null {
  try {
    const raw = localStorage.getItem(CACHE)
    const c = raw ? (JSON.parse(raw) as { user: number; list: Launcher[] }) : null
    const user = getAccount().user?.id
    return c && (user === undefined || c.user === user) && Array.isArray(c.list) ? c.list : null
  } catch {
    return null
  }
}

function sorted(list: Launcher[]): Launcher[] {
  const at = new Map(order.get().map((id, i) => [id, i]))
  return list
    .map((l, i) => ({ l, i }))
    .sort((a, b) => (at.get(a.l.id) ?? 1e9 + a.i) - (at.get(b.l.id) ?? 1e9 + b.i))
    .map((x) => x.l)
}

function compute(): Launcher[] {
  const h = home()
  if (h.kind === 'local') return sorted(legacy.get())
  if (h.kind === 'pending') return readCache() ?? sorted(legacy.get())
  const out: Launcher[] = []
  const seen = new Set<string>()
  const before = new Map(current.filter((l) => l.file).map((l) => [l.file!, l]))
  for (const [dir, desktop] of [
    [h.desktop, true],
    [h.apps, false],
  ] as const) {
    for (const e of entriesOf(dir)) {
      if (e.dir || !isLauncherName(e.name)) continue
      const at = `${dir}/${e.name}`
      const text = textOf(at, e.mtime)
      let l: Launcher | null | undefined = text === undefined ? before.get(at) : launcherFromText(text, at, { desktop, languages: languages(), isApp: isLauncherApp })
      if (!l) continue
      // A copied file keeps its id: the second one gets one of its own here.
      if (seen.has(l.id)) l = { ...l, id: `${l.id}-${idForPath(at)}` }
      seen.add(l.id)
      out.push({ ...l, desktop })
    }
  }
  for (const id of [...adding.keys()]) if (seen.has(id)) adding.delete(id)
  const list = [...out.filter((l) => !removing.has(l.id)).map((l) => (patching.has(l.id) ? { ...l, ...patching.get(l.id) } : l)), ...adding.values()]
  return sorted(list)
}

let scheduled = false
function schedule() {
  if (scheduled) return
  scheduled = true
  queueMicrotask(() => {
    scheduled = false
    const next = compute()
    if (JSON.stringify(next) === JSON.stringify(current)) return
    current = next
    const h = home()
    if (h.kind === 'files')
      try {
        localStorage.setItem(CACHE, JSON.stringify({ user: getAccount().user?.id, list: next }))
      } catch {
        /* not kept */
      }
    listeners.forEach((l) => l())
    void maybeMigrate()
  })
}

let started = false
function start() {
  if (started) return
  started = true
  current = compute()
  for (const sub of [subscribeAccount, subscribeMounts, subscribeBrowserFiles, subscribeDirs, legacy.subscribe, order.subscribe]) sub(() => schedule())
  // Another device may have changed the folders: look again now and then while in view.
  const again = () => {
    const h = home()
    if (h.kind !== 'files' || document.visibilityState !== 'visible') return
    for (const dir of [h.desktop, h.apps]) if (isSf(dir)) fetchFolder(dir, 15_000)
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', again)
    setInterval(again, 60_000)
  }
  legacy.onRemote(() => void maybeMigrate(true))
  schedule()
}

const subscribe = (l: () => void) => {
  start()
  listeners.add(l)
  return () => listeners.delete(l)
}
export const getLaunchers = () => {
  start()
  return current
}
export const useLaunchers = () => useSyncExternalStore(subscribe, getLaunchers)

// --- writing ------------------------------------------------------------------------------------

/** A filesystem path for one as Files has it (Seafile paths are where fstab mounts them). */
export const posixPath = (at: string) => (isSf(at) ? posixOf(at) : at)

/** The real files, through the terminal's filesystem (Seafile or this browser alike). */
export const launcherPort: LauncherPort = {
  async list(dir) {
    const w = whereIs(dir)
    if (w.kind === 'sf') {
      const l = await listDir(w.sf, 0).catch(() => null)
      return l ? l.entries.map((e) => ({ name: e.name, dir: e.dir })) : null
    }
    await prepare('/', 'ls', [dir]).catch(() => {})
    const node = lookup(dir)
    return node?.type === 'dir' ? [...node.children.values()].map((n) => ({ name: n.name, dir: n.type === 'dir' })) : null
  },
  async read(path) {
    const r = await readFileText(path)
    if (!r) throw new Error(`${nameOf(path)}: no such file`)
    return r.text
  },
  async write(path, text) {
    await writeFile('/', path, text, false)
    const w = whereIs(path)
    if (w.kind === 'sf') {
      texts.set(w.sf, { mtime: null, text })
      refreshDirs(w.sf.replace(/\/[^/]*$/, ''))
    }
  },
  async mkdirp(dir) {
    await makeDir('/', dir, true)
  },
}

/** Runs a change to the files, saying so when it fails, and lists the folders again after. */
async function change(work: () => Promise<unknown>, failed: string): Promise<boolean> {
  try {
    await work()
    return true
  } catch (e) {
    notify({ title: failed, body: (e as Error).message, transient: true })
    return false
  } finally {
    const h = home()
    if (h.kind === 'files') for (const dir of [h.desktop, h.apps]) if (isSf(dir)) refreshDirs(dir)
    schedule()
  }
}

/** Writes a launcher as a new .desktop file in a folder (as Files has it); answers its path. */
export async function writeLauncherFile(folder: string, l: Omit<Launcher, 'file' | 'desktop'>): Promise<string> {
  const dir = posixPath(folder)
  if (!dir) throw new Error('That folder is not mounted anywhere (see /etc/fstab)')
  const taken = new Set(((await launcherPort.list(dir)) ?? []).map((e) => e.name))
  const name = launcherFileName(l.label, taken)
  await launcherPort.write(`${dir}/${name}`, launcherText(l))
  return `${folder}/${name}`
}

const newId = () => crypto.randomUUID().slice(0, 8)

export function addLauncher(l: Omit<Launcher, 'id' | 'file'>): Launcher {
  start()
  const launcher: Launcher = { ...l, id: newId() }
  const h = home()
  if (h.kind !== 'files') {
    legacy.set((all) => [...all, launcher])
    return launcher
  }
  adding.set(launcher.id, { ...launcher, desktop: l.desktop !== false })
  schedule()
  void change(() => writeLauncherFile(l.desktop === false ? h.apps : h.desktop, launcher), `Could not add ${l.label}`).then((ok) => {
    if (ok) return
    adding.delete(launcher.id)
    schedule()
  })
  return launcher
}

export function updateLauncher(id: string, patch: Partial<Omit<Launcher, 'id' | 'file'>>) {
  start()
  const l = current.find((x) => x.id === id)
  if (!l?.file) return legacy.set((all) => all.map((x) => (x.id === id ? { ...x, ...patch } : x)))
  const h = home()
  patching.set(id, { ...patching.get(id), ...patch })
  schedule()
  void change(async () => {
    const path = posixPath(l.file!)
    if (!path) throw new Error(`${nameOf(l.file!)} is not mounted anywhere`)
    const { text } = (await readFileText(path)) ?? { text: '' }
    const next = { ...l, ...patch }
    // The file keeps the id it has, if it has one: the list may show it with another (a copy).
    await launcherPort.write(path, launcherText({ ...next, id: idInText(text) ?? l.id }, text || undefined))
    // On the desktop or not: the file goes to the other folder.
    if (patch.desktop !== undefined && patch.desktop !== l.desktop && h.kind === 'files') {
      const to = posixPath(patch.desktop === false ? h.apps : h.desktop)
      if (to) {
        await makeDir('/', to, true)
        const taken = new Set(((await launcherPort.list(to)) ?? []).map((e) => e.name))
        const name = taken.has(nameOf(path)) ? launcherFileName(next.label, taken) : nameOf(path)
        await transfer('move', '/', path, `${to}/${name}`, true)
      }
    }
  }, `Could not change ${l.label}`).then(() => {
    patching.delete(id)
    schedule()
  })
}

export function removeLauncher(id: string) {
  start()
  const l = current.find((x) => x.id === id)
  if (!l?.file) return legacy.set((all) => all.filter((x) => x.id !== id))
  removing.add(id)
  schedule()
  void change(async () => {
    const path = posixPath(l.file!)
    if (path) await removePath('/', path, { recursive: false, force: true, dir: false })
  }, `Could not remove ${l.label}`).then(() => {
    removing.delete(id)
    schedule()
  })
}

export function moveLauncher(id: string, by: number) {
  const ids = getLaunchers().map((l) => l.id)
  const i = ids.indexOf(id)
  const j = Math.max(0, Math.min(ids.length - 1, i + by))
  if (i < 0 || i === j) return
  ids.splice(j, 0, ids.splice(i, 1)[0])
  if (home().kind === 'files') return order.set(ids)
  legacy.set((all) => ids.map((x) => all.find((l) => l.id === x)).filter((l): l is Legacy => !!l))
}

// --- moving the old list into files --------------------------------------------------------------

let migrating: Promise<void> | null = null
const migratedFor = new Set<string>()

/** Turns the old list into files, once per home and visit (again when another device adds to it). */
function maybeMigrate(again = false): Promise<void> {
  const h = home()
  if (h.kind !== 'files' || !legacy.get().length) return Promise.resolve()
  const key = `${getAccount().user?.id}:${h.desktop}`
  if (migrating || (migratedFor.has(key) && !again)) return migrating ?? Promise.resolve()
  migratedFor.add(key)
  const desktop = posixPath(h.desktop)
  const apps = posixPath(h.apps)
  if (!desktop || !apps) return Promise.resolve()
  const run = migrateLaunchers(launcherPort, legacy.get(), { desktop, apps })
    .then(({ written }) => {
      if (written.length) for (const dir of [h.desktop, h.apps]) if (isSf(dir)) refreshDirs(dir)
    })
    .catch(() => void migratedFor.delete(key))
    .finally(() => {
      migrating = null
      schedule()
    })
  migrating = run
  return run
}

// --- opening ------------------------------------------------------------------------------------

type Opener = { open: (app: AppId, props?: Record<string, string | undefined>) => void }

/** Opens a launcher: its web address, or its app (when a window manager is at hand). */
export function launch(l: Launcher, wm?: Opener) {
  if (l.app) {
    if (wm && isLauncherApp(l.app)) wm.open(l.app as AppId, { ...l.props, t: String(Date.now()) })
    return
  }
  openLink(l.url, { title: l.label })
}

/** The launcher a .desktop file is, read now (the terminal's `open`). */
export async function readLauncherFile(abs: string): Promise<Launcher | null> {
  const r = await readFileText(abs).catch(() => null)
  return r ? launcherFromText(r.text, abs, { languages: languages(), isApp: isLauncherApp }) : null
}

/** The site's own favicon, straight from it (no third-party favicon service sees the URL). */
export const faviconOf = (url: string) => {
  try {
    return `${new URL(url).origin}/favicon.ico`
  } catch {
    return undefined
  }
}

/** The picture a launcher shows when it has no emoji: its own, or its site's favicon. */
export const launcherImage = (l: Pick<Launcher, 'image' | 'url'>) => l.image ?? (l.url ? faviconOf(l.url) : undefined)

/** Renames a launcher file anywhere (Files' F2 on one): its Name changes, the file keeps its name. */
export async function renameLauncherFile(at: string, label: string) {
  const path = posixPath(at)
  if (!path) throw new Error(`${nameOf(at)} is not mounted anywhere`)
  const r = await readFileText(path)
  const l = r ? launcherFromText(r.text, at, { isApp: isLauncherApp }) : null
  if (!r || !l) throw new Error(`${nameOf(at)} is not a launcher`)
  await launcherPort.write(path, launcherText({ ...l, label, id: idInText(r.text) ?? l.id }, r.text))
  emitFiles()
}
