import { seafileAt } from '../../data/agentPlaces'
import type { ClientGrant, Workdir } from '../../data/agents'
import { HANDLE } from '../../os/identity'
import { capabilities } from '../capabilities'
import { commands } from '../commands'
import { lookup, prepare, actorOf } from '../fs'
import { AGENT_LIMITS, Budget, MAX_TIMEOUT_MS, type Limits, type Stop } from '../limits'
import { startAgent } from '../msh/interp'
import { makePolicy, type Grant } from '../policy'
import { HOME, resolvePath } from '../vfs'

// Where an agent's terminal tool calls run, for the Agents app and the agents command alike: both
// call runAgentCall with the call the server sent, so the same line gives the same result in either,
// with no terminal window needed. Each call is a fresh msh (nothing carries over from the last one
// but the files it wrote), in the work folder or a folder inside it, bounded by the call's budget and
// confined by the policy built from the server's grant (src/terminal/policy.ts, limits.ts).

/** The work folder as a terminal path, if the mounts here still put it there. */
export function workdirPath(w: Workdir): string | null {
  const label = w.label.startsWith('~') ? HOME + w.label.slice(1) : w.label
  if (!label.startsWith('/')) return null
  const at = seafileAt(label)
  return at && at.repo === w.repo && at.path === w.path ? label : null
}

/** What a terminal call answers: for the model (the server writes the tool result from `result`) and for a screen. */
export type TerminalResult = {
  exit_code: number
  stdout: string
  stderr: string
  duration_ms: number
  /** Characters of each stream dropped for being over the limit */
  truncated: { stdout: number; stderr: number }
  /** Why the run was cut short, or null when it finished by itself */
  terminated: Stop | null
  cwd: string
}

export type CallAnswer = {
  /** Plain text: stdout, then stderr (what a screen shows) */
  output: string
  status: number
  /** The structured answer of a `terminal` call */
  result?: TerminalResult
  /** The JSON of a `terminal_capabilities` call */
  capabilities?: string
}

/** The grant of a call that arrives without one (an older server): it only reads. */
const READ_ONLY: ClientGrant = { mode: 'default', write: false, delete: false, network: false, steering: false }

const text = (r: TerminalResult) => [r.stdout, r.stderr].filter(Boolean).join('\n')
const failed = (message: string, cwd: string, status = 1): CallAnswer => {
  const result: TerminalResult = { exit_code: status, stdout: '', stderr: message, duration_ms: 0, truncated: { stdout: 0, stderr: 0 }, terminated: null, cwd }
  return { output: message, status, result }
}

/** The environment a call starts with: the same variables a terminal opens with, and nothing else. */
const agentEnv = (cwd: string): Record<string, string> => ({ USER: HANDLE, HOME, SHELL: '/bin/msh', TERM: 'dumb', EDITOR: 'nvim', LANG: 'en_US.UTF-8', PWD: cwd })

/** A call's context: no terminal window behind it, so nothing here can open an app, take a key or draw. */
function headless(cwd: string, grant: Grant, budget: Budget, signal: AbortSignal) {
  return {
    cwd,
    setCwd: () => {},
    env: agentEnv(cwd),
    history: [] as string[],
    windows: [],
    openApp: () => {},
    openNewApp: () => {},
    closeWindow: () => {},
    clear: () => {},
    exit: () => {},
    setAccent: () => false,
    print: () => {},
    live: () => {},
    size: { cols: 100, rows: 30 },
    // rm's y/N is answered no; nothing else reads keys.
    onKey: (h: ((key: string) => boolean) | null) => void (h && setTimeout(() => h('n'))),
    root: false,
    signal,
    policy: makePolicy(grant),
    budget,
  }
}

/** The folder a call starts in: the work folder, or a folder inside it named by `cwd`. */
async function startDir(workdir: { label: string } | null, base: string, wanted: unknown, ctx: ReturnType<typeof headless>): Promise<{ cwd: string } | { error: string }> {
  if (wanted === undefined || wanted === null || wanted === '') return { cwd: base }
  if (typeof wanted !== 'string') return { error: 'cwd is a folder inside the work folder, as text' }
  // The folder as the terminal shows it (~/Projects/x/sub) or relative to the work folder.
  const label = workdir?.label.startsWith('~') ? HOME + workdir.label.slice(1) : workdir?.label
  const raw = wanted.trim().startsWith('~') ? HOME + wanted.trim().slice(1) : wanted.trim()
  const abs = resolvePath(label && raw.startsWith(label) ? '/' : base, raw)
  if (workdir && abs !== base && !abs.startsWith(base === '/' ? '/' : `${base}/`)) return { error: `cwd ${wanted} is outside the work folder` }
  ctx.signal.throwIfAborted()
  const refused = ctx.policy.cwd(abs)
  if (refused) return { error: refused }
  await prepare(abs, 'ls', [], actorOf(ctx))
  ctx.signal.throwIfAborted()
  const node = lookup(abs)
  if (!node) return { error: `cwd ${wanted}: No such file or directory` }
  if (node.type !== 'dir') return { error: `cwd ${wanted}: Not a directory` }
  return { cwd: abs }
}

/**
 * Runs one call from the server: a `terminal` command line or a `terminal_capabilities` query.
 * `fallbackDir` is where the call starts when the thread has no work folder (the terminal's own
 * folder); with a work folder that is not mounted here the call fails instead of running elsewhere.
 */
