// Emoji shortcodes, :rofl: and the like, the way Discord and Slack have them. The names are in
// data.ts (about 38 kB, ~15 kB gzipped), which nothing imports directly: loadEmoji() fetches it as
// its own chunk the first time something needs a name, so it is not in the main bundle. Until it has
// loaded, lookup and search find nothing and replaceShortcodes leaves the text as it is.

export type EmojiHit = { name: string; emoji: string }

let byName: Map<string, string> | null = null
let list: EmojiHit[] = []
let loading: Promise<void> | null = null
const listeners = new Set<() => void>()

/** True once the names are loaded. */
export const emojiReady = () => byName !== null

/** Loads the names (once). Resolves when lookup, search and replaceShortcodes work. */
export function loadEmoji(): Promise<void> {
  if (byName) return Promise.resolve()
  loading ??= import('./data.ts')
    .then((m) => {
      const map = new Map<string, string>()
      const hits: EmojiHit[] = []
      for (const line of m.default.split('\n')) {
        const sp = line.indexOf(' ')
        if (sp < 1) continue
        const emoji = line.slice(0, sp)
        line
          .slice(sp + 1)
          .split(',')
          .forEach((name) => {
            if (map.has(name)) return
            map.set(name, emoji)
            hits.push({ name, emoji })
          })
      }
      byName = map
      list = hits
      listeners.forEach((l) => l())
    })
    .catch(() => {
      loading = null
    })
  return loading
}

/** For useSyncExternalStore: fires once when the names have loaded. */
export function onEmojiLoaded(l: () => void) {
  listeners.add(l)
  return () => void listeners.delete(l)
}

/** The emoji for a name, with or without colons: "joy" or ":joy:". Undefined when unknown (or not loaded). */
export function lookup(name: string): string | undefined {
  if (!byName) return undefined
  const n = name.replace(/^:|:$/g, '').toLowerCase()
  return byName.get(n) ?? byName.get(n.replace(/(?<=.)-/g, '_'))
}

/**
 * Names starting with `prefix`, then names containing it, at most `limit`. An exact name comes
 * first, then shorter names, then the data's order (the common faces first). The same emoji is
 * listed once, under the name that matched best.
 */
export function search(prefix: string, limit = 8): EmojiHit[] {
  const q = prefix.replace(/^:/, '').toLowerCase().replace(/(?<=.)-/g, '_')
  if (!q || !byName) return []
  const scored: { hit: EmojiHit; score: number; i: number }[] = []
  list.forEach((hit, i) => {
    const at = hit.name.indexOf(q)
    if (at === -1) return
    scored.push({ hit, i, score: hit.name === q ? 0 : at === 0 ? 1 + hit.name.length / 100 : 2 + at / 100 + hit.name.length / 1000 })
  })
  scored.sort((a, b) => a.score - b.score || a.i - b.i)
  const seen = new Set<string>()
  const out: EmojiHit[] = []
  for (const { hit } of scored) {
    if (seen.has(hit.emoji)) continue
    seen.add(hit.emoji)
    out.push(hit)
    if (out.length >= limit) break
  }
  return out
}

// :name: not glued to a word before it (12:30:45, http://x:80:), so only a shortcode on its own.
const SHORTCODE = /(?<![\w])(:([A-Za-z0-9_+-]{1,40}):)/g

/** Whether `text` may hold a shortcode, so callers can skip loading the names for plain text. */
export const hasShortcode = (text: string) => text.includes(':') && /(?<!\w):[A-Za-z0-9_+-]{1,40}:/.test(text)

/** `text` with every known :name: as its emoji. Unknown names stay as written. Not for code: callers pass prose only. */
export function replaceShortcodes(text: string): string {
  if (!byName || !text.includes(':')) return text
  return text.replace(SHORTCODE, (all, _c, name: string) => lookup(name) ?? all)
}

// ---- typing -----------------------------------------------------------------------------------

/** Whether the end of `before` is inside a code span or fenced block of Markdown. */
function inCode(before: string): boolean {
  const fences = before.match(/^ {0,3}(```|~~~)/gm)
  if (fences && fences.length % 2 === 1) return true
  const line = before.slice(before.lastIndexOf('\n') + 1)
  return ((line.match(/`/g) ?? []).length & 1) === 1
}

export type EmojiTyping =
  /** A finished :name: and the character typed after it: replace [start, end) with `text`. */
  | { kind: 'replace'; start: number; end: number; text: string }
  /** A :partial being typed, for the autocomplete: it spans [start, caret). */
  | { kind: 'query'; start: number; query: string }

/**
 * What the caret is next to: a finished `:name:` plus one non-word character just typed (replace
 * it), a `:na` of two or more letters being typed (autocomplete), or nothing. Never inside code
 * spans or blocks, and never when the colon follows a word, so URLs and times are left alone.
 */
export function emojiTyping(text: string, caret: number): EmojiTyping | null {
  if (!byName) return null
  const before = text.slice(0, caret)
  if (!before.includes(':')) return null
  const done = /(?<![\w])(:([A-Za-z0-9_+-]{1,40}):)([^\w:])$/.exec(before)
  if (done) {
    const start = done.index
    const emoji = lookup(done[2])
    if (emoji && !inCode(before.slice(0, start))) return { kind: 'replace', start, end: caret, text: emoji + done[3] }
    return null
  }
  const part = /(?<![\w:])(:([A-Za-z][A-Za-z0-9_+-]{1,39}))$/.exec(before)
  if (!part || inCode(before.slice(0, part.index))) return null
  return { kind: 'query', start: part.index, query: part[2] }
}
