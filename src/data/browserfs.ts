import { useSyncExternalStore } from 'react'
import { getAccount, subscribeAccount } from '../os/account'
import { kindOfName } from '../terminal/vfs'
import type { VirtualFiles } from './launcherStore'

// Files kept in this browser, for signed-in users without Seafile: the Terminal, Zed, Files and
// the desktop write here when home is not in Seafile (data/mounts.ts mounts it on ~, or on
// /mnt/browser once Seafile is home). One IndexedDB database per account, so another account on
// the same browser never sees them; they are gone when the browser's site data is cleared, which
// Files, Zed, the terminal and Settings all say.
//
// Every file's name, size and time is kept in memory (the terminal's commands are synchronous),
// with the text of small text files; the bytes stay in IndexedDB as Blobs until something reads
// them. Paths are relative to the store's root: "/", "/Documents/notes.md".

/** `mode`: permission bits set with chmod (terminal/modes.ts); absent means the defaults. Moves with the file, goes with it when it is deleted, and survives a rewrite. */
export type BrowserEntry = { path: string; dir: boolean; size: number; mtime: number; type: string; mode?: number }

/** Text files up to this size are kept in memory too, for cat, grep and the editors. */
const TEXT_IN_MEMORY = 1024 * 1024
const NODES = 'nodes'
const BLOBS = 'blobs'
const FOLDERS = ['/Desktop', '/Documents', '/Downloads', '/Music', '/Pictures', '/Videos']

let db: IDBDatabase | null = null
let owner: number | null = null
let storeUUID: string | null = null
/** Backing identity; never inferred from the mount label or a home path. */
export const browserStoreIdentity = () => state === 'ready' && owner !== null && storeUUID ? { account: owner, storeUUID } : null
let state: 'off' | 'loading' | 'ready' | 'error' = 'off'
/** Settles once the account is known and its store (or none) is open: until then nobody can tell. */
let settleFirst: () => void = () => {}
let opening: Promise<void> = new Promise<void>((resolve) => (settleFirst = resolve))
let known = false
const nodes = new Map<string, BrowserEntry>()
const children = new Map<string, Set<string>>()
const texts = new Map<string, string>()
const listeners = new Set<() => void>()
let version = 0
let askedToPersist = false

const parentOf = (p: string) => p.replace(/\/[^/]*$/, '') || '/'
const nameOf = (p: string) => p.split('/').pop() || ''
const join = (dir: string, name: string) => (dir === '/' ? `/${name}` : `${dir}/${name}`)
const isTextName = (name: string) => ['text', 'markdown', 'link'].includes(kindOfName(name))
/**
 * Mutation evidence, for checks that must notice any change to a path (widget trust): every entry
 * and folder gets a fresh number from one counter on each write, removal or move here, whatever its
 * size or time say. This tab's memory does not follow writes made in other tabs of this browser, so
 * those tabs announce the paths they changed and they are recorded here as changed elsewhere.
 */
let mutations = 0
const entrySeq = new Map<string, number>()
const changedElsewhere = new Map<string, number>()
const outgoing = new Set<string>()
let quiet = false
/** `self`: the entry at `path` was written, removed or moved. `child`: the folder's list of entries
 * changed (an entry in it came or went); the entry that changed is announced as `self` too. */
export type BrowserChange = 'self' | 'child'
const touch = (path: string, kind: BrowserChange) => {
  entrySeq.set(path, ++mutations)
  if (state === 'ready' && !quiet) outgoing.add(`${kind}:${path}`)
}
/** This tab's mutation number of a path (0: unchanged since the store was loaded). */
export const browserEntrySeq = (path: string) => entrySeq.get(path) ?? 0
/** Changes another tab of this browser announced and this tab has not read again from the store
 * (keys `self:<path>` and `child:<path>`, see BrowserChange). */
export const browserChangedElsewhere = (): ReadonlyMap<string, number> => changedElsewhere
/** Whether an announced change can affect a folder `path` and what is in it: the folder or any folder
 * on the way to it was itself written, removed or moved, or something inside it changed. A list change
 * of a folder above it (a sibling came or went) cannot: that sibling is announced on its own. */
