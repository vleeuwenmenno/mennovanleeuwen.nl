import { toAttachment } from '../../data/agents'
import { getDraft, setDraft } from '../../data/agentDrafts'

// A share to the installed Agents app (the share_target in public/agents.webmanifest): the service
// worker (pwa/sw.js receiveShare) keeps what was shared in a cache of its own and opens
// /agents?share=1. The page takes it from there once, signed in, and it fills a new chat's message
// box: never sent by itself. A share waits for an hour (through signing in, say), then is let go.
// Signing out drops it.

const CACHE = 'mvlos-share'
const KEEP = 60 * 60 * 1000

type Meta = { at: number; title: string; text: string; url: string; files: { name: string; type: string }[]; left: string[] }

/** What became of a share: whether one was taken, and the files that could not be attached. */
export type Shared = { errors: string[] }

const hasCaches = () => typeof caches !== 'undefined'

async function meta(): Promise<Meta | null> {
  if (!hasCaches() || !(await caches.has(CACHE))) return null
  const m = (await (await caches.open(CACHE)).match('/__share/meta').then((r) => r?.json()).catch(() => null)) as Meta | null
  if (!m || typeof m.at !== 'number' || Date.now() - m.at > KEEP) {
    await caches.delete(CACHE)
    return null
  }
  return m
}

/** Whether a share is waiting (for the sign-in screen to say so). */
export const shareWaiting = async () => !!(await meta().catch(() => null))

/** The title, text and link a share sheet sends, as one message: each once, in that order. */
export function sharedText(title: string, text: string, url: string): string {
  const parts: string[] = []
  const add = (s: string) => {
    s = s.trim()
    if (s && !parts.some((p) => p.includes(s))) parts.push(s)
  }
  add(text)
  if (title.trim() && !parts.some((p) => p.includes(title.trim()))) parts.unshift(title.trim())
  add(url)
  return parts.join('\n\n')
}

/**
 * The waiting share, read once and dropped, with its files read as the composer reads them, added to
 * the new chat's unsent draft (after what was typed there). One read at a time, so a second caller
 * (React's development mode runs effects twice) gets the same result and adds nothing again.
 */
let taking: Promise<Shared | null> | null = null
export function takeShare(): Promise<Shared | null> {
  taking ??= readShare().finally(() => setTimeout(() => (taking = null), 1000))
  return taking
}

async function readShare(): Promise<Shared | null> {
  const m = await meta().catch(() => null)
  if (!m) return null
  const cache = await caches.open(CACHE)
  const errors = m.left.map((n) => `${n} is too large to attach`)
  const read = await Promise.allSettled(
    m.files.map(async (f, i) => {
      const res = await cache.match(`/__share/${i}`)
      if (!res) throw new Error(`${f.name} did not arrive`)
      const blob = await res.blob()
      return toAttachment(f.type && blob.type !== f.type ? new Blob([blob], { type: f.type }) : blob, f.name, 'Shared')
    }),
  )
  await caches.delete(CACHE)
  const files = read.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
  for (const r of read) if (r.status === 'rejected') errors.push((r.reason as Error).message)
  const was = getDraft('new')
  const text = [was?.text.trim(), sharedText(m.title, m.text, m.url)].filter(Boolean).join('\n\n')
  setDraft('new', text, [...(was?.files ?? []), ...files].slice(0, 10))
  return { errors }
}

if (typeof window !== 'undefined' && hasCaches()) window.addEventListener('mvlos:forget', () => void caches.delete(CACHE).catch(() => {}))
