// Turns ANSI colour escapes (as sent by wttr.in and friends) into the terminal's `{fg:#rrggbb}`
// markup. Only foreground colours and resets are kept; every other escape is dropped.

const BASIC = ['#15161e', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#a9b1d6']
const BRIGHT = ['#414868', '#ff899d', '#9fe044', '#faba4a', '#8db0ff', '#c7a9ff', '#a4daff', '#c0caf5']

const hex = (r: number, g: number, b: number) => '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('')

/** xterm's 256-colour palette. */
function color256(n: number): string {
  if (n < 8) return BASIC[n]
  if (n < 16) return BRIGHT[n - 8]
  if (n < 232) {
    const i = n - 16
    const level = (v: number) => (v === 0 ? 0 : 55 + v * 40)
    return hex(level(Math.floor(i / 36)), level(Math.floor(i / 6) % 6), level(i % 6))
  }
  const g = 8 + (n - 232) * 10
  return hex(g, g, g)
}

/** Keeps markup-looking text from the network from being read as markup. */
const neutral = (s: string) => s.replace(/\{(?=(?:c|link|anim|fg):|\/\})/g, '{​')

export function ansiToMarkup(text: string): string {
  let out = ''
  let fg: string | null = null
  const emit = (s: string) => {
    if (!s) return
    const safe = neutral(s)
    out += fg ? `{fg:${fg}}${safe}{/}` : safe
  }
  // CSI sequences (ESC [ ... letter); SGR ("m") ones set colours.
  const re = /\x1b\[([0-9;?]*)([A-Za-z])|\x1b[()][A-Z0-9]|\x1b[=>]/g
  let last = 0
  for (const m of text.matchAll(re)) {
    emit(text.slice(last, m.index))
    last = m.index! + m[0].length
    if (m[2] !== 'm') continue
    const codes = (m[1] || '0').split(';').map((x) => parseInt(x || '0', 10))
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i]
      if (code === 0 || code === 39) fg = null
      else if (code >= 30 && code <= 37) fg = BASIC[code - 30]
      else if (code >= 90 && code <= 97) fg = BRIGHT[code - 90]
      else if (code === 38 && codes[i + 1] === 5) {
        fg = color256(codes[i + 2] ?? 7)
        i += 2
      } else if (code === 38 && codes[i + 1] === 2) {
        fg = hex(codes[i + 2] ?? 0, codes[i + 3] ?? 0, codes[i + 4] ?? 0)
        i += 4
      } else if (code === 48) i += codes[i + 1] === 5 ? 2 : codes[i + 1] === 2 ? 4 : 0 // backgrounds: skipped
    }
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