export const browserChangeAffects = (marker: string, path: string) => {
  const kind = marker.slice(0, marker.indexOf(':')), at = marker.slice(marker.indexOf(':') + 1)
  const inside = at === path || at.startsWith(path === '/' ? '/' : `${path}/`)
  return kind === 'self' ? inside || path.startsWith(at === '/' ? '/' : `${at}/`) : inside
}
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('mvlos-browserfs') : null
channel?.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as { store?: unknown; paths?: unknown }
  if (!storeUUID || data?.store !== storeUUID || !Array.isArray(data.paths)) return
  for (const p of data.paths) if (typeof p === 'string' && /^(self|child):\//.test(p)) changedElsewhere.set(p, ++mutations)
  version++
  listeners.forEach((l) => l())
})
const emit = () => {
  if (outgoing.size && storeUUID) { channel?.postMessage({ store: storeUUID, paths: [...outgoing] }); outgoing.clear() }
  version++
  listeners.forEach((l) => l())
}

/**
 * Launchers: the .desktop files in ~/Desktop and ~/.local/share/applications are not kept here
 * but in the synced launcher list, so every device has them (data/launcherStore.ts, set up by
 * data/launchers.ts). Reading those folders lists them too; writing, deleting, renaming or moving
 * a .desktop file there goes to the list.
 */
let virtual: VirtualFiles | null = null
export function setVirtualFiles(v: VirtualFiles | null) {
  virtual = v
  emit()
}
/** The launcher list changed (here or on another device): its files show the change. */
export const virtualFilesChanged = () => emit()
const isVirtual = (path: string) => !nodes.has(path) && !!virtual?.has(path)

/** Thrown for anything the store refuses: a missing folder, a name taken, a full disk. */
export class BrowserFsError extends Error {}

// --- IndexedDB ----------------------------------------------------------------------------------

const done = (req: IDBRequest | IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    if ('oncomplete' in req) {
      req.oncomplete = () => resolve()
      req.onabort = req.onerror = () => reject(req.error ?? new Error('aborted'))
    } else {
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
    }
  })

function result<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

const dbName = (userId: number) => `mvlos-files-${userId}`

