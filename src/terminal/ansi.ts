// Turns ANSI colour escapes (as sent by wttr.in and friends) into the terminal's markup
// (src/terminal/markup.ts): foreground and background colours (16, 256 and truecolour), bold,
// dim, italic, underline, strikethrough and inverse, nested. Other escapes are dropped; output
// that moves the cursor around belongs in a stream (src/terminal/vt/session.ts) instead.

import { color256, hex } from './vt/palette.ts'

/** Keeps markup-looking text from the network from being read as markup. */
const neutral = (s: string) => s.replace(/\{(?=(?:c|link|anim|fg|bg):|\/\})/g, '{​')

type Pen = { fg: string | null; bg: string | null; bold: boolean; dim: boolean; italic: boolean; underline: boolean; strike: boolean; inverse: boolean }
const PLAIN: Pen = { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, strike: false, inverse: false }

/** A colour from the 256 as a markup argument: the 16 follow the theme. */
const indexed = (n: number) => (n < 16 ? String(n) : color256(n))

/** The text wrapped in the pen's tags, outermost first. */
function styled(pen: Pen, text: string): string {
  const open: string[] = []
  let { fg, bg } = pen
  if (pen.inverse) {
    if (fg || bg) [fg, bg] = [bg ?? null, fg ?? null]
    else open.push('{c:inverse}')
  }
  // Inverse with only one colour set: the other side is the default, which a tag cannot name.
  if (pen.inverse && (pen.fg || pen.bg)) {
    if (!fg) fg = '0'
    if (!bg) bg = '7'
  }
  if (fg) open.push(`{fg:${fg}}`)
  if (bg) open.push(`{bg:${bg}}`)
  for (const c of ['bold', 'dim', 'italic', 'underline', 'strike'] as const) if (pen[c]) open.push(`{c:${c}}`)
  return open.join('') + text + '{/}'.repeat(open.length)
}

export function ansiToMarkup(text: string): string {
  let out = ''
  let pen: Pen = PLAIN
  const emit = (s: string) => {
    if (s) out += styled(pen, neutral(s))
  }
  // CSI sequences (ESC [ ... letter); SGR ("m") ones set the pen. Colon sub-parameters count too.
  const re = /\x1b\[([0-9;:?]*)([A-Za-z])|\x1b[()][A-Z0-9]|\x1b[=>]/g
  let last = 0
  for (const m of text.matchAll(re)) {
    emit(text.slice(last, m.index))
    last = m.index! + m[0].length
    if (m[2] !== 'm' || m[1].startsWith('?')) continue
    const codes = (m[1] || '0').split(/[;:]/).map((x) => parseInt(x || '0', 10))
    const next = { ...pen }
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i]
      if (code === 0) Object.assign(next, PLAIN)
      else if (code === 1) next.bold = true
      else if (code === 2) next.dim = true
      else if (code === 3) next.italic = true
      else if (code === 4 || code === 21) next.underline = true
      else if (code === 7) next.inverse = true
      else if (code === 9) next.strike = true
      else if (code === 22) next.bold = next.dim = false
      else if (code === 23) next.italic = false
      else if (code === 24) next.underline = false
      else if (code === 27) next.inverse = false
      else if (code === 29) next.strike = false
      else if (code === 39) next.fg = null
      else if (code === 49) next.bg = null
      else if (code >= 30 && code <= 37) next.fg = String(code - 30)
      else if (code >= 90 && code <= 97) next.fg = String(code - 90 + 8)
      else if (code >= 40 && code <= 47) next.bg = String(code - 40)
      else if (code >= 100 && code <= 107) next.bg = String(code - 100 + 8)
      else if (code === 38 || code === 48) {
        let color: string | null = null
        if (codes[i + 1] === 5) {
          color = indexed((codes[i + 2] ?? 7) & 255)
          i += 2
        } else if (codes[i + 1] === 2) {
          color = hex(codes[i + 2] ?? 0, codes[i + 3] ?? 0, codes[i + 4] ?? 0)
          i += 4
        }
        if (color && code === 38) next.fg = color
        else if (color) next.bg = color
      }
    }
    pen = next
  }
  emit(text.slice(last))
  return out
}

/** Plain text from the network, made safe to show (markup neutralised, stray escapes removed). */
export const plain = (text: string) => neutral(text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''))

/** Rainbow colouring, lolcat style: hue shifts along each line and down the lines. */
export function rainbow(text: string, seed = Math.random() * 360): string {
  return text
    .split('\n')
    .map((line, y) =>
      [...line]
        .map((ch, x) => {
          if (ch === ' ') return ch
          const h = ((seed + x * 7 + y * 12) % 360) / 60
          const f = (n: number) => {
            const k = (n + h) % 6
            return Math.round(255 * (1 - Math.max(0, Math.min(k, 4 - k, 1)) * 0.75))
          }
          return `{fg:${hex(f(5), f(3), f(1))}}${neutral(ch)}{/}`
        })
        .join(''),
    )
    .join('\n')
}
