// A VT100/xterm-compatible terminal emulator without a screen: it reads what a program writes
// (text and escape sequences) and keeps the grid of characters it would show, the cursor and the
// modes the program set. The renderer (VtView.tsx) draws the grid; the node check script
// (scripts/terminal-vt.ts) replays recorded sessions into it and compares the grid with tmux's.
//
// What it covers: cursor movement, save and restore; erasing in the line and the display;
// inserting and deleting lines and characters; scroll regions and origin mode; the alternate
// screen (47, 1047, 1049); autowrap with xterm's pending wrap; tab stops; DEC line drawing;
// 16, 256 and truecolour foreground and background, bold, dim, italic, underline, blink, inverse,
// invisible, strikethrough and overline; OSC 0/2 titles and OSC 8 links; bracketed paste,
// application cursor and keypad modes, mouse reporting (X10, normal, button and any-event
// tracking, SGR encoding), focus events, cursor visibility and shape, synchronized output; the
// replies to device attribute, status, cursor position, mode and size requests; and resizing
// (without reflowing wrapped lines). DCS strings, OSC 52 (clipboard) and sixel are read and dropped.

import { charWidth } from './width.ts'
import { DEFAULT_COLOR, RGB } from './palette.ts'

export const BOLD = 1
export const DIM = 2
export const ITALIC = 4
export const UNDERLINE = 8
export const BLINK = 16
export const INVERSE = 32
export const INVISIBLE = 64
export const STRIKE = 128
export const OVERLINE = 256

/** How a cell looks. Interned, so equal styles are the same object and can be compared with ===. */
export type Style = { readonly fg: number; readonly bg: number; readonly flags: number; readonly link: string | null }

const styles = new Map<string, Style>()
export function style(fg: number, bg: number, flags: number, link: string | null = null): Style {
  const key = `${fg},${bg},${flags},${link ?? ''}`
  let s = styles.get(key)
  if (!s) {
    // Truecolour gradients make many; cells keep theirs when the table starts over.
    if (styles.size > 8192) styles.clear()
    s = { fg, bg, flags, link }
    styles.set(key, s)
  }
  return s
}
export const PLAIN = style(DEFAULT_COLOR, DEFAULT_COLOR, 0)

/**
 * One row. A wide character's cell holds it and the cell after it holds '' (the renderer skips
 * that one); `wrapped` says the line went on into the next one. `ver` changes whenever the row
 * does, so a renderer can skip the rows that stayed the same.
 */
export type Line = { ch: string[]; st: Style[]; wrapped: boolean; ver: number }

let version = 0
const touch = (line: Line) => void (line.ver = ++version)

function blankLine(cols: number, st: Style = PLAIN): Line {
  return { ch: new Array<string>(cols).fill(' '), st: new Array<Style>(cols).fill(st), wrapped: false, ver: ++version }
}

/** A row as text, without trailing spaces. */
export const lineText = (line: Line) => line.ch.join('').replace(/\s+$/, '')

export type MouseMode = 0 | 9 | 1000 | 1002 | 1003

export type Modes = {
  /** IRM: printing shifts the rest of the line right */
  insert: boolean
  /** LNM: a line feed also returns the carriage */
  newline: boolean
  /** DECCKM: arrows, Home and End send ESC O … instead of ESC [ … */
  appCursor: boolean
  /** DECKPAM: the keypad sends ESC O … */
  appKeypad: boolean
  /** DECOM: row numbers count from the top of the scroll region */
  origin: boolean
  /** DECAWM */
  autowrap: boolean
  /** DECTCEM */
  cursorVisible: boolean
  /** DECSCNM: the whole screen in reverse video */
  reverse: boolean
  bracketedPaste: boolean
  mouse: MouseMode
  /** 1006: mouse reports as CSI < … M/m rather than bytes */
  mouseSgr: boolean
  /** 1004: focus in and out are reported */
  focus: boolean
  /** 1007: the wheel sends arrow keys on the alternate screen when the mouse is not tracked */
  altScroll: boolean
  /** 2026: the program is drawing a frame; the renderer waits for the end of it */
  sync: boolean
}

type Saved = { x: number; y: number; pen: Style; origin: boolean; wrapPending: boolean; charsets: string[]; gl: number }

export type VtOptions = {
  cols: number
  rows: number
  /** Lines kept above the screen (normal screen only) */
  scrollback?: number
  /** Answers to the program's requests (cursor position, device attributes), to send back to it */
  onReply?: (data: string) => void
  onTitle?: (title: string) => void
  onBell?: () => void
  /** The program asks for a size (CSI 8 ; rows ; cols t); 0 for both is the window's own again */
  onResizeRequest?: (cols: number, rows: number) => void
  /** The default colours as #rrggbb, for programs that ask (OSC 10/11; Neovim picks light or dark by them) */
  colors?: () => { fg: string; bg: string }
}

// The parser's states.
const GROUND = 0
const ESC = 1
const ESC_INT = 2
const CSI = 3
const OSC = 4
const STR = 5
const STR_ESC = 6
const OSC_ESC = 7

