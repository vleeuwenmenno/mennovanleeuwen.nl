import type { ChatProvider } from './agentChatGPT.ts'

// Thread stats for the Agents app ("stats for nerds"): how long each model call took, how fast it
// wrote, how many tokens went in and out and how many of those the provider had cached. Each call is
// measured here, from the moment the request goes out; the provider's own counts come with its last
// event. Saved as JSON in agent_messages.stats with the reply (or compaction) it made, and with each
// tool result its wall time, so they survive a reload. The window adds them up
// (src/data/agentStats.ts); older messages have none and show as "—".

/** One model call, as saved. Counts the provider does not report are left out (shown as "—"). */
export type CallStats = {
  provider: ChatProvider
  model: string
  /** Prompt tokens (Ollama: prompt_eval_count; OpenAI: input_tokens) */
  input?: number
  /** Of those, read from the provider's prompt cache (OpenAI's cached_tokens); left out when not reported */
  cached?: number
  /** Tokens written (thinking included) */
  output?: number
  /** Of those, reasoning (OpenAI's reasoning_tokens) */
  reasoning?: number
  /** Milliseconds from sending the request to the first thing streamed back (text, thinking or a tool call) */
  ttft?: number
  /** Milliseconds spent writing: Ollama's eval_duration, else from the first to the last streamed piece */
  gen?: number
  /** Ollama's prompt_eval_duration and load_duration, in milliseconds */
  promptEval?: number
  load?: number
  /** The whole call, wall time in milliseconds */
  ms: number
}

/** A tool call's wall time, saved with its result; `waited`: the part spent waiting for the user. */
export type ToolStats = { ms: number; waited?: number }

const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined)
const nsToMs = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v / 1e6) : undefined)

/** Times one streamed call: `first()` on everything streamed back, `end()` once it is done. */
export function meter() {
  const start = performance.now()
  let first: number | null = null
  let last: number | null = null
  return {
    first() {
      const now = performance.now()
      if (first === null) first = now
      last = now
    },
    /** Wall time, time to first token and the time spent writing, as measured here. */
    end(): { ms: number; ttft?: number; gen?: number } {
      const now = performance.now()
      return { ms: Math.round(now - start), ...(first !== null ? { ttft: Math.round(first - start), gen: Math.round((last ?? now) - first) } : {}) }
    },
  }
}

/** Drops what is not a count, so the saved JSON stays small. */
const tidy = (s: CallStats): CallStats => Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined)) as CallStats

/** Ollama's last chunk: its counts, and its own durations (nanoseconds) where it gives them. */
export function ollamaStats(model: string, done: Record<string, unknown> | null, measured: { ms: number; ttft?: number; gen?: number }): CallStats {
  const gen = nsToMs(done?.eval_duration)
  return tidy({
    provider: 'ollama',
    model,
    input: count(done?.prompt_eval_count),
    output: count(done?.eval_count),
    ttft: measured.ttft,
    gen: gen && gen > 0 ? gen : measured.gen,
    promptEval: nsToMs(done?.prompt_eval_duration),
    load: nsToMs(done?.load_duration),
    ms: measured.ms,
  })
}

type Usage = { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number }; output_tokens_details?: { reasoning_tokens?: number } }

/** A Responses API usage block (OpenAI and ChatGPT's Codex backend). */
export function responsesStats(provider: ChatProvider, model: string, usage: Usage | null, measured: { ms: number; ttft?: number; gen?: number }): CallStats {
  return tidy({
    provider,
    model,
    input: count(usage?.input_tokens),
    cached: count(usage?.input_tokens_details?.cached_tokens),
    output: count(usage?.output_tokens),
    reasoning: count(usage?.output_tokens_details?.reasoning_tokens),
    ttft: measured.ttft,
    gen: measured.gen,
    ms: measured.ms,
  })
}
