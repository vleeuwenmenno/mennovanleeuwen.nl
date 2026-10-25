// Text for the agents TUI: runs of styled text ("segments") wrapped to the terminal's width and
// turned into the terminal's flat markup ({c:green}…{/}, which does not nest).

import { charWidth } from '../vt/width.ts'

export type Seg = { t: string; c?: string; link?: string; fg?: string; bg?: string }
export type Line = Seg[]

/** Text from the model or the network can hold the terminal's own markup: a zero-width space defuses it. */
export const esc = (s: string) => s.replace(/\{/g, '{​')

/** A line of segments as markup. */
export function markup(line: Line): string {
  return line
    .map((s) => {
      if (!s.t) return ''
      const t = esc(s.t)
      if (s.link && /^https?:\/\/[^\s}]+$/.test(s.link)) return `{link:${s.link}}${t}{/}`
      let styled = s.c ? `{c:${s.c}}${t}{/}` : t
      for (const key of ['fg', 'bg'] as const) if (/^#[0-9a-f]{6}$/i.test(s[key] ?? '')) styled = `{${key}:${s[key]}}${styled}{/}`
      return styled
    })
    .join('')
}

/** Lines as markup; an empty line keeps a space, or the terminal would fold it away at the end of a block. */
export const lines = (ls: Line[]) => ls.map((l) => markup(l) || ' ').join('\n')
export const seg = (t: string, c?: string): Seg => ({ t, ...(c ? { c } : {}) })
/** Terminal columns of a text: emoji and East Asian wide characters take 2, combining marks 0 (src/terminal/vt/width.ts). */
export const cols = (t: string) => {
  let n = 0
  for (const c of t) n += charWidth(c.codePointAt(0)!)
  return n
}
export const width = (line: Line) => line.reduce((n, s) => n + cols(s.t), 0)
/** The longest start of `chars` that fits in `room` columns, and its columns. */
function fit(chars: string[], room: number): { n: number; w: number } {
  let n = 0
  let w = 0
  while (n < chars.length) {
    const cw = charWidth(chars[n].codePointAt(0)!)
    if (w + cw > room) break
    w += cw
    n++
  }
  return { n, w }
}

/** Cuts a line to `max` columns, with … at the end when something was cut. */
export function clipLine(line: Line, max: number): Line {
  if (width(line) <= max) return line
  const out: Line = []
  let left = Math.max(0, max - 1)
  for (const s of line) {
    const chars = [...s.t]
    const w = cols(s.t)
    if (w <= left) {
      out.push(s)
      left -= w
    } else {
      const f = fit(chars, left)
      if (f.n > 0) out.push({ ...s, t: chars.slice(0, f.n).join('') })
      break
    }
  }
  out.push(seg('…', 'muted'))
  return out
}

/** Pads a line with spaces to `n` columns. */
export const pad = (line: Line, n: number): Line => {
  const w = width(line)
  return w >= n ? line : [...line, seg(' '.repeat(n - w))]
}

/**
 * Wraps segments to `max` columns at spaces (a word longer than a line is broken), with `first`
 * before the first line and `rest` before the others (prefixes, indents).
 */
export function wrap(segs: Line, max: number, first: Line = [], rest: Line = first.length ? [seg(' '.repeat(width(first)))] : []): Line[] {
  const out: Line[] = []
  // Words keep their style; spaces between them are where lines may break.
  type Word = { parts: Seg[]; w: number; space: boolean }
  const words: Word[] = []
  for (const s of segs) {
    for (const piece of s.t.split(/(\s+)/)) {
      if (!piece) continue
      const space = /^\s+$/.test(piece)
      if (piece.includes('\n')) {
        words.push({ parts: [], w: -1, space: true }) // a hard break
        continue
      }
      const last = words[words.length - 1]
      // Glued to the previous word (no space between): one word for wrapping.
      if (!space && last && !last.space && last.w >= 0) {
        last.parts.push({ ...s, t: piece })
        last.w += cols(piece)
      } else words.push({ parts: [{ ...s, t: piece }], w: cols(piece), space })
    }
  }
  let cur: Line = [...first]
  let curW = width(first)
  let lead = curW
  const avail = () => Math.max(8, max)
  const push = () => {
    out.push(cur)
    cur = [...rest]
    curW = width(rest)
    lead = curW
  }
  for (const w of words) {
    if (w.w < 0) {
      push()
      continue
    }
    if (w.space) {
      if (curW > lead && curW + w.w <= avail()) {
        cur.push(...w.parts)
        curW += w.w
      }
      continue
    }
    if (curW + w.w > avail() && curW > lead) {
      // Drop the space the line ended on.
      const tail = cur[cur.length - 1]
      if (tail && /^\s+$/.test(tail.t)) {
        cur.pop()
      }
      push()
    }
    if (w.w > avail() - curW) {
      // Longer than a whole line: broken where it has to be.
      for (const p of w.parts) {
        let chars = [...p.t]
        while (chars.length) {
          const room = avail() - curW
          if (room <= 0) {
            push()
            continue
          }
          // A wide character that does not fit the room left starts the next line (at least one goes on a line).
          const f = fit(chars, room)
          const n = f.n || (curW > lead ? 0 : 1)
          if (n === 0) {
            push()
            continue
          }
          cur.push({ ...p, t: chars.slice(0, n).join('') })
          curW += f.n ? f.w : cols(chars[0])
          chars = chars.slice(n)
          if (chars.length) push()
        }
      }
      continue
    }
    cur.push(...w.parts)
    curW += w.w
  }
  if (cur.length > rest.length || !out.length) out.push(cur)
  return out
}

/** A box around lines: ╭─╮ │ │ ╰─╯, `w` columns wide, with an optional title in the top edge. */
export function box(body: Line[], w: number, opts: { color?: string; title?: string } = {}): Line[] {
  const c = opts.color ?? 'muted'
  const inner = Math.max(4, w - 4)
  const top = opts.title ? `╭─ ${opts.title} ${'─'.repeat(Math.max(0, w - 5 - cols(opts.title)))}╮` : `╭${'─'.repeat(w - 2)}╮`
  return [[seg(top, c)], ...body.map((l) => [seg('│ ', c), ...pad(clipLine(l, inner), inner), seg(' │', c)]), [seg(`╰${'─'.repeat(w - 2)}╯`, c)]]
}

/** How long ago, briefly: 5s, 3m, 2h, 4d. */
export function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86400)}d`
}

/** 1.2k, 34k, 1.5M */
export const count = (n: number) => (n < 1000 ? String(n) : n < 1e6 ? `${(n / 1000).toFixed(n < 1e4 ? 1 : 0)}k` : `${(n / 1e6).toFixed(1)}M`)
