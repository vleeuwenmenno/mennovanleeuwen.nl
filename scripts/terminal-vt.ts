// Checks the terminal's VT emulator (src/terminal/vt/screen.ts) without a browser:
// `node scripts/terminal-vt.ts`.
//
//   - Recorded sessions (src/terminal/vt/fixtures, made by scripts/terminal-vt-record.ts): Neovim,
//     less, top, nano and tmux, replayed byte for byte. At each checkpoint the screen's text,
//     colours and looks, the cursor, the alternate screen, the modes and the scroll region must
//     match what tmux (a real emulator) showed at that moment.
//   - Synthetic sequences for each feature, with the screen they must leave.
//   - The keys, mouse and paste encodings, the terminal's markup (nesting) and ansiToMarkup.
//
// Exits 1 on any failure.

import { readdirSync, readFileSync } from 'node:fs'
import { BOLD, DIM, INVERSE, ITALIC, STRIKE, UNDERLINE, VT, lineText, type Line } from '../src/terminal/vt/screen.ts'
import { RGB } from '../src/terminal/vt/palette.ts'
import { encodeKey, encodeMouse, encodePaste } from '../src/terminal/vt/keys.ts'
import { parseMarkupLines, stripMarkup, type MarkupNode } from '../src/terminal/markup.ts'
import { ansiToMarkup } from '../src/terminal/ansi.ts'

let failures = 0
let passed = 0
const fail = (what: string, detail = '') => {
  failures++
  console.log(`  ✗ ${what}${detail ? `\n${detail}` : ''}`)
}
const check = (ok: boolean, what: string, detail = '') => (ok ? passed++ : fail(what, detail))
const eq = (got: unknown, want: unknown, what: string) => check(JSON.stringify(got) === JSON.stringify(want), what, `      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`)
const show = (s: string) => JSON.stringify(s)

// --- recorded sessions -----------------------------------------------------------------------------

type Check = {
  label: string
  frame: number
  screen: string[]
  ansi: string[]
  cursor: [number, number]
  alt: boolean
  modes: Record<string, boolean | number>
  region: [number, number]
  title: string
}
type Fixture = { name: string; cols: number; rows: number; frames: [number, string][]; checks: Check[] }

/** A cell's look as compared: tmux and we may spell the same thing differently, so it is normalised. */
function look(line: Line, x: number) {
  const st = line.st[x]
  const ch = line.ch[x]
  const flags = st.flags & (BOLD | DIM | ITALIC | UNDERLINE | INVERSE | STRIKE)
  // A blank's foreground and bold/italic/underline cannot be seen, only its background and inverse.
  if (ch === ' ' || ch === '') return `bg=${st.bg} inv=${!!(st.flags & INVERSE)}`
  return `fg=${st.fg} bg=${st.bg} flags=${flags}`
}

