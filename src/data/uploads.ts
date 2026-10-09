import { useSyncExternalStore } from 'react'
import { notify } from '../os/notify'
import { fileLink, getLibrary, libraryName, parseSf, refreshDirs, type Listing } from './seafile'

// Uploads into Seafile: files and whole folders, from the computer (dropped on Files or the
// desktop, or picked with Upload files / Upload folder). The browser sends them straight to
// Seafile's file server with a link this site's server hands out, three at a time, with real
// progress. Big files go in 8 MB chunks, so a failed one carries on from where it stopped.
// Names already in the folder ask once per upload: replace, keep both (Seafile adds " (1)"), or skip.

const CONCURRENT = 3
const CHUNK = 8 * 1024 * 1024
const CHUNKED_FROM = 16 * 1024 * 1024

export type UploadStatus = 'queued' | 'uploading' | 'done' | 'failed' | 'canceled' | 'skipped'
export type Upload = {
  id: string
  batch: string
  file: File
  name: string
  /** Folders inside the target the file goes into ("Photos/2024"), '' for the target itself */
  rel: string
  /** The Seafile folder it goes to */
  target: string
  size: number
  loaded: number
  status: UploadStatus
  error: string | null
  replace: boolean
  /** Bytes per second, smoothed */
  speed: number
}

export type Conflict = { target: string; names: string[]; resolve: (choice: 'replace' | 'keep' | 'skip' | 'cancel') => void }

let uploads: Upload[] = []
let conflict: Conflict | null = null
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}
const update = (id: string, patch: Partial<Upload>) => {
  uploads = uploads.map((u) => (u.id === id ? { ...u, ...patch } : u))
  emit()
}

export const useUploads = () => useSyncExternalStore(subscribe, () => uploads)
export const useConflict = () => useSyncExternalStore(subscribe, () => conflict)

const running = new Map<string, XMLHttpRequest>()
const links = new Map<string, { at: number; url: Promise<string> }>()

/** One upload link per folder, good for an hour; asked again after 50 minutes. */
function uploadLink(target: string): Promise<string> {
  const hit = links.get(target)
  if (hit && Date.now() - hit.at < 50 * 60_000) return hit.url
  const url = fileLink(target, 'upload')
  links.set(target, { at: Date.now(), url })
  url.catch(() => links.delete(target))
  return url
}

const folderOf = (u: Upload) => (u.rel ? `${u.target}/${u.rel}` : u.target)

// --- starting --------------------------------------------------------------------------------

export type Picked = { file: File; rel: string }

/**
 * Uploads files into a Seafile folder. `rel` puts a file in folders inside it (made as needed),
 * for folder uploads. Asks first when names are already there.
 */
export async function uploadFiles(picked: Picked[], target: string) {
  const at = parseSf(target)
  if (!at || !picked.length) return
  if (getLibrary(at.repo)?.permission === 'r') return notify({ title: 'Read-only', body: `${libraryName(at.repo)} is read-only for you.` })

  // What is there already (top level only: a folder that exists is merged into).
  let existing = new Set<string>()
  try {
    const res = await fetch(`/api/seafile/dir?repo=${encodeURIComponent(at.repo)}&p=${encodeURIComponent(at.p)}`, { credentials: 'same-origin' })
    if (res.ok) existing = new Set(((await res.json()) as Listing).entries.filter((e) => !e.dir).map((e) => e.name))
  } catch {
    /* ask nothing, Seafile keeps both */
  }
  const clashes = picked.filter((p) => !p.rel && existing.has(p.file.name)).map((p) => p.file.name)
  let choice: 'replace' | 'keep' | 'skip' | 'cancel' = 'keep'
  if (clashes.length) {
    choice = await new Promise((resolve) => {
      conflict = {
        target,
        names: clashes,
        resolve: (c) => {
          conflict = null
          emit()
          resolve(c)
        },
      }
      emit()
    })
    if (choice === 'cancel') return
  }

  const batch = crypto.randomUUID()
  const fresh: Upload[] = picked.map((p) => {
    const clash = !p.rel && existing.has(p.file.name)
    return {
      id: crypto.randomUUID(),
      batch,
      file: p.file,
      name: p.file.name,
      rel: p.rel,
      target,
      size: p.file.size,
      loaded: 0,
      status: clash && choice === 'skip' ? 'skipped' : 'queued',
      error: null,
      replace: clash && choice === 'replace',
      speed: 0,
    }
  })
  uploads = [...uploads, ...fresh]
  emit()
  pump()
}

