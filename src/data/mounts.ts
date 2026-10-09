import { useEffect, useSyncExternalStore } from 'react'
import { getAccount, subscribeAccount } from '../os/account'
import { synced } from '../os/synced'
import { HOME } from '../terminal/vfs'
import { getLibraries, getSeafilePrefsStored, loadLibraries, PLACES, primaryOf, SF, sfPath, parseSf, subscribeLibraries, type Library, type PlaceId } from './seafile'

// /etc/fstab, and what is mounted: the one place that says where Seafile shows up. Files and the
// terminal both read it. The line `seafile /mnt/seafile seafile` puts every library in a folder
// of its own (like SeaDrive), `UUID=<library id> /home/menno seafile` makes a library home, and a
// bind line maps one folder onto another (Pictures onto a shared library, say). Settings edits
// these lines; so can `sudo nano /etc/fstab`.
//
// Until anything edits it, the file is written from the older Seafile settings (home on or off,
// the primary library, places mapped elsewhere), so nothing moves for someone who had those.

export type FstabEntry = { source: string; target: string; type: string; options: string[]; dump: string; pass: string }
export type FstabLine = { raw: string; entry: FstabEntry | null; error?: boolean }

const unescape = (s: string) => s.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)))
const escape = (s: string) => s.replace(/[ \t\n\\]/g, (ch) => `\\${ch.charCodeAt(0).toString(8).padStart(3, '0')}`)
const trimSlash = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p)

/** fstab(5): six whitespace-separated fields, octal escapes, # comments on their own lines. */
export function parseFstab(text: string): FstabLine[] {
  return text.split('\n').map((raw) => {
    const body = raw.trim()
    if (!body || body.startsWith('#')) return { raw, entry: null }
    const f = body.split(/\s+/).map(unescape)
    if (f.length < 2) return { raw, entry: null, error: true }
    return { raw, entry: { source: f[0], target: trimSlash(f[1]), type: f[2] ?? 'auto', options: (f[3] ?? 'defaults').split(','), dump: f[4] ?? '0', pass: f[5] ?? '0' } }
  })
}

export const formatEntry = (e: FstabEntry) =>
  `${escape(e.source).padEnd(40)} ${escape(e.target).padEnd(22)} ${e.type.padEnd(8)} ${e.options.join(',').padEnd(16)} ${e.dump} ${e.pass}`.replace(/\s+$/, '')

const entry = (source: string, target: string, type: string, options = 'defaults', dump = '0', pass = '0'): FstabEntry => ({ source, target, type, options: options.split(','), dump, pass })

/** The built-in disks, always there. */
export const SYSTEM_MOUNTS: FstabEntry[] = [entry('/dev/nvme0n1p2', '/', 'ext4', 'ro,noatime', '0', '1'), entry('tmpfs', '/tmp', 'tmpfs', 'rw,nosuid,nodev,mode=1777'), entry('proc', '/proc', 'proc')]

const HEADER = [
  '# /etc/fstab: static file system information.',
  '#',
  '# Files follows this file too: its Home, the places in its sidebar and the',
  '# Seafile libraries all come from the lines below. Edit it with',
  '# `sudo nano /etc/fstab` or in Settings → Integrations → Seafile; `man fstab`',
  '# explains the columns. Libraries go by UUID=<library id>, LABEL=<name> or',
  '# /dev/seafile/<name>; `lsblk` lists them.',
  '#',
  `# ${'<file system>'.padEnd(38)} ${'<mount point>'.padEnd(22)} ${'<type>'.padEnd(8)} ${'<options>'.padEnd(16)} <dump> <pass>`,
]

const ACCOUNT_COMMENT = '# Every Seafile library, each in a folder of its own'
const homeComment = (name: string) => `# ${name} as home`
const placeComment = (label: string) => `# ${label} from somewhere else`
const GENERATED = /^# (.+ as home|\w+ from somewhere else)$/

const placeTarget = (id: PlaceId) => {
  const folder = PLACES.find((p) => p.id === id)!.folder
  return folder ? `${HOME}/${folder}` : HOME
}