// DEC special graphics (ESC ( 0): what line-drawing programs mean by these letters.
const DEC_GRAPHICS: Record<string, string> = {
  '`': '◆', a: '▒', b: '␉', c: '␌', d: '␍', e: '␊', f: '°', g: '±', h: '␤', i: '␋', j: '┘', k: '┐', l: '┌', m: '└', n: '┼', o: '⎺', p: '⎻', q: '─', r: '⎼', s: '⎽',
  t: '├', u: '┤', v: '┴', w: '┬', x: '│', y: '≤', z: '≥', '{': 'π', '|': '≠', '}': '£', '~': '·',
}

const ANSI_MODES = new Set([4, 20])
const DEC_MODES = new Set([1, 5, 6, 7, 9, 12, 25, 47, 66, 1000, 1002, 1003, 1004, 1006, 1007, 1047, 1048, 1049, 2004, 2026])

export class VT {
  cols: number
  rows: number
  /** The normal screen's rows; `scrollback` holds what scrolled off its top, oldest first. */
  normal: Line[]
  alt: Line[]
  scrollback: Line[] = []
  altActive = false
  x = 0
  y = 0
  /** At the last column after printing there: the next character wraps first (xterm's way). */
  wrapPending = false
  /** The style new characters get (SGR). */
  pen: Style = PLAIN
  top = 0
  bottom: number
  modes: Modes = VT.defaultModes()
  /** DECSCUSR: 0/1/2 block, 3/4 underline, 5/6 bar (odd ones blink) */
  cursorShape = 0
  title = ''
  /** Changes on every write that changed something, for whoever draws it. */
  version = 0

  private maxScrollback: number
  private opts: VtOptions
  private tabs: boolean[] = []
  private charsets = ['B', 'B', 'B', 'B']
  private gl = 0
  private saved: { normal: Saved | null; alt: Saved | null } = { normal: null, alt: null }
  private titles: string[] = []
  private lastChar = ''
  private decoder = new TextDecoder('utf-8')
  // Parser state.
  private state = GROUND
  private params = ''
  private prefix = ''
  private inter = ''
  private str = ''

  constructor(opts: VtOptions) {
    this.opts = opts
    this.cols = Math.max(2, opts.cols | 0)
    this.rows = Math.max(1, opts.rows | 0)
    this.bottom = this.rows - 1
    this.maxScrollback = opts.scrollback ?? 2000
    this.normal = Array.from({ length: this.rows }, () => blankLine(this.cols))
    this.alt = Array.from({ length: this.rows }, () => blankLine(this.cols))
    this.resetTabs()
  }

  static defaultModes(): Modes {
    return { insert: false, newline: false, appCursor: false, appKeypad: false, origin: false, autowrap: true, cursorVisible: true, reverse: false, bracketedPaste: false, mouse: 0, mouseSgr: false, focus: false, altScroll: true, sync: false }
  }

  /** The rows on screen now (the alternate screen's while it is up). */
  get screen(): Line[] {
    return this.altActive ? this.alt : this.normal
  }

  /** The screen as text, one string per row, trailing spaces trimmed. */
  screenText(): string[] {
    return this.screen.map(lineText)
  }

  /** Feeds program output. Bytes are read as UTF-8, also when a character is split over two writes. */
  write(data: Uint8Array | string) {
    const text = typeof data === 'string' ? data : this.decoder.decode(data, { stream: true })
    if (!text) return
    this.parse(text)
    this.version++
  }

  // --- the parser ------------------------------------------------------------------------------

