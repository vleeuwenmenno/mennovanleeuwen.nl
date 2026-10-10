import { useSyncExternalStore } from 'react'
import { notify } from '../os/notify'
import { parseSf, refreshDirs, sfPath } from './seafile'

// Unpacking ZIPs from Seafile into Seafile. The server does the work (server/unzip.ts: only the
// chosen files' bytes are read, never the whole archive); this keeps the running jobs, polls them
// for progress, lists the folder again when one is done, and says so.

export type Clash = 'replace' | 'keep' | 'skip'
export type Done = { path: string; how: 'inflating' | 'extracting' | 'creating' | 'skipped' }
export type Status = {
  id: string
  state: 'running' | 'done' | 'failed' | 'cancelled'
  error: string | null
  total: number
  totalBytes: number
  bytes: number
  current: string | null
  count: number
  done: Done[]
  errors: { path: string; error: string }[]
  into: { repo: string; path: string }
}
/** A job as the page keeps it: the archive's name and where it goes, with its latest status. */
export type ExtractJob = { id: string; archive: string; zip: string; into: string; status: Status }

let jobs: ExtractJob[] = []
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())
export const useExtractJobs = () =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => jobs,
  )

async function call<T>(url: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init
  const res = await fetch(url, { ...rest, credentials: 'same-origin', headers: json !== undefined ? { 'Content-Type': 'application/json' } : undefined, body: json !== undefined ? JSON.stringify(json) : undefined })
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`)
  return body as T
}

/** The default destination: a folder next to the archive, named after it ("mods" for mods.zip). */
export function besideArchive(zip: string): string {
  const at = parseSf(zip)!
  const parent = at.p.split('/').slice(0, -1).join('/') || '/'
  const stem = at.p.split('/').pop()!.replace(/\.zip$/i, '') || 'archive'
  return sfPath(at.repo, `${parent === '/' ? '' : parent}/${stem}`)
}

export type ExtractOptions = {
  /** Paths in the archive (a folder takes all it holds); none: everything */
  entries?: string[]
  /** The archive folder they come from, left off their paths */
  base?: string
  clash: Clash
  /** Per file, overriding `clash` (unzip's questions) */
  decisions?: Record<string, Clash>
  /** No notification when it is done (the terminal prints its own) */
  quiet?: boolean
}

/**
 * Unpacks into a Seafile folder; `onUpdate` hears every status (with the files finished since
 * the last one). Resolves with the final status.
 */
export async function extract(zip: string, into: string, opts: ExtractOptions, onUpdate?: (s: Status) => void, signal?: AbortSignal): Promise<Status> {
  const z = parseSf(zip)!
  const t = parseSf(into)!
  const { id } = await call<{ id: string }>('/api/seafile/extract', { method: 'POST', json: { repo: z.repo, path: z.p, into: { repo: t.repo, path: t.p }, entries: opts.entries, base: opts.base, clash: opts.clash, decisions: opts.decisions } })
  const archive = z.p.split('/').pop()!
  const job: ExtractJob = { id, archive, zip, into, status: { id, state: 'running', error: null, total: 0, totalBytes: 0, bytes: 0, current: null, count: 0, done: [], errors: [], into: { repo: t.repo, path: t.p } } }
  jobs = [...jobs, job]
  emit()
  signal?.addEventListener('abort', () => void cancelExtract(id), { once: true })
  let seen = 0
  for (;;) {
    await new Promise((r) => setTimeout(r, 600))
    let s: Status
    try {
      s = await call<Status>(`/api/seafile/extract?id=${encodeURIComponent(id)}&since=${seen}`)
    } catch (e) {
      s = { ...job.status, state: 'failed', error: (e as Error).message }
    }
    seen = s.count
    jobs = jobs.map((j) => (j.id === id ? { ...j, status: { ...s, done: [...j.status.done, ...s.done] } } : j))
    emit()
    onUpdate?.(s)
    if (s.state === 'running') continue
    // The folder it went into, and the one that holds it (it may be new).
    const parent = t.p.split('/').slice(0, -1).join('/') || '/'
    refreshDirs(sfPath(t.repo, parent))
    if (!opts.quiet) {
      notify({
        title: s.state === 'done' ? `Unpacked ${archive}` : s.state === 'cancelled' ? `Stopped unpacking ${archive}` : `Could not unpack ${archive}`,
        body: s.error ?? `${s.total - s.errors.length} file${s.total - s.errors.length === 1 ? '' : 's'}${s.errors.length ? `, ${s.errors.length} left out (${s.errors[0].error})` : ''}`,
      })
    }
    return s
  }
}

export const cancelExtract = (id: string) => call(`/api/seafile/extract?id=${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {})

/** Takes a finished job off the list. */
export function dismissExtract(id: string) {
  jobs = jobs.filter((j) => j.id !== id)
  emit()
}