/** fstab as the older settings would have it: the account, home and mapped places. */
function generated(): string {
  const lines = [...HEADER, ...SYSTEM_MOUNTS.map(formatEntry)]
  if (getAccount().seafile) {
    const p = getSeafilePrefsStored()
    lines.push('', ACCOUNT_COMMENT, formatEntry(entry('seafile', '/mnt/seafile', 'seafile')))
    if (p.home) {
      const lib = p.primary ? getLibraries()?.find((l) => l.id === p.primary) : primaryOf(getLibraries(), null)
      const source = p.primary ? `UUID=${p.primary}` : lib ? `UUID=${lib.id}` : 'LABEL=My Library'
      lines.push('', homeComment(lib?.name ?? 'My Library'), formatEntry(entry(source, HOME, 'seafile')))
      for (const place of PLACES) {
        const to = p.places[place.id]
        const from = to && accountPath(to)
        if (from) lines.push(placeComment(place.label), formatEntry(entry(from, placeTarget(place.id), 'none', 'bind')))
      }
    }
  }
  return `${lines.join('\n')}\n`
}

const store = synced<string | null>('fstab', null, { normalize: (v) => (typeof v === 'string' ? v : null) })

/** /etc/fstab as it is now. */
export const getFstab = () => store.get() ?? generated()
/** Replaces /etc/fstab (nano's save, Settings' edits). */
export function setFstab(text: string) {
  store.set(text.endsWith('\n') ? text : `${text}\n`)
}

// --- libraries by name ---------------------------------------------------------------------------