const FIXTURES = new URL('../src/terminal/vt/fixtures/', import.meta.url)
const files = readdirSync(FIXTURES).filter((f) => f.endsWith('.json')).sort()
console.log(`Recorded sessions (${files.length})`)
for (const file of files) {
  const fx = JSON.parse(readFileSync(new URL(file, FIXTURES), 'utf8')) as Fixture
  const replies: string[] = []
  const vt = new VT({ cols: fx.cols, rows: fx.rows, onReply: (r) => replies.push(r) })
  let at = 0
  for (const c of fx.checks) {
    while (at < c.frame) vt.write(fx.frames[at++][1])
    const where = `${fx.name} / ${c.label}`
    const text = vt.screenText()
    const diff = text.map((l, y) => (l === c.screen[y] ? null : `      row ${y}: got  ${show(l)}\n              want ${show(c.screen[y])}`)).filter(Boolean)
    check(!diff.length, `${where}: screen text`, diff.slice(0, 6).join('\n'))
    // tmux puts a cursor waiting to wrap one past the last column.
    eq([vt.x + (vt.wrapPending ? 1 : 0), vt.y], c.cursor, `${where}: cursor`)
    eq(vt.altActive, c.alt, `${where}: alternate screen`)
    for (const [k, v] of Object.entries(c.modes)) eq(vt.modes[k as keyof typeof vt.modes], v, `${where}: mode ${k}`)
    eq([vt.top, vt.bottom], c.region, `${where}: scroll region`)
    if (c.title || vt.title) eq(vt.title, c.title, `${where}: title`)
    // Colours and looks: tmux's coloured capture, read into a fresh emulator. tmux only writes
    // what changes from one cell to the next, also from one row to the next.
    const bad: string[] = []
    const ref = new VT({ cols: fx.cols, rows: fx.rows })
    ref.write('\x1b[?7l' + c.ansi.join('\r\n'))
    c.ansi.forEach((_, y) => {
      const mine = vt.screen[y]
      const theirs = ref.screen[y]
      for (let x = 0; x < fx.cols; x++) {
        // One known difference: erasing (EL) while waiting to wrap clears the last column in
        // xterm, which we follow, and nothing in tmux (top's inverse header ends that way).
        if (x === fx.cols - 1 && mine.ch[x] === ' ' && theirs.ch[x] === ' ') continue
        if (look(mine, x) !== look(theirs, x)) {
          bad.push(`      row ${y} col ${x} ${show(mine.ch[x])}: got ${look(mine, x)}, want ${look(theirs, x)}`)
          break
        }
      }
    })
    check(!bad.length, `${where}: colours and looks`, bad.slice(0, 6).join('\n'))
  }
  // The same bytes cut anywhere (in the middle of escape sequences) end the same way.
  while (at < fx.frames.length) vt.write(fx.frames[at++][1])
  const whole = fx.frames.map((f) => f[1]).join('')
  const bytes = new TextEncoder().encode(whole)
  const cut = new VT({ cols: fx.cols, rows: fx.rows })
  for (let i = 0; i < bytes.length; i += 7) cut.write(bytes.slice(i, i + 7))
  eq(cut.screenText(), vt.screenText(), `${fx.name}: the same screen when fed 7 bytes at a time`)
  console.log(`  ${fx.name}: ${fx.checks.length} checkpoints, ${fx.frames.length} chunks replayed${replies.length ? `, ${replies.length} replies` : ''}`)
}

// --- synthetic sequences ---------------------------------------------------------------------------

console.log('Sequences')
/** A fresh terminal fed `input`; `want` is the screen's text, rows joined with |, trailing empty rows dropped. */
function run(input: string, cols = 10, rows = 4) {
  const replies: string[] = []
  let title = ''
  const vt = new VT({ cols, rows, onReply: (r) => replies.push(r), onTitle: (t) => (title = t) })
  vt.write(input)
  const text = vt.screenText()
  while (text.length && !text[text.length - 1]) text.pop()
  return { vt, text: text.join('|'), replies, title: () => title }
}
const screen = (name: string, input: string, want: string, cols = 10, rows = 4) => eq(run(input, cols, rows).text, want, name)
const cursorAt = (name: string, input: string, want: [number, number], cols = 10, rows = 4) => {
  const { vt } = run(input, cols, rows)
  eq([vt.x, vt.y], want, name)
}