function openDb(userId: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName(userId), 1)
    req.onupgradeneeded = () => {
      req.result.createObjectStore(NODES, { keyPath: 'path' })
      req.result.createObjectStore(BLOBS)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/** Turns a failed write into words: a full disk is the likely one. */
function writeError(e: unknown): BrowserFsError {
  const name = (e as DOMException | null)?.name
  if (name === 'QuotaExceededError') return new BrowserFsError('This browser has no room left for more files. Delete some, or set up Seafile in Settings → Integrations.')
  return new BrowserFsError(`This browser could not save it (${(e as Error)?.message ?? 'unknown error'})`)
}

function index(e: BrowserEntry) {
  nodes.set(e.path, e)
  touch(e.path, 'self')
  if (e.path === '/') return
  const parent = parentOf(e.path)
  touch(parent, 'child')
  let set = children.get(parent)
  if (!set) children.set(parent, (set = new Set()))
  set.add(e.path)
}

function unindex(path: string) {
  touch(path, 'self')
  touch(parentOf(path), 'child')
  nodes.delete(path)
  texts.delete(path)
  children.get(parentOf(path))?.delete(path)
  children.delete(path)
}

async function load(userId: number) {
  const opened = await openDb(userId)
  if (owner !== userId) return opened.close()
  db = opened
  const identityTx = opened.transaction(BLOBS, 'readwrite')
  const identityStore = identityTx.objectStore(BLOBS)
  const identityKey = '\0mvlos-store-uuid'
  const previous = await result(identityStore.get(identityKey))
  const uuid = typeof previous === 'string' ? previous : crypto.randomUUID()
  if (!previous) identityStore.put(uuid, identityKey)
  await done(identityTx)
  if (owner !== userId) return
  storeUUID = uuid
  nodes.clear()
  changedElsewhere.clear()
  children.clear()
  texts.clear()
  const tx = db.transaction([NODES, BLOBS], 'readonly')
  const all = await result(tx.objectStore(NODES).getAll() as IDBRequest<BrowserEntry[]>)
  for (const e of all) index(e)
  const small = all.filter((e) => !e.dir && e.size <= TEXT_IN_MEMORY && isTextName(nameOf(e.path)))
  const blobs = await Promise.all(small.map((e) => result(tx.objectStore(BLOBS).get(e.path) as IDBRequest<Blob | undefined>)))
  await Promise.all(small.map(async (e, i) => texts.set(e.path, (await blobs[i]?.text()) ?? '')))
  index({ path: '/', dir: true, size: 0, mtime: 0, type: '' })
  // A new store starts with the usual home folders.
  if (!all.length) for (const f of FOLDERS) await put({ path: f, dir: true, size: 0, mtime: Date.now(), type: '' })
}

/** Opens the signed-in account's store (closing another's), or none. */
function openFor(userId: number | null) {
  if (known && owner === userId) return opening
  const first = !known
  known = true
  owner = userId
  db?.close()
  db = null
  storeUUID = null
  nodes.clear()
  changedElsewhere.clear()
  children.clear()
  texts.clear()
  if (userId === null || typeof indexedDB === 'undefined') {
    state = 'off'
    emit()
    if (first) settleFirst()
    return (opening = Promise.resolve())
  }
  state = 'loading'
  emit()
  opening = load(userId).then(
    () => {
      if (owner === userId) state = 'ready'
      emit()
    },
    () => {
      if (owner === userId) state = 'error'
      emit()
    },
  )
  if (first) void opening.then(settleFirst)
  return opening
}

let started = false

/** Follows the account: its own store once signed in, nothing for guests. */
export function startBrowserFiles() {
  if (started) return
  started = true
  const follow = () => {
    const a = getAccount()
    if (a.status === 'user') void openFor(a.user!.id)
    else if (a.status !== 'loading') void openFor(null)
  }
  follow()
  subscribeAccount(follow)
}

export type BrowserGuard = { check: () => void; signal?: AbortSignal }
/** Guarded transactions abort with their executor and never publish into a different account's cache. */
async function guardedDone(tx: IDBTransaction, guard?: BrowserGuard) {
  const original = db
  const abort = () => { try { tx.abort() } catch { /* already committed */ } }
  guard?.signal?.addEventListener('abort', abort, { once: true })
  try { guard?.check(); await done(tx); guard?.check(); if (db !== original) throw new BrowserFsError('The browser account changed') }
  catch (e) { abort(); throw e }
  finally { guard?.signal?.removeEventListener('abort', abort) }
}
/** Writes one entry (and its bytes) to IndexedDB, then to memory. */
async function put(e: BrowserEntry, blob?: Blob, guard?: BrowserGuard) {
  guard?.check()
  if (!db) throw new BrowserFsError('Files in this browser are not available (sign in first)')
  const tx = db.transaction([NODES, BLOBS], 'readwrite')
  tx.objectStore(NODES).put(e)
  if (blob) tx.objectStore(BLOBS).put(blob, e.path)
  await guardedDone(tx, guard).catch((err) => {
    throw writeError(err)
  })
  index(e)
}

/** Asks the browser not to clear these files on its own when space runs low (once per visit). */
function persist() {
  if (askedToPersist) return
  askedToPersist = true
  void navigator.storage?.persist?.().catch(() => {})
}

// --- reading ------------------------------------------------------------------------------------

export const browserFilesState = () => state
/** Resolves once the store is loaded (or there is none). */
export const browserFilesReady = () => opening
export const subscribeBrowserFiles = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}
/** Re-renders whenever anything in the store changes. */
export const useBrowserFiles = () => useSyncExternalStore(subscribeBrowserFiles, () => version)

/** A stored entry only: never a launcher file projected from the synced launcher list. The store has
 * no links or aliases; every stored path is a plain file or folder written through this module. */
