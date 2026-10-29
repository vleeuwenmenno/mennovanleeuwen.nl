// Subagents (server/agents.ts): a chat agent can start helpers that work alongside it, each in a
// hidden child thread of its own (agent_threads.quick = 4), message them while they work, and get an
// overview of each one and its final answer back when it is done. Shared by the server, the Agents
// app and the terminal's agents command (its /subagents command). No DOM or Node APIs here.

export type SubagentStatus = 'running' | 'idle' | 'stopped' | 'failed' | 'interrupted'

/** A subagent as the API gives it. `id` is its child thread's id. */
export type SubagentInfo = {
  id: string
  parent: string
  name: string
  status: SubagentStatus
  /** What the parent agent asked it first */
  instruction: string
  model: string
  /** The permission mode it was started with (it runs under the stricter of this and its parent's, each round) */
  permission: string
  /** The tool groups it may use: always a subset of its parent's */
  tools: string[]
  /** Whether it may change files in the work folder (asked about as its mode says) */
  writeFiles: boolean
  createdAt: number
  startedAt: number | null
  endedAt: number | null
  activeMs: number
  tokensIn: number
  tokensOut: number
  toolCalls: number
  /** The end of its last answer (clipped), or null before it answered */
  lastOutput: string | null
  error: string | null
}

/** What a finished subagent hands its parent: shown in the parent thread as its own kind of message. */
export type SubagentOverview = { id: string; name: string; status: SubagentStatus; ms: number; tokens: number; toolCalls: number; tools: Record<string, number> }

/** How many may run at once: per thread, per account and on the server. */
export const SUBAGENTS_PER_THREAD = 4
export const SUBAGENTS_PER_USER = 6
export const SUBAGENTS_TOTAL = 24
/** Per user message in the parent: spawns and continuation turns (a parent → result → spawn loop stops here). */
export const SPAWNS_PER_MESSAGE = 8
export const CONTINUATIONS_PER_MESSAGE = 6
/** Per turn of a subagent: tool calls, minutes and tokens (like a task run's caps). */
export const SUBAGENT_CAPS = { toolCalls: 60, minutes: 20, tokens: 1_500_000 }
/** Subagents kept per thread (the oldest finished ones go). */
export const SUBAGENTS_KEPT = 30

export const SUBAGENT_STATUS_LABEL: Record<SubagentStatus, string> = { running: 'Working', idle: 'Done', stopped: 'Stopped', failed: 'Failed', interrupted: 'Interrupted' }

/** "1m 20s", "12s", "1h 5m" */
export function shortDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/** "12.3k" */
export const shortCount = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

/** One line about a finished subagent: "Done · 1m 20s · 12.3k tokens · 7 tool calls (web_search ×4, web_fetch ×3)". */
export function overviewLine(o: SubagentOverview): string {
  const tools = Object.entries(o.tools).sort((a, b) => b[1] - a[1]).map(([n, k]) => (k > 1 ? `${n} ×${k}` : n))
  return [SUBAGENT_STATUS_LABEL[o.status], shortDuration(o.ms), `${shortCount(o.tokens)} tokens`, `${o.toolCalls} tool ${o.toolCalls === 1 ? 'call' : 'calls'}${tools.length ? ` (${tools.slice(0, 6).join(', ')}${tools.length > 6 ? ', …' : ''})` : ''}`].join(' · ')
}

/**
 * The terminal's /subagents command: `list` (or nothing), `show <id>`, `msg <id> <text>`,
 * `stop <id>`. An id may be the start of one (as listed) or a subagent's name. Answers null for
 * anything else, with what is wrong in `error`.
 */
export type SubagentsCommand = { op: 'list' } | { op: 'show'; ref: string } | { op: 'msg'; ref: string; text: string } | { op: 'stop'; ref: string } | { op: 'error'; error: string }
export function parseSubagentsCommand(line: string): SubagentsCommand {
  const m = /^\/subagents(?:\s+([\s\S]*))?$/i.exec(line.trim())
  if (!m) return { op: 'error', error: 'Not a /subagents command' }
  const rest = (m[1] ?? '').trim()
  if (!rest || /^(list|ls)$/i.test(rest)) return { op: 'list' }
  const [verb, ...words] = rest.split(/\s+/)
  const ref = words[0] ?? ''
  const usage = 'Usage: /subagents [list] | show <id> | msg <id> <text> | stop <id>'
  switch (verb.toLowerCase()) {
    case 'show':
      return ref ? { op: 'show', ref } : { op: 'error', error: usage }
    case 'stop':
      return ref ? { op: 'stop', ref } : { op: 'error', error: usage }
    case 'msg':
    case 'message':
    case 'say': {
      const text = rest.slice(verb.length).trim().slice(ref.length).trim()
      return ref && text ? { op: 'msg', ref, text } : { op: 'error', error: usage }
    }
    default:
      return { op: 'error', error: usage }
  }
}

/** The subagent an id (or its start, at least 4 characters) or name points at, or why none does. */
export function findSubagent<T extends Pick<SubagentInfo, 'id' | 'name'>>(list: T[], ref: string): T | string {
  const r = ref.trim().toLowerCase()
  const exact = list.find((s) => s.id === r) ?? list.filter((s) => s.name.toLowerCase() === r).at(-1)
  if (exact) return exact
  const prefixed = r.length >= 4 ? list.filter((s) => s.id.startsWith(r)) : []
  if (prefixed.length === 1) return prefixed[0]
  return prefixed.length > 1 ? `"${ref}" matches ${prefixed.length} subagents: give more of the id` : `No subagent "${ref}" in this thread`
}
