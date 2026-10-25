// Thread stats for nerds (the Agents app's Stats tab and the agents command's /stats): what the
// server measured per model call and tool call (server/agentStats.ts, GET /api/agents/threads/<id>/stats),
// added up for the thread and per turn. Calls saved before stats were kept count as calls, with "—"
// for what they lack.

export type CallStats = {
  provider: 'ollama' | 'chatgpt' | 'openai'
  model: string
  input?: number
  cached?: number
  output?: number
  reasoning?: number
  ttft?: number
  gen?: number
  promptEval?: number
  load?: number
  ms: number
}
export type StatsCall = { kind: 'reply' | 'compact'; stats: CallStats | null }
export type StatsTool = { name: string; ms: number | null; waited?: number }
export type StatsTurn = { id: number; at: number; text: string; calls: StatsCall[]; tools: StatsTool[] }
export type ThreadStats = { model: string; turns: StatsTurn[] }

export type StatsSummary = {
  calls: number
  /** Calls with no stats (saved before they were kept) */
  unmeasured: number
  toolCalls: number
  llmMs: number
  toolMs: number
  /** Of the tool time, waiting for the user to allow a change or answer a form */
  waitedMs: number
  ttftAvg: number | null
  /** Output tokens over the time spent writing them */
  tokPerSec: number | null
  /** Cached over input tokens, only over the calls whose provider says; null when none does */
  cacheHit: number | null
  /** Input tokens of the calls that report a cache figure */
  cacheInput: number
  input: number
  output: number
  /** Null when no call reported reasoning tokens */
  reasoning: number | null
  providers: CallStats['provider'][]
}

export function summarize(calls: StatsCall[], tools: StatsTool[]): StatsSummary {
  const measured = calls.flatMap((c) => (c.stats ? [c.stats] : []))
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
  const ttfts = measured.flatMap((s) => (typeof s.ttft === 'number' ? [s.ttft] : []))
  const writing = measured.filter((s) => typeof s.output === 'number' && typeof s.gen === 'number' && s.gen > 0)
  const genMs = sum(writing.map((s) => s.gen!))
  const cachedCalls = measured.filter((s) => typeof s.cached === 'number' && typeof s.input === 'number')
  const cacheInput = sum(cachedCalls.map((s) => s.input!))
  const withReasoning = measured.filter((s) => typeof s.reasoning === 'number')
  return {
    calls: calls.length,
    unmeasured: calls.length - measured.length,
    toolCalls: tools.length,
    llmMs: sum(measured.map((s) => s.ms)),
    toolMs: sum(tools.map((t) => t.ms ?? 0)),
    waitedMs: sum(tools.map((t) => t.waited ?? 0)),
    ttftAvg: ttfts.length ? sum(ttfts) / ttfts.length : null,
    tokPerSec: genMs > 0 ? sum(writing.map((s) => s.output!)) / (genMs / 1000) : null,
    cacheHit: cacheInput > 0 ? sum(cachedCalls.map((s) => s.cached!)) / cacheInput : null,
    cacheInput,
    input: sum(measured.map((s) => s.input ?? 0)),
    output: sum(measured.map((s) => s.output ?? 0)),
    reasoning: withReasoning.length ? sum(withReasoning.map((s) => s.reasoning!)) : null,
    providers: [...new Set(measured.map((s) => s.provider))],
  }
}

export const threadSummary = (s: ThreadStats) => summarize(s.turns.flatMap((t) => t.calls), s.turns.flatMap((t) => t.tools))

/** 850ms, 3.2s, 14m54s, 2h05m. */
export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
  const s = Math.round(ms / 1000)
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
}

/** 980, 16.4k, 1.2M. */
export function tokens(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

export const percent = (f: number | null) => (f === null ? '—' : `${Math.round(f * 100)}%`)
export const rate = (r: number | null) => (r === null ? '—' : `${r < 10 ? r.toFixed(1) : Math.round(r)} tok/s`)

/** Why there is no cache figure: Ollama's API does not report one. */
export function cacheNote(s: StatsSummary): string | null {
  if (s.cacheHit !== null) return null
  if (!s.providers.length) return null
  return s.providers.every((p) => p === 'ollama') ? 'not reported by Ollama' : 'not reported'
}

/** The headline lines, as in other harnesses: "LLM 14m54s · Tool 49m12s", then speed, cache and tokens. */
export function summaryLines(s: StatsSummary): [string, string][] {
  return [
    ['Time', `LLM ${duration(s.llmMs)} · Tool ${duration(s.toolMs)}${s.waitedMs ? ` (${duration(s.waitedMs)} waiting for you)` : ''}`],
    ['Speed', `TTFT avg ${duration(s.ttftAvg)} · ${rate(s.tokPerSec)}`],
    ['Cache hit', s.cacheHit !== null ? `${percent(s.cacheHit)} of ${tokens(s.cacheInput)} input` : (cacheNote(s) ?? '—')],
    ['Tokens', `Input ${tokens(s.input)} · Output ${tokens(s.output)}${s.reasoning !== null ? ` · Reasoning ${tokens(s.reasoning)}` : ''}`],
    ['Calls', `${s.calls} model ${s.calls === 1 ? 'call' : 'calls'}${s.unmeasured ? ` (${s.unmeasured} from before stats)` : ''} · ${s.toolCalls} tool ${s.toolCalls === 1 ? 'call' : 'calls'}`],
  ]
}

/** One model call on a line: "1.2s · TTFT 300ms · 4.1k in (98% cached) · 210 out · 85 tok/s". */
export function callLine(c: StatsCall): string {
  const s = c.stats
  const kind = c.kind === 'compact' ? 'compaction · ' : ''
  if (!s) return `${kind}—`
  const cached = typeof s.cached === 'number' && s.input ? ` (${percent(s.cached / s.input)} cached)` : ''
  const speed = typeof s.output === 'number' && s.gen ? ` · ${rate(s.output / (s.gen / 1000))}` : ''
  const reasoning = typeof s.reasoning === 'number' ? ` (${tokens(s.reasoning)} reasoning)` : ''
  const prompt = typeof s.promptEval === 'number' ? ` · prompt ${duration(s.promptEval)}` : ''
  return `${kind}${duration(s.ms)} · TTFT ${duration(s.ttft)}${prompt} · ${tokens(s.input)} in${cached} · ${tokens(s.output)} out${reasoning}${speed}`
}
