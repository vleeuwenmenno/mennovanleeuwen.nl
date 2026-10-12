// HTML mail made safe to show, for the Mail app (server/jmap.ts). An allow-list sanitiser with
// no dependencies: the mail is read into tags and text, and only what is on the lists below is
// written out again, every attribute re-escaped and every element closed, so nothing the browser
// would read differently from this parser can get through. Whatever it misses, the page shows the
// result in an iframe sandboxed without scripts or same-origin, under a strict
// Content-Security-Policy (src/apps/mail/Reader.tsx): this is the first of two walls, not the only one.
//
// - Scripts, styles' expressions, event handlers, forms, frames, objects, SVG and MathML, meta
//   refreshes and <base> never come through; links only to http(s), mailto and tel, opened in a
//   new tab without an opener or referrer, with the real address as their tooltip.
// - Remote images (img src, background attributes, CSS url()) are left out unless `images` is on;
//   tracking pixels (tiny or hidden images) are left out either way. cid: images point at the
//   message's own parts through `cid()`. data: images (PNG, JPEG, GIF, WebP) stay.
// - CSS keeps its looks: declarations with escapes, expression(), bindings or image-set() go,
//   as do @import, @font-face and the like.
// - Quoted text (Gmail, Apple Mail, Thunderbird, Outlook) is folded into a <details>, once
//   something of the message's own came before it.

export type SanitizeOptions = {
  /** Remote images and CSS url()s load ("Load images", or always for this sender). */
  images: boolean
  /** The address for an inline part by its Content-ID, or null when the message has no such part. */
  cid?: (id: string) => string | null
}

export type Sanitized = {
  html: string
  /** Remote images left out because images are off. */
  blocked: number
  /** Tracking pixels left out (always). */
  trackers: number
  /** Content-IDs the HTML showed, so those parts need not be listed as attachments too. */
  cids: string[]
}

const MAX_INPUT = 2_000_000
const MAX_DEPTH = 160

/** Elements kept, with their contents. */
const ALLOWED = new Set(
  'a abbr address article aside b bdi bdo big blockquote br caption center cite code col colgroup dd del details dfn div dl dt em figcaption figure font footer h1 h2 h3 h4 h5 h6 header hr i img ins kbd li main mark nav ol p pre q rp rt ruby s samp section small span strike strong sub summary sup table tbody td tfoot th thead time tr tt u ul var wbr'.split(' '),
)
/** Elements dropped together with everything in them. */
const DROP_WITH_CONTENT = new Set(
  'script style title noscript template iframe frame frameset object embed applet svg math canvas audio video source track select textarea option optgroup datalist noembed noframes xmp plaintext map area param portal'.split(' '),
)
/** Contents the tokenizer reads as plain text up to the matching end tag. */
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'template'])
const VOID = new Set(['br', 'hr', 'img', 'wbr', 'col', 'area', 'base', 'embed', 'input', 'link', 'meta', 'param', 'source', 'track', 'keygen'])

