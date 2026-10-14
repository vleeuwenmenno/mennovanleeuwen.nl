// cmatrix: the digital rain from The Matrix, after cmatrix -k and unimatrix. Half-width katakana
// (mirrored, as in the film), digits and a few symbols fall in columns at their own speeds: a
// glowing pale head, a trail that fades from bright to deep green, characters that flicker while
// they fade.
//
// It paints a canvas (ctx.paint, src/apps/Terminal.tsx) instead of redrawing text. As text, every
// frame was one markup string for the whole screen that React parsed and compared again (some
// 10 ms of main thread per frame at 210×50): fine for 16 frames a second, not for 144 or 240.
// Here the rain is a few typed arrays, and a frame redraws only the cells whose character or shade
// changed (a hundred or two), each one copy from a sheet of glyphs drawn once at the start. The
// heads, with their glow, go on a second canvas on top, so a glow never gets cut off by the cell
// next to it being redrawn. The simulation runs on time, not frames: the speed is the same at 60
// and at 240 Hz, and a faster screen only gets smoother fades. Every glyph is centred in its own
// cell (and narrowed if the fallback font draws it wider), so katakana from whatever font the
// browser falls back to stay on the grid.

import { CmdError, type Ctx } from './types'

/** Half-width katakana ｦ and ｱ to ﾝ: one cell wide, like the digits. (The small kana and ｰ read as noise.) */
const KATAKANA = ['\uff66', ...Array.from({ length: 0xff9d - 0xff71 + 1 }, (_, i) => String.fromCharCode(0xff71 + i))]
/** The film's mix: mostly katakana, some digits, a few Latin letters and symbols. */
const FILM = [...KATAKANA, ...'0123456789', ...'Z:."=*+-<>¦|']
/** The old look (-a): Latin letters, digits and symbols. */
const ASCII = [...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@#$%&*+=<>?/\\|']

type RGB = [number, number, number]
export const COLORS: Record<string, RGB> = {
  green: [0x10, 0xff, 0x50],
  red: [0xff, 0x2a, 0x2a],
  blue: [0x3a, 0x7d, 0xff],
  cyan: [0x00, 0xe5, 0xff],
  magenta: [0xff, 0x3d, 0xd8],
  yellow: [0xff, 0xe0, 0x30],
  white: [0xe6, 0xe6, 0xe6],
}
const RAINBOW: RGB[] = [COLORS.red, [0xff, 0x8c, 0x1a], COLORS.yellow, COLORS.green, COLORS.cyan, COLORS.blue, COLORS.magenta]
/** Live colour keys, as in cmatrix: ! red, @ green, # yellow, $ blue, % magenta, ^ cyan, & white. */
const COLOR_KEYS: Record<string, string> = { '!': 'red', '@': 'green', '#': 'yellow', $: 'blue', '%': 'magenta', '^': 'cyan', '&': 'white' }

/** Shades from just-passed (SHADES) to nearly gone (1); 0 is an empty cell. */
const SHADES = 12
/** How often a lit character changes, per cell per second. */
const GLITCH = 0.35

export const USAGE = [
  'Usage: cmatrix [-aksrh] [-C color] [-u delay]',
  ' -a          the old look: ASCII letters, digits and symbols',
  ' -k          katakana, digits and symbols, like the film (the default)',
  ' -C color    green (default), red, blue, cyan, magenta, yellow or white',
  ' -r          rainbow: every drop its own colour',
  ' -u delay    speed, 0 (fastest) to 9 (slowest); 4 is the default',
  ' -s          screensaver: any key quits',
  ' -h          this help',
  'While it runs: q or Esc quits, 0-9 change the speed, p or space pauses,',
  '!@#$%^& change the colour (red, green, yellow, blue, magenta, cyan, white).',
].join('\n')

export type MatrixOptions = { ascii: boolean; color: string; rainbow: boolean; speed: number; screensaver: boolean; help: boolean }

/** Reads the flags like getopt: `-ar`, `-u 5`, `-u5`, `-C red`, `-Cred`. */
export function parseMatrixArgs(args: string[]): MatrixOptions {
  const o: MatrixOptions = { ascii: false, color: 'green', rainbow: false, speed: 4, screensaver: false, help: false }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--help') {
      o.help = true
      continue
    }
    if (!a.startsWith('-') || a === '-') throw new CmdError(`cmatrix: unexpected argument '${a}'\nTry 'cmatrix -h' for more information.`)
    for (let j = 1; j < a.length; j++) {
      const f = a[j]
      if (f === 'a') o.ascii = true
      else if (f === 'k') o.ascii = false
      else if (f === 'r') o.rainbow = true
      else if (f === 's') o.screensaver = true
      else if (f === 'h') o.help = true
      else if (f === 'C' || f === 'u') {
        const value = a.slice(j + 1) || args[++i]
        if (value === undefined) throw new CmdError(`cmatrix: option requires an argument -- '${f}'`)
        if (f === 'C') {
          const name = value.toLowerCase()
          if (!COLORS[name]) throw new CmdError(`cmatrix: invalid color '${value}' (${Object.keys(COLORS).join(', ')})`)
          o.color = name
        } else {
          if (!/^\d$/.test(value)) throw new CmdError(`cmatrix: -u takes a delay from 0 to 9, not '${value}'`)
          o.speed = Number(value)
        }
        break
      } else throw new CmdError(`cmatrix: invalid option -- '${f}'\nTry 'cmatrix -h' for more information.`)
    }
  }
  return o
}