/** Each library's folder name under /mnt/seafile: its name, numbered when two share one. */
export function libraryNames(libs: Library[] | null = getLibraries()): Map<string, string> {
  const out = new Map<string, string>()
  const taken = new Map<string, number>()
  for (const l of libs ?? []) {
    const base = l.name.replace(/\//g, '-')
    const n = (taken.get(base) ?? 0) + 1
    taken.set(base, n)
    out.set(l.id, n === 1 ? base : `${base} (${n})`)
  }
  return out
}

/** /dev/seafile/<slug>: the name in lower case, words joined by dashes. */
export function deviceNames(libs: Library[] | null = getLibraries()): Map<string, string> {
  const out = new Map<string, string>()
  const taken = new Map<string, number>()
  for (const l of libs ?? []) {
    const base = l.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'library'
    const n = (taken.get(base) ?? 0) + 1
    taken.set(base, n)
    out.set(l.id, n === 1 ? base : `${base}-${n}`)
  }
  return out
}

/** The library a seafile line's first column names; undefined while the libraries are loading. */
export function repoOfSource(source: string): string | null | undefined {
  const libs = getLibraries()
  if (source.startsWith('UUID=')) {
    const id = source.slice(5)
    return !libs || libs.some((l) => l.id === id) ? id : null
  }
  if (!libs) return undefined
  if (source.startsWith('LABEL=')) return libs.find((l) => l.name === source.slice(6))?.id ?? null
  if (source.startsWith('/dev/seafile/')) {
    const slug = source.slice('/dev/seafile/'.length)
    return [...deviceNames(libs)].find(([, s]) => s === slug)?.[0] ?? null
  }
  return null
}

/** A Seafile path under /mnt/seafile (for bind lines), whether or not that is mounted. */
function accountPath(sf: string): string | null {
  const at = parseSf(sf)
  const name = at && libraryNames().get(at.repo)
  return name ? `/mnt/seafile/${name}${at!.p === '/' ? '' : at!.p}` : null
}

// --- what is mounted -----------------------------------------------------------------------------

export type Mount = FstabEntry & { manual?: boolean }

// This session's changes: auto lines unmounted, noauto lines (or ad-hoc mounts) mounted.
const unmounted = new Set<string>()
let manual: Mount[] = []
let version = 0
const listeners = new Set<() => void>()
const emit = () => {
  version++
  listeners.forEach((l) => l())
}
// Wired on first use: seafile.ts and this module import each other, so nothing of seafile.ts may
// run while this one loads.
let wired = false
function wire() {
  if (wired) return
  wired = true
  store.subscribe(emit)
  subscribeLibraries(emit)
  subscribeAccount(emit)
}

export const isSeafileType = (m: FstabEntry) => m.type === 'seafile' || m.type === 'fuse.seafile'
export const isBind = (m: FstabEntry) => m.options.includes('bind') || m.options.includes('rbind')

/** What is mounted now, in mount order (later mounts cover earlier ones). */
export function mounts(): Mount[] {
  wire()
  const linked = !!getAccount().seafile
  const fromFstab = parseFstab(getFstab())
    .flatMap((l) => (l.entry ? [l.entry] : []))
    .filter((e) => e.type !== 'swap' && !e.options.includes('noauto') && !unmounted.has(e.target))
  // The disk, /tmp and /proc are mounted before fstab is read, whatever it says.
  const system = SYSTEM_MOUNTS.filter((s) => !fromFstab.some((e) => e.target === s.target))
  return [...system, ...fromFstab, ...manual].filter((m) => linked || !isSeafileType(m))
}

/** fstab's lines (comments and broken lines left out). */
export const fstabEntries = () => parseFstab(getFstab()).flatMap((l) => (l.entry ? [l.entry] : []))

/** Line numbers fstab cannot read, for mount's complaints. */
export const fstabErrors = () => parseFstab(getFstab()).flatMap((l, i) => (l.error ? [i + 1] : []))

/** mount -a: everything in fstab that should be mounted and is not. */
export function mountAll(): { target: string; error: string | null; already: boolean }[] {
  return fstabEntries()
    .filter((e) => !e.options.includes('noauto') && e.type !== 'swap')
    .map((e) => {
      const already = mounts().some((m) => m.target === e.target && m.source === e.source)
      return { target: e.target, already, error: already ? null : mountEntry(e) }
    })
}

/** Mounts a line of fstab (by mount point or source), as `mount <dir>` does; an error message, or null. */
export function mountFromFstab(what: string): string | null {
  const lines = parseFstab(getFstab()).flatMap((l) => (l.entry ? [l.entry] : []))
  const e = lines.find((x) => x.target === trimSlash(what)) ?? lines.find((x) => x.source === what)
  if (!e) return `mount: ${what}: can't find in /etc/fstab.`
  return mountEntry(e)
}

export function mountEntry(e: FstabEntry): string | null {
  if (isSeafileType(e) && !getAccount().seafile) return `mount: ${e.target}: can't find a Seafile account (link one in Settings → Integrations → Seafile).`
  if (isSeafileType(e) && e.source !== 'seafile' && repoOfSource(e.source) === null) return `mount: ${e.target}: special device ${e.source} does not exist.`
  if (mounts().some((m) => m.target === e.target && m.source === e.source)) return `mount: ${e.target}: ${e.source} already mounted on ${e.target}.`
  if (unmounted.has(e.target) && !e.options.includes('noauto')) unmounted.delete(e.target)
  else manual = [...manual, { ...e, manual: true }]
  emit()
  return null
}

/** Unmounts the last mount on `target`; an error message, or null. `busy`: the shell's cwd. */
export function unmount(target: string, busy?: string): string | null {
  const t = trimSlash(target)
  const all = mounts()
  const m = [...all].reverse().find((x) => x.target === t || x.source === t)
  if (!m) return `umount: ${target}: not mounted.`
  if (SYSTEM_MOUNTS.some((s) => s.target === m.target)) return `umount: ${m.target}: target is busy.`
  if (busy && (busy === m.target || busy.startsWith(`${m.target}/`))) return `umount: ${m.target}: target is busy.`
  if (all.some((x) => x !== m && x.target.startsWith(`${m.target}/`))) return `umount: ${m.target}: target is busy.`
  if (m.manual) manual = manual.filter((x) => x !== m)
  else unmounted.add(m.target)
  emit()
  return null
}

export function useMounts() {
  wire()
  // Library names and LABEL= lines need the list of libraries.
  useEffect(() => {
    if (getAccount().seafile && !getLibraries()) void loadLibraries()
  })
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => version,
  )
}
export const subscribeMounts = (l: () => void) => {
  wire()
  listeners.add(l)
  return () => listeners.delete(l)
}

