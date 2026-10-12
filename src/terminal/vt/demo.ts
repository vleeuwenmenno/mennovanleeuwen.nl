// `vtdemo`, a hidden command: byte sources for the stream API (session.ts) to try it without SSH.
//
//   vtdemo                 the recordings and what else there is
//   vtdemo play <name>     replays a recorded session (Neovim, less, top, nano, tmux) at its own
//                          pace, pausing at each checkpoint the check script compares with tmux
//   vtdemo colors          the 16, 256 and truecolour palettes, backgrounds and text looks
//   vtdemo keys            echoes what each key, paste, focus change and mouse click sends
//
// The recordings are src/terminal/vt/fixtures (scripts/terminal-vt-record.ts makes them); each is
// its own chunk, fetched when played.

import { CmdError, type Ctx } from '../types'
import type { TermPort } from './session'

type Fixture = { name: string; title: string; command: string; cols: number; rows: number; frames: [number, string][]; checks: { label: string; frame: number }[] }

const recordings = import.meta.glob<Fixture>('./fixtures/*.json', { import: 'default' })
const names = () =>
  Object.keys(recordings)
    .map((p) => p.replace(/^.*\/|\.json$/g, ''))
    .sort()

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    const t = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true })
  })

/** The next key (or paste) from the stream; Ctrl+C and q count as quitting. */
function nextKey(port: TermPort, signal: AbortSignal): Promise<string | null> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(null)
    const stop = port.onData((d) => {
      stop()
      resolve(d)
    })
    signal.addEventListener('abort', () => (stop(), resolve(null)), { once: true })
  })
}

const title = (port: TermPort, text: string) => port.write(`\x1b]2;${text}\x07`)

async function play(ctx: Ctx, port: TermPort, name: string, speed: number) {
  const load = recordings[`./fixtures/${name}.json`]
  if (!load) throw new CmdError(`vtdemo: no recording called ${name} (there are ${names().join(', ')})`)
  const fx = await load()
  const done = new AbortController()
  const stopOn = (d: string) => (d === 'q' || d === '\x03' ? done.abort() : undefined)
  port.detached.then(() => done.abort())
  ctx.signal.addEventListener('abort', () => done.abort(), { once: true })
  // The recording is 80×24: the screen takes that size while it plays, as xterm does when asked.
  port.write(`\x1b[8;${fx.rows};${fx.cols}t`)
  title(port, `vtdemo: ${fx.title}`)
  let stopKeys = port.onData(stopOn)
  let at = 0
  for (let n = 0; n < fx.checks.length && !done.signal.aborted; n++) {
    const check = fx.checks[n]
    while (at < check.frame && !done.signal.aborted) {
      const [delay, text] = fx.frames[at++]
      if (delay > 0) await sleep(Math.min(700, delay) / speed, done.signal)
      port.write(text)
    }
    if (done.signal.aborted) break
    title(port, `vtdemo ${fx.name} ${n + 1}/${fx.checks.length}: ${check.label} · space goes on, q quits`)
    stopKeys()
    const key = await nextKey(port, done.signal)
    if (key === null || key === 'q' || key === '\x03') break
    stopKeys = port.onData(stopOn)
  }
  if (!done.signal.aborted && at >= fx.frames.length) {
    title(port, `vtdemo ${fx.name}: done · any key goes back to msh`)
    await nextKey(port, done.signal)
  }
}

/** A chart of every colour and look, drawn with the same escapes a program would send. */
function colors(cols: number): string {
  const e = '\x1b['
  const out: string[] = [`${e}1mvtdemo colors${e}0m  ${e}2m(q quits)${e}0m`, '']
  const swatch = (code: string, label: string) => `${e}${code}m ${label.padStart(3)} ${e}0m`
  out.push('16 colours, foreground and background:')
  out.push(Array.from({ length: 8 }, (_, i) => `${e}${30 + i}m${String(i).padStart(3)} ${e}0m`).join('') + ' ' + Array.from({ length: 8 }, (_, i) => `${e}${90 + i}m${String(i + 8).padStart(3)} ${e}0m`).join(''))
  out.push(Array.from({ length: 8 }, (_, i) => swatch(String(40 + i), String(i))).join('') + Array.from({ length: 8 }, (_, i) => swatch(String(100 + i), String(i + 8))).join(''))
  out.push('', '256 colours:')
  const per = Math.max(6, Math.min(36, Math.floor((cols - 2) / 4)))
  for (let start = 16; start < 232; start += per) out.push(Array.from({ length: Math.min(per, 232 - start) }, (_, i) => `${e}48;5;${start + i}m${String(start + i).padStart(4)}${e}0m`).join(''))
  out.push(Array.from({ length: 24 }, (_, i) => `${e}48;5;${232 + i}m  ${e}0m`).join(''))
  out.push('', 'Truecolour:')
  const width = Math.min(cols - 2, 72)
  out.push(
    Array.from({ length: width }, (_, i) => {
      const h = (i / width) * 6
      const f = (n: number) => Math.round(255 * Math.max(0, Math.min(1, Math.abs(((h + n) % 6) - 3) - 1)))
      return `${e}48;2;${f(0)};${f(4)};${f(2)}m ${e}0m`
    }).join(''),
  )
  out.push('', 'Looks:')
  out.push(`${e}1mbold${e}0m ${e}2mdim${e}0m ${e}3mitalic${e}0m ${e}4munderline${e}0m ${e}7minverse${e}0m ${e}9mstrike${e}0m ${e}53moverline${e}0m ${e}1;3;4;38;5;208mall at once${e}0m`)
  out.push(`${e}1;31mbold red${e}0m on ${e}30;43m black on yellow ${e}0m and ${e}38;2;255;105;180;48;2;30;30;60m truecolour pink on navy ${e}0m`)
  out.push(`Wide: 日本語 中文 한국어 ✅ 🚀  Lines: \x1b(0lqqqwqqqk\x1b(B`)
  out.push(`${'\x1b]8;;https://mennovanleeuwen.nl\x1b\\'}A link (OSC 8)${'\x1b]8;;\x1b\\'}`)
  return out.join('\r\n')
}