/** Cells a drop of speed 1 falls per second, for -u 0 to 9 (cmatrix waits delay × 10 ms a step). */
export const cellsPerSecond = (speed: number) => 1000 / (12 + speed * 9)

/**
 * The rain itself, without a screen: a grid of cells (character, brightness, colour) and the
 * drops falling through it. Typed arrays, sized once per terminal size; nothing is allocated per
 * frame.
 */
export class Rain {
  cols = 0
  rows = 0
  /** Per cell: index into the character set, brightness (1 just passed, 0 empty), fade per cell a speed-1 drop falls, colour. */
  glyph = new Uint16Array(0)
  bright = new Float32Array(0)
  fade = new Float32Array(0)
  hue = new Uint8Array(0)
  /** Per column: cells to fall before the next drop starts at the top. */
  wait = new Float32Array(0)
  /** The drops, as parallel arrays: column, row (fractional), speed, fade per cell, colour. */
  n = 0
  dx = new Int16Array(0)
  dy = new Float32Array(0)
  dv = new Float32Array(0)
  df = new Float32Array(0)
  dh = new Uint8Array(0)
  rate: number
  paused = false
  /** Set when a head moved, appeared, left or changed character since the last look. */
  headsMoved = true

  constructor(
    cols: number,
    rows: number,
    readonly glyphs: number,
    speed: number,
    public hues = 1,
    private rand: () => number = Math.random,
  ) {
    this.rate = cellsPerSecond(speed)
    this.resize(cols, rows)
  }

  setSpeed(speed: number) {
    this.rate = cellsPerSecond(speed)
  }

  /** A new size: what was on screen stays where it was, drops outside it go. */
  resize(cols: number, rows: number) {
    cols = Math.max(1, cols | 0)
    rows = Math.max(1, rows | 0)
    if (cols === this.cols && rows === this.rows) return
    const old = { cols: this.cols, rows: this.rows, glyph: this.glyph, bright: this.bright, fade: this.fade, hue: this.hue, wait: this.wait }
    const size = cols * rows
    this.glyph = new Uint16Array(size)
    this.bright = new Float32Array(size)
    this.fade = new Float32Array(size)
    this.hue = new Uint8Array(size)
    for (let y = 0; y < Math.min(rows, old.rows); y++) {
      for (let x = 0; x < Math.min(cols, old.cols); x++) {
        const from = y * old.cols + x
        const to = y * cols + x
        this.glyph[to] = old.glyph[from]
        this.bright[to] = old.bright[from]
        this.fade[to] = old.fade[from]
        this.hue[to] = old.hue[from]
      }
    }
    this.wait = new Float32Array(cols)
    for (let x = 0; x < cols; x++) this.wait[x] = x < old.cols ? old.wait[x] : this.rand() * rows * 1.5
    // Room for three drops a column; drops in columns that went away are dropped.
    const cap = cols * 3
    const keep = { dx: this.dx, dy: this.dy, dv: this.dv, df: this.df, dh: this.dh, n: this.n }
    this.dx = new Int16Array(cap)
    this.dy = new Float32Array(cap)
    this.dv = new Float32Array(cap)
    this.df = new Float32Array(cap)
    this.dh = new Uint8Array(cap)
    this.n = 0
    for (let i = 0; i < keep.n && this.n < cap; i++) {
      if (keep.dx[i] >= cols) continue
      const k = this.n++
      this.dx[k] = keep.dx[i]
      this.dy[k] = keep.dy[i]
      this.dv[k] = keep.dv[i]
      this.df[k] = keep.df[i]
      this.dh[k] = keep.dh[i]
    }
    this.cols = cols
    this.rows = rows
    this.headsMoved = true
  }

