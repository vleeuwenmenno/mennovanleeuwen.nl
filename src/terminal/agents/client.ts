import { runCaptured, type Base } from '../msh/interp'
import { commandWords, parse } from '../msh/parse'
import type { Ctx } from '../types'

// A command the user types after `!` in the agents command: a command line goes through msh like
// `msh -c`, in the work folder, with everything it prints collected. It is the user's own command, with
// the user's own rights. (The agents' terminal tool is something else: exec.ts, confined and bounded.)
// Programs that take over the screen or the session do not run; a question a command asks (rm's y/N) is
// answered no.

const INTERACTIVE = new Set(['nano', 'vim', 'nvim', 'htop', 'top', 'watch', 'cmatrix', 'sl', 'agents', 'claude', 'exit', 'logout', 'reboot', 'shutdown', 'poweroff', 'halt', 'startx', 'clear', 'sudo', 'su', 'mount', 'umount', 'games', 'tetris', 'pacman', 'snake', 'minesweeper', 'breakout', 'pool'])
const TIMEOUT = 60_000
const MAX_OUTPUT = 60_000

export { workdirPath } from './exec'

/** Runs a line the user typed after `!`; answers what it printed and its exit status. */
export async function runCommand(ctx: Ctx, cwd: string, command: string, signal: AbortSignal): Promise<{ output: string; status: number }> {
  let names: string[]
  try {
    names = commandWords(parse(command)).map((c) => c.name)
  } catch (e) {
    return { output: `msh: ${(e as Error).message}`, status: 2 }
  }
  const blocked = names.find((n) => INTERACTIVE.has(n))
  if (blocked) return { output: `${blocked} is interactive or ends the session, so it does not run from the agent. Use a non-interactive command, or ask the user to run it.`, status: 126 }
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), TIMEOUT)
  const stop = () => ctl.abort()
  signal.addEventListener('abort', stop)
  const { args: _a, stdin: _s, tty: _t, ...rest } = ctx
  const base: Base = {
    ...rest,
    cwd,
    setCwd: () => {},
    env: { ...ctx.env, PWD: cwd },
    print: () => {},
    live: () => {},
    clear: () => {},
    exit: () => {},
    onKey: (h) => void (h && setTimeout(() => h('n'))),
    signal: ctl.signal,
  }
  try {
    const r = await runCaptured(command, base)
    const output = r.output.length > MAX_OUTPUT ? `${r.output.slice(0, MAX_OUTPUT)}\n[… ${r.output.length - MAX_OUTPUT} more characters]` : r.output
    return { output: ctl.signal.aborted && !signal.aborted ? `${output}\n[stopped after ${TIMEOUT / 1000}s]` : output, status: ctl.signal.aborted ? 124 : r.status }
  } catch (e) {
    return { output: `msh: ${(e as Error).message}`, status: 1 }
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', stop)
  }
}
