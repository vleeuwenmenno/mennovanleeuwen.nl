// Markdown to a small syntax tree, close to CommonMark with GitHub's additions (tables, task lists,
// strikethrough, bare URLs). MarkdownPreview (MarkdownPreview.tsx) turns the tree into React
// elements; this file has no React and no DOM, so `node scripts/markdown-check.ts` can test it.
//
// Blocks follow CommonMark's own two-phase algorithm: each line first walks the open containers
// (quotes, lists, items) to see which ones it continues, then may open new ones, and what is left
// lands in a leaf (a paragraph, heading, code block or table). Inlines are parsed afterwards, once
// every link reference definition is known, with CommonMark's delimiter-run algorithm, which is
// what lets emphasis nest in any combination ("**bold with *italic* inside**").
//
// Markdown here mostly comes from a model, streamed in token by token and parsed again on every
// chunk, so both passes stay linear-ish and an unfinished document still makes sense: an open
// fence is a code block to the end, and an unclosed ** stays literal until its closer arrives.

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'em' | 'strong' | 'del'; children: Inline[] }
  | { type: 'link'; href: string; title?: string; children: Inline[] }
  | { type: 'image'; src: string; alt: string; title?: string }
  /** Furigana, written {漢字|かんじ}: the base text with its reading above it (a <ruby>). */
  | { type: 'ruby'; base: string; reading: string }
  /** A hard line break: two trailing spaces or a backslash at the end of a line. */
  | { type: 'br' }
  /** A plain line break inside a paragraph, which reads as a space unless `breaks` is on. */
  | { type: 'soft' }

export type Align = 'left' | 'center' | 'right' | null

export type Block =
  | { type: 'paragraph'; children: Inline[] }
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; children: Inline[] }
  | { type: 'hr' }
  /** `open`: a fence that was never closed (an answer still streaming in, a note being written) */
  | { type: 'code'; lang: string; text: string; open?: boolean }
  | { type: 'quote'; children: Block[] }
  | { type: 'list'; ordered: boolean; start: number; tight: boolean; items: ListItem[] }
  | { type: 'table'; align: Align[]; head: Inline[][]; rows: Inline[][][] }

/** `checked` is null for an ordinary item, true or false for a task ("- [x]", "- [ ]"). */
export type ListItem = { checked: boolean | null; children: Block[] }

// --- Links ---------------------------------------------------------------------------------------

/**
 * Whether a link may point somewhere: the web, mail, or a relative path. Markdown here comes
 * from a model, so javascript:, data: and every other scheme stay plain text.
 */
export function safeHref(href: string) {
  const h = href.trim()
  return /^(https?:|mailto:)/i.test(h) || !/^[a-z][a-z0-9+.-]*:/i.test(h)
}

/** Pictures load from https or a data: image only; anything else is shown as a link instead. */
export function safeImage(src: string) {
  return /^https:\/\//i.test(src.trim()) || /^data:image\/(png|jpe?g|gif|webp|avif|svg\+xml)[;,]/i.test(src.trim())
}

// --- Blocks --------------------------------------------------------------------------------------

type Kind = 'document' | 'quote' | 'list' | 'item' | 'paragraph' | 'heading' | 'hr' | 'code' | 'table'

/** A block while the document is being read; `toBlocks` turns the finished tree into `Block`s. */
type Node = {
  kind: Kind
  parent: Node | null
  children: Node[]
  open: boolean
  lastLineBlank: boolean
  /** Paragraph and code lines, a heading's text (one line), table rows as raw lines. */
  lines: string[]
  // Lists and items
  ordered?: boolean
  start?: number
  /** The bullet character or the ordered delimiter (. or )); a different one starts a new list. */
  marker?: string
  tight?: boolean
  /** Items: the column the marker is at, and the column the content starts at. */
  markerCol?: number
  contentCol?: number
  // Code blocks
  fence?: string
  fenceIndent?: number
  /** Still open when the text ended: no closing fence came */
  unclosed?: boolean
  lang?: string
  // Headings
  level?: number
  // Tables
  align?: Align[]
  head?: string
}

const node = (kind: Kind, parent: Node | null): Node => ({ kind, parent, children: [], open: true, lastLineBlank: false, lines: [] })

/**
 * What is left of a line once the containers took their markers: the text and the column it
 * starts at, which tabs need (a tab runs to the next multiple of 4).
 */
type Rest = { s: string; col: number }

/** How many columns of spaces and tabs `r` starts with. */
function indentOf(r: Rest) {
  let col = r.col
  for (const ch of r.s) {
    if (ch === ' ') col++
    else if (ch === '\t') col += 4 - (col % 4)
    else break
  }
  return col - r.col
}

/** Removes up to `n` columns of leading whitespace; a tab that is only partly used becomes spaces. */
function strip(r: Rest, n: number): Rest {
  let { s, col } = r
  while (n > 0 && s.length) {
    if (s[0] === ' ') {
      s = s.slice(1)
      col++
      n--
    } else if (s[0] === '\t') {
      const w = 4 - (col % 4)
      if (w <= n) {
        s = s.slice(1)
        col += w
        n -= w
      } else {
        s = ' '.repeat(w - n) + s.slice(1)
        col += n
        n = 0
      }
    } else break
  }
  return { s, col }
}