/** Attributes allowed on any kept element, each with a check of its value. */
const SIMPLE = /^[\w\s#%.,()+-]{0,200}$/
const ATTRS: Record<string, (v: string) => boolean> = {
  align: (v) => /^[a-z]{1,10}$/i.test(v),
  valign: (v) => /^[a-z]{1,10}$/i.test(v),
  bgcolor: (v) => SIMPLE.test(v),
  color: (v) => SIMPLE.test(v),
  face: (v) => /^[\w\s,'"-]{0,200}$/.test(v),
  size: (v) => /^[+-]?\d{1,3}$/.test(v),
  width: (v) => /^\d{1,5}(\.\d+)?(%|px)?$/i.test(v.trim()),
  height: (v) => /^\d{1,5}(\.\d+)?(%|px)?$/i.test(v.trim()),
  border: (v) => /^\d{1,3}(px)?$/i.test(v.trim()),
  cellpadding: (v) => /^\d{1,3}$/.test(v),
  cellspacing: (v) => /^\d{1,3}$/.test(v),
  colspan: (v) => /^\d{1,3}$/.test(v),
  rowspan: (v) => /^\d{1,3}$/.test(v),
  span: (v) => /^\d{1,3}$/.test(v),
  start: (v) => /^-?\d{1,6}$/.test(v),
  type: (v) => /^[a-z1]{1,10}$/i.test(v),
  dir: (v) => /^(ltr|rtl|auto)$/i.test(v),
  lang: (v) => /^[a-z]{1,8}(-[a-z0-9]{1,8})*$/i.test(v),
  title: (v) => v.length <= 500,
  alt: (v) => v.length <= 500,
  class: (v) => /^[\w\s-]{0,300}$/.test(v),
  id: (v) => /^[\w-]{1,100}$/.test(v),
  name: (v) => /^[\w-]{1,100}$/.test(v),
  nowrap: () => true,
  hspace: (v) => /^\d{1,3}$/.test(v),
  vspace: (v) => /^\d{1,3}$/.test(v),
  clear: (v) => /^[a-z]{1,10}$/i.test(v),
  noshade: () => true,
  scope: (v) => /^[a-z]{1,10}$/i.test(v),
  headers: (v) => /^[\w\s-]{0,200}$/.test(v),
  abbr: (v) => v.length <= 200,
  summary: (v) => v.length <= 500,
  datetime: (v) => /^[\w:.+-]{0,40}$/.test(v),
  open: () => true,
  reversed: () => true,
}

/** Named character references read in attribute values (anything else stays as written). */
const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', colon: ':', semi: ';', comma: ',', period: '.', sol: '/', bsol: '\\', lpar: '(', rpar: ')',
  Tab: '\t', NewLine: '\n', excl: '!', quest: '?', num: '#', percnt: '%', equals: '=', plus: '+', lowbar: '_', hyphen: '-', dash: '-', commat: '@', grave: '`',
  copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•', middot: '·', euro: '€',
  pound: '£', yen: '¥', cent: '¢', deg: '°', times: '×', divide: '÷', laquo: '«', raquo: '»', zwnj: '‌', zwj: '‍', shy: '­', ensp: ' ', emsp: ' ', thinsp: ' ',
}

// ---------------------------------------------------------------------------------------------
// Reading

type Token = { k: 'text'; v: string } | { k: 'start'; name: string; attrs: Map<string, string>; self: boolean } | { k: 'end'; name: string }

function* tokens(s: string): Generator<Token> {
  let i = 0
  const n = s.length
  while (i < n) {
    const lt = s.indexOf('<', i)
    if (lt < 0) {
      yield { k: 'text', v: s.slice(i) }
      return
    }
    if (lt > i) yield { k: 'text', v: s.slice(i, lt) }
    i = lt
    const next = s[i + 1] ?? ''
    if (s.startsWith('<!--', i)) {
      // A comment: to "-->" (or "--!>"), or to the end.
      const m = /--!?>/g
      m.lastIndex = i + 4
      const end = s.startsWith('<!-->', i) ? i + 5 : s.startsWith('<!--->', i) ? i + 6 : m.exec(s) ? m.lastIndex : n
      i = end
      continue
    }
    if (next === '!' || next === '?') {
      // A doctype, CDATA or processing instruction: dropped, to the next ">".
      const end = s.indexOf('>', i)
      i = end < 0 ? n : end + 1
      continue
    }
    const end = next === '/'
    if (!/[a-z]/i.test(end ? (s[i + 2] ?? '') : next)) {
      yield { k: 'text', v: '<' }
      i++
      continue
    }
    // A tag: its name, then its attributes, to the ">" outside quotes.
    let j = i + (end ? 2 : 1)
    const nameStart = j
    while (j < n && !/[\s/>]/.test(s[j])) j++
    const name = s.slice(nameStart, j).toLowerCase()
    const attrs = new Map<string, string>()
    let self = false
    for (;;) {
      while (j < n && /[\s/]/.test(s[j])) {
        if (s[j] === '/' && s[j + 1] === '>') self = true
        j++
      }
      if (j >= n || s[j] === '>') break
      const aStart = j
      j++ // an attribute name may start with "="
      while (j < n && !/[\s/>=]/.test(s[j])) j++
      const aName = s.slice(aStart, j).toLowerCase()
      while (j < n && /\s/.test(s[j])) j++
      let value = ''
      if (s[j] === '=') {
        j++
        while (j < n && /\s/.test(s[j])) j++
        const q = s[j]
        if (q === '"' || q === "'") {
          const close = s.indexOf(q, j + 1)
          value = s.slice(j + 1, close < 0 ? n : close)
          j = close < 0 ? n : close + 1
        } else {
          const vStart = j
          while (j < n && !/[\s>]/.test(s[j])) j++
          value = s.slice(vStart, j)
        }
      }
      if (!attrs.has(aName)) attrs.set(aName, value)
    }
    i = j + 1
    if (end) {
      yield { k: 'end', name }
      continue
    }
    yield { k: 'start', name, attrs, self }
    if (name === 'plaintext') return // the rest is its text: dropped with it
    if (RAW_TEXT.has(name) && !self) {
      // Its contents are text up to its own end tag, whatever they look like.
      const re = new RegExp(`</${name}[\\s/>]`, 'ig')
      re.lastIndex = i
      const m = re.exec(s)
      const stop = m ? m.index : n
      yield { k: 'text', v: s.slice(i, stop) }
      i = stop
    }
  }
}

/** Character references in an attribute value, as the browser would read them. */
export function decodeEntities(v: string): string {
  return v.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,31});?/gi, (all, ref: string) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10)
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '�'
    }
    return ENTITIES[ref] ?? all
  })
}

