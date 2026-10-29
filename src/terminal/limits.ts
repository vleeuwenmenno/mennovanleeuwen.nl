// What bounds a script run by an agent (src/terminal/agents/exec.ts): interpreter steps, elapsed
// time, and the text it keeps in memory. One Budget is shared by everything a call starts (pipeline
// stages, $(…), subshells, sourced files, nested msh), so a loop cannot get around it by nesting.
// The interpreter (msh/interp.ts) charges it and stops with a LimitSignal when it runs out.

export type Limits = {
  /** Wall-clock time for the whole call */
  timeoutMs: number
  /** Nodes executed and commands started */
  maxSteps: number
  /** What each of stdout and stderr hands back; more is dropped and counted as truncated */
  maxOutput: number
  /** One intermediate buffer: a pipe stage, a $(…), a file being redirected into */
  maxBuffer: number
  /** Everything written to any sink during the call (the bound on what a loop can pile up) */
  maxTotal: number
  /** One variable's value */
  maxVariable: number
}

export const AGENT_LIMITS: Limits = {
  timeoutMs: 60_000,
  maxSteps: 100_000,
  maxOutput: 60_000,
  maxBuffer: 4 * 1024 * 1024,
  maxTotal: 32 * 1024 * 1024,
  maxVariable: 1024 * 1024,
}

/** The longest time an agent may ask for (the timeout_seconds argument). */
export const MAX_TIMEOUT_MS = 180_000

export type Stop = 'timeout' | 'cancelled' | 'steps' | 'output' | 'memory'

export class Budget {
  steps = 0
  /** Characters written to any sink so far */
  total = 0
  /** Why the run was stopped; once set, nothing more runs and nothing more is written */
  stopped: Stop | null = null
  readonly deadline: number
  constructor(readonly limits: Limits) {
    this.deadline = Date.now() + limits.timeoutMs
  }

  stop(why: Stop): Stop {
    this.stopped ??= why
    return this.stopped
  }

  /** One more step; the reason to stop, if there is one. */
  step(): Stop | null {
    if (this.stopped) return this.stopped
    if (++this.steps > this.limits.maxSteps) return this.stop('steps')
    if (Date.now() > this.deadline) return this.stop('timeout')
    return null
  }

  /** `n` more characters going into a buffer that holds `held` already. */
  write(n: number, held: number): Stop | null {
    if (this.stopped) return this.stopped
    this.total += n
    if (this.total > this.limits.maxTotal || held + n > this.limits.maxBuffer) return this.stop('output')
    return null
  }

  /** A variable about to get a value this long. */
  variable(n: number): Stop | null {
    return n > this.limits.maxVariable ? this.stop('memory') : this.stopped
  }
}