// --- paths ---------------------------------------------------------------------------------------

/**
 * Where a path really is: in Seafile (a seafile:// path; seafile:// alone is the list of
 * libraries), in the site's own filesystem, or on a mount that cannot be reached (the library is
 * gone, or the libraries are still loading).
 */
/** A library shared with you read-only stays read-only, however it is mounted. */
const readOnlyLibrary = (repo: string) => getLibraries()?.find((l) => l.id === repo)?.permission === 'r'

export type Where = { kind: 'sf'; sf: string; ro: boolean; mount: Mount } | { kind: 'local'; path: string } | { kind: 'missing'; mount: Mount; loading: boolean }

export function whereIs(abs: string, depth = 0): Where {
  let best: Mount | null = null
  for (const m of mounts()) if (abs === m.target || abs.startsWith(m.target === '/' ? '/' : `${m.target}/`)) if (!best || m.target.length >= best.target.length) best = m
  if (!best) return { kind: 'local', path: abs }
  const rel = best.target === '/' ? abs : abs.slice(best.target.length)
  const ro = best.options.includes('ro')
  if (isBind(best)) {
    if (depth > 8) return { kind: 'missing', mount: best, loading: false }
    const inner = whereIs(trimSlash(best.source + rel) || '/', depth + 1)
    return inner.kind === 'sf' ? { ...inner, ro: inner.ro || ro } : inner
  }
  if (!isSeafileType(best)) return { kind: 'local', path: abs }
  if (best.source === 'seafile') {
    if (!rel || rel === '/') return { kind: 'sf', sf: SF, ro: true, mount: best }
    const [name, ...rest] = rel.slice(1).split('/')
    const libs = getLibraries()
    if (!libs) return { kind: 'missing', mount: best, loading: true }
    const repo = [...libraryNames(libs)].find(([, n]) => n === name)?.[0]
    if (!repo) return { kind: 'missing', mount: best, loading: false }
    return { kind: 'sf', sf: sfPath(repo, rest.length ? `/${rest.join('/')}` : '/'), ro: ro || readOnlyLibrary(repo), mount: best }
  }
  const repo = repoOfSource(best.source)
  if (!repo) return { kind: 'missing', mount: best, loading: repo === undefined }
  return { kind: 'sf', sf: sfPath(repo, rel || '/'), ro: ro || readOnlyLibrary(repo), mount: best }
}

/** Where a Seafile path shows up in the filesystem: the nearest mount of it, home first. */
export function posixOf(sf: string): string | null {
  const at = parseSf(sf)
  if (!at) return null
  const found: { path: string; depth: number }[] = []
  for (const m of mounts()) {
    let base: string | null = null
    if (isBind(m)) {
      const w = whereIs(m.source)
      if (w.kind === 'sf') base = w.sf
    } else if (isSeafileType(m)) {
      if (m.source === 'seafile') {
        const name = libraryNames().get(at.repo)
        if (name) found.push({ path: `${m.target}/${name}${at.p === '/' ? '' : at.p}`, depth: 1 })
        continue
      }
      const repo = repoOfSource(m.source)
      if (repo) base = sfPath(repo)
    }
    if (!base) continue
    const inBase = sf === base || sf.startsWith(`${base}/`) || (base.endsWith('/') && sf.startsWith(base))
    if (!inBase) continue
    const rest = sf.slice(base.length)
    found.push({ path: trimSlash(`${m.target}${rest}`) || '/', depth: base.length })
  }
  // The most specific mount wins, and only if nothing mounted later covers it.
  const ok = found.filter((f) => {
    const w = whereIs(f.path)
    return w.kind === 'sf' && w.sf === sf
  })
  ok.sort((a, b) => b.depth - a.depth || Number(b.path.startsWith(HOME)) - Number(a.path.startsWith(HOME)) || a.path.length - b.path.length)
  return ok[0]?.path ?? null
}

// --- home and places, for Files and the desktop ----------------------------------------------------