/** Drops the leading whitespace altogether. */
const trimStart = (r: Rest) => strip(r, indentOf(r))
/** Moves past `n` characters that are not whitespace (a marker). */
const advance = (r: Rest, n: number): Rest => ({ s: r.s.slice(n), col: r.col + n })
const isBlank = (s: string) => !/[^ \t]/.test(s)

const ATX = /^#{1,6}(?=[ \t]|$)/
const FENCE = /^(`{3,}|~{3,})/
const HR = /^(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/
const BULLET = /^[-*+](?=[ \t]|$)/
const ORDERED = /^(\d{1,9})([.)])(?=[ \t]|$)/
// Setext underlines: "===" makes the paragraph above an h1, "---" an h2. A single "-" is left out
// on purpose: while a list streams in after a paragraph, its first "-" would flash the paragraph
// into a heading for a chunk.
const SETEXT = /^(?:=+|-{2,})[ \t]*$/
// Tables, GitHub style: a header row, a delimiter row (dashes, colons for alignment), then rows.
// Pipes at the ends are optional; a pipe inside a cell is written \|.
const TABLE_SEP = /^\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/
const hasPipe = (s: string) => /(^|[^\\])\|/.test(s)

// Furigana: {base|reading}, both non-empty, with no braces, pipes, backslashes, backticks or line
// breaks inside. Braces around it ("{{a|b}}") or a "$" before it ("${a|b}") are template or shell
// syntax, not ruby.
const RUBY = /^\{([^{}|\n\\`]{1,60})\|([^{}|\n\\`]{1,120})\}/

/** The furigana starting at `pos` in `s`, as the match of RUBY, or null. */
function rubyAt(s: string, pos: number): RegExpExecArray | null {
  if (s[pos] !== '{' || s[pos - 1] === '$' || s[pos - 1] === '{') return null
  const m = RUBY.exec(s.slice(pos, pos + 200))
  return m && m[1].trim() && m[2].trim() && s[pos + m[0].length] !== '}' ? m : null
}

// Furigana written as HTML, which models reach for when they do not know {…|…}:
// <ruby>漢字<rt>かんじ</rt></ruby>, optionally with <rp>(</rp>…<rp>)</rp> around the reading or <rb>
// around the base, and several base/reading pairs in one ruby (<ruby>漢<rt>かん</rt>字<rt>じ</rt></ruby>).
// Tags take no attributes and any case. Only the text comes through, as ruby nodes, never the
// HTML itself; anything malformed stays plain text. Same limits and characters as RUBY.
const HTML_RUBY = /^<ruby>([^\n]{1,600}?)<\/ruby>/i
const HTML_RUBY_PAIR = /^[ \t]*(?:<rb>([^<>\n]*)<\/rb>|([^<>\n]*))[ \t]*(?:<rp>[^<>\n]{0,4}<\/rp>)?<rt>([^<>\n]*)<\/rt>(?:<rp>[^<>\n]{0,4}<\/rp>)?[ \t]*/i
const RUBY_TEXT = /^[^{}|\n\\`<>]+$/

export type RubyPair = { base: string; reading: string }

/** The HTML ruby starting at `pos` in `s`: how long it is and its base/reading pairs, or null. */
export function htmlRubyAt(s: string, pos: number): { length: number; pairs: RubyPair[] } | null {
  if (s[pos] !== '<' || (s[pos + 1] !== 'r' && s[pos + 1] !== 'R')) return null
  const m = HTML_RUBY.exec(s.slice(pos, pos + 640))
  if (!m) return null
  const pairs: RubyPair[] = []
  let body = m[1]
  while (body.trim()) {
    const p = HTML_RUBY_PAIR.exec(body)
    if (!p || !p[0]) return null
    const base = decodeEntities(p[1] ?? p[2]).trim()
    const reading = decodeEntities(p[3]).trim()
    if (!base || !reading || base.length > 60 || reading.length > 120 || !RUBY_TEXT.test(base) || !RUBY_TEXT.test(reading)) return null
    pairs.push({ base, reading })
    body = body.slice(p[0].length)
  }
  return pairs.length ? { length: m[0].length, pairs } : null
}

/** Entities (&amp;, &#x6F22;) in the text of an HTML ruby. */
function decodeEntities(s: string) {
  return s.replace(/&(?:#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (all) => entity(all) ?? all)
}

function tableCells(line: string): string[] {
  let t = line.trim()
  if (t.startsWith('|')) t = t.slice(1)
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1)
  // Cells split at every pipe that is not written \|, except the one inside furigana ({a|b}).
  const cells: string[] = []
  let cur = ''
  for (let i = 0; i < t.length; i++) {
    const ruby = t[i] === '{' && t[i - 1] !== '\\' ? rubyAt(t, i) : null
    if (ruby) {
      cur += ruby[0]
      i += ruby[0].length - 1
    } else if (t[i] === '|' && t[i - 1] !== '\\') {
      cells.push(cur)
      cur = ''
    } else cur += t[i]
  }
  cells.push(cur)
  // \| is a pipe inside a cell, code spans included (as GitHub does), so it is unescaped here.
  return cells.map((c) => c.trim().replace(/\\\|/g, '|'))
}

class BlockParser {
  doc = node('document', null)
  tip: Node = this.doc
  /** The deepest block that was open before the current line, for lazy paragraph continuation. */
  oldTip: Node = this.doc
  /** The deepest open block the current line continued, and whether that was every open block. */
  lastMatched: Node = this.doc
  allClosed = true
  refs = new Map<string, { href: string; title?: string }>()

  add(kind: Kind): Node {
    while (!canContain(this.tip.kind, kind)) this.finalize(this.tip)
    const n = node(kind, this.tip)
    this.tip.children.push(n)
    this.tip = n
    return n
  }

  finalize(n: Node) {
    n.open = false
    this.tip = n.parent ?? this.doc
    if (n.kind === 'paragraph') this.takeRefs(n)
    else if (n.kind === 'code' && !n.fence) {
      // An indented code block ends at its last line of code, not the blank lines after it.
      while (n.lines.length && isBlank(n.lines[n.lines.length - 1])) n.lines.pop()
    } else if (n.kind === 'list') n.tight = isTight(n)
  }

  /** Link reference definitions ("[label]: url "title"") at the start of a paragraph. */
  takeRefs(p: Node) {
    while (p.lines.length) {
      const m = /^ {0,3}\[([^\]^][^\]]{0,998})\]:[ \t]*(<[^<>\n]*>|\S+)(?:[ \t]+("[^"]*"|'[^']*'|\([^()]*\)))?[ \t]*$/.exec(p.lines[0])
      if (!m || !m[1].trim()) break
      const label = normalizeLabel(m[1])
      const href = unescape(m[2].startsWith('<') ? m[2].slice(1, -1) : m[2])
      if (!this.refs.has(label)) this.refs.set(label, { href, title: m[3] ? unescape(m[3].slice(1, -1)) : undefined })
      p.lines.shift()
    }
    if (!p.lines.length) p.parent!.children.splice(p.parent!.children.indexOf(p), 1)
  }

  /** Closes the blocks the current line did not continue, up to `keep`. */
  closeUnmatched() {
    if (this.allClosed) return
    while (this.oldTip !== this.lastMatched) {
      const parent = this.oldTip.parent!
      if (this.oldTip.open) this.finalize(this.oldTip)
      this.oldTip = parent
    }
    this.tip = this.lastMatched
    this.allClosed = true
  }

  /** 0: the line continues `n`; 1: it does not; 2: it closed `n` and nothing of it is left. */
  continues(n: Node, r: Rest): [0 | 1 | 2, Rest] {
    const indent = indentOf(r)
    const blank = isBlank(r.s)
    switch (n.kind) {
      case 'quote': {
        const t = strip(r, indent)
        if (indent > 3 || t.s[0] !== '>') return [1, r]
        let after = advance(t, 1)
        if (after.s[0] === ' ' || after.s[0] === '\t') after = strip(after, 1)
        return [0, after]
      }
      case 'item': {
        if (blank) {
          // An item that opened on a blank line ends at the next blank line.
          return n.children.length ? [0, trimStart(r)] : [1, r]
        }
        if (r.col + indent >= n.contentCol!) return [0, strip(r, n.contentCol! - r.col)]
        // Lenient on purpose: "1. step" followed by a sublist indented by only two spaces nests
        // the sublist, as people (and models) mean it, where CommonMark wants three.
        const t = strip(r, indent)
        if (r.col + indent >= n.markerCol! + 2 && (BULLET.test(t.s) || ORDERED.test(t.s)) && !HR.test(t.s)) return [0, t]
        return [1, r]
      }
      case 'list':
        return [0, r]
      case 'code': {
        if (n.fence) {
          const t = strip(r, indent)
          if (indent <= 3 && t.s.startsWith(n.fence) && new RegExp(`^${n.fence[0] === '`' ? '`' : '~'}+[ \\t]*$`).test(t.s)) {
            this.finalize(n)
            return [2, r]
          }
          return [0, strip(r, Math.min(indent, n.fenceIndent!))]
        }
        if (indent >= 4) return [0, strip(r, 4)]
        return blank ? [0, trimStart(r)] : [1, r]
      }
      case 'paragraph':
        return [blank ? 1 : 0, r]
      case 'table':
        return [blank || !hasPipe(r.s) ? 1 : 0, r]
      default:
        return [1, r]
    }
  }

  line(raw: string) {
    let r: Rest = { s: raw, col: 0 }
    let container = this.doc
    this.oldTip = this.tip

    // 1. Which open blocks does this line continue?
    let allMatched = true
    for (;;) {
      const last = container.children[container.children.length - 1]
      if (!last || !last.open) break
      const [res, rest] = this.continues(last, r)
      if (res === 2) return
      if (res === 1) {
        allMatched = false
        break
      }
      r = rest
      container = last
    }

    this.lastMatched = container
    this.allClosed = container === this.oldTip

    // 2. New blocks: quotes and items may nest; a leaf ends the search. Code takes the line as is.
    let matchedLeaf = container.kind === 'code'
    while (!matchedLeaf) {
      const indent = indentOf(r)
      const t = strip(r, indent)
      if (indent >= 4) {
        if (this.tip.kind !== 'paragraph' && !isBlank(r.s)) {
          this.closeUnmatched()
          container = this.add('code')
          r = strip(r, 4)
          matchedLeaf = true
        }
        break
      }
      if (t.s[0] === '>') {
        this.closeUnmatched()
        container = this.add('quote')
        r = advance(t, 1)
        if (r.s[0] === ' ' || r.s[0] === '\t') r = strip(r, 1)
        continue
      }
      const atx = ATX.exec(t.s)
      if (atx) {
        this.closeUnmatched()
        const h = this.add('heading')
        h.level = atx[0].length
        // An optional closing run of #s goes, as long as a space comes before it.
        h.lines = [t.s.slice(atx[0].length).replace(/^[ \t]+/, '').replace(/(^|[ \t]+)#+[ \t]*$/, '').trim()]
        container = h
        r = { s: '', col: t.col }
        matchedLeaf = true
        break
      }
      const fence = FENCE.exec(t.s)
      if (fence && !(fence[1][0] === '`' && t.s.slice(fence[1].length).includes('`'))) {
        this.closeUnmatched()
        const c = this.add('code')
        c.fence = fence[1]
        c.fenceIndent = indent
        c.lang = unescape(t.s.slice(fence[1].length).trim().split(/[ \t{]/)[0] ?? '')
        // The info string line itself is not code.
        return
      }
      if (container.kind === 'paragraph' && SETEXT.test(t.s) && allMatched) {
        this.closeUnmatched()
        container.kind = 'heading'
        container.level = t.s[0] === '=' ? 1 : 2
        this.takeRefs(container)
        if (container.lines.length) {
          container.lines = [container.lines.join('\n').trim()]
          container.open = false
          this.tip = container.parent!
        } else {
          // Only link definitions: then the underline is just text (or a rule).
          container = container.parent!
          this.tip = container
          continue
        }
        return
      }
      if (HR.test(t.s)) {
        this.closeUnmatched()
        container = this.add('hr')
        container.open = false
        this.tip = container.parent!
        return
      }
      const item = this.itemStart(container, t)
      if (item) {
        this.closeUnmatched()
        if (container.kind !== 'list' || container.ordered !== item.ordered || container.marker !== item.marker) {
          const list = this.add('list')
          list.ordered = item.ordered
          list.marker = item.marker
          list.start = item.start
          container = list
        }
        const it = this.add('item')
        it.markerCol = t.col
        it.contentCol = item.contentCol
        container = it
        r = item.rest
        continue
      }
      break
    }

    // 3. What is left of the line: lazy paragraph text, or into the leaf (or a new paragraph).
    const blank = isBlank(r.s)
    if (!this.allClosed && !blank && this.tip.kind === 'paragraph') {
      this.addLine(this.tip, r)
      return
    }
    this.closeUnmatched()
    if (blank && container.children.length) container.children[container.children.length - 1].lastLineBlank = true
    const lastLineBlank =
      blank && !(container.kind === 'quote' || (container.kind === 'code' && container.fence) || (container.kind === 'item' && !container.children.length))
    for (let c: Node | null = container; c; c = c.parent) c.lastLineBlank = lastLineBlank
    if (container.kind === 'paragraph' || container.kind === 'code' || container.kind === 'table') this.addLine(container, r)
    else if (!blank) {
      const p = this.add('paragraph')
      this.addLine(p, r)
    }
  }

  /** A list marker at the start of `t`, with the column the item's content starts at. */
  itemStart(container: Node, t: Rest) {
    const b = BULLET.exec(t.s)
    const o = b ? null : ORDERED.exec(t.s)
    if (!b && !o) return null
    const width = b ? 1 : o![0].length
    const after = advance(t, width)
    const spaces = indentOf(after)
    const empty = isBlank(after.s)
    // An item interrupts a paragraph only when it has content and, if ordered, starts at 1.
    if (container.kind === 'paragraph') {
      if (empty || (o && o[1] !== '1')) return null
    }
    // Five or more spaces after the marker: the content is indented code one space in.
    const pad = empty || spaces > 4 ? 1 : spaces
    return {
      ordered: !!o,
      marker: b ? b[0] : o![2],
      start: o ? Number(o[1]) : 1,
      contentCol: t.col + width + pad,
      rest: strip(after, empty ? spaces : pad),
    }
  }

  addLine(n: Node, r: Rest) {
    if (n.kind === 'code') return void n.lines.push(r.s)
    if (n.kind === 'table') return void n.lines.push(r.s)
    // A paragraph whose last line is a table header, followed by a delimiter row, turns into a
    // table (the lines before the header stay a paragraph of their own).
    const head = n.lines[n.lines.length - 1]
    if (head !== undefined && TABLE_SEP.test(r.s.trim()) && r.s.includes('-') && hasPipe(head) && (hasPipe(r.s) || head.trim().startsWith('|'))) {
      const cols = tableCells(head).length
      const seps = tableCells(r.s)
      if (seps.length === cols) {
        n.lines.pop()
        const parent = n.parent!
        if (!n.lines.length) parent.children.pop()
        else this.finalize(n)
        this.tip = parent
        const t = this.add('table')
        t.head = head
        t.align = seps.map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : null))
        return
      }
    }
    n.lines.push(r.s.replace(/^[ \t]+/, ''))
  }

  finish() {
    if (this.tip.kind === 'code' && this.tip.fence) this.tip.unclosed = true
    while (this.tip !== this.doc) this.finalize(this.tip)
    this.finalize(this.doc)
  }
}

function canContain(parent: Kind, child: Kind) {
  if (parent === 'document' || parent === 'quote' || parent === 'item') return child !== 'item'
  return parent === 'list' && child === 'item'
}

const endsWithBlank = (n: Node | undefined): boolean => {
  while (n) {
    if (n.lastLineBlank) return true
    if (n.kind !== 'list' && n.kind !== 'item') return false
    n = n.children[n.children.length - 1]
  }
  return false
}

/** A list is loose when a blank line separates two of its items, or two blocks inside an item. */
function isTight(list: Node) {
  for (let i = 0; i < list.children.length; i++) {
    const item = list.children[i]
    const lastItem = i === list.children.length - 1
    if (endsWithBlank(item) && !lastItem) return false
    for (let j = 0; j < item.children.length; j++) {
      if (endsWithBlank(item.children[j]) && (!lastItem || j < item.children.length - 1)) return false
    }
  }
  return true
}

const normalizeLabel = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase()

// --- Inlines -------------------------------------------------------------------------------------

/** An inline while it is being parsed: a doubly linked tree, so emphasis can regroup nodes cheaply. */
type INode = {
  type: Inline['type']
  text: string
  href?: string
  title?: string
  parent: INode | null
  first: INode | null
  last: INode | null
  prev: INode | null
  next: INode | null
}

const inode = (type: Inline['type'], text = ''): INode => ({ type, text, parent: null, first: null, last: null, prev: null, next: null })

function appendChild(parent: INode, child: INode) {
  child.parent = parent
  child.prev = parent.last
  child.next = null
  if (parent.last) parent.last.next = child
  else parent.first = child
  parent.last = child
}

function unlink(n: INode) {
  if (n.prev) n.prev.next = n.next
  else if (n.parent) n.parent.first = n.next
  if (n.next) n.next.prev = n.prev
  else if (n.parent) n.parent.last = n.prev
  n.parent = n.prev = n.next = null
}

function insertAfter(at: INode, n: INode) {
  n.parent = at.parent
  n.prev = at
  n.next = at.next
  if (at.next) at.next.prev = n
  else if (at.parent) at.parent.last = n
  at.next = n
}

/** A run of * _ or ~ that may open or close emphasis. */
type Delim = {
  node: INode
  ch: string
  count: number
  orig: number
  canOpen: boolean
  canClose: boolean
  prev: Delim | null
  next: Delim | null
}

/** A [ or ![ waiting for its ]. */
type Bracket = { node: INode; image: boolean; active: boolean; index: number; delims: Delim | null; prev: Bracket | null }

const PUNCT = /[\p{P}\p{S}]/u
const SPACE = /\s/
const ESCAPABLE = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/
const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™', hellip: '…',
  mdash: '—', ndash: '–', laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•',
  middot: '·', times: '×', divide: '÷', deg: '°', rarr: '→', larr: '←', uarr: '↑', darr: '↓', harr: '↔', euro: '€',
}

function entity(s: string): string | null {
  const m = /^&(?:#[xX]([0-9a-fA-F]{1,6})|#([0-9]{1,7})|([a-zA-Z][a-zA-Z0-9]{1,31}));$/.exec(s)
  if (!m) return null
  if (m[3]) return ENTITIES[m[3]] ?? null
  const code = parseInt(m[1] ?? m[2], m[1] ? 16 : 10)
  return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '�'
}

/** Backslash escapes and entities in link destinations, titles and info strings. */
function unescape(s: string) {
  return s.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])|&(?:#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (all, esc) => esc ?? entity(all) ?? all)
}

// Characters that may start something other than plain text, and the bare URLs GitHub links.
const SPECIAL = /[\n\\`*_~[\]!<&{]|https?:\/\//g

class InlineParser {
  s = ''
  pos = 0
  root = inode('text')
  delims: Delim | null = null
  brackets: Bracket | null = null
  /** Where the last furigana ended: its braces count as letters, not punctuation, for emphasis. */
  rubyEnd = -1
  refs: Map<string, { href: string; title?: string }>

  constructor(refs: Map<string, { href: string; title?: string }>) {
    this.refs = refs
  }

  parse(s: string): Inline[] {
    this.s = s
    this.pos = 0
    this.root = inode('text')
    this.delims = null
    this.brackets = null
    this.rubyEnd = -1
    while (this.pos < s.length) this.step()
    this.processEmphasis(null)
    return convert(this.root, false)
  }

  text(t: string) {
    appendChild(this.root, inode('text', t))
  }

  step() {
    const { s } = this
    const c = s[this.pos]
    if (c === '\n') return this.newline()
    if (c === '\\') {
      const n = s[this.pos + 1]
      if (n === '\n') {
        this.pos += 2
        appendChild(this.root, inode('br'))
        this.skipSpaces()
      } else if (n !== undefined && ESCAPABLE.test(n)) {
        this.pos += 2
        this.text(n)
      } else {
        this.pos++
        this.text('\\')
      }
      return
    }
    if (c === '`') return this.codeSpan()
    if (c === '*' || c === '_' || c === '~') return this.delim(c)
    if (c === '[') {
      this.pos++
      this.pushBracket(false)
      return
    }
    if (c === '!' && s[this.pos + 1] === '[') {
      this.pos += 2
      this.pushBracket(true)
      return
    }
    if (c === ']') return this.closeBracket()
    if (c === '<') {
      const r = htmlRubyAt(s, this.pos)
      if (r) {
        for (const p of r.pairs) {
          const n = inode('ruby', p.base)
          n.title = p.reading
          appendChild(this.root, n)
        }
        this.pos += r.length
        this.rubyEnd = this.pos
        return
      }
      if (this.autolink()) return
    }
    if (c === '&') {
      const m = /^&(?:#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z][a-zA-Z0-9]{1,31});/.exec(s.slice(this.pos, this.pos + 40))
      const e = m && entity(m[0])
      if (m && e !== null) {
        this.pos += m[0].length
        return this.text(e)
      }
    }
    if (c === 'h' && this.bareUrl()) return
    if (c === '{') {
      const m = rubyAt(s, this.pos)
      if (m) {
        const n = inode('ruby', m[1].trim())
        n.title = m[2].trim()
        appendChild(this.root, n)
        this.pos += m[0].length
        this.rubyEnd = this.pos
        return
      }
    }
    // Plain text up to the next character that could mean something.
    SPECIAL.lastIndex = this.pos + 1
    const next = SPECIAL.exec(s)
    const end = next ? next.index : s.length
    this.text(s.slice(this.pos, end))
    this.pos = end
  }

  skipSpaces() {
    while (this.s[this.pos] === ' ' || this.s[this.pos] === '\t') this.pos++
  }

  newline() {
    this.pos++
    const last = this.root.last
    let hard = false
    if (last && last.type === 'text' && / $/.test(last.text)) {
      hard = /  $/.test(last.text)
      last.text = last.text.replace(/ +$/, '')
    }
    appendChild(this.root, inode(hard ? 'br' : 'soft'))
    this.skipSpaces()
  }

  codeSpan() {
    const { s } = this
    const open = /^`+/.exec(s.slice(this.pos))![0]
    const from = this.pos + open.length
    // The closer is a run of exactly as many backticks.
    const re = /`+/g
    re.lastIndex = from
    for (let m = re.exec(s); m; m = re.exec(s)) {
      if (m[0].length !== open.length) continue
      let code = s.slice(from, m.index).replace(/\n/g, ' ')
      if (code.length > 2 && code[0] === ' ' && code[code.length - 1] === ' ' && /[^ ]/.test(code)) code = code.slice(1, -1)
      appendChild(this.root, inode('code', code))
      this.pos = m.index + m[0].length
      return
    }
    this.text(open)
    this.pos = from
  }

  delim(ch: string) {
    const { s } = this
    let end = this.pos
    while (s[end] === ch) end++
    const count = end - this.pos
    // Furigana next to a delimiter reads as a word, so **{漢字|かんじ}**を is bold as it would be
    // with the bare characters.
    const before = this.pos === 0 ? '\n' : this.rubyEnd === this.pos ? 'a' : s[this.pos - 1]
    const after = end >= s.length ? '\n' : rubyAt(s, end) || htmlRubyAt(s, end) ? 'a' : s[end]
    const afterSpace = SPACE.test(after)
    const afterPunct = PUNCT.test(after)
    const beforeSpace = SPACE.test(before)
    const beforePunct = PUNCT.test(before)
    const left = !afterSpace && (!afterPunct || beforeSpace || beforePunct)
    const right = !beforeSpace && (!beforePunct || afterSpace || afterPunct)
    let canOpen = left
    let canClose = right
    // Underscores inside a word (snake_case) neither open nor close.
    if (ch === '_') {
      canOpen = left && (!right || beforePunct)
      canClose = right && (!left || afterPunct)
    }
    const n = inode('text', s.slice(this.pos, end))
    appendChild(this.root, n)
    this.pos = end
    // Strikethrough takes exactly two tildes; one is "about" (~10 minutes) and stays text.
    if (ch === '~' && count !== 2) return
    if (!canOpen && !canClose) return
    const d: Delim = { node: n, ch, count, orig: count, canOpen, canClose, prev: this.delims, next: null }
    if (this.delims) this.delims.next = d
    this.delims = d
  }

  removeDelim(d: Delim) {
    if (d.prev) d.prev.next = d.next
    if (d.next) d.next.prev = d.prev
    else this.delims = d.prev
  }

  pushBracket(image: boolean) {
    const n = inode('text', image ? '![' : '[')
    appendChild(this.root, n)
    this.brackets = { node: n, image, active: true, index: this.pos, delims: this.delims, prev: this.brackets }
  }

  closeBracket() {
    const { s } = this
    this.pos++
    const opener = this.brackets
    if (!opener) return this.text(']')
    if (!opener.active) {
      this.brackets = opener.prev
      return this.text(']')
    }
    const startPos = this.pos
    let dest: string | null = null
    let title: string | undefined
    // An inline link: [text](destination "title")
    if (s[this.pos] === '(') {
      const m = /^\([ \t]*\n?[ \t]*(?:<((?:[^<>\n\\]|\\.)*)>|((?:[^\s()\\]|\\.|\((?:[^\s()\\]|\\.)*\))*))(?:[ \t]*\n?[ \t]*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\((?:[^()\\]|\\.)*\)))?[ \t]*\n?[ \t]*\)/.exec(s.slice(this.pos))
      if (m && !(m[2] === undefined && m[1] === undefined)) {
        dest = unescape(m[1] ?? m[2] ?? '')
        title = m[3] ? unescape(m[3].slice(1, -1)) : undefined
        this.pos += m[0].length
      }
    }
    // A reference link: [text][label], [text][] or [text].
    if (dest === null) {
      let label = ''
      const m = /^\[((?:[^[\]\\]|\\.){0,999})\]/.exec(s.slice(this.pos))
      if (m && m[1].trim()) {
        label = m[1]
      } else {
        label = s.slice(opener.index, startPos - 1)
      }
      const ref = /[^ \t\n]/.test(label) && !label.startsWith('^') ? this.refs.get(normalizeLabel(label)) : undefined
      if (ref) {
        dest = ref.href
        title = ref.title
        if (m) this.pos += m[0].length
      } else {
        this.pos = startPos
      }
    }
    if (dest === null) {
      this.brackets = opener.prev
      return this.text(']')
    }
    const link = inode(opener.image ? 'image' : 'link')
    link.href = dest
    link.title = title
    for (let n = opener.node.next; n; ) {
      const next = n.next
      unlink(n)
      appendChild(link, n)
      n = next
    }
    insertAfter(opener.node, link)
    this.processEmphasis(opener.delims)
    unlink(opener.node)
    this.brackets = opener.prev
    // No links inside links: the [ before this one can no longer open one.
    if (!opener.image) for (let b = this.brackets; b; b = b.prev) if (!b.image) b.active = false
  }

  /** <https://…> and <mail@example.com>; anything else after a < (raw HTML) stays text. */
  autolink() {
    const rest = this.s.slice(this.pos, this.pos + 2048)
    const url = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^<>\x00-\x20]*)>/.exec(rest)
    const mail = url ? null : /^<([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)>/.exec(rest)
    const m = url ?? mail
    if (!m) return false
    const link = inode('link')
    link.href = mail ? `mailto:${m[1]}` : m[1]
    appendChild(link, inode('text', m[1]))
    appendChild(this.root, link)
    this.pos += m[0].length
    return true
  }

  /** A bare http(s) URL, without the punctuation that ends the sentence around it. */
  bareUrl() {
    const before = this.pos ? this.s[this.pos - 1] : ' '
    if (!/[\s*_~(]/.test(before)) return false
    // Inside link text a ] ends the URL, so "[https://a.b](https://a.b)" is still a link.
    const m = (this.brackets ? /^https?:\/\/[^\s<\]]+/ : /^https?:\/\/[^\s<]+/).exec(this.s.slice(this.pos, this.pos + 4096))
    if (!m || m[0].length <= 8) return false
    let url = m[0]
    for (;;) {
      const trimmed = url.replace(/[?!.,:*_~'"]+$/, '')
      if (trimmed !== url) {
        url = trimmed
        continue
      }
      if (url.endsWith(')') && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) {
        url = url.slice(0, -1)
        continue
      }
      const ent = /&[a-zA-Z0-9]+;$/.exec(url)
      if (ent) {
        url = url.slice(0, ent.index)
        continue
      }
      break
    }
    const link = inode('link')
    link.href = url
    appendChild(link, inode('text', url))
    appendChild(this.root, link)
    this.pos += url.length
    return true
  }

  /** CommonMark's "process emphasis": pairs up the delimiter runs above `bottom`. */
  processEmphasis(bottom: Delim | null) {
    const openersBottom = new Map<string, Delim | null>()
    // Start from the first delimiter above `bottom`.
    let closer: Delim | null = this.delims
    while (closer && closer.prev !== bottom) closer = closer.prev
    while (closer) {
      if (!closer.canClose) {
        closer = closer.next
        continue
      }
      const key = `${closer.ch}${closer.canOpen ? 1 : 0}${closer.orig % 3}`
      const floor = openersBottom.has(key) ? openersBottom.get(key)! : bottom
      let opener = closer.prev
      let found = false
      while (opener && opener !== bottom && opener !== floor) {
        // The "rule of three": *foo**bar* is one emphasis, not a strong one inside.
        const odd = closer.ch !== '~' && (closer.canOpen || opener.canClose) && closer.orig % 3 !== 0 && (opener.orig + closer.orig) % 3 === 0
        if (opener.ch === closer.ch && opener.canOpen && !odd && (closer.ch !== '~' || opener.count === closer.count)) {
          found = true
          break
        }
        opener = opener.prev
      }
      const oldCloser = closer
      if (found && opener) {
        const use = closer.ch === '~' ? 2 : closer.count >= 2 && opener.count >= 2 ? 2 : 1
        opener.count -= use
        closer.count -= use
        opener.node.text = opener.node.text.slice(0, opener.node.text.length - use)
        closer.node.text = closer.node.text.slice(0, closer.node.text.length - use)
        const wrap = inode(closer.ch === '~' ? 'del' : use === 1 ? 'em' : 'strong')
        for (let n = opener.node.next; n && n !== closer.node; ) {
          const next: INode | null = n.next
          unlink(n)
          appendChild(wrap, n)
          n = next
        }
        insertAfter(opener.node, wrap)
        // Delimiters between the pair can no longer match anything outside it.
        for (let d = closer.prev; d && d !== opener; ) {
          const prev: Delim | null = d.prev
          this.removeDelim(d)
          d = prev
        }
        if (opener.count === 0) {
          unlink(opener.node)
          this.removeDelim(opener)
        }
        if (closer.count === 0) {
          const next = closer.next
          unlink(closer.node)
          this.removeDelim(closer)
          closer = next
        }
      } else {
        closer = closer.next
        openersBottom.set(key, oldCloser.prev)
        if (!oldCloser.canOpen) this.removeDelim(oldCloser)
      }
    }
    while (this.delims && this.delims !== bottom) this.removeDelim(this.delims)
  }
}

/** The linked tree as plain `Inline`s: neighbouring text joined, and no links inside links. */
function convert(parent: INode, inLink: boolean): Inline[] {
  const out: Inline[] = []
  const push = (n: Inline) => {
    const last = out[out.length - 1]
    if (n.type === 'text' && last?.type === 'text') last.text += n.text
    else if (n.type !== 'text' || n.text) out.push(n)
  }
  for (let n = parent.first; n; n = n.next) {
    switch (n.type) {
      case 'text':
      case 'code':
        push({ type: n.type, text: n.text })
        break
      case 'br':
      case 'soft':
        push({ type: n.type })
        break
      case 'ruby':
        push({ type: 'ruby', base: n.text, reading: n.title! })
        break
      case 'em':
      case 'strong':
      case 'del':
        push({ type: n.type, children: convert(n, inLink) })
        break
      case 'link': {
        const kids = convert(n, true)
        if (inLink || !safeHref(n.href!)) kids.forEach(push)
        else push({ type: 'link', href: n.href!.trim(), title: n.title, children: kids })
        break
      }
      case 'image': {
        const alt = plain(convert(n, true))
        if (safeImage(n.href!)) push({ type: 'image', src: n.href!.trim(), alt, title: n.title })
        else if (!inLink && safeHref(n.href!)) push({ type: 'link', href: n.href!.trim(), title: n.title, children: [{ type: 'text', text: alt || n.href! }] })
        else push({ type: 'text', text: alt })
        break
      }
    }
  }
  return out
}

/** The text of some inlines, for an image's alt text. */
export function plain(nodes: Inline[]): string {
  return nodes
    .map((n) => {
      if (n.type === 'text' || n.type === 'code') return n.text
      if (n.type === 'image') return n.alt
      if (n.type === 'ruby') return n.base
      if (n.type === 'br' || n.type === 'soft') return ' '
      return 'children' in n ? plain(n.children) : ''
    })
    .join('')
}

// --- Putting it together -------------------------------------------------------------------------

function toBlocks(nodes: Node[], inline: InlineParser): Block[] {
  const out: Block[] = []
  for (const n of nodes) {
    switch (n.kind) {
      case 'paragraph':
        out.push({ type: 'paragraph', children: inline.parse(n.lines.join('\n').replace(/[ \t]+$/, '')) })
        break
      case 'heading':
        out.push({ type: 'heading', level: n.level as 1, children: inline.parse(n.lines[0] ?? '') })
        break
      case 'hr':
        out.push({ type: 'hr' })
        break
      case 'code':
        out.push({ type: 'code', lang: n.lang ?? '', text: n.lines.join('\n'), ...(n.unclosed ? { open: true } : {}) })
        break
      case 'quote':
        out.push({ type: 'quote', children: toBlocks(n.children, inline) })
        break
      case 'list':
        out.push({
          type: 'list',
          ordered: !!n.ordered,
          start: n.start ?? 1,
          tight: n.tight ?? true,
          items: n.children.map((item) => {
            // A task: "[ ] " or "[x] " at the start of the item's first paragraph.
            let checked: boolean | null = null
            const p = item.children[0]
            const m = p?.kind === 'paragraph' ? /^\[([ xX])\](?:[ \t]+|$)/.exec(p.lines[0]) : null
            if (m && (p.lines[0].length > m[0].length || p.lines.length > 1)) {
              checked = m[1] !== ' '
              p.lines[0] = p.lines[0].slice(m[0].length)
            }
            return { checked, children: toBlocks(item.children, inline) }
          }),
        })
        break
      case 'table': {
        const head = tableCells(n.head!)
        const cols = head.length
        out.push({
          type: 'table',
          align: n.align!,
          head: head.map((c) => inline.parse(c)),
          rows: n.lines.map((line) => {
            const cells = tableCells(line)
            return Array.from({ length: cols }, (_, j) => inline.parse(cells[j] ?? ''))
          }),
        })
        break
      }
    }
  }
  return out
}

/** Parses Markdown into blocks. Cheap enough to run again on every streamed chunk. */
export function parseMarkdown(text: string): Block[] {
  const blocks = new BlockParser()
  const lines = text.replace(/\r\n?/g, '\n').replace(/\0/g, '�').split('\n')
  // A final newline ends the last line rather than starting an empty one (which an open fence
  // would show as a blank line of code).
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  for (const line of lines) blocks.line(line)
  blocks.finish()
  return toBlocks(blocks.doc.children, new InlineParser(blocks.refs))
}