export const realBrowserEntry = (path: string): BrowserEntry | null => (state === 'ready' ? nodes.get(path) ?? null : null)
export const statBrowser = (path: string): BrowserEntry | null => nodes.get(path) ?? (state === 'ready' ? (virtual?.stat(path) ?? null) : null)
export function listBrowser(dir: string): BrowserEntry[] {
  const real = [...(children.get(dir) ?? [])].map((p) => nodes.get(p)!).filter(Boolean)
  if (!virtual || state !== 'ready' || !nodes.get(dir)?.dir) return real
  return [...real, ...virtual.list(dir).filter((e) => !nodes.has(e.path))]
}
/** A small text file's contents, from memory; null when it is not kept there. */
export const browserText = (path: string): string | null => texts.get(path) ?? (isVirtual(path) ? virtual!.text(path) : null)

/**
 * Re-reads one folder, its ancestors and everything inside it from IndexedDB (the store itself, which
 * other tabs write to) into this tab's memory. Entries whose stored metadata or small text differ are
 * re-indexed (and get new mutation numbers); entries gone from the store are dropped; the paths it
 * covered are no longer marked as changed elsewhere. Unchanged entries keep their numbers.
 */
export async function refreshBrowserTree(path: string) {
  await opening
  const current = db
  if (!current || state !== 'ready') throw new BrowserFsError('Files in this browser are not available')
  const parts = path.split('/').filter(Boolean)
  const ancestors = parts.map((_, i) => `/${parts.slice(0, i + 1).join('/')}`)
  // Announcements that arrive while this reads may describe writes it did not see: those stay marked.
  const startedAt = mutations
  const tx = current.transaction([NODES, BLOBS], 'readonly')
  const store = tx.objectStore(NODES)
  const fetched = new Map<string, BrowserEntry>()
  for (const at of ancestors) {
    const e = await result(store.get(at) as IDBRequest<BrowserEntry | undefined>)
    if (e) fetched.set(at, e)
  }
  if (path !== '/') for (const e of await result(store.getAll(IDBKeyRange.bound(`${path}/`, `${path}/\uffff`)) as IDBRequest<BrowserEntry[]>)) fetched.set(e.path, e)
  const small = [...fetched.values()].filter((e) => !e.dir && e.size <= TEXT_IN_MEMORY && isTextName(nameOf(e.path)))
  const blobs = await Promise.all(small.map((e) => result(tx.objectStore(BLOBS).get(e.path) as IDBRequest<Blob | undefined>)))
  const fresh = new Map(await Promise.all(small.map(async (e, i) => [e.path, (await blobs[i]?.text()) ?? ''] as const)))
  if (db !== current || state !== 'ready') throw new BrowserFsError('The browser account changed')
  const inScope = (p: string) => p === path || p.startsWith(`${path}/`) || ancestors.includes(p)
  const same = (a: BrowserEntry | undefined, b: BrowserEntry) => !!a && JSON.stringify([a.path, a.dir, a.size, a.mtime, a.type, a.mode ?? null]) === JSON.stringify([b.path, b.dir, b.size, b.mtime, b.type, b.mode ?? null])
  let changed = false
  quiet = true
  try {
    for (const p of [...nodes.keys()]) if (p !== '/' && inScope(p) && !fetched.has(p)) { unindex(p); changed = true }
    for (const e of [...fetched.values()].sort((a, b) => a.path.length - b.path.length)) {
      const text = fresh.get(e.path)
      if (same(nodes.get(e.path), e) && (text === undefined ? !texts.has(e.path) : texts.get(e.path) === text)) continue
      index(e)
      if (text === undefined) texts.delete(e.path)
      else texts.set(e.path, text)
      changed = true
    }
    // Every change this read covers is settled: the folder, the folders on the way to it, and everything inside.
    for (const [p, n] of [...changedElsewhere]) if (n <= startedAt && browserChangeAffects(p, path)) { changedElsewhere.delete(p); changed = true }
  } finally { quiet = false }
  // Only a real difference notifies (a check that re-reads must not wake every listener into another check).
  if (changed) {
    version++
    listeners.forEach((l) => l())
  }
}

