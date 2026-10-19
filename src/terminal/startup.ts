import { browserFilesReady } from '../data/browserfs'
import { lookup, prepare, readFileText } from './fs'
import { runRc, type Base } from './msh/interp'
import { RC_PATH } from './rcfile'

/** The longest the startup file may take: a `sleep` in it must not hold the prompt for good. */
const RC_LIMIT_MS = 5000
/** The longest to wait for the account and the files before going without the startup file. */
const READ_LIMIT_MS = 4000

async function within<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([work, new Promise<null>((r) => (timer = setTimeout(() => r(null), ms)))])
  } finally {
    clearTimeout(timer)
  }
}

/** The text of ~/.mvshrc, or null when there is none (or it cannot be read). */
export async function readRc(): Promise<string | null> {
  return within(readRcNow().catch(() => null), READ_LIMIT_MS)
}

async function readRcNow(): Promise<string | null> {
  // Signed in, ~ is the browser's files or Seafile: wait until the account is known and they are open.
  await browserFilesReady()
  await prepare(RC_PATH.replace(/\/[^/]*$/, ''), 'cat', [RC_PATH])
  const node = lookup(RC_PATH)
  if (node?.type !== 'file') return null
  return (await readFileText(RC_PATH))?.text ?? node.content()
}

/**
 * Runs ~/.mvshrc once in a new terminal session, before its first command. Never throws: a
 * missing, unreadable or broken file leaves the terminal as it would be without one.
 */
export async function runStartupFile(base: Omit<Base, 'signal'>): Promise<void> {
  try {
    const text = await readRc()
    if (!text?.trim()) return
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), RC_LIMIT_MS)
    try {
      await runRc(text, { ...base, signal: ctl.signal }, '~/.mvshrc', RC_PATH)
      if (ctl.signal.aborted) base.print(`{c:muted}~/.mvshrc stopped after ${RC_LIMIT_MS / 1000}s.{/}`)
    } finally {
      clearTimeout(timer)
    }
  } catch {
    /* the terminal starts anyway */
  }
}