export async function runAgentCall(req: { name: string; arguments: Record<string, unknown>; workdir: Workdir | null; fallbackDir: string; grant?: ClientGrant; signal: AbortSignal }): Promise<CallAnswer> {
  const base = req.workdir ? workdirPath(req.workdir) : req.fallbackDir
  if (!base) return failed(`The work folder ${req.workdir?.label} is not mounted here (check /etc/fstab).`, '/')
  return runInFolder({ name: req.name, arguments: req.arguments, folder: req.workdir ? { path: base, label: req.workdir.label, backing: { repo: req.workdir.repo, path: req.workdir.path } } : null, fallbackDir: base, grant: req.grant, signal: req.signal })
}

/** The part of a call that needs the folder as a terminal path (the check script runs it on folders that are not in Seafile). */
export async function runInFolder(req: { name: string; arguments: Record<string, unknown>; folder: { path: string; label: string; backing?: { repo: string; path: string } } | null; fallbackDir: string; grant?: ClientGrant; signal: AbortSignal }): Promise<CallAnswer> {
  const { arguments: args, folder } = req
  const base = folder ? folder.path : req.fallbackDir
  const grant: Grant = { ...(req.grant ?? READ_ONLY), root: folder ? base : null, backing: folder?.backing }

  if (req.name === 'terminal_capabilities') {
    const budget = new Budget(AGENT_LIMITS)
    const only = typeof args.command === 'string' && args.command.trim() ? args.command.trim() : undefined
    const ctx = headless(base, grant, budget, req.signal)
    const info = capabilities(commands, { ...ctx, tty: false }, only, true)
    if (only && !info.commands.length) return failed(`There is no command called ${only}. Call terminal_capabilities without a command to list them.`, base)
    return { output: 'capabilities', status: 0, capabilities: JSON.stringify(info) }
  }

  const command = typeof args.command === 'string' ? args.command : ''
  if (!command.trim()) return failed('msh: no command given', base, 2)
  const seconds = Number(args.timeout_seconds)
  const timeoutMs = Number.isFinite(seconds) && seconds > 0 ? Math.min(MAX_TIMEOUT_MS, Math.max(1000, seconds * 1000)) : AGENT_LIMITS.timeoutMs
  return execute(command, base, grant, { ...AGENT_LIMITS, timeoutMs }, req.signal, args.cwd)
}

/** Runs a command line under a grant and limits (split out so the check script can use small limits). */
export async function execute(command: string, cwd: string, grant: Grant, limits: Limits, outer: AbortSignal, wanted?: unknown): Promise<CallAnswer> {
  const ctl = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    ctl.abort()
  }, limits.timeoutMs)
  const stop = () => ctl.abort()
  outer.addEventListener('abort', stop)
  if (outer.aborted) ctl.abort()
  const t0 = performance.now()
  const budget = new Budget(limits)
  try {
    const ctx = headless(cwd, grant, budget, ctl.signal)
    let run: ReturnType<typeof startAgent> | undefined
    const task = async () => {
      ctx.signal.throwIfAborted()
      if (command.length > 64_000) { budget.stop('memory'); return null }
      const start = await startDir(grant.root ? { label: grant.root } : null, cwd, wanted, ctx)
      ctx.signal.throwIfAborted()
      if ('error' in start) throw new Error(start.error)
      cwd = start.cwd
      ctx.cwd = cwd
      ctx.env.PWD = cwd
      run = startAgent(command, ctx)
      return await run.done
    }
    const gaveUp = new Promise<null>((resolve) => {
      if (ctl.signal.aborted) resolve(null)
      else ctl.signal.addEventListener('abort', () => resolve(null), { once: true })
    })
    const r = await Promise.race([task().catch((e) => {
      if (ctl.signal.aborted) return null
      throw e
    }), gaveUp])
    const reason = budget.stopped ?? (timedOut ? 'timeout' : 'cancelled')
    const done = r ?? run?.snapshot(reason) ?? { status: reason === 'timeout' ? 124 : reason === 'cancelled' ? 130 : 125, stdout: '', stderr: '', truncated: { stdout: 0, stderr: 0 }, termination: reason }
    const terminated = done.termination ?? (ctl.signal.aborted ? (timedOut ? 'timeout' : 'cancelled') : null)
    const result: TerminalResult = { exit_code: terminated && !done.termination ? (timedOut ? 124 : 130) : done.status, stdout: done.stdout, stderr: done.stderr, duration_ms: Math.round(performance.now() - t0), truncated: done.truncated, terminated, cwd }
    return { output: text(result), status: result.exit_code, result }
  } catch (e) {
    if (budget.stopped) {
      const reason = budget.stopped
      const status = reason === 'timeout' ? 124 : reason === 'cancelled' ? 130 : 125
      const result: TerminalResult = { exit_code: status, stdout: '', stderr: '', duration_ms: Math.round(performance.now() - t0), truncated: { stdout: 0, stderr: 0 }, terminated: reason, cwd }
      return { output: '', status, result }
    }
    return failed(`msh: ${(e as Error).message}`, cwd, 2)
  } finally {
    clearTimeout(timer)
    outer.removeEventListener('abort', stop)
  }
}