screen('plain text and newlines', 'ab\r\ncd', 'ab|cd')
screen('autowrap', 'abcdefghijKL', 'abcdefghij|KL')
cursorAt('pending wrap: the cursor stays on the last column', 'abcdefghij', [9, 0])
screen('pending wrap: CR then text overwrites the same row', 'abcdefghij\rX', 'Xbcdefghij')
screen('pending wrap: a cursor move cancels the wrap', 'abcdefghij\x1b[DX', 'abcdefghXj')
screen('autowrap off: the last column is overwritten', '\x1b[?7labcdefghijKL', 'abcdefghiL')
screen('wrap scrolls at the bottom', '1\r\n2\r\n3\r\n4567890123x', '2|3|4567890123|x')
screen('CUP and text', '\x1b[2;3Hx\x1b[1;1Hy', 'y|  x')
screen('CUU CUD CUF CUB', '\x1b[3;3H\x1b[Aa\x1b[2Bb\x1b[5Cc\x1b[20Dd', '|  a||d  b     c')
screen('CHA and VPA', '\x1b[5Gx\x1b[3dy', '    x||     y')
screen('EL 0, 1, 2', 'abcdef\x1b[1;3H\x1b[K\r\nabcdef\x1b[2;3H\x1b[1K\r\nabcdef\x1b[2K', 'ab|   def')
screen('ED 0 from the middle', 'aaaa\r\nbbbb\r\ncccc\x1b[2;3H\x1b[J', 'aaaa|bb')
screen('ED 1 to the cursor', 'aaaa\r\nbbbb\r\ncccc\x1b[2;3H\x1b[1J', '|   b|cccc')
screen('ED 2 keeps the cursor', 'aaaa\r\nbbbb\x1b[2Jx', '|    x')
screen('ICH inserts blanks', 'abcdef\x1b[1;3H\x1b[2@', 'ab  cdef')
screen('DCH deletes characters', 'abcdef\x1b[1;3H\x1b[2P', 'abef')
screen('ECH erases in place', 'abcdef\x1b[1;2H\x1b[3X', 'a   ef')
screen('IL inserts lines in place', '1\r\n2\r\n3\r\n4\x1b[2;1H\x1b[L', '1||2|3')
screen('DL deletes lines', '1\r\n2\r\n3\r\n4\x1b[2;1H\x1b[2M', '1|4')
screen('scroll region: LF at its bottom scrolls only the region', '1\r\n2\r\n3\r\n4\x1b[2;3r\x1b[3;1H\nX', '1|3|X|4')
screen('scroll region: RI at its top scrolls it down', '1\r\n2\r\n3\r\n4\x1b[2;3r\x1b[2;1H\x1bMY', '1|Y|2|4')
screen('SU and SD', '1\r\n2\r\n3\r\n4\x1b[S', '2|3|4')
screen('SD', '1\r\n2\r\n3\r\n4\x1b[2T', '||1|2')
screen('origin mode counts rows from the region', '\x1b[2;3r\x1b[?6h\x1b[1;1Hx', '|x')
screen('IRM insert mode', 'abc\r\x1b[4hXY', 'XYabc')
screen('tabs', 'a\tb', 'a       b', 12)
screen('CBT goes back a tab stop', 'a\tb\x1b[Zc', 'a       c', 12)
screen('REP repeats the last character', 'x\x1b[3b', 'xxxx')
screen('DEC line drawing', '\x1b(0lqqk\x1b(Bx', '┌──┐x')
screen('DECALN fills the screen with E', '\x1b#8', 'EEE|EEE|EEE', 3, 3)
screen('wide characters take two cells', '日本x', '日本x')
screen('a wide character does not split at the edge', 'abcdefghi日', 'abcdefghi|日')
screen('overwriting half a wide character blanks the other half', '日本\x1b[1;2Hx', ' x本')
screen('combining marks join their character', 'éx', 'éx')
screen('save and restore the cursor (DECSC/DECRC)', 'ab\x1b7\x1b[3;5Hx\x1b8c', 'abc||    x')
screen('save and restore the cursor (CSI s/u)', 'ab\x1b[s\x1b[3;5Hx\x1b[uc', 'abc||    x')
{
  const { vt, text } = run('normal\x1b[?1049halt screen\x1b[?1049lback')
  eq(text, 'normalback', '1049: the normal screen comes back with its cursor')
  eq(vt.altActive, false, '1049: off again')
}
{
  const { vt } = run('normal\x1b[?1049h\x1b[Hon alt')
  eq(vt.screenText()[0], 'on alt', '1049: the alternate screen starts empty')
  eq(lineText(vt.normal[0]), 'normal', '1049: the normal screen is kept')
}
screen('47 switches without clearing, and the cursor stays where it is', 'a\x1b[?47hb\x1b[?47lc', 'a c')
{
  const { vt } = run('x\x1b[31;42;1;3;4;7;9mA\x1b[0mB\x1b[38;5;208;48;2;1;2;3mC\x1b[38:2::10:20:30mD\x1b[91;104mE\x1b[2mF\x1b[22;39;49mG')
  const st = (x: number) => vt.screen[0].st[x]
  eq([st(1).fg, st(1).bg, st(1).flags], [1, 2, BOLD | ITALIC | UNDERLINE | INVERSE | STRIKE], 'SGR: 16 colours and looks')
  eq([st(2).fg, st(2).bg, st(2).flags], [-1, -1, 0], 'SGR 0 resets')
  eq([st(3).fg, st(3).bg], [208, RGB + 0x010203], 'SGR: 256 colours and truecolour background')
  eq(st(4).fg, RGB + 0x0a141e, 'SGR: colon truecolour')
  eq([st(5).fg, st(5).bg], [9, 12], 'SGR: bright colours')
  eq(st(6).flags & DIM, DIM, 'SGR: dim')
  eq([st(7).fg, st(7).bg, st(7).flags], [-1, -1, 0], 'SGR 22/39/49')
}
{
  const { vt } = run('\x1b[44m\x1b[2J')
  eq(vt.screen[2].st[5].bg, 4, 'erase fills with the background colour')
}
{
  const r = run('\x1b]0;first\x07\x1b]2;second title\x1b\\')
  eq(r.title(), 'second title', 'OSC 0 and 2 set the title (BEL and ST)')
  eq(r.vt.title, 'second title', 'the title is kept')
}
{
  const { vt } = run('\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\ no')
  eq([vt.screen[0].st[0].link, vt.screen[0].st[5].link], ['https://example.com', null], 'OSC 8 links')
  const evil = run('\x1b]8;;javascript:alert(1)\x1b\\x').vt
  eq(evil.screen[0].st[0].link, null, 'OSC 8 only takes http(s) links')
}
{
  const { vt } = run('\x1b[?2004h\x1b[?1h\x1b=\x1b[?1002h\x1b[?1006h\x1b[?25l\x1b[?1004h\x1b[5 q')
  eq([vt.modes.bracketedPaste, vt.modes.appCursor, vt.modes.appKeypad, vt.modes.mouse, vt.modes.mouseSgr, vt.modes.cursorVisible, vt.modes.focus, vt.cursorShape], [true, true, true, 1002, true, false, true, 5], 'modes: paste, cursor keys, keypad, mouse, SGR, cursor, focus, shape')
  vt.write('\x1b[?2004l\x1b[?1l\x1b>\x1b[?1002l\x1b[?25h')
  eq([vt.modes.bracketedPaste, vt.modes.appCursor, vt.modes.appKeypad, vt.modes.mouse, vt.modes.cursorVisible], [false, false, false, 0, true], 'modes: off again')
}
{
  const r = run('ab\x1b[6n\x1b[c\x1b[>c\x1b[5n\x1b[18t\x1b[?2004$p\x1b[?9999$p')
  eq(r.replies, ['\x1b[1;3R', '\x1b[?62;22c', '\x1b[>0;10;1c', '\x1b[0n', '\x1b[8;4;10t', '\x1b[?2004;2$y', '\x1b[?9999;0$y'], 'replies: CPR, DA1, DA2, DSR, size, DECRQM')
}
{
  const replies: string[] = []
  const vt = new VT({ cols: 10, rows: 2, onReply: (r) => replies.push(r), colors: () => ({ fg: '#c0caf5', bg: '#1a1b26' }) })
  vt.write('\x1b]11;?\x07')
  eq(replies, ['\x1b]11;rgb:1a1a/1b1b/2626\x1b\\'], 'OSC 11 answers the background colour')
}
{
  const vt = new VT({ cols: 10, rows: 4 })
  const enc = new TextEncoder().encode('é日')
  vt.write(enc.slice(0, 1))
  vt.write(enc.slice(1, 4))
  vt.write(enc.slice(4))
  eq(vt.screenText()[0], 'é日', 'UTF-8 split over writes')
}
{
  const vt = new VT({ cols: 10, rows: 4 })
  vt.write('1\r\n2\r\n3\r\n4\r\n5\r\n6')
  eq(vt.scrollback.map(lineText), ['1', '2'], 'scrollback keeps what scrolls off the top')
  vt.write('\x1b[3J')
  eq(vt.scrollback.length, 0, 'ED 3 clears the scrollback')
  vt.write('\x1b[?1049h\r\n\r\n\r\n\r\n\r\n')
  eq(vt.scrollback.length, 0, 'the alternate screen keeps no scrollback')
}
{
  const vt = new VT({ cols: 10, rows: 4 })
  vt.write('1\r\n2\r\n3\r\n4')
  vt.resize(6, 2)
  eq([vt.screenText(), vt.scrollback.map(lineText), [vt.x, vt.y]], [['3', '4'], ['1', '2'], [1, 1]], 'resize smaller: rows off the top go to the scrollback')
  vt.resize(12, 5)
  eq([vt.screenText().length, vt.screen[0].ch.length, [vt.x, vt.y]], [5, 12, [1, 1]], 'resize bigger: rows and columns are added')
  const short = new VT({ cols: 10, rows: 4 })
  short.write('top')
  short.resize(10, 2)
  eq([short.screenText()[0], short.scrollback.length], ['top', 0], 'resize: blank rows under the cursor go first')
}
{
  const vt = new VT({ cols: 10, rows: 3 })
  vt.write('\x1b[?1049hhello\x1b[2;3r\x1b[?6h\x1b[31m')
  vt.write('\x1bc')
  eq([vt.altActive, vt.modes.origin, vt.top, vt.bottom, vt.pen.fg, vt.screenText().join('')], [false, false, 0, 2, -1, ''], 'RIS resets everything')
}
{
  const vt = new VT({ cols: 10, rows: 3 })
  vt.write('\x1b[?6h\x1b[4h\x1b[?25l\x1b[!p')
  eq([vt.modes.origin, vt.modes.insert, vt.modes.cursorVisible], [false, false, true], 'DECSTR soft reset')
}
screen('C0 controls inside a CSI sequence still act', '\x1b[2\rAx', 'x') // CR mid-sequence, then CSI 2 A
screen('CAN cancels a sequence', 'a\x1b[3\x18b', 'ab')
screen('DCS strings are skipped', 'a\x1bP1$r0m\x1b\\b', 'ab')
screen('unknown OSC is skipped', 'a\x1b]52;c;aGVsbG8=\x07b', 'ab')