export async function readBrowserBlob(path: string): Promise<Blob> {
  if (isVirtual(path)) return new Blob([virtual!.text(path) ?? ''], { type: 'text/plain' })
  const e = nodes.get(path)
  if (!e || e.dir || !db) throw new BrowserFsError(`${path}: no such file`)
  const blob = await result(db.transaction(BLOBS, 'readonly').objectStore(BLOBS).get(path) as IDBRequest<Blob | undefined>)
  return blob ?? new Blob([], { type: e.type })
}

export async function readBrowserText(path: string): Promise<string> {
  return texts.get(path) ?? (await readBrowserBlob(path)).text()
}

/** Everything stored, in bytes. */
export const browserBytes = () => [...nodes.values()].reduce((n, e) => n + (e.dir ? 0 : e.size), 0)

/** How many files (not folders) there are, and their bytes, under a folder. */
export function browserTree(dir = '/'): { files: number; bytes: number } {
  let files = 0
  let bytes = 0
  for (const e of nodes.values()) {
    if (e.dir || !(dir === '/' || e.path.startsWith(`${dir}/`))) continue
    files++
    bytes += e.size
  }
  return { files, bytes }
}

// --- writing ------------------------------------------------------------------------------------

function needFolder(dir: string) {
  const e = nodes.get(dir)
  if (!e) throw new BrowserFsError(`${dir}: no such folder`)
  if (!e.dir) throw new BrowserFsError(`${dir}: not a folder`)
}

/** Writes a file, replacing one of that name. Its folder must exist (see mkdirBrowser). */
export async function writeBrowserFile(path: string, data: Blob | string, guard?: BrowserGuard) {
  guard?.check()
  if (guard && virtual?.isPlace(path)) throw new BrowserFsError('Agent writes to launcher folders are unavailable')
  needFolder(parentOf(path))
  if (nodes.get(path)?.dir) throw new BrowserFsError(`${path}: is a folder`)
  // A launcher in one of the launcher folders goes to the synced list (a plain file of that name goes).
  if (virtual?.isPlace(path) && virtual.write(path, typeof data === 'string' ? data : await data.text())) {
    if (nodes.has(path)) await removeBrowser(path)
    return emit()
  }
  const blob = typeof data === 'string' ? new Blob([data], { type: 'text/plain' }) : data
  persist()
  const mode = nodes.get(path)?.mode
  await put({ path, dir: false, size: blob.size, mtime: Date.now(), type: blob.type, ...(mode === undefined ? {} : { mode }) }, blob, guard)
  const text = blob.size <= TEXT_IN_MEMORY && isTextName(nameOf(path)) ? (typeof data === 'string' ? data : await blob.text()) : null
  guard?.check()
  if (text !== null) texts.set(path, text)
  else texts.delete(path)
  emit()
}

/** Sets a file's or folder's permission bits (chmod); null puts the defaults back. */
export async function setBrowserMode(path: string, mode: number | null) {
  const e = nodes.get(path)
  if (!e) throw new BrowserFsError(`${path}: no such file or folder`)
  const { mode: _was, ...rest } = e
  void _was
  await put(mode === null ? rest : { ...rest, mode })
  emit()
}

/** Makes a folder; with `parents`, the folders above it too (and an existing folder is fine). */
export async function mkdirBrowser(path: string, parents = false, guard?: BrowserGuard) {
  guard?.check()
  const existing = nodes.get(path)
  if (existing) {
    if (parents && existing.dir) return
    throw new BrowserFsError(`${path}: already exists`)
  }
  const parent = parentOf(path)
  if (!nodes.has(parent)) {
    if (!parents) throw new BrowserFsError(`${parent}: no such folder`)
    await mkdirBrowser(parent, true, guard)
  }
  needFolder(parent)
  persist()
  await put({ path, dir: true, size: 0, mtime: Date.now(), type: '' }, undefined, guard)
  emit()
}

/** Everything at and under a path, deepest last. */
const subtree = (path: string) => [...nodes.keys()].filter((p) => p === path || p.startsWith(`${path}/`)).sort((a, b) => a.length - b.length)

