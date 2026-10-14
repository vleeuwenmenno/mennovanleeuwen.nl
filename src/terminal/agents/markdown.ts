import { furiganaMode } from '../../data/furigana'
import { seg, width, wrap, type Line, type Seg } from './text'

// Markdown as terminal lines, the way a CLI agent prints a reply: headings in bold, `code` in
// colour, fenced blocks indented, lists with their marks, quotes with a bar, tables drawn with box
// lines (or left as they are when too wide), links clickable.

// Furigana, {漢字|かんじ}: drawn as 漢字(かんじ), or as 漢字 alone when Settings → Language & region says Off.
// Same shape as the one in src/data/markdown/parse.ts.
const RUBY = /(?<![${])\{([^{}|\n\\`]{1,60})\|([^{}|\n\\`]{1,120})\}(?!\})/g
const furigana = (t: string) =>
  t.replace(RUBY, (all, base: string, reading: string) => (!base.trim() || !reading.trim() ? all : furiganaMode() === 'off' ? base.trim() : `${base.trim()}(${reading.trim()})`))

/** Inline Markdown: **bold**, *em*, `code`, [text](url), bare URLs, furigana. */
export function inline(text: string, base?: string): Seg[] {
  const out: Seg[] = []
  const re = /(`+)([\s\S]+?)\1|\*\*([^*]+)\*\*|__([^_]+)__|(?<![\w*])\*([^*\s][^*]*?)\*(?!\w)|(?<![\w_])_([^_\s][^_]*?)_(?!\w)|~~([^~]+)~~|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g
  let last = 0
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push(seg(furigana(text.slice(last, m.index)), base))
    if (m[2] !== undefined) out.push(seg(m[2], 'cyan'))
    else if (m[3] !== undefined || m[4] !== undefined) out.push(seg(furigana(m[3] ?? m[4]), 'bold'))
    else if (m[5] !== undefined || m[6] !== undefined) out.push(seg(furigana(m[5] ?? m[6]), base ?? 'yellow'))
    else if (m[7] !== undefined) out.push(seg(furigana(m[7]), 'muted'))
    else if (m[8] !== undefined) out.push({ t: furigana(m[8]), link: m[9] })
    else if (m[10] !== undefined) out.push({ t: m[10], link: m[10] })
    last = m.index! + m[0].length
  }
  if (last < text.length) out.push(seg(furigana(text.slice(last)), base))
  return out
}

const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/
// A pipe inside furigana ({a|b}) does not split a cell.
function cells(row: string): string[] {
  const t = row.trim().replace(/^\|/, '').replace(/\|$/, '')
  const out: string[] = []
  let cur = ''
  for (let i = 0; i < t.length; i++) {
    const ruby = t[i] === '{' && t[i - 1] !== '\\' ? /^\{[^{}|\n\\`]{1,60}\|[^{}|\n\\`]{1,120}\}/.exec(t.slice(i, i + 200)) : null
    if (ruby) {
      cur += ruby[0]
      i += ruby[0].length - 1
    } else if (t[i] === '|' && t[i - 1] !== '\\') {
      out.push(cur.trim())
      cur = ''
    } else cur += t[i]
  }
  return [...out, cur.trim()]
}

function table(rows: string[], max: number): Line[] | null {
  const head = cells(rows[0])
  const body = rows.slice(2).map(cells)
  const n = head.length
  const widths = Array.from({ length: n }, (_, i) => Math.max(width(inline(head[i] ?? '')), ...body.map((r) => width(inline(r[i] ?? '')))))
  const total = widths.reduce((a, b) => a + b + 3, 1)
  if (total > max) return null
  const rule = (l: string, m: string, r: string): Line => [seg(l + widths.map((w) => '─'.repeat(w + 2)).join(m) + r, 'muted')]
  const row = (r: string[], bold: boolean): Line => {
    const line: Line = [seg('│', 'muted')]
    for (let i = 0; i < n; i++) {
      const content = inline(r[i] ?? '', bold ? 'bold' : undefined)
      line.push(seg(' '), ...content, seg(' '.repeat(widths[i] - width(content) + 1)), seg('│', 'muted'))
    }
    return line
  }
  return [rule('┌', '┬', '┐'), row(head, true), rule('├', '┼', '┤'), ...body.map((r) => row(r, false)), rule('└', '┴', '┘')]
}

/** A Markdown text as lines no wider than `max`. */
export function markdown(text: string, max: number): Line[] {
  const src = text.replace(/\r\n/g, '\n').split('\n')
  const out: Line[] = []
  let para: string[] = []
  const flush = () => {
    if (para.length) out.push(...wrap(inline(para.join(' ')), max))
    para = []
  }
  for (let i = 0; i < src.length; i++) {
    const l = src[i]
    const fence = /^(\s*)(```+|~~~+)\s*([\w+-]*)/.exec(l)
    if (fence) {
      flush()
      const close = fence[2]
      const code: string[] = []
      while (i + 1 < src.length && !src[i + 1].trimStart().startsWith(close)) code.push(src[++i])
      i++
      if (fence[3]) out.push([seg(`  ${fence[3]}`, 'muted')])
      for (const c of code) out.push(...wrap([seg(c.replace(/\t/g, '  '), 'green')], max, [seg('  ')]))
      continue
    }
    if (!l.trim()) {
      flush()
      if (out.length && out[out.length - 1].length) out.push([])
      continue
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(l)
    if (h) {
      flush()
      out.push(...wrap(inline(h[2].replace(/\s+#+\s*$/, ''), h[1].length <= 2 ? 'bold' : 'bold'), max))
      continue
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) {
      flush()
      out.push([seg('─'.repeat(Math.min(max, 40)), 'muted')])
      continue
    }
    if (l.includes('|') && i + 1 < src.length && TABLE_SEP.test(src[i + 1])) {
      flush()
      const rows = [l, src[i + 1]]
      while (i + 2 < src.length && src[i + 2].includes('|') && src[i + 2].trim()) rows.push(src[++i + 1])
      i++
      out.push(...(table(rows, max) ?? rows.flatMap((r) => wrap([seg(r)], max))))
      continue
    }
    const quote = /^\s*>\s?(.*)$/.exec(l)
    if (quote) {
      flush()
      out.push(...wrap(inline(quote[1], 'muted'), max, [seg('│ ', 'muted')]))
      continue
    }
    const item = /^(\s*)([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?(.*)$/.exec(l)
    if (item) {
      flush()
      const indent = ' '.repeat(Math.min(8, item[1].replace(/\t/g, '  ').length))
      const box = item[3] ? (/[xX]/.test(item[3]) ? '☒ ' : '☐ ') : ''
      const mark = /\d/.test(item[2]) ? `${item[2]} ` : '• '
      out.push(...wrap(inline(item[4]), max, [seg(indent + (box || mark), box ? undefined : 'muted')], [seg(indent + ' '.repeat((box || mark).length))]))
      continue
    }
    para.push(l.trim())
  }
  flush()
  while (out.length && !out[out.length - 1].length) out.pop()
  return out
}