function pump() {
  let active = uploads.filter((u) => u.status === 'uploading').length
  for (const u of uploads) {
    if (active >= CONCURRENT) break
    if (u.status !== 'queued') continue
    active++
    update(u.id, { status: 'uploading', error: null })
    run(u.id).finally(pump)
  }
}

// --- sending ---------------------------------------------------------------------------------

const ERRORS: Record<number, string> = { 440: 'Seafile does not accept that file name', 441: 'The file is already there', 442: 'Too big for Seafile', 443: 'Out of space (quota)', 403: 'Not allowed in that folder', 423: 'The library is locked: unlock it in Files first' }

class UploadError extends Error {}

async function run(id: string) {
  const u = uploads.find((x) => x.id === id)
  if (!u) return
  try {
    const link = await uploadLink(u.target)
    if (u.size >= CHUNKED_FROM) await sendChunks(u, link)
    else await send(u, link, u.file, null)
    if (uploads.find((x) => x.id === id)?.status !== 'uploading') return
    update(id, { status: 'done', loaded: u.size, speed: 0 })
    refreshDirs(folderOf(u))
    if (u.rel) refreshDirs(`${u.target}/${u.rel.split('/')[0]}`)
  } catch (e) {
    if (uploads.find((x) => x.id === id)?.status !== 'uploading') return
    // An old upload link (Seafile forgot it) gets a fresh one on the retry.
    links.delete(u.target)
    update(id, { status: 'failed', error: (e as Error).message || 'It did not upload', speed: 0 })
  } finally {
    running.delete(id)
    finishBatch(u.batch)
  }
}

/** One request: the whole file, or one chunk of it (with its byte range). */
function send(u: Upload, link: string, body: Blob, range: { start: number; end: number } | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    running.set(u.id, xhr)
    const form = new FormData()
    form.append('parent_dir', parseSf(u.target)!.p)
    if (u.rel) form.append('relative_path', u.rel)
    form.append('replace', u.replace ? '1' : '0')
    form.append('file', body, u.name)
    xhr.open('POST', `${link}?ret-json=1`)
    if (range) {
      xhr.setRequestHeader('Content-Range', `bytes ${range.start}-${range.end}/${u.size}`)
      const ascii = u.name.replace(/[^\x20-\x7e]|"/g, '_')
      xhr.setRequestHeader('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(u.name)}`)
    }
    const base = range?.start ?? 0
    let last = { t: performance.now(), b: base }
    xhr.upload.onprogress = (e) => {
      const now = performance.now()
      const loaded = base + e.loaded
      const dt = (now - last.t) / 1000
      const prev = uploads.find((x) => x.id === u.id)
      if (dt > 0.3) {
        const rate = (loaded - last.b) / dt
        update(u.id, { loaded: Math.min(loaded, u.size), speed: prev?.speed ? prev.speed * 0.7 + rate * 0.3 : rate })
        last = { t: now, b: loaded }
      } else if (prev) update(u.id, { loaded: Math.min(loaded, u.size) })
    }
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new UploadError(ERRORS[xhr.status] ?? (xhr.responseText.slice(0, 120) || `Seafile answered ${xhr.status}`))))
    xhr.onerror = () => reject(new UploadError('The connection dropped'))
    xhr.onabort = () => reject(new UploadError('Canceled'))
    xhr.send(form)
  })
}

/** A big file in order, chunk by chunk, starting from what Seafile already has. */
async function sendChunks(u: Upload, link: string) {
  const at = parseSf(u.target)!
  const parent = u.rel ? `${at.p === '/' ? '' : at.p}/${u.rel}` : at.p
  let start = 0
  try {
    const res = await fetch(`/api/seafile/uploaded?repo=${encodeURIComponent(at.repo)}&parent=${encodeURIComponent(parent)}&name=${encodeURIComponent(u.name)}`, { credentials: 'same-origin' })
    if (res.ok) start = Math.min(u.size, ((await res.json()) as { bytes: number }).bytes || 0)
  } catch {
    /* from the start */
  }
  // Replacing starts over: what is there belongs to the old file.
  if (u.replace || start >= u.size) start = 0
  update(u.id, { loaded: start })
  while (start < u.size) {
    if (uploads.find((x) => x.id === u.id)?.status !== 'uploading') throw new UploadError('Canceled')
    const end = Math.min(u.size, start + CHUNK) - 1
    await send(u, link, u.file.slice(start, end + 1), { start, end })
    start = end + 1
  }
}

// --- managing --------------------------------------------------------------------------------