  private pick() {
    return (this.rand() * this.glyphs) | 0
  }

  /** Advances the rain by `dt` seconds. */
  step(dt: number) {
    if (this.paused || dt <= 0) return
    const { cols, rows, glyph, bright, fade, hue, wait, dx, dy, dv, df, dh } = this
    const fall = this.rate * dt
    // New drops at the top, each column on its own clock.
    for (let x = 0; x < cols; x++) {
      wait[x] -= fall
      if (wait[x] > 0 || this.n >= dx.length) continue
      const v = 0.55 + this.rand() * 0.9
      const len = 5 + this.rand() * rows * 0.75
      const k = this.n++
      dx[k] = x
      dy[k] = -0.001
      dv[k] = v
      df[k] = 1 / len
      dh[k] = this.hues > 1 ? (this.rand() * this.hues) | 0 : 0
      // The next one after this one's trail, plus a gap.
      wait[x] = (len * (1 + this.rand()) + this.rand() * rows) / v
    }
    // Drops fall; every cell a head enters gets a fresh character at full brightness.
    for (let k = 0; k < this.n; k++) {
      const before = Math.floor(dy[k])
      dy[k] += dv[k] * fall
      const now = Math.floor(dy[k])
      if (now === before) continue
      this.headsMoved = true
      const x = dx[k]
      for (let y = Math.max(0, before + 1); y <= now && y < rows; y++) {
        const i = y * cols + x
        glyph[i] = this.pick()
        bright[i] = 1
        fade[i] = df[k] * dv[k]
        hue[i] = dh[k]
      }
      if (now >= rows) {
        // Off the bottom: the trail fades on its own.
        const last = --this.n
        dx[k] = dx[last]
        dy[k] = dy[last]
        dv[k] = dv[last]
        df[k] = df[last]
        dh[k] = dh[last]
        k--
      }
    }
    // Trails fade as their drop falls on: over its length, whatever the speed.
    const size = cols * rows
    for (let i = 0; i < size; i++) {
      const b = bright[i]
      if (b > 0) bright[i] = b - fade[i] * fall
    }
    // Characters change now and then while they fade.
    let flips = size * GLITCH * dt
    while (flips >= 1 || this.rand() < flips) {
      flips--
      const i = (this.rand() * size) | 0
      if (bright[i] > 0) glyph[i] = this.pick()
    }
    // The heads flicker faster.
    for (let k = 0; k < this.n; k++) {
      const y = Math.floor(dy[k])
      if (y >= 0 && y < rows && this.rand() < 6 * dt) {
        glyph[y * cols + dx[k]] = this.pick()
        this.headsMoved = true
      }
    }
  }
}

/** The shade a brightness shows as: 0 (empty) to SHADES. */
export const shadeOf = (b: number) => (b > 0 ? Math.min(SHADES, Math.ceil(b * SHADES)) : 0)

// ---------------------------------------------------------------------------
// The command

