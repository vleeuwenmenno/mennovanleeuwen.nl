// Pretty names for the Agents app's model ids, and who made each model, for the model picker and
// Settings. Ollama Cloud names models like "deepseek-v4.1-flash:1017" or "gpt-oss:120b", OpenAI's
// come as "chatgpt/gpt-5.5" or "openai/gpt-4o" (server/agentChatGPT.ts): this turns them into
// "DeepSeek V4.1 Flash" with a small "1017" variant tag, "GPT-OSS" with "120B", "GPT-5.5", and
// files each under its maker. Recognised by patterns, so new versions of known families need no
// change here; anything else is filed under Other with its raw id as the name.

export type MakerId = 'openai' | 'anthropic' | 'google' | 'deepseek' | 'zai' | 'moonshot' | 'minimax' | 'mistral' | 'nvidia' | 'alibaba' | 'meta' | 'xai' | 'ibm' | 'microsoft' | 'cohere' | 'other'
/** A model maker: its name and the letter mark the picker draws for it (no logos). */
export type Maker = { id: MakerId; name: string; mark: string }

/** In the order the picker's rail lists them. */
export const MAKERS: Maker[] = [
  { id: 'openai', name: 'OpenAI', mark: 'OA' },
  { id: 'anthropic', name: 'Anthropic', mark: 'An' },
  { id: 'google', name: 'Google', mark: 'G' },
  { id: 'deepseek', name: 'DeepSeek', mark: 'DS' },
  { id: 'zai', name: 'Z.ai', mark: 'Z' },
  { id: 'moonshot', name: 'Moonshot AI', mark: 'Ms' },
  { id: 'minimax', name: 'MiniMax', mark: 'MM' },
  { id: 'mistral', name: 'Mistral', mark: 'Mi' },
  { id: 'nvidia', name: 'NVIDIA', mark: 'NV' },
  { id: 'alibaba', name: 'Alibaba', mark: 'Qw' },
  { id: 'meta', name: 'Meta', mark: 'Me' },
  { id: 'xai', name: 'xAI', mark: 'x' },
  { id: 'ibm', name: 'IBM', mark: 'IBM' },
  { id: 'microsoft', name: 'Microsoft', mark: 'MS' },
  { id: 'cohere', name: 'Cohere', mark: 'Co' },
  { id: 'other', name: 'Other', mark: '?' },
]
export const makerOf = (id: MakerId): Maker => MAKERS.find((m) => m.id === id) ?? MAKERS[MAKERS.length - 1]

/** Which maker a base id (no provider prefix, no tag) belongs to, by its first word. */
const MAKER_PATTERNS: [RegExp, MakerId][] = [
  [/^(gpt|o\d|chatgpt|codex)\b/, 'openai'],
  [/^claude/, 'anthropic'],
  [/^(gemma|gemini|codegemma)/, 'google'],
  [/^deepseek/, 'deepseek'],
  [/^(glm|chatglm|codegeex)/, 'zai'],
  [/^(kimi|moonshot)/, 'moonshot'],
  [/^minimax/, 'minimax'],
  [/^(mistral|mixtral|magistral|devstral|codestral|ministral|pixtral)/, 'mistral'],
  [/^(nemotron|nvidia)/, 'nvidia'],
  [/^(qwen|qwq)/, 'alibaba'],
  [/^(llama|codellama)/, 'meta'],
  [/^grok/, 'xai'],
  [/^granite/, 'ibm'],
  [/^phi\d?/, 'microsoft'],
  [/^(command|aya)/, 'cohere'],
]

/** Words with their own spelling; others are capitalised. */
const WORDS: Record<string, string> = { deepseek: 'DeepSeek', glm: 'GLM', minimax: 'MiniMax', gpt: 'GPT', oss: 'OSS', qwq: 'QwQ', vl: 'VL', ai: 'AI', it: 'IT', moe: 'MoE', nvidia: 'NVIDIA', codegeex: 'CodeGeeX', chatglm: 'ChatGLM' }
/** Families whose version is written on to the name ("Qwen3"), not after a space ("Gemma 4"). */
const GLUED = new Set(['qwen', 'phi'])

const SIZE = /^\d+(\.\d+)?[bmkt]$/i
const word = (t: string) => WORDS[t] ?? (/^[a-z]\d/.test(t) ? t.toUpperCase() : /^\d/.test(t) ? t.toUpperCase() : t[0].toUpperCase() + t.slice(1))

export type Provider = 'ollama' | 'chatgpt' | 'openai'
export const PROVIDER_NAMES: Record<Provider, string> = { ollama: 'Ollama Cloud', chatgpt: 'ChatGPT', openai: 'OpenAI API' }
export const providerOfModel = (raw: string): Provider => (raw.startsWith('chatgpt/') ? 'chatgpt' : raw.startsWith('openai/') ? 'openai' : 'ollama')

export type ModelName = {
  /** The id as the server has it */
  raw: string
  /** "DeepSeek V4.1 Flash" */
  name: string
  /** A small tag after the name: a size ("120B") or a dated build ("1017"), or null */
  variant: string | null
  maker: MakerId
  /** The family: the name's first word ("DeepSeek", "GLM", "GPT-OSS") */
  family: string
  provider: Provider
}