// --- keys, mouse and paste -----------------------------------------------------------------------

console.log('Keys, mouse and paste')
const key = (k: string, mods: Partial<{ ctrl: boolean; alt: boolean; shift: boolean }> = {}, modes = { appCursor: false, appKeypad: false }, code?: string) =>
  encodeKey({ key: k, code, ctrlKey: !!mods.ctrl, altKey: !!mods.alt, shiftKey: !!mods.shift, metaKey: false }, modes)
eq(key('a'), 'a', 'a letter')
eq(key('é'), 'é', 'a non-ASCII character')
eq(key('c', { ctrl: true }), '\x03', 'Ctrl+C')
eq(key('C', { ctrl: true, shift: true }), '\x03', 'Ctrl+Shift+C is still ^C')
eq(key(' ', { ctrl: true }), '\x00', 'Ctrl+Space')
eq(key('[', { ctrl: true }), '\x1b', 'Ctrl+[')
eq(key('x', { alt: true }), '\x1bx', 'Alt+x')
eq(key('x', { alt: true, ctrl: true }), '\x1b\x18', 'Ctrl+Alt+x')
eq(key('Enter'), '\r', 'Enter')
eq(key('Backspace'), '\x7f', 'Backspace')
eq(key('Backspace', { ctrl: true }), '\x08', 'Ctrl+Backspace')
eq(key('Tab', { shift: true }), '\x1b[Z', 'Shift+Tab')
eq(key('Escape'), '\x1b', 'Esc')
eq(key('ArrowUp'), '\x1b[A', 'Up')
eq(key('ArrowUp', {}, { appCursor: true, appKeypad: false }), '\x1bOA', 'Up in application cursor mode')
eq(key('ArrowLeft', { ctrl: true }), '\x1b[1;5D', 'Ctrl+Left')
eq(key('ArrowRight', { shift: true, alt: true }), '\x1b[1;4C', 'Shift+Alt+Right')
eq(key('Home'), '\x1b[H', 'Home')
eq(key('End', {}, { appCursor: true, appKeypad: false }), '\x1bOF', 'End in application mode')
eq(key('PageDown'), '\x1b[6~', 'PageDown')
eq(key('Delete', { ctrl: true }), '\x1b[3;5~', 'Ctrl+Delete')
eq(key('F1'), '\x1bOP', 'F1')
eq(key('F5'), '\x1b[15~', 'F5')
eq(key('F12', { shift: true }), '\x1b[24;2~', 'Shift+F12')
eq(key('F3', { ctrl: true }), '\x1b[1;5R', 'Ctrl+F3')
eq(key('5', {}, { appCursor: false, appKeypad: true }, 'Numpad5'), '\x1bOu', 'keypad 5 in application keypad mode')
eq(key('5', {}, { appCursor: false, appKeypad: false }, 'Numpad5'), '5', 'keypad 5 normally')
eq(key('Shift', { shift: true }), null, 'Shift alone sends nothing')
eq(encodeKey({ key: 'c', ctrlKey: false, altKey: false, shiftKey: false, metaKey: true }, { appCursor: false, appKeypad: false }), null, 'Meta combinations stay with the browser')
const m = { shift: false, alt: false, ctrl: false }
eq(encodeMouse('down', 0, 4, 2, m, { mouse: 1000, mouseSgr: true }), '\x1b[<0;5;3M', 'SGR mouse press')
eq(encodeMouse('up', 0, 4, 2, m, { mouse: 1000, mouseSgr: true }), '\x1b[<0;5;3m', 'SGR mouse release')
eq(encodeMouse('wheel', 1, 0, 0, { ...m, ctrl: true }, { mouse: 1000, mouseSgr: true }), '\x1b[<81;1;1M', 'SGR wheel down with Ctrl')
eq(encodeMouse('move', 0, 1, 1, m, { mouse: 1000, mouseSgr: true }), null, 'normal tracking reports no moves')
eq(encodeMouse('move', 0, 1, 1, m, { mouse: 1002, mouseSgr: true }, true), '\x1b[<32;2;2M', 'button tracking reports drags')
eq(encodeMouse('move', 0, 1, 1, m, { mouse: 1003, mouseSgr: true }), '\x1b[<35;2;2M', 'any-event tracking reports moves')
eq(encodeMouse('down', 2, 0, 0, m, { mouse: 1000, mouseSgr: false }), '\x1b[M"!!', 'X11 mouse encoding')
eq(encodeMouse('down', 0, 0, 0, m, { mouse: 0, mouseSgr: true }), null, 'no reports without tracking')
eq(encodePaste('a\nb', true), '\x1b[200~a\rb\x1b[201~', 'bracketed paste')
eq(encodePaste('a\x1b[201~b', true), '\x1b[200~ab\x1b[201~', 'a paste cannot end the bracket early')
eq(encodePaste('a\r\nb', false), 'a\rb', 'plain paste')