export function cancelUpload(id: string) {
  const u = uploads.find((x) => x.id === id)
  if (!u || (u.status !== 'uploading' && u.status !== 'queued')) return
  update(id, { status: 'canceled', speed: 0 })
  running.get(id)?.abort()
  pump()
}

export function retryUpload(id: string) {
  const u = uploads.find((x) => x.id === id)
  if (!u || (u.status !== 'failed' && u.status !== 'canceled')) return
  update(id, { status: 'queued', error: null, loaded: 0 })
  pump()
}

export const cancelAll = () => uploads.filter((u) => u.status === 'queued' || u.status === 'uploading').forEach((u) => cancelUpload(u.id))
export const retryFailed = () => uploads.filter((u) => u.status === 'failed').forEach((u) => retryUpload(u.id))
export function clearFinished() {
  uploads = uploads.filter((u) => u.status === 'queued' || u.status === 'uploading')
  emit()
}

/** When an upload finishes, say so (once, for the whole lot). */
function finishBatch(batch: string) {
  const all = uploads.filter((u) => u.batch === batch)
  if (all.some((u) => u.status === 'queued' || u.status === 'uploading')) return
  const done = all.filter((u) => u.status === 'done')
  const failed = all.filter((u) => u.status === 'failed')
  if (!done.length && !failed.length) return
  const target = all[0].target
  const at = parseSf(target)!
  const where = at.p === '/' ? libraryName(at.repo) : at.p.split('/').pop()
  notify({
    title: failed.length ? `${failed.length} of ${all.length} uploads failed` : `Uploaded ${done.length === 1 ? done[0].name : `${done.length} files`}`,
    body: failed.length ? failed[0].error ?? undefined : `To ${where}`,
  })
}

export const busy = () => uploads.some((u) => u.status === 'queued' || u.status === 'uploading')

// Leaving the page stops uploads: the browser asks first.
if (typeof window !== 'undefined')
  window.addEventListener('beforeunload', (e) => {
    if (busy()) e.preventDefault()
  })

// --- what was dropped ------------------------------------------------------------------------

type Entry = { isFile: boolean; isDirectory: boolean; name: string; file?: (ok: (f: File) => void, err: (e: unknown) => void) => void; createReader?: () => { readEntries: (ok: (es: Entry[]) => void, err: (e: unknown) => void) => void } }

/** Whether a drag holds files from the computer. */
export const hasOsFiles = (dt: DataTransfer) => dt.types.includes('Files')

/**
 * The files dropped from the computer, folders walked, each with the folders it sits in. Must be
 * called during the drop (the browser forgets the items after it).
 */
export function droppedFiles(dt: DataTransfer): Promise<Picked[]> {
  const entries = [...dt.items].map((i) => (i.kind === 'file' ? ((i as DataTransferItem & { webkitGetAsEntry?: () => Entry | null }).webkitGetAsEntry?.() ?? null) : null))
  const plain = [...dt.files]
  if (!entries.some(Boolean)) return Promise.resolve(plain.map((file) => ({ file, rel: '' })))
  const out: Picked[] = []
  const walk = async (entry: Entry, rel: string): Promise<void> => {
    if (entry.isFile && entry.file) {
      const file = await new Promise<File>((ok, err) => entry.file!(ok, err))
      out.push({ file, rel })
    } else if (entry.isDirectory && entry.createReader) {
      const reader = entry.createReader()
      const dir = rel ? `${rel}/${entry.name}` : entry.name
      // readEntries answers in batches until it answers none.
      for (;;) {
        const batch = await new Promise<Entry[]>((ok, err) => reader.readEntries(ok, err))
        if (!batch.length) break
        for (const child of batch) await walk(child, dir)
      }
    }
  }
  return Promise.all(entries.map((e) => (e ? walk(e, '') : Promise.resolve()))).then(() => out)
}

/** Files picked with a file input: a folder pick keeps each file's folders. */
export const pickedFiles = (list: FileList): Picked[] =>
  [...list].map((file) => {
    const path = (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? ''
    return { file, rel: path.split('/').slice(0, -1).join('/') }
  })

/** Opens the computer's file picker and uploads what is picked into `target`. */
export function pickAndUpload(target: string, folder = false) {
  const input = document.createElement('input')
  input.type = 'file'
  input.multiple = true
  if (folder) (input as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true
  input.onchange = () => input.files && void uploadFiles(pickedFiles(input.files), target)
  input.click()
}

export const targetName = (target: string) => {
  const at = parseSf(target)
  return at ? (at.p === '/' ? libraryName(at.repo) : at.p.split('/').pop()!) : target
}