export async function cmatrix(ctx: Ctx): Promise<string> {
  const opts = parseMatrixArgs(ctx.args)
  if (opts.help) return USAGE
  if (!ctx.tty) throw new CmdError('cmatrix: not a terminal')
  if (!ctx.paint) throw new CmdError('cmatrix: needs a terminal window')
  const state: View = { charset: opts.ascii ? ASCII : FILM, mirror: !opts.ascii, color: opts.color, rainbow: opts.rainbow, speed: opts.speed, paused: false, changed: 0 }
  let quit = () => {}
  const done = new Promise<void>((resolve) => (quit = resolve))
  if (ctx.signal.aborted) quit()
  ctx.signal.addEventListener('abort', () => quit(), { once: true })
  ctx.onKey((k) => {
    if (opts.screensaver) {
      if (!['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(k)) quit()
      return true
    }
    if (k === 'q' || k === 'Q' || k === 'Escape') quit()
    else if (/^\d$/.test(k)) state.speed = Number(k)
    else if (k === 'p' || k === 'P' || k === ' ') state.paused = !state.paused
    else if (COLOR_KEYS[k]) {
      state.color = COLOR_KEYS[k]
      state.rainbow = false
    }
    state.changed++
    return true
  })
  const release = ctx.paint((host) => mountRain(host, state))
  try {
    await done
  } finally {
    ctx.onKey(null)
    release()
  }
  return ''
}

// ---------------------------------------------------------------------------
// The screen (browser only)

/** What the keys can change while it runs; `changed` counts changes. */
type View = { charset: string[]; mirror: boolean; color: string; rainbow: boolean; speed: number; paused: boolean; changed: number }

const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
const css = (c: RGB, alpha = 1) => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${alpha})`

/** A CSS colour as RGB, through a 1×1 canvas (works for any syntax the browser knows); null when see-through. */
function rgbOf(color: string): RGB | null {
  const c = document.createElement('canvas')
  c.width = c.height = 1
  const g = c.getContext('2d', { willReadFrequently: true })
  if (!g || !color) return null
  g.fillStyle = color
  g.fillRect(0, 0, 1, 1)
  const d = g.getImageData(0, 0, 1, 1).data
  return d[3] > 200 ? [d[0], d[1], d[2]] : null
}

/** The colour behind `el`: the first solid background up the tree, else the theme's. */
function backgroundOf(el: HTMLElement): RGB {
  for (let at: HTMLElement | null = el; at; at = at.parentElement) {
    const bg = rgbOf(getComputedStyle(at).backgroundColor)
    if (bg) return bg
  }
  return rgbOf(getComputedStyle(el).getPropertyValue('--bg').trim()) ?? [0, 0, 0]
}

/** The trail's colours for one base colour: pale near the head, the colour itself, then into the background. */
function trailColors(base: RGB, bg: RGB, toward: RGB): string[] {
  const out = ['']
  for (let s = 1; s <= SHADES; s++) {
    const t = s / SHADES
    out.push(css(t > 0.8 ? mix(base, toward, ((t - 0.8) / 0.2) * 0.45) : mix(bg, base, Math.pow(t / 0.8, 0.9) * 0.92 + 0.08)))
  }
  return out
}

/** Draws every glyph once per colour and shade: trails, and the heads with their glow. */
function drawSheets(view: View, font: string, cw: number, ch: number, bg: RGB) {
  const light = bg[0] * 0.299 + bg[1] * 0.587 + bg[2] * 0.114 > 140
  const toward: RGB = light ? [0, 0, 0] : [255, 255, 255]
  // On a light theme the bright colours would wash out: darker, with dark heads.
  const bases = (view.rainbow ? RAINBOW : [COLORS[view.color] ?? COLORS.green]).map((c) => (light ? mix(c, [0, 0, 0], 0.4) : c))
  const { charset, mirror } = view
  const trail = document.createElement('canvas')
  trail.width = charset.length * cw
  trail.height = bases.length * SHADES * ch
  const pad = Math.ceil(ch * 0.6)
  const heads = document.createElement('canvas')
  heads.width = charset.length * (cw + 2 * pad)
  heads.height = bases.length * (ch + 2 * pad)
  const t = trail.getContext('2d')!
  const h = heads.getContext('2d')!
  for (const g of [t, h]) {
    g.font = font
    g.textAlign = 'center'
    g.textBaseline = 'alphabetic'
  }
  const m = t.measureText('M')
  const ascent = m.fontBoundingBoxAscent ?? m.actualBoundingBoxAscent ?? ch * 0.75
  const descent = m.fontBoundingBoxDescent ?? m.actualBoundingBoxDescent ?? ch * 0.25
  const baseline = Math.round((ch - (ascent + descent)) / 2 + ascent)
  // Each glyph centred in its cell and narrowed if the font draws it wider. Katakana come from a
  // fallback font that draws them small: a little larger, and mirrored, as in the film.
  const shapes = charset.map((c) => {
    const kana = c >= '\uff66'
    const scale = kana ? 1.15 : 1
    const w = t.measureText(c).width * scale
    return { c, sx: (mirror && kana ? -1 : 1) * scale * Math.min(1, (cw * 0.96) / (w || cw)), sy: scale }
  })
  const put = (g: CanvasRenderingContext2D, i: number, x: number, y: number) => {
    const s = shapes[i]
    g.setTransform(s.sx, 0, 0, s.sy, x + cw / 2, y + baseline)
    g.fillText(s.c, 0, 0)
  }
  bases.forEach((base, hi) => {
    const colors = trailColors(base, bg, toward)
    for (let s = 1; s <= SHADES; s++) {
      t.fillStyle = colors[s]
      for (let i = 0; i < charset.length; i++) put(t, i, i * cw, (hi * SHADES + s - 1) * ch)
    }
    h.fillStyle = css(mix(base, toward, 0.88))
    h.shadowColor = css(base, 0.95)
    h.shadowBlur = ch * 0.55
    for (let i = 0; i < charset.length; i++) put(h, i, i * (cw + 2 * pad) + pad, hi * (ch + 2 * pad) + pad)
  })
  return { trail, heads, pad }
}

/** Puts the rain in `host` (the terminal's text area) until the returned function is called. */
function mountRain(host: HTMLElement, view: View): () => void {
  const back = document.createElement('canvas')
  const front = document.createElement('canvas')
  for (const c of [back, front]) {
    c.style.position = 'absolute'
    c.setAttribute('aria-hidden', 'true')
    host.append(c)
  }
  // Follows the text size (zoom): a hidden probe, like the emulator's.
  const probe = document.createElement('span')
  probe.textContent = 'MMMMMMMMMM'
  Object.assign(probe.style, { position: 'absolute', visibility: 'hidden', whiteSpace: 'pre', pointerEvents: 'none' })
  host.append(probe)
  host.setAttribute('aria-label', 'cmatrix: characters falling like rain. q quits.')

  const b = back.getContext('2d', { alpha: true })!
  const f = front.getContext('2d', { alpha: true })!
  let rain: Rain | null = null
  let sheets: ReturnType<typeof drawSheets> | null = null
  let shown = new Uint32Array(0)
  let cw = 1
  let ch = 1
  let dpr = 0
  let seen = -1
  let needLayout = true
  let frame = 0
  let last = 0
  let font = ''
  /** Cells where the heads were drawn last, to clear just those next time. */
  let headAt = new Int32Array(0)
  let headsDrawn = 0
  let look = ''
  let drawnFor = ''
  let bg: RGB = [0, 0, 0]

  function layout() {
    needLayout = false
    dpr = window.devicePixelRatio || 1
    const style = getComputedStyle(host)
    const px = parseFloat(style.fontSize) || 13
    font = `${px * dpr}px ${style.fontFamily}`
    // What the trails fade into.
    bg = backgroundOf(host)
    b.font = font
    // Whole device pixels per cell, so cells never share a pixel and never leave a seam.
    cw = Math.max(1, Math.round(b.measureText('MMMMMMMMMM').width / 10))
    ch = Math.max(1, Math.round(px * 1.25 * dpr))
    const cols = Math.max(1, Math.floor((host.clientWidth * dpr) / cw))
    const rows = Math.max(1, Math.floor((host.clientHeight * dpr) / ch))
    for (const c of [back, front]) {
      c.width = cols * cw
      c.height = rows * ch
      c.style.width = `${(cols * cw) / dpr}px`
      c.style.height = `${(rows * ch) / dpr}px`
      c.style.left = `${Math.floor((host.clientWidth - (cols * cw) / dpr) / 2)}px`
      c.style.top = '0px'
    }
    // The glyph sheets only when what they look like changed (not on every step of a window drag).
    if (`${font} ${cw} ${ch} ${bg}` !== drawnFor) rebuild()
    if (!rain) rain = new Rain(cols, rows, view.charset.length, view.speed, view.rainbow ? RAINBOW.length : 1)
    else rain.resize(cols, rows)
    shown = new Uint32Array(cols * rows).fill(0xffffffff)
    headsDrawn = 0
    rain.headsMoved = true
  }

  function rebuild() {
    look = `${view.color} ${view.rainbow}`
    drawnFor = `${font} ${cw} ${ch} ${bg}`
    sheets = drawSheets(view, font, cw, ch, bg)
    shown.fill(0xffffffff)
    if (rain) {
      rain.hues = view.rainbow ? RAINBOW.length : 1
      if (!view.rainbow) rain.hue.fill(0), rain.dh.fill(0)
      rain.headsMoved = true
    }
  }

  function paint(now: number) {
    frame = requestAnimationFrame(paint)
    if (needLayout || dpr !== (window.devicePixelRatio || 1)) layout()
    if (!rain || !sheets) return
    if (seen !== view.changed) {
      seen = view.changed
      rain.setSpeed(view.speed)
      rain.paused = view.paused
      if (look !== `${view.color} ${view.rainbow}`) rebuild()
    }
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 0
    last = now
    rain.step(dt)

    // The trails: only cells whose character, colour or shade changed.
    const { cols, rows, glyph, bright, hue } = rain
    const trail = sheets.trail
    for (let y = 0, i = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++, i++) {
        const s = shadeOf(bright[i])
        const key = s ? ((glyph[i] * 16 + hue[i]) << 4) | s : 0
        if (key === shown[i]) continue
        shown[i] = key
        b.clearRect(x * cw, y * ch, cw, ch)
        if (s) b.drawImage(trail, glyph[i] * cw, (hue[i] * SHADES + s - 1) * ch, cw, ch, x * cw, y * ch, cw, ch)
      }
    }

    // The heads, glow and all, on their own layer.
    if (rain.headsMoved) {
      rain.headsMoved = false
      const { heads, pad } = sheets
      const w = cw + 2 * pad
      const hh = ch + 2 * pad
      // Only where heads were (a full clear is most of a frame's pixels on a software canvas).
      for (let k = 0; k < headsDrawn; k++) {
        const i = headAt[k]
        f.clearRect((i % cols) * cw - pad, Math.floor(i / cols) * ch - pad, w, hh)
      }
      headsDrawn = 0
      if (headAt.length < rain.dx.length) headAt = new Int32Array(rain.dx.length)
      for (let k = 0; k < rain.n; k++) {
        const y = Math.floor(rain.dy[k])
        if (y < 0 || y >= rows) continue
        const x = rain.dx[k]
        f.drawImage(heads, glyph[y * cols + x] * w, rain.dh[k] * hh, w, hh, x * cw - pad, y * ch - pad, w, hh)
        headAt[headsDrawn++] = y * cols + x
      }
    }
  }

  const ro = new ResizeObserver(() => (needLayout = true))
  ro.observe(host)
  ro.observe(probe)
  // The fonts first, so the sheets are drawn in JetBrains Mono rather than the fallback.
  let stopped = false
  const start = () => !stopped && (frame = requestAnimationFrame(paint))
  const fonts = document.fonts
  if (fonts?.load) fonts.load(`${parseFloat(getComputedStyle(host).fontSize) || 13}px ${getComputedStyle(host).fontFamily}`, 'Mｱ').then(start, start)
  else start()
  return () => {
    stopped = true
    cancelAnimationFrame(frame)
    ro.disconnect()
    back.remove()
    front.remove()
    probe.remove()
  }
}