// --- markup ------------------------------------------------------------------------------------

console.log('Markup')
/** The tree as compact HTML-ish text, line by line. */
const html = (nodes: MarkupNode[]): string => nodes.map((n) => (typeof n === 'string' ? n : `<${n.kind}:${n.arg}>${html(n.children)}</>`)).join('')
const lines = (text: string) => parseMarkupLines(text).map((l) => html(l.nodes))
eq(lines('plain'), ['plain'], 'plain text')
eq(lines('{c:green}ok{/} done'), ['<c:green>ok</> done'], 'one tag')
eq(lines('{c:bold}{fg:#ff0000}bold red{/} bold{/}'), ['<c:bold><fg:#ff0000>bold red</> bold</>'], 'tags nest (bold in colour)')
eq(lines('{fg:1}{bg:#000000}x{/}{/}'), ['<fg:1><bg:#000000>x</></>'], 'ANSI colour index and background')
eq(lines('{c:green}a\nb{/}c'), ['<c:green>a</>', '<c:green>b</>c'], 'a tag across lines opens again on the next')
eq(lines('{c:nope}x{/}'), ['{c:nope}x{/}'], 'an unknown class shows as text')
eq(lines('{link:javascript:x}y{/}'), ['{link:javascript:x}y{/}'], 'only http(s) links')
eq(lines('{c:red}never closed'), ['{c:red}never closed'], 'an unclosed tag shows as text')
eq(lines('stray {/} close'), ['stray {/} close'], 'a stray close shows as text')
eq(lines('{c:green}a{c:nope}b{/}c{/}'), ['<c:green>a{c:nope}b{/}c</>'], 'an invalid tag inside a valid one')
eq(lines('{anim:sl}{/}'), ['<anim:sl></>'], 'the animation')
{
  const a = parseMarkupLines('{c:red}one\ntwo{/}\nthree')
  const b = parseMarkupLines('{c:red}one\nTWO{/}\nthree')
  eq([a[0].key === b[0].key, a[1].key === b[1].key, a[2].key === b[2].key], [true, false, true], 'line keys only change with the line')
}
eq(stripMarkup('{c:bold}{bg:#112233}x{/}{/} {link:https://a.b}y{/}'), 'x y', 'stripping for pipes')
eq(ansiToMarkup('\x1b[1;31mred bold\x1b[0m plain'), '{fg:1}{c:bold}red bold{/}{/} plain', 'ansiToMarkup: colour and bold nest')
eq(ansiToMarkup('\x1b[42mbg\x1b[49m'), '{bg:2}bg{/}', 'ansiToMarkup keeps backgrounds')
eq(ansiToMarkup('\x1b[38;5;208;48;2;1;2;3mx'), '{fg:#ff8700}{bg:#010203}x{/}{/}', 'ansiToMarkup: 256 and truecolour')
eq(ansiToMarkup('\x1b[7mrev\x1b[27m'), '{c:inverse}rev{/}', 'ansiToMarkup: inverse')
eq(ansiToMarkup('\x1b[31;7mx'), '{fg:0}{bg:1}x{/}{/}', 'ansiToMarkup: inverse swaps the colours')
eq(ansiToMarkup('{c:red}not markup'), '{​c:red}not markup', 'ansiToMarkup neutralises markup in the text')

console.log(failures ? `\n${failures} failed, ${passed} passed` : `\nAll ${passed} checks passed`)
process.exit(failures ? 1 : 0)
