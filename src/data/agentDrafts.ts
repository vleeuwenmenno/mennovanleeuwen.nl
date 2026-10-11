import type { Attachment } from './agents'

// What is typed in a thread's message box (and attached) but not sent yet, per thread, with 'new'
// for a thread not started. Kept in memory while the page is open and in localStorage for the
// next visit, per browser. Pictures and big files stay in memory only: localStorage is small.

export type Draft = { text: string; files: Attachment[]; at: number }

const KEY = 'mvlos.agents.drafts'
/** Left alone this long, a draft is let go. */
const KEEP = 30 * 24 * 3600 * 1000
/** What may go to localStorage for all drafts together, in characters. */
const STORED = 1_500_000

const drafts = new Map<string, Draft>()
try {
  const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, Draft>
  for (const [id, d] of Object.entries(saved)) if (d && typeof d.text === 'string' && Date.now() - d.at < KEEP) drafts.set(id, { text: d.text, files: Array.isArray(d.files) ? d.files : [], at: d.at })
} catch {
  /* none saved */
}

let timer: ReturnType<typeof setTimeout> | null = null
/** Signing out clears the account's drafts from this browser (src/os/account.ts): none may come back. */
let forgotten = false
function store() {
  timer = null
  if (forgotten) return
  let room = STORED
  const out: Record<string, Draft> = {}
  // The newest drafts first, so they are the ones that fit.
  for (const [id, d] of [...drafts].sort((a, b) => b[1].at - a[1].at)) {
    room -= d.text.length
    if (room < 0) break
    const files = d.files.filter((f) => f.kind === 'text' && (room -= (f.text?.length ?? 0) + 200) >= 0)
    out[id] = { ...d, files }
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(out))
  } catch {
    /* full or blocked: the drafts stay in memory */
  }
}
const later = () => {
  if (timer) clearTimeout(timer)
  timer = setTimeout(store, 400)
}
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => timer && (clearTimeout(timer), store()))
  window.addEventListener('mvlos:forget', () => ((forgotten = true), drafts.clear()))
}

export const getDraft = (id: string): Draft | undefined => drafts.get(id)

export function setDraft(id: string, text: string, files: Attachment[]) {
  if (!text.trim() && !files.length) {
    if (!drafts.delete(id)) return
  } else drafts.set(id, { text, files, at: Date.now() })
  later()
}

export const dropDraft = (id: string) => setDraft(id, '', [])