const escAttr = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
/** Text as written, except that "<", ">" and lone "&" are escaped: references stay references, never markup. */
const escText = (v: string) => v.replace(/&(?!(?:#\d{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,31});)/gi, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// ---------------------------------------------------------------------------------------------
// Addresses

/** An address as the browser would read it: tabs and newlines inside it removed, spaces and controls around it trimmed. */
const tidyUrl = (raw: string) => decodeEntities(raw).replace(/[\t\n\r]/g, '').replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '')

/** A link's target, or null to leave it out: http(s) (as the URL parser writes it), mailto, tel or a fragment. */
export function safeHref(raw: string): string | null {
  const v = tidyUrl(raw)
  if (/^#[\w-]{0,100}$/.test(v)) return v
  if (/^(mailto|tel):/i.test(v)) return /[\x00-\x1f<>"]/.test(v) ? null : v
  if (!/^https?:\/\//i.test(v)) return null
  try {
    const u = new URL(v)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null
  } catch {
    return null
  }
}

const DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]{1,3000000}$/i

type Ctx = SanitizeOptions & { blocked: number; trackers: number; cids: Set<string> }

/** An image's address: a part of the message, a data: image, or a remote one when images are on. 'blocked' when it was left out for that. */
function imageUrl(raw: string, ctx: Ctx): string | null | 'blocked' {
  const v = tidyUrl(raw)
  if (/^cid:/i.test(v)) {
    let id = v.slice(4)
    try {
      id = decodeURIComponent(id)
    } catch {
      /* as written */
    }
    id = id.replace(/^<|>$/g, '')
    const url = ctx.cid?.(id) ?? null
    if (url) ctx.cids.add(id)
    return url
  }
  if (DATA_IMAGE.test(v)) return v.replace(/\s+/g, '')
  if (!/^https?:\/\//i.test(v)) return null
  if (!ctx.images) return 'blocked'
  try {
    const u = new URL(v)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------------------------
// CSS

const BAD_PROPERTY = /^(behavior|-moz-binding|binding|-o-link|-o-link-source|-webkit-user-modify|user-modify)$/
const BAD_VALUE = /expression\s*\(|javascript:|vbscript:|livescript:|(?:-webkit-)?image-set\s*\(|\bimage\s*\(|cross-fade\s*\(|element\s*\(|\bsrc\s*\(|@import|<|>|\\/i

/** Splits CSS at a separator outside strings and brackets. */
function splitOutside(text: string, sep: string): string[] {
  const out: string[] = []
  let depth = 0
  let quote = ''
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (c === quote) quote = ''
    } else if (c === '"' || c === "'") quote = c
    else if (c === '(') depth++
    else if (c === ')') depth = Math.max(0, depth - 1)
    else if (c === sep && depth === 0) {
      out.push(text.slice(start, i))
      start = i + 1
    }
  }
  out.push(text.slice(start))
  return out
}

/** One declaration's value with its url()s checked and rewritten, or null to drop the declaration. */
function cleanValue(value: string, ctx: Ctx): string | null {
  if (BAD_VALUE.test(value)) return null
  // A string left open would run on into whatever follows.
  if ((value.match(/"/g) ?? []).length % 2 || (value.match(/'/g) ?? []).length % 2) return null
  let dropped = false
  const out = value.replace(/url\s*\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]*))\s*\)/gi, (_all, a?: string, b?: string, c?: string) => {
    const url = imageUrl(a ?? b ?? c ?? '', ctx)
    if (url === 'blocked') ctx.blocked++
    if (!url || url === 'blocked') {
      dropped = true
      return ''
    }
    return `url("${url.replace(/["\\\n]/g, encodeURIComponent)}")`
  })
  // A url( the pattern above could not read: not something to pass along.
  if (dropped || /url\s*\(/i.test(out.replace(/url\("[^"]*"\)/gi, ''))) return null
  return out
}

/** A style attribute's (or a rule's) declarations, cleaned. */
export function cleanDeclarations(text: string, ctx: Ctx): string {
  const kept: string[] = []
  for (const decl of splitOutside(text.replace(/\/\*[\s\S]*?(\*\/|$)/g, ''), ';')) {
    const colon = decl.indexOf(':')
    if (colon < 0) continue
    const prop = decl.slice(0, colon).trim().toLowerCase()
    if (!/^-?[a-z][a-z0-9-]{0,60}$/.test(prop) || BAD_PROPERTY.test(prop)) continue
    const value = cleanValue(decl.slice(colon + 1).trim(), ctx)
    if (value === null || !value) continue
    kept.push(`${prop}: ${value}`)
  }
  return kept.join('; ')
}

/** The text up to the "}" that closes a block opened just before `from` (strings and nesting respected). */
function blockEnd(css: string, from: number): number {
  let depth = 1
  let quote = ''
  for (let i = from; i < css.length; i++) {
    const c = css[i]
    if (quote) {
      if (c === quote) quote = ''
    } else if (c === '"' || c === "'") quote = c
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) return i
  }
  return css.length
}

/** A <style> element's rules: @media and @supports kept (cleaned inside), other at-rules dropped. */
export function cleanStylesheet(input: string, ctx: Ctx, nesting = 0): string {
  const css = input.replace(/\/\*[\s\S]*?(\*\/|$)/g, '').replace(/<!--|-->/g, '')
  let out = ''
  let i = 0
  while (i < css.length) {
    while (i < css.length && /[\s;]/.test(css[i])) i++
    if (i >= css.length) break
    const open = css.indexOf('{', i)
    const semi = css.indexOf(';', i)
    if (css[i] === '@' && (open < 0 || (semi >= 0 && semi < open))) {
      i = semi < 0 ? css.length : semi + 1 // @import, @charset, @namespace: gone
      continue
    }
    if (open < 0) break
    const prelude = css.slice(i, open).trim()
    const close = blockEnd(css, open + 1)
    const body = css.slice(open + 1, close)
    i = close + 1
    if (/[<>\\]/.test(prelude) || prelude.length > 2000) continue
    if (prelude.startsWith('@')) {
      const at = /^@([\w-]+)/.exec(prelude)?.[1].toLowerCase()
      if ((at === 'media' || at === 'supports') && nesting < 3 && !/url\s*\(/i.test(prelude)) {
        const inner = cleanStylesheet(body, ctx, nesting + 1)
        if (inner) out += `${prelude}{${inner}}`
      }
      continue // @font-face (remote fonts), @keyframes, @page and the rest
    }
    const decls = cleanDeclarations(body, ctx)
    if (decls) out += `${prelude}{${decls}}`
  }
  return out
}

/** Whether a style hides an element or makes it a pixel: what tracking images look like. */
function hiddenOrTiny(style: string, attrs: Map<string, string>): boolean {
  const px = (v: string | undefined) => (v === undefined ? null : /^\s*(\d+(\.\d+)?)\s*(px)?\s*$/i.exec(v) ? parseFloat(v) : null)
  const w = px(attrs.get('width'))
  const h = px(attrs.get('height'))
  if ((w !== null && w <= 2) || (h !== null && h <= 2)) return true
  const s = style.toLowerCase()
  if (/display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(\.0*)?\s*(;|$)/.test(s)) return true
  const dim = (p: string) => new RegExp(`(?:^|;)\\s*(?:max-)?${p}\\s*:\\s*(\\d+(?:\\.\\d+)?)\\s*px`).exec(s)
  const sw = dim('width')
  const sh = dim('height')
  return (!!sw && parseFloat(sw[1]) <= 2) || (!!sh && parseFloat(sh[1]) <= 2)
}

// ---------------------------------------------------------------------------------------------
// Writing

/** Whether an element starts quoted text: Gmail, Apple Mail, Thunderbird, Yahoo, Proton, Outlook. */
function quoteKind(name: string, attrs: Map<string, string>): 'element' | 'rest' | null {
  const cls = ` ${(attrs.get('class') ?? '').toLowerCase()} `
  const id = (attrs.get('id') ?? '').toLowerCase()
  if (name === 'blockquote' && (attrs.get('type') ?? '').toLowerCase() === 'cite') return 'element'
  if (/ (gmail_quote|yahoo_quoted|protonmail_quote|moz-cite-prefix) /.test(cls)) return 'element'
  // Outlook writes no wrapper: everything after its "From: … Sent: …" block is the quote.
  if (id === 'divrplyfwdmsg' || id === 'appendonsend' || / (outlookmessageheader) /.test(cls)) return 'rest'
  return null
}

/** An open element; `#quote` is the wrapper around an Outlook quote, `quote` an element whose wrapper closes with it. */
type Open = { name: string; out: string; quote?: 'element' }

export function sanitizeHtml(input: string, opts: SanitizeOptions): Sanitized {
  const ctx: Ctx = { ...opts, blocked: 0, trackers: 0, cids: new Set() }
  let out = ''
  const stack: Open[] = []
  /** Set while inside an element dropped with its contents: how deep, to know when it ends. */
  let dropping: { name: string; depth: number } | null = null
  /** Whether the message said something of its own before its quoted text. */
  let ownText = 0
  let quoted = false
  const html = input.length > MAX_INPUT ? input.slice(0, MAX_INPUT) : input

  const close = (o: Open) => {
    out += o.name === '#quote' ? '</details>' : `</${o.out}>${o.quote ? '</details>' : ''}`
  }
  for (const t of tokens(html)) {
    if (dropping) {
      if (t.k === 'start' && t.name === dropping.name && !t.self) dropping.depth++
      else if (t.k === 'end' && t.name === dropping.name && --dropping.depth === 0) dropping = null
      continue
    }
    if (t.k === 'text') {
      // Inside <style>: the stylesheet, cleaned.
      if (stack.at(-1)?.name === 'style') {
        out += cleanStylesheet(t.v.slice(0, 500_000), ctx).replace(/</g, '\\3c ')
        continue
      }
      out += escText(t.v)
      ownText += t.v.replace(/&nbsp;|\s/g, '').length
      continue
    }
    if (t.k === 'end') {
      const name = t.name === 'body' || t.name === 'html' ? 'body' : t.name
      // The innermost open element of that name; whatever is open inside it closes first.
      let at = -1
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k].name === name) {
          at = k
          break
        }
      }
      if (at < 0) continue
      while (stack.length > at) close(stack.pop()!)
      continue
    }
    const { name, attrs } = t
    if (name === 'style') {
      // A <style> element: kept (it only reaches into the iframe), its contents cleaned as text.
      if (t.self || stack.length >= MAX_DEPTH) continue
      out += '<style>'
      stack.push({ name: 'style', out: 'style' })
      continue
    }
    if (DROP_WITH_CONTENT.has(name)) {
      if (!t.self && !VOID.has(name)) dropping = { name, depth: 1 }
      continue
    }
    if (name === 'html' || name === 'body') {
      // The body's colours go to a wrapper of its own; html and later bodies just go.
      if (name === 'body' && !stack.some((o) => o.name === 'body')) {
        const style = [attrs.get('bgcolor') && SIMPLE.test(attrs.get('bgcolor')!) ? `background-color: ${attrs.get('bgcolor')}` : '', attrs.get('text') && SIMPLE.test(attrs.get('text')!) ? `color: ${attrs.get('text')}` : '', cleanDeclarations(decodeEntities(attrs.get('style') ?? ''), ctx)]
          .filter(Boolean)
          .join('; ')
        out += `<div class="mail-body"${style ? ` style="${escAttr(style)}"` : ''}>`
        stack.push({ name: 'body', out: 'div' })
      }
      continue
    }
    if (!ALLOWED.has(name)) continue // the tag goes, its contents stay
    if (stack.length >= MAX_DEPTH) continue

    let attrText = ''
    const style = attrs.has('style') ? cleanDeclarations(decodeEntities(attrs.get('style')!), ctx) : ''
    if (name === 'img') {
      const src = attrs.get('src')
      if (src === undefined) continue
      const url = imageUrl(src, ctx)
      const tracker = hiddenOrTiny(style, attrs) && (url === 'blocked' || (!!url && /^https?:/.test(url)))
      if (tracker) {
        ctx.trackers++
        continue
      }
      if (url === 'blocked') {
        ctx.blocked++
        // Its words stay, where the picture would have been.
        const alt = decodeEntities(attrs.get('alt') ?? '').trim()
        if (alt) out += `<span class="mail-blocked" title="Image not loaded">${escAttr(alt.slice(0, 300))}</span>`
        continue
      }
      if (!url) continue
      attrText += ` src="${escAttr(url)}" loading="lazy" referrerpolicy="no-referrer"`
    }
    if (name === 'a') {
      const href = attrs.has('href') ? safeHref(attrs.get('href')!) : null
      if (href?.startsWith('#')) attrText += ` href="${escAttr(href)}" target="_self"`
      else if (href) attrText += ` href="${escAttr(href)}" target="_blank" rel="noopener noreferrer" title="${escAttr(href.slice(0, 500))}"`
    }
    if (attrs.has('background')) {
      const url = imageUrl(attrs.get('background')!, ctx)
      if (url === 'blocked') ctx.blocked++
      else if (url) attrText += ` background="${escAttr(url)}"`
    }
    for (const [k, raw] of attrs) {
      if (k === 'style' || k === 'src' || k === 'href' || k === 'background' || (k === 'title' && name === 'a' && attrText.includes(' title='))) continue
      const check = ATTRS[k]
      const v = decodeEntities(raw)
      if (check?.(v)) attrText += ` ${k}="${escAttr(v)}"`
    }
    if (style) attrText += ` style="${escAttr(style)}"`

    if (VOID.has(name)) {
      out += `<${name}${attrText}>`
      continue
    }
    // Quoted text: folded away, once the message has said something of its own.
    const quote = !quoted && ownText > 0 ? quoteKind(name, attrs) : null
    if (quote) {
      quoted = true
      out += '<details class="mail-quote"><summary>Show quoted text</summary>'
    }
    if (quote === 'rest') {
      // Outlook: from here to the end of the element around it, which closes the wrapper too.
      stack.push({ name: '#quote', out: '' })
    }
    out += `<${name}${attrText}>`
    stack.push({ name, out: name, ...(quote === 'element' ? { quote } : {}) })
  }
  while (stack.length) close(stack.pop()!)
  return { html: out, blocked: ctx.blocked, trackers: ctx.trackers, cids: [...ctx.cids] }
}