/** OpenAI's names: "gpt-5.5" → "GPT-5.5", "gpt-4o-mini" → "GPT-4o Mini", "gpt-oss" → "GPT-OSS", "o4-mini" → "o4 Mini". */
function openaiName(tokens: string[]): string {
  if (tokens[0] === 'gpt' && tokens[1] === 'oss') return ['GPT-OSS', ...tokens.slice(2).map(word)].join(' ')
  if (tokens[0] === 'gpt' && tokens[1]) return [`GPT-${tokens[1]}`, ...tokens.slice(2).map(word)].join(' ')
  if (/^o\d/.test(tokens[0])) return [tokens[0], ...tokens.slice(1).map(word)].join(' ')
  return tokens.map(word).join(' ')
}

/**
 * The pretty name, variant and maker of a model id. `label` is the provider's own display name
 * when it sends one (ChatGPT's model list does), which wins for the name.
 */
export function modelName(raw: string, label?: string): ModelName {
  const provider = providerOfModel(raw)
  const id = provider === 'ollama' ? raw : raw.slice(raw.indexOf('/') + 1)
  const [base, tag = ''] = id.toLowerCase().split(':')
  const maker = MAKER_PATTERNS.find(([re]) => re.test(base))?.[1] ?? 'other'
  const variant = !tag || tag === 'latest' || tag === 'cloud' ? null : SIZE.test(tag) ? tag.toUpperCase() : tag.replace(/-cloud$/, '').slice(0, 16)
  if (maker === 'other') return { raw, name: provider === 'ollama' ? base : id, variant, maker, family: base, provider }
  // "gemma4" → gemma 4, "qwen3" stays one word; sizes inside the name ("30b") become "30B".
  let tokens = base.split(/[-_\s]+/).filter(Boolean)
  const m = /^([a-z]+)(\d[\w.]*)$/.exec(tokens[0])
  if (m && !GLUED.has(m[1]) && maker !== 'openai') tokens = [m[1], m[2], ...tokens.slice(1)]
  const pretty = label?.trim() || (maker === 'openai' ? openaiName(tokens) : tokens.map((t) => (SIZE.test(t) ? t.toUpperCase() : GLUED.has(t.replace(/\d.*$/, '')) ? word(t.replace(/\d.*$/, '')) + t.replace(/^[a-z]+/, '') : word(t))).join(' '))
  return { raw, name: pretty, variant, maker, family: pretty.split(' ')[0], provider }
}

/**
 * How well `query` matches a model: 0 is no match. Every word of the query must appear in the
 * pretty name, raw id, maker or provider, as a run or (scored lower) with gaps, like "dsv4" for
 * DeepSeek V4.
 */
export function modelMatch(n: ModelName, query: string): number {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return 1
  const hay = `${n.name} ${n.variant ?? ''} ${n.raw} ${makerOf(n.maker).name} ${PROVIDER_NAMES[n.provider]}`.toLowerCase()
  const compact = hay.replace(/[\s.:/-]+/g, '')
  let score = 0
  for (const w of words) {
    if (hay.startsWith(w) || hay.includes(` ${w}`)) score += 4
    else if (hay.includes(w)) score += 3
    else if (compact.includes(w.replace(/[\s.:/-]+/g, ''))) score += 2
    else {
      // In order with gaps: the tighter the run, the better (up to just under a whole match).
      let best = Infinity
      for (let start = compact.indexOf(w[0]); start >= 0; start = compact.indexOf(w[0], start + 1)) {
        let at = start + 1
        for (const ch of w.slice(1)) {
          at = compact.indexOf(ch, at)
          if (at < 0) break
          at++
        }
        if (at > 0) best = Math.min(best, at - start)
      }
      if (best === Infinity) return 0
      score += 1 + Math.min(0.9, w.length / best)
    }
  }
  return score
}

// --- thinking effort ---------------------------------------------------------------------------

/**
 * Thinking effort levels, lowest first (server/agentChatGPT.ts has the same). Ollama's models think
 * or not (off, on), gpt-oss takes low to high, OpenAI's take what their list says.
 */
export const EFFORTS = ['off', 'on', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const
export type Effort = (typeof EFFORTS)[number]
export const EFFORT_NAMES: Record<Effort, string> = { off: 'Off', on: 'On', none: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'XHigh', max: 'Max', ultra: 'Ultra' }
/**
 * The effort a thread runs with: its own pick when the model takes it (else the nearest the model
 * has), or what the mode means (quick low, deep high; Ollama's on/off models: on).
 */
export function effortFor(list: Effort[] | undefined, picked: Effort | null | undefined, mode: 'quick' | 'deep'): Effort | null {
  if (!list?.length) return null
  const want: Effort = picked ?? (list.includes('on') ? 'on' : mode === 'deep' ? 'high' : 'low')
  if (list.includes(want)) return want
  if (want === 'off' || want === 'none') return list.find((e) => e === 'off' || e === 'none') ?? list[0]
  if (want === 'on') return list.includes('medium') ? 'medium' : list[Math.floor(list.length / 2)]
  if (list.includes('on')) return 'on'
  const order: Effort[] = EFFORTS.filter((e) => e !== 'on')
  return [...list].sort((a, b) => Math.abs(order.indexOf(a) - order.indexOf(want)) - Math.abs(order.indexOf(b) - order.indexOf(want)))[0]
}
