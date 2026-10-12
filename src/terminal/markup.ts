// The output markup commands print, read into a tree for the renderer (Markup in Terminal.tsx):
//
//   {c:green}text{/}         a class: a colour (green, red, yellow, blue, cyan, magenta, muted,
//                            accent, heat1–4) or a look (bold, dim, italic, underline, strike, inverse)
//   {fg:#rrggbb}text{/}      a foreground colour; {fg:0} to {fg:15} are the theme's ANSI colours
//   {bg:#rrggbb}text{/}      the same for the background
//   {link:https://…}text{/}  a link
//   {anim:sl}{/}             an animation (only `sl` today)
//
// Tags nest ({c:bold}{fg:#ff0000}bold red{/}{/}). Output can hold text from the network (curl),
// so every argument is checked; a tag that is not valid, or never closed, shows as the text it
// is, and so does a {/} that closes nothing. The result comes in lines, each with a key that
// only changes when that line does, so a block that is redrawn (htop, agents) only re-renders
// the lines that changed.

export type MarkupKind = 'c' | 'fg' | 'bg' | 'link' | 'anim'
export type MarkupNode = string | { kind: MarkupKind; arg: string; children: MarkupNode[] }
export type MarkupLine = { key: string; nodes: MarkupNode[] }

export const MARKUP_CLASSES = new Set([
  'green', 'red', 'yellow', 'blue', 'cyan', 'magenta', 'muted', 'accent', 'bold', 'dim', 'italic', 'underline', 'strike', 'inverse', 'heat1', 'heat2', 'heat3', 'heat4',
])

const COLOR_ARG = /^(#[0-9a-f]{6}|1[0-5]|[0-9])$/i

export function validTag(kind: MarkupKind, arg: string): boolean {
  switch (kind) {
    case 'c':
      return MARKUP_CLASSES.has(arg)
    case 'fg':
    case 'bg':
      return COLOR_ARG.test(arg)
    case 'link':
      return /^https?:\/\//.test(arg)
    case 'anim':
      return arg === 'sl'
  }
}

/** A colour argument as CSS: an ANSI index is the theme's variable. */
export const markupColor = (arg: string) => (arg.startsWith('#') ? arg : `var(--ansi-${arg})`)

const TOKEN = /\{(c|link|anim|fg|bg):([^}]*)\}|\{\/\}/g

type Token = { at: number; end: number; raw: string; kind?: MarkupKind; arg?: string; match: number }

export function parseMarkupLines(text: string): MarkupLine[] {
  // Which tags pair up: an opening tag with the {/} that closes it (-1: none).
  const tokens: Token[] = []
  const open: number[] = []
  for (const m of text.matchAll(TOKEN)) {
    const t: Token = { at: m.index!, end: m.index! + m[0].length, raw: m[0], kind: m[1] as MarkupKind | undefined, arg: m[2], match: -1 }
    tokens.push(t)
    if (t.kind) open.push(tokens.length - 1)
    else if (open.length) {
      const o = open.pop()!
      tokens[o].match = tokens.length - 1
      t.match = o
    }
  }

  type Frame = { kind: MarkupKind; arg: string; valid: boolean; raw: string }
  const lines: MarkupLine[] = []
  const stack: Frame[] = []
  let containers: MarkupNode[][] = []
  let lineFrom = 0
  let sig = ''

  const startLine = () => {
    const root: MarkupNode[] = []
    containers = [root]
    for (const f of stack) {
      if (!f.valid) {
        containers.push(containers[containers.length - 1])
        continue
      }
      const node = { kind: f.kind, arg: f.arg, children: [] as MarkupNode[] }
      containers[containers.length - 1].push(node)
      containers.push(node.children)
    }
    sig = stack.map((f) => (f.valid ? f.raw : '\0')).join('')
  }
  const endLine = (to: number) => {
    lines.push({ key: sig + '\u0001' + text.slice(lineFrom, to), nodes: containers[0] })
    lineFrom = to + 1
  }
  const emit = (s: string) => {
    if (s) containers[containers.length - 1].push(s)
  }
  const emitText = (from: number, to: number) => {
    let at = from
    while (at < to) {
      const nl = text.indexOf('\n', at)
      if (nl < 0 || nl >= to) {
        emit(text.slice(at, to))
        return
      }
      emit(text.slice(at, nl))
      endLine(nl)
      startLine()
      at = nl + 1
    }
  }

  startLine()
  let pos = 0
  for (const t of tokens) {
    emitText(pos, t.at)
    pos = t.end
    if (t.match < 0) emit(t.raw)
    else if (t.kind) {
      const valid = validTag(t.kind, t.arg!)
      stack.push({ kind: t.kind, arg: t.arg!, valid, raw: t.raw })
      if (valid) {
        const node = { kind: t.kind, arg: t.arg!, children: [] as MarkupNode[] }
        containers[containers.length - 1].push(node)
        containers.push(node.children)
      } else {
        emit(t.raw)
        containers.push(containers[containers.length - 1])
      }
    } else {
      const f = stack.pop()!
      containers.pop()
      if (!f.valid) emit(t.raw)
    }
  }
  emitText(pos, text.length)
  endLine(text.length)
  return lines
}

/** The markup's text alone, as a pipe or a redirect gets it. */
export const stripMarkup = (s: string) => s.replace(/\{anim:[^}]*\}\{\/\}/g, '').replace(/\{(?:c|link|fg|bg):[^}]*\}|\{\/\}/g, '')