/** Escapes made readable: ESC as ^[, other controls as ^X. */
const readable = (s: string) =>
  [...s]
    .map((ch) => {
      const c = ch.charCodeAt(0)
      if (c === 0x1b) return '^['
      if (c < 0x20) return '^' + String.fromCharCode(c + 64)
      if (c === 0x7f) return '^?'
      return ch
    })
    .join('')

async function keys(ctx: Ctx, port: TermPort) {
  // Mouse (button tracking, SGR), bracketed paste and focus reports on, like Neovim turns them on.
  port.write('\x1b[?1002h\x1b[?1006h\x1b[?2004h\x1b[?1004h')
  port.write('\x1b[1mvtdemo keys\x1b[0m: what each key, paste, click and focus change sends. \x1b[2mCtrl+D quits.\x1b[0m\r\n\r\n')
  title(port, 'vtdemo keys · Ctrl+D quits')
  const done = new AbortController()
  ctx.signal.addEventListener('abort', () => done.abort(), { once: true })
  port.detached.then(() => done.abort())
  const stop = port.onData((d) => {
    if (d === '\x04') return done.abort()
    port.write(`\x1b[36m${readable(d).replace(/\r/g, '^M')}\x1b[0m  \x1b[2m${[...new TextEncoder().encode(d)].map((b) => b.toString(16).padStart(2, '0')).join(' ')}\x1b[0m\r\n`)
  })
  await new Promise<void>((resolve) => done.signal.addEventListener('abort', () => resolve(), { once: true }))
  stop()
}

async function vtdemo(ctx: Ctx): Promise<string | void> {
  const [sub, name] = ctx.args
  if (!sub) {
    return [
      'vtdemo: try the terminal emulator without SSH.',
      '',
      `  vtdemo play <name>   replay a recorded session: ${names().join(', ')}`,
      '  vtdemo colors        colours and text looks',
      '  vtdemo keys          what each key, paste and click sends',
    ].join('\n')
  }
  if (!ctx.attachStream || !ctx.tty) throw new CmdError('vtdemo: needs a terminal window (not a pipe)')
  if (sub === 'play' && !name) throw new CmdError(`vtdemo: play which? ${names().join(', ')}`)
  if (!['play', 'colors', 'keys'].includes(sub)) throw new CmdError(`vtdemo: ${sub}: unknown (play, colors or keys)`)
  const speed = Math.max(0.1, Math.min(10, parseFloat(ctx.args[ctx.args.indexOf('-s') + 1] ?? '') || 1))
  const port = ctx.attachStream()
  try {
    if (sub === 'play') await play(ctx, port, name, ctx.args.includes('-s') ? speed : 1)
    else if (sub === 'keys') await keys(ctx, port)
    else {
      port.write(colors(port.size.cols))
      port.write('\x1b[?25l')
      title(port, 'vtdemo colors · q quits')
      const done = new AbortController()
      ctx.signal.addEventListener('abort', () => done.abort(), { once: true })
      while (!done.signal.aborted) {
        const k = await nextKey(port, done.signal)
        if (k === null || k === 'q' || k === '\x03') break
      }
      port.write('\x1b[?25h\r\n')
    }
  } finally {
    port.detach()
  }
}

export const vtCommands = {
  vtdemo: { desc: 'try the VT emulator: replays, colours, keys', usage: 'vtdemo [play <name> [-s speed] | colors | keys]', hidden: true, run: vtdemo },
}