/** Deletes a file, or a folder with everything in it. For good: there is no trash here. */
export async function removeBrowser(path: string, guard?: BrowserGuard) {
  guard?.check()
  if (guard && (isVirtual(path) || nodes.get(path)?.dir)) throw new BrowserFsError('Agent bulk/virtual deletion is unavailable')
  if (isVirtual(path)) {
    virtual!.remove(path)
    return emit()
  }
  if (path === '/' || !nodes.has(path)) throw new BrowserFsError(`${path}: no such file or folder`)
  if (!db) throw new BrowserFsError('Files in this browser are not available')
  const all = subtree(path)
  const tx = db.transaction([NODES, BLOBS], 'readwrite')
  for (const p of all) {
    tx.objectStore(NODES).delete(p)
    tx.objectStore(BLOBS).delete(p)
  }
  await guardedDone(tx, guard)
  for (const p of all.reverse()) unindex(p)
  emit()
}

/** Moves or copies a file or folder to a new path (which must not exist; its folder must). */
export async function transferBrowser(op: 'move' | 'copy', from: string, to: string) {
  if (nodes.has(to) || isVirtual(to)) throw new BrowserFsError(`${nameOf(to)} already exists there`)
  // Launchers of the list: renamed or moved within it, or out of it as a plain file.
  if (isVirtual(from)) {
    if (to === from || to.startsWith(`${from}/`)) return
    needFolder(parentOf(to))
    if (virtual!.isPlace(to) && virtual!.rename(op, from, to)) return emit()
    await writeBrowserFile(to, virtual!.text(from) ?? '')
    if (op === 'move') virtual!.remove(from)
    return emit()
  }
  if (!nodes.has(from)) throw new BrowserFsError(`${from}: no such file or folder`)
  // A .desktop file moved into a launcher folder joins the list, if it is a launcher.
  if (!nodes.get(from)!.dir && virtual?.isPlace(to)) {
    needFolder(parentOf(to))
    if (virtual.write(to, await readBrowserText(from))) {
      if (op === 'move') await removeBrowser(from)
      return emit()
    }
  }
  if (to === from || to.startsWith(`${from}/`)) throw new BrowserFsError('A folder cannot go inside itself')
  needFolder(parentOf(to))
  if (!db) throw new BrowserFsError('Files in this browser are not available')
  const all = subtree(from)
  const now = Date.now()
  const moved = all.map((p) => ({ old: p, e: { ...nodes.get(p)!, path: to + p.slice(from.length), mtime: op === 'copy' ? now : nodes.get(p)!.mtime } }))
  const blobs = new Map<string, Blob | undefined>()
  for (const m of moved) if (!m.e.dir) blobs.set(m.old, await result(db.transaction(BLOBS, 'readonly').objectStore(BLOBS).get(m.old) as IDBRequest<Blob | undefined>))
  const tx = db.transaction([NODES, BLOBS], 'readwrite')
  for (const m of moved) {
    tx.objectStore(NODES).put(m.e)
    if (!m.e.dir) tx.objectStore(BLOBS).put(blobs.get(m.old) ?? new Blob([]), m.e.path)
    if (op === 'move') {
      tx.objectStore(NODES).delete(m.old)
      tx.objectStore(BLOBS).delete(m.old)
    }
  }
  await done(tx).catch((err) => {
    throw writeError(err)
  })
  for (const m of moved) {
    const text = texts.get(m.old)
    if (op === 'move') unindex(m.old)
    index(m.e)
    if (text !== undefined) texts.set(m.e.path, text)
  }
  emit()
}

/** Deletes this account's whole store on this browser (Settings → Account, and deleting the account). */
export async function wipeBrowserFiles(userId = owner) {
  if (userId === null) return
  if (owner === userId) {
    db?.close()
    db = null
    nodes.clear()
    changedElsewhere.clear()
    children.clear()
    texts.clear()
    owner = null
    state = 'off'
  }
  await done(indexedDB.deleteDatabase(dbName(userId))).catch(() => {})
  emit()
  const a = getAccount()
  if (a.status === 'user' && a.user!.id === userId) void openFor(userId)
}

export { join as joinBrowserPath, nameOf as browserName, parentOf as browserParent }