  private parse(s: string) {
    const n = s.length
    for (let i = 0; i < n; i++) {
      let c = s.charCodeAt(i)
      if (this.state === GROUND) {
        // Runs of plain ASCII, the common case.
        if (c >= 0x20 && c < 0x7f) {
          let j = i + 1
          while (j < n) {
            const d = s.charCodeAt(j)
            if (d < 0x20 || d >= 0x7f) break
            j++
          }
          this.print(s, i, j)
          i = j - 1
          continue
        }
      }
      // A surrogate pair is one character.
      let ch: string
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < n) {
        const lo = s.charCodeAt(i + 1)
        if (lo >= 0xdc00 && lo <= 0xdfff) {
          c = ((c - 0xd800) << 10) + (lo - 0xdc00) + 0x10000
          ch = s.slice(i, i + 2)
          i++
        } else ch = s[i]
      } else ch = s[i]

      switch (this.state) {
        case OSC:
          if (c === 0x07 || c === 0x9c) this.endOsc()
          else if (c === 0x1b) this.state = OSC_ESC
          else if (c === 0x18 || c === 0x1a) this.state = GROUND
          else if (this.str.length < 8192) this.str += ch
          continue
        case OSC_ESC:
          // ESC \ ends it; any other ESC also ends it and starts a new sequence.
          this.endOsc()
          if (c !== 0x5c) this.enterEsc(), this.escape(c, ch)
          continue
        case STR:
          if (c === 0x1b) this.state = STR_ESC
          else if (c === 0x07 || c === 0x9c || c === 0x18 || c === 0x1a) this.state = GROUND
          continue
        case STR_ESC:
          this.state = GROUND
          if (c !== 0x5c) this.enterEsc(), this.escape(c, ch)
          continue
      }

      // C0 controls act in the middle of escape sequences too, as on a VT100.
      if (c < 0x20 || c === 0x7f) {
        if (c === 0x1b) this.enterEsc()
        else if (c === 0x18 || c === 0x1a) this.state = GROUND
        else if (c !== 0x7f) this.control(c)
        continue
      }
      if (c >= 0x80 && c < 0xa0) continue // C1 controls: not used in UTF-8 mode

      switch (this.state) {
        case GROUND:
          this.printChar(c, ch)
          break
        case ESC:
          this.escape(c, ch)
          break
        case ESC_INT:
          if (c >= 0x20 && c <= 0x2f) this.inter += ch
          else this.escDispatch(this.inter, ch)
          break
        case CSI:
          if (c >= 0x30 && c <= 0x3b) this.params += ch
          else if (c >= 0x3c && c <= 0x3f) {
            if (this.params || this.inter) this.prefix = '\0' // malformed: ignored at the end
            else this.prefix += ch
          } else if (c >= 0x20 && c <= 0x2f) this.inter += ch
          else if (c >= 0x40 && c <= 0x7e) {
            this.state = GROUND
            if (this.prefix !== '\0') this.csi(ch)
          } else this.state = GROUND
          break
      }
    }
  }

  private enterEsc() {
    this.state = ESC
    this.inter = ''
  }

  private escape(c: number, ch: string) {
    if (ch === '[') {
      this.state = CSI
      this.params = ''
      this.prefix = ''
      this.inter = ''
    } else if (ch === ']') {
      this.state = OSC
      this.str = ''
    } else if (ch === 'P' || ch === 'X' || ch === '^' || ch === '_') this.state = STR
    else if (c >= 0x20 && c <= 0x2f) {
      this.state = ESC_INT
      this.inter = ch
    } else this.escDispatch('', ch)
  }

  private escDispatch(inter: string, final: string) {
    this.state = GROUND
    if (inter) {
      const g = '()*+'.indexOf(inter[0])
      if (g >= 0) this.charsets[g] = final
      else if (inter === '#' && final === '8') this.alignmentTest()
      return
    }
    switch (final) {
      case '7':
        return this.saveCursor()
      case '8':
        return this.restoreCursor()
      case 'D':
        return this.index()
      case 'E':
        this.x = 0
        return this.index()
      case 'H':
        this.tabs[this.x] = true
        return
      case 'M':
        return this.reverseIndex()
      case 'c':
        return this.reset()
      case '=':
        this.modes.appKeypad = true
        return
      case '>':
        this.modes.appKeypad = false
        return
      case 'Z':
        return this.reply('\x1b[?62;22c')
      // ESC \ (string terminator outside a string), SS2/SS3 and the rest: nothing to do
    }
  }

  private control(c: number) {
    switch (c) {
      case 0x07:
        return this.opts.onBell?.()
      case 0x08:
        // Backspace from the pending-wrap spot lands on the column before the last.
        if (this.wrapPending) this.wrapPending = false
        if (this.x > 0) this.x--
        return
      case 0x09:
        return this.tab(1)
      case 0x0a:
      case 0x0b:
      case 0x0c:
        if (this.modes.newline) this.x = 0
        return this.index()
      case 0x0d:
        this.x = 0
        this.wrapPending = false
        return
      case 0x0e:
        this.gl = 1
        return
      case 0x0f:
        this.gl = 0
        return
    }
  }

  private endOsc() {
    this.state = GROUND
    const s = this.str
    const semi = s.indexOf(';')
    const code = semi < 0 ? s : s.slice(0, semi)
    const arg = semi < 0 ? '' : s.slice(semi + 1)
    switch (code) {
      case '0':
      case '2':
        this.setTitle(arg)
        return
      case '8': {
        // OSC 8 ; params ; uri: a link around the text that follows, until an empty uri.
        const uri = arg.slice(arg.indexOf(';') + 1)
        this.pen = style(this.pen.fg, this.pen.bg, this.pen.flags, /^https?:\/\/[^\s]+$/i.test(uri) && uri.length < 2048 ? uri : null)
        return
      }
      case '10':
      case '11': {
        if (arg !== '?') return
        const colors = this.opts.colors?.()
        if (!colors) return
        const hexColor = code === '10' ? colors.fg : colors.bg
        const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hexColor)
        if (m) this.reply(`\x1b]${code};rgb:${m[1]}${m[1]}/${m[2]}${m[2]}/${m[3]}${m[3]}\x1b\\`)
        return
      }
    }
  }

  private setTitle(t: string) {
    // eslint-disable-next-line no-control-regex
    this.title = t.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200)
    this.opts.onTitle?.(this.title)
  }

  private reply(data: string) {
    this.opts.onReply?.(data)
  }

  // --- printing --------------------------------------------------------------------------------

  /** Plain ASCII from s[from] to s[to]. */
  private print(s: string, from: number, to: number) {
    const graphics = this.charsets[this.gl] === '0'
    for (let i = from; i < to; i++) {
      const ch = s[i]
      this.put(graphics ? (DEC_GRAPHICS[ch] ?? ch) : ch, 1)
    }
  }

  private printChar(c: number, ch: string) {
    const w = charWidth(c)
    if (w === 0) return this.combine(ch)
    if (c < 0x80 && this.charsets[this.gl] === '0') ch = DEC_GRAPHICS[ch] ?? ch
    this.put(ch, w)
  }

  /** A zero-width character joins the one before the cursor. */
  private combine(ch: string) {
    const line = this.screen[this.y]
    let x = this.wrapPending ? this.x : this.x - 1
    if (x < 0) return
    if (line.ch[x] === '' && x > 0) x--
    line.ch[x] += ch
    touch(line)
  }

  private put(ch: string, w: number) {
    const cols = this.cols
    if (this.wrapPending) {
      if (this.modes.autowrap) {
        this.screen[this.y].wrapped = true
        this.x = 0
        this.index()
      }
      this.wrapPending = false
    }
    // A wide character does not fit in the last column: it goes to the next line.
    if (w === 2 && this.x === cols - 1) {
      if (!this.modes.autowrap) return
      const line = this.screen[this.y]
      this.clearCell(line, this.x)
      line.wrapped = true
      this.x = 0
      this.index()
    }
    const line = this.screen[this.y]
    if (this.modes.insert) this.shiftRight(line, this.x, w)
    this.clearCell(line, this.x)
    line.ch[this.x] = ch
    line.st[this.x] = this.pen
    if (w === 2) {
      this.clearCell(line, this.x + 1)
      line.ch[this.x + 1] = ''
      line.st[this.x + 1] = this.pen
    }
    touch(line)
    this.lastChar = ch
    this.x += w
    if (this.x >= cols) {
      this.x = cols - 1
      if (this.modes.autowrap) this.wrapPending = true
    }
  }

  /** Before a cell is overwritten: the other half of a wide character there goes blank. */
  private clearCell(line: Line, x: number) {
    if (x >= this.cols) return
    if (line.ch[x] === '' && x > 0) line.ch[x - 1] = ' '
    else if (x + 1 < this.cols && line.ch[x + 1] === '') line.ch[x + 1] = ' '
  }

  // --- cursor and scrolling --------------------------------------------------------------------

  /** Line feed: down a row, scrolling the region at its bottom. */
  private index() {
    this.wrapPending = false
    if (this.y === this.bottom) this.scrollUp(1)
    else if (this.y < this.rows - 1) this.y++
  }

  private reverseIndex() {
    this.wrapPending = false
    if (this.y === this.top) this.scrollDown(1)
    else if (this.y > 0) this.y--
  }

  /** The style erased cells get: the pen's background (xterm's background colour erase). */
  private blank(): Style {
    return this.pen.bg === DEFAULT_COLOR ? PLAIN : style(DEFAULT_COLOR, this.pen.bg, 0)
  }

  private scrollUp(n: number, top = this.top, bottom = this.bottom) {
    const buf = this.screen
    n = Math.min(n, bottom - top + 1)
    for (let i = 0; i < n; i++) {
      const [gone] = buf.splice(top, 1)
      // Only the normal screen, scrolled as a whole, keeps what goes off the top.
      if (!this.altActive && top === 0 && bottom === this.rows - 1) {
        this.scrollback.push(gone)
        if (this.scrollback.length > this.maxScrollback) this.scrollback.splice(0, this.scrollback.length - this.maxScrollback)
      }
      buf.splice(bottom, 0, blankLine(this.cols, this.blank()))
    }
  }

  private scrollDown(n: number, top = this.top, bottom = this.bottom) {
    const buf = this.screen
    n = Math.min(n, bottom - top + 1)
    for (let i = 0; i < n; i++) {
      buf.splice(bottom, 1)
      buf.splice(top, 0, blankLine(this.cols, this.blank()))
    }
  }

  private tab(n: number) {
    this.wrapPending = false
    while (n-- > 0) {
      let x = this.x + 1
      while (x < this.cols - 1 && !this.tabs[x]) x++
      this.x = Math.min(x, this.cols - 1)
    }
  }

  private backTab(n: number) {
    this.wrapPending = false
    while (n-- > 0 && this.x > 0) {
      let x = this.x - 1
      while (x > 0 && !this.tabs[x]) x--
      this.x = x
    }
  }

  private resetTabs() {
    this.tabs = Array.from({ length: this.cols }, (_, i) => i > 0 && i % 8 === 0)
  }

  /** Moves the cursor; rows count from the region's top in origin mode, and stay in it. */
  private moveTo(x: number, y: number) {
    this.wrapPending = false
    this.x = Math.max(0, Math.min(this.cols - 1, x))
    if (this.modes.origin) this.y = Math.max(this.top, Math.min(this.bottom, y + this.top))
    else this.y = Math.max(0, Math.min(this.rows - 1, y))
  }

  private saveCursor() {
    const s: Saved = { x: this.x, y: this.y, pen: this.pen, origin: this.modes.origin, wrapPending: this.wrapPending, charsets: [...this.charsets], gl: this.gl }
    if (this.altActive) this.saved.alt = s
    else this.saved.normal = s
  }

  private restoreCursor() {
    const s = this.altActive ? this.saved.alt : this.saved.normal
    if (!s) {
      this.moveTo(0, 0)
      this.pen = PLAIN
      return
    }
    this.x = Math.min(s.x, this.cols - 1)
    this.y = Math.min(s.y, this.rows - 1)
    this.pen = s.pen
    this.modes.origin = s.origin
    this.wrapPending = s.wrapPending && this.x === this.cols - 1
    this.charsets = [...s.charsets]
    this.gl = s.gl
  }

  private setAlt(on: boolean, clear: boolean) {
    if (on === this.altActive) return
    if (on && clear) this.alt = Array.from({ length: this.rows }, () => blankLine(this.cols))
    this.altActive = on
    this.wrapPending = false
  }

  // --- erasing and editing ---------------------------------------------------------------------

  private erase(line: Line, from: number, to: number) {
    const st = this.blank()
    from = Math.max(0, from)
    to = Math.min(this.cols, to)
    if (from >= to) return
    // A wide character cut in half by the erase goes blank whole.
    if (line.ch[from] === '' && from > 0) line.ch[from - 1] = ' '
    if (to < this.cols && line.ch[to] === '') line.ch[to] = ' '
    for (let x = from; x < to; x++) {
      line.ch[x] = ' '
      line.st[x] = st
    }
    touch(line)
  }

  private eraseInDisplay(mode: number) {
    const buf = this.screen
    if (mode === 0) {
      this.erase(buf[this.y], this.x, this.cols)
      for (let y = this.y + 1; y < this.rows; y++) this.erase(buf[y], 0, this.cols), (buf[y].wrapped = false)
    } else if (mode === 1) {
      for (let y = 0; y < this.y; y++) this.erase(buf[y], 0, this.cols), (buf[y].wrapped = false)
      this.erase(buf[this.y], 0, this.x + 1)
    } else if (mode === 2) {
      for (let y = 0; y < this.rows; y++) this.erase(buf[y], 0, this.cols), (buf[y].wrapped = false)
    } else if (mode === 3 && !this.altActive) this.scrollback = []
  }

  private eraseInLine(mode: number) {
    const line = this.screen[this.y]
    if (mode === 0) this.erase(line, this.x, this.cols), (line.wrapped = false)
    else if (mode === 1) this.erase(line, 0, this.x + 1)
    else if (mode === 2) this.erase(line, 0, this.cols), (line.wrapped = false)
  }

  /** Moves the cells from x on right by n within the line; what falls off the end is lost. */
  private shiftRight(line: Line, x: number, n: number) {
    const st = this.blank()
    line.ch.splice(x, 0, ...new Array<string>(n).fill(' '))
    line.st.splice(x, 0, ...new Array<Style>(n).fill(st))
    line.ch.length = this.cols
    line.st.length = this.cols
    fixWide(line)
    touch(line)
  }

  private insertChars(n: number) {
    this.wrapPending = false
    this.shiftRight(this.screen[this.y], this.x, Math.min(n, this.cols - this.x))
  }

  private deleteChars(n: number) {
    this.wrapPending = false
    const line = this.screen[this.y]
    n = Math.min(n, this.cols - this.x)
    line.ch.splice(this.x, n)
    line.st.splice(this.x, n)
    const st = this.blank()
    while (line.ch.length < this.cols) {
      line.ch.push(' ')
      line.st.push(st)
    }
    fixWide(line)
    touch(line)
  }

  private insertLines(n: number) {
    if (this.y < this.top || this.y > this.bottom) return
    this.scrollDown(n, this.y, this.bottom)
    this.x = 0
    this.wrapPending = false
  }

  private deleteLines(n: number) {
    if (this.y < this.top || this.y > this.bottom) return
    this.scrollUpNoHistory(n, this.y, this.bottom)
    this.x = 0
    this.wrapPending = false
  }

  /** Deleting lines never puts them in the scrollback. */
  private scrollUpNoHistory(n: number, top: number, bottom: number) {
    const buf = this.screen
    n = Math.min(n, bottom - top + 1)
    for (let i = 0; i < n; i++) {
      buf.splice(top, 1)
      buf.splice(bottom, 0, blankLine(this.cols, this.blank()))
    }
  }

  private alignmentTest() {
    for (const line of this.screen) {
      line.ch.fill('E')
      line.st.fill(PLAIN)
      touch(line)
    }
    this.top = 0
    this.bottom = this.rows - 1
    this.moveTo(0, 0)
  }

  /** RIS: back to how a new terminal starts. */
  reset() {
    this.normal = Array.from({ length: this.rows }, () => blankLine(this.cols))
    this.alt = Array.from({ length: this.rows }, () => blankLine(this.cols))
    this.altActive = false
    this.scrollback = []
    this.softReset()
    this.x = this.y = 0
    this.modes = VT.defaultModes()
    this.saved = { normal: null, alt: null }
    this.cursorShape = 0
    this.resetTabs()
  }

  /** DECSTR. */
  private softReset() {
    this.pen = PLAIN
    this.top = 0
    this.bottom = this.rows - 1
    this.wrapPending = false
    this.charsets = ['B', 'B', 'B', 'B']
    this.gl = 0
    Object.assign(this.modes, { insert: false, origin: false, autowrap: true, cursorVisible: true, appCursor: false, appKeypad: false })
  }

  // --- CSI -------------------------------------------------------------------------------------

  private csi(final: string) {
    // Parameters, each with its colon-separated sub-parameters; -1 where one was left out.
    const params = this.params ? this.params.split(';').map((p) => p.split(':').map((v) => (v === '' ? -1 : Math.min(65535, parseInt(v, 10))))) : []
    const p = (i: number, def: number) => {
      const v = params[i]?.[0] ?? -1
      return v <= 0 ? def : v
    }
    const n = p(0, 1)
    const prefix = this.prefix
    const inter = this.inter

    if (prefix === '?') {
      if (final === 'h' || final === 'l') return params.forEach((m) => this.decMode(m[0], final === 'h'))
      if (final === 'J') return this.eraseInDisplay(Math.max(0, params[0]?.[0] ?? 0))
      if (final === 'K') return this.eraseInLine(Math.max(0, params[0]?.[0] ?? 0))
      if (final === 'n' && params[0]?.[0] === 6) return this.reply(`\x1b[?${this.y + 1 - (this.modes.origin ? this.top : 0)};${this.x + 1}R`)
      if (final === 'p' && inter === '$') return this.reportMode(params[0]?.[0] ?? 0, true)
      return
    }
    if (prefix === '>') {
      if (final === 'c') return this.reply('\x1b[>0;10;1c')
      if (final === 'q') return this.reply('\x1bP>|MvL OS terminal\x1b\\')
      return // modifyOtherKeys and the rest
    }
    if (prefix) return

    if (inter === ' ' && final === 'q') {
      this.cursorShape = Math.max(0, Math.min(6, params[0]?.[0] ?? 0))
      return
    }
    if (inter === '!' && final === 'p') return this.softReset()
    if (inter === '$' && final === 'p') return this.reportMode(params[0]?.[0] ?? 0, false)
    if (inter) return

    switch (final) {
      case '@':
        return this.insertChars(n)
      case 'A':
        return this.moveTo(this.x, this.relRow(Math.max(this.y >= this.top ? this.top : 0, this.y - n)))
      case 'B':
        return this.moveTo(this.x, this.relRow(Math.min(this.y <= this.bottom ? this.bottom : this.rows - 1, this.y + n)))
      case 'C':
      case 'a':
        this.wrapPending = false
        this.x = Math.min(this.cols - 1, this.x + n)
        return
      case 'D':
        this.wrapPending = false
        this.x = Math.max(0, this.x - n)
        return
      case 'E':
        this.moveTo(0, this.relRow(Math.min(this.y <= this.bottom ? this.bottom : this.rows - 1, this.y + n)))
        return
      case 'F':
        this.moveTo(0, this.relRow(Math.max(this.y >= this.top ? this.top : 0, this.y - n)))
        return
      case 'G':
      case '`':
        this.wrapPending = false
        this.x = Math.min(this.cols - 1, n - 1)
        return
      case 'H':
      case 'f':
        return this.moveTo(p(1, 1) - 1, p(0, 1) - 1)
      case 'I':
        return this.tab(n)
      case 'J':
        return this.eraseInDisplay(Math.max(0, params[0]?.[0] ?? 0))
      case 'K':
        return this.eraseInLine(Math.max(0, params[0]?.[0] ?? 0))
      case 'L':
        return this.insertLines(n)
      case 'M':
        return this.deleteLines(n)
      case 'P':
        return this.deleteChars(n)
      case 'S':
        return this.scrollUp(n)
      case 'T':
        if (params.length <= 1) this.scrollDown(n)
        return
      case 'X': {
        this.wrapPending = false
        return this.erase(this.screen[this.y], this.x, this.x + n)
      }
      case 'Z':
        return this.backTab(n)
      case 'b':
        if (this.lastChar) for (let i = 0; i < Math.min(n, 65535); i++) this.put(this.lastChar, charWidthOf(this.lastChar))
        return
      case 'c':
        if ((params[0]?.[0] ?? 0) <= 0) this.reply('\x1b[?62;22c')
        return
      case 'd':
        return this.moveTo(this.x, n - 1)
      case 'e':
        return this.moveTo(this.x, this.relRow(Math.min(this.rows - 1, this.y + n)))
      case 'g': {
        const m = params[0]?.[0] ?? 0
        if (m <= 0) this.tabs[this.x] = false
        else if (m === 3) this.tabs.fill(false)
        return
      }
      case 'h':
      case 'l':
        for (const m of params) {
          if (m[0] === 4) this.modes.insert = final === 'h'
          else if (m[0] === 20) this.modes.newline = final === 'h'
        }
        return
      case 'm':
        return this.sgr(params)
      case 'n':
        if (params[0]?.[0] === 5) this.reply('\x1b[0n')
        else if (params[0]?.[0] === 6) this.reply(`\x1b[${this.y + 1 - (this.modes.origin ? this.top : 0)};${this.x + 1}R`)
        return
      case 'r': {
        const top = p(0, 1) - 1
        const bottom = Math.min(this.rows, p(1, this.rows)) - 1
        if (top >= bottom) return
        this.top = top
        this.bottom = bottom
        return this.moveTo(0, 0)
      }
      case 's':
        return this.saveCursor()
      case 'u':
        return this.restoreCursor()
      case 't': {
        const op = params[0]?.[0] ?? 0
        if (op === 8) this.opts.onResizeRequest?.(Math.max(0, params[2]?.[0] ?? 0), Math.max(0, params[1]?.[0] ?? 0))
        else if (op === 18) this.reply(`\x1b[8;${this.rows};${this.cols}t`)
        else if (op === 22) this.titles.push(this.title), this.titles.length > 10 && this.titles.shift()
        else if (op === 23 && this.titles.length) this.setTitle(this.titles.pop()!)
        return
      }
    }
  }

  /** A row for moveTo, which adds the region's top back in origin mode. */
  private relRow(y: number) {
    return this.modes.origin ? y - this.top : y
  }

  private reportMode(mode: number, dec: boolean) {
    const known = dec ? DEC_MODES.has(mode) : ANSI_MODES.has(mode)
    const value = known ? (this.modeValue(mode, dec) ? 1 : 2) : 0
    this.reply(`\x1b[${dec ? '?' : ''}${mode};${value}$y`)
  }

  private modeValue(mode: number, dec: boolean): boolean {
    const m = this.modes
    if (!dec) return mode === 4 ? m.insert : m.newline
    switch (mode) {
      case 1:
        return m.appCursor
      case 5:
        return m.reverse
      case 6:
        return m.origin
      case 7:
        return m.autowrap
      case 25:
        return m.cursorVisible
      case 66:
        return m.appKeypad
      case 9:
      case 1000:
      case 1002:
      case 1003:
        return m.mouse === mode
      case 1004:
        return m.focus
      case 1006:
        return m.mouseSgr
      case 1007:
        return m.altScroll
      case 47:
      case 1047:
      case 1049:
        return this.altActive
      case 2004:
        return m.bracketedPaste
      case 2026:
        return m.sync
    }
    return false
  }

  private decMode(mode: number, on: boolean) {
    const m = this.modes
    switch (mode) {
      case 1:
        m.appCursor = on
        return
      case 5:
        if (m.reverse !== on) for (const line of this.screen) touch(line)
        m.reverse = on
        return
      case 6:
        m.origin = on
        return this.moveTo(0, 0)
      case 7:
        m.autowrap = on
        if (!on) this.wrapPending = false
        return
      case 25:
        m.cursorVisible = on
        return
      case 66:
        m.appKeypad = on
        return
      case 9:
      case 1000:
      case 1002:
      case 1003:
        m.mouse = on ? mode : 0
        return
      case 1004:
        m.focus = on
        return
      case 1006:
        m.mouseSgr = on
        return
      case 1007:
        m.altScroll = on
        return
      case 47:
        return this.setAlt(on, false)
      case 1047:
        if (!on && this.altActive) this.eraseInDisplay(2)
        return this.setAlt(on, false)
      case 1048:
        return on ? this.saveCursor() : this.restoreCursor()
      case 1049:
        if (on) {
          if (this.altActive) return
          this.saveCursor()
          this.setAlt(true, true)
          // The alternate screen starts with the cursor where it was and its own saved one.
          this.saved.alt = this.saved.normal && { ...this.saved.normal }
        } else {
          if (!this.altActive) return
          this.setAlt(false, false)
          this.restoreCursor()
        }
        return
      case 2004:
        m.bracketedPaste = on
        return
      case 2026:
        m.sync = on
        return
    }
  }

  private sgr(params: number[][]) {
    if (!params.length) params = [[0]]
    let { fg, bg, flags } = this.pen
    for (let i = 0; i < params.length; i++) {
      const sub = params[i]
      const code = sub[0] < 0 ? 0 : sub[0]
      if (code === 38 || code === 48 || code === 58) {
        // Extended colour, either 38:5:n / 38:2:[cs:]r:g:b or 38;5;n / 38;2;r;g;b.
        let color: number | null = null
        if (sub.length > 1) {
          if (sub[1] === 5 && sub.length > 2) color = sub[2] & 255
          else if (sub[1] === 2) {
            const rgb = sub.length >= 6 ? sub.slice(3, 6) : sub.slice(2, 5)
            color = RGB + (((rgb[0] & 255) << 16) | ((rgb[1] & 255) << 8) | (rgb[2] & 255))
          }
        } else {
          const kind = params[i + 1]?.[0]
          if (kind === 5) {
            color = (params[i + 2]?.[0] ?? 0) & 255
            i += 2
          } else if (kind === 2) {
            const [r, g, b] = [params[i + 2]?.[0] ?? 0, params[i + 3]?.[0] ?? 0, params[i + 4]?.[0] ?? 0].map((v) => Math.max(0, v) & 255)
            color = RGB + ((r << 16) | (g << 8) | b)
            i += 4
          } else i = params.length // malformed: the rest is unreadable
        }
        if (color !== null && code === 38) fg = color
        else if (color !== null && code === 48) bg = color
        continue
      }
      switch (code) {
        case 0:
          fg = bg = DEFAULT_COLOR
          flags = 0
          break
        case 1:
          flags |= BOLD
          break
        case 2:
          flags |= DIM
          break
        case 3:
          flags |= ITALIC
          break
        case 4:
          // 4:0 turns underline off; 4:1 to 4:5 are its styles (single, double, curly…).
          if (sub.length > 1 && sub[1] === 0) flags &= ~UNDERLINE
          else flags |= UNDERLINE
          break
        case 5:
        case 6:
          flags |= BLINK
          break
        case 7:
          flags |= INVERSE
          break
        case 8:
          flags |= INVISIBLE
          break
        case 9:
          flags |= STRIKE
          break
        case 21:
          flags |= UNDERLINE
          break
        case 22:
          flags &= ~(BOLD | DIM)
          break
        case 23:
          flags &= ~ITALIC
          break
        case 24:
          flags &= ~UNDERLINE
          break
        case 25:
          flags &= ~BLINK
          break
        case 27:
          flags &= ~INVERSE
          break
        case 28:
          flags &= ~INVISIBLE
          break
        case 29:
          flags &= ~STRIKE
          break
        case 39:
          fg = DEFAULT_COLOR
          break
        case 49:
          bg = DEFAULT_COLOR
          break
        case 53:
          flags |= OVERLINE
          break
        case 55:
          flags &= ~OVERLINE
          break
        default:
          if (code >= 30 && code <= 37) fg = code - 30
          else if (code >= 40 && code <= 47) bg = code - 40
          else if (code >= 90 && code <= 97) fg = code - 90 + 8
          else if (code >= 100 && code <= 107) bg = code - 100 + 8
      }
    }
    this.pen = style(fg, bg, flags, this.pen.link)
  }

  // --- size ------------------------------------------------------------------------------------

  /**
   * A new size. Rows are cut or padded, not reflowed. When the screen gets shorter, blank rows
   * under the cursor go first, then rows off the top (into the scrollback), so the cursor's row
   * stays in view, like xterm.
   */
  resize(cols: number, rows: number) {
    cols = Math.max(2, cols | 0)
    rows = Math.max(1, rows | 0)
    if (cols === this.cols && rows === this.rows) return
    const fit = (line: Line) => {
      if (line.ch.length > cols) {
        line.ch.length = cols
        line.st.length = cols
        fixWide(line)
      } else
        while (line.ch.length < cols) {
          line.ch.push(' ')
          line.st.push(PLAIN)
        }
      touch(line)
    }
    this.normal.forEach(fit)
    this.alt.forEach(fit)

    const shrink = (buf: Line[], cursorY: number, history: boolean) => {
      let excess = buf.length - rows
      let shifted = 0
      while (excess > 0 && buf.length - 1 > cursorY && !lineText(buf[buf.length - 1])) {
        buf.pop()
        excess--
      }
      while (excess > 0) {
        const gone = buf.shift()!
        if (history) this.scrollback.push(gone)
        shifted++
        excess--
      }
      while (buf.length < rows) buf.push(blankLine(cols))
      return shifted
    }
    const normalY = this.altActive ? (this.saved.normal?.y ?? 0) : this.y
    const shifted = shrink(this.normal, normalY, true)
    if (this.scrollback.length > this.maxScrollback) this.scrollback.splice(0, this.scrollback.length - this.maxScrollback)
    const altShifted = shrink(this.alt, this.altActive ? this.y : 0, false)
    if (this.altActive) {
      this.y -= altShifted
      if (this.saved.normal) this.saved.normal.y = Math.max(0, this.saved.normal.y - shifted)
    } else this.y -= shifted

    this.cols = cols
    this.rows = rows
    this.top = 0
    this.bottom = rows - 1
    this.x = Math.max(0, Math.min(cols - 1, this.x))
    this.y = Math.max(0, Math.min(rows - 1, this.y))
    this.wrapPending = false
    const tabs = this.tabs
    this.resetTabs()
    for (let i = 0; i < Math.min(tabs.length, cols); i++) this.tabs[i] = tabs[i]
    for (const s of [this.saved.normal, this.saved.alt]) {
      if (!s) continue
      s.x = Math.min(s.x, cols - 1)
      s.y = Math.min(s.y, rows - 1)
    }
    this.version++
  }

  /**
   * What the session leaves behind in the scrollback when it ends: the normal screen's history
   * and its rows down to the last one with something on it (or the cursor's).
   */
  contentLines(): Line[] {
    let last = this.altActive ? -1 : this.y
    for (let y = this.rows - 1; y > last; y--) {
      if (lineText(this.normal[y])) {
        last = y
        break
      }
    }
    return [...this.scrollback, ...this.normal.slice(0, last + 1)]
  }
}

/** The width of what a cell holds (its first character's). */
function charWidthOf(s: string): number {
  const cp = s.codePointAt(0)
  return cp === undefined ? 0 : charWidth(cp)
}

/** After cells moved: a wide character without its second half, or a second half without its character, goes blank. */
function fixWide(line: Line) {
  const n = line.ch.length
  for (let i = 0; i < n; i++) {
    if (line.ch[i] === '') {
      if (i === 0 || charWidthOf(line.ch[i - 1]) !== 2) line.ch[i] = ' '
    } else if (charWidthOf(line.ch[i]) === 2 && (i + 1 >= n || line.ch[i + 1] !== '')) line.ch[i] = ' '
  }
}