export type SeafileHome = { home: string | null; library: Library | null; places: Record<PlaceId, string> | null; mapped: Partial<Record<PlaceId, string>> }

/** Home and its places as fstab has them: Seafile paths when home is in Seafile, else nulls. */
export function seafileHome(): SeafileHome {
  const libs = getLibraries()
  const home = whereIs(HOME)
  const fallback = primaryOf(libs, getSeafilePrefsStored().primary)
  if (home.kind !== 'sf' || home.sf === SF) return { home: null, library: fallback, places: null, mapped: {} }
  const repo = parseSf(home.sf)!.repo
  const library = libs?.find((l) => l.id === repo) ?? fallback
  const places = {} as Record<PlaceId, string>
  const mapped: Partial<Record<PlaceId, string>> = {}
  const own = new Set(mounts().map((m) => m.target))
  for (const p of PLACES) {
    const target = placeTarget(p.id)
    const w = whereIs(target)
    places[p.id] = w.kind === 'sf' ? w.sf : `${home.sf}${p.folder ? `/${p.folder}` : ''}`
    if (p.id !== 'home' && own.has(target) && w.kind === 'sf') mapped[p.id] = w.sf
  }
  return { home: home.sf, library, places, mapped }
}

/** The same, re-rendering when fstab, the mounts or the libraries change. */
export function useSeafileHome(): SeafileHome {
  useMounts()
  return seafileHome()
}

// --- editing fstab -------------------------------------------------------------------------------

function edit(fn: (lines: FstabLine[]) => FstabLine[]) {
  const lines = fn(parseFstab(getFstab()))
  setFstab(
    lines
      .map((l) => l.raw)
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/\n+$/, ''),
  )
}

/** Drops the lines mounted on `target`, with a comment Settings wrote right above them. */
function without(lines: FstabLine[], target: string): FstabLine[] {
  const out: FstabLine[] = []
  for (const l of lines) {
    if (l.entry?.target === target) {
      if (out.length && GENERATED.test(out[out.length - 1].raw.trim())) out.pop()
      continue
    }
    out.push(l)
  }
  return out
}

const line = (e: FstabEntry): FstabLine => ({ raw: formatEntry(e), entry: e })
const comment = (raw: string): FstabLine => ({ raw, entry: null })

/** Makes sure every library is under /mnt/seafile (bind lines into Seafile go through there). */
function withAccount(lines: FstabLine[]): FstabLine[] {
  if (lines.some((l) => l.entry && isSeafileType(l.entry) && l.entry.source === 'seafile')) return lines
  return [...lines, comment(''), comment(ACCOUNT_COMMENT), line(entry('seafile', '/mnt/seafile', 'seafile'))]
}

/** Seafile as home or not, and which library: the line mounted on the home folder. */
export function setHomeMount(repo: string | null) {
  edit((lines) => {
    const rest = without(lines, HOME)
    if (!repo) return rest
    const name = getLibraries()?.find((l) => l.id === repo)?.name ?? 'Seafile'
    // Home goes right after the account line, or at the end.
    const at = rest.findIndex((l) => l.entry?.source === 'seafile')
    const add = [comment(''), comment(homeComment(name)), line(entry(`UUID=${repo}`, HOME, 'seafile'))]
    return at < 0 ? [...rest, ...add] : [...rest.slice(0, at + 1), ...add, ...rest.slice(at + 1)]
  })
}

/** A place (Desktop, Pictures…) onto another Seafile folder, or back to home's own (null). */
export function setPlaceMount(id: PlaceId, sf: string | null) {
  if (id === 'home') {
    const at = sf ? parseSf(sf) : null
    if (!sf || (at && at.p === '/')) return setHomeMount(at?.repo ?? null)
  }
  edit((lines) => {
    const target = placeTarget(id)
    const rest = without(lines, target)
    if (!sf) return rest
    const from = accountPath(sf)
    if (!from) return rest
    return [...withAccount(rest), comment(placeComment(PLACES.find((p) => p.id === id)!.label)), line(entry(from, target, 'none', 'bind'))]
  })
}

/** The primary library: home's, or the one the settings name. */
export const primaryLibrary = () => seafileHome().library
