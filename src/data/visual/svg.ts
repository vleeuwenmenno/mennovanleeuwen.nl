// The `scene` kind of visual block (spec.ts): a drawing the model writes as SVG. Models write it,
// so it is untrusted markup, and this file is the wall between it and the page:
//
// 1. sanitizeSvg reads the text with its own small XML reader (no DOM, so the server and the check
//    script use it too) and keeps only an allowlist of drawing elements and attributes. Everything
//    else goes, with what it held: scripts, foreignObject, animation, links, nested <svg>, event
//    handlers, any reference that is not to an element of the drawing itself (#id), CSS that could
//    load something. A DOCTYPE and its entities are skipped and never expanded.
// 2. serializeSvg writes a new document from that tree (never the model's text), escaping every
//    value, with the theme's colours and the icon library's pictures filled in.
// 3. Visual.tsx shows the result as an <img> from a data: URL. An SVG in an <img> runs no script
//    and loads nothing from outside, even when step 1 had missed something; a data: URL (unlike a
//    blob: one) also has no origin of ours if someone opens the picture in a tab of its own.

export type SvgNode = { tag: string; attrs: [string, string][]; children: (SvgNode | string)[] }
export type SceneSvg = {
  /** The drawing's children (the root <svg> itself is written by serializeSvg) */
  children: (SvgNode | string)[]
  /** Allowed presentation attributes from the model's root <svg> (fill, font-size...) */
  rootAttrs: [string, string][]
  viewBox: [number, number, number, number]
  /** What the drawing places: icon library slugs (icon:<slug>) and found pictures as image:<id> */
  icons: string[]
  /** Text of the drawing's labels, for the text version */
  labels: string[]
}
export type IconPlacement = { slug: string; x: number; y: number; width: number; height: number }
/** The key a picture reference goes by: an icon's slug (icon:<slug>), a found picture's whole image:<id>. */
export const pictureKey = (href: string) => (href.startsWith('icon:') ? href.slice(5) : href)

export const SCENE_LIMITS = { chars: 120_000, elements: 3000, depth: 40, uses: 200, icons: 40, value: 20_000, text: 400, size: 4000 }

/**
 * The colour names a scene may use, as a bare value (`fill="accent"`) or as a variable
 * (`var(--accent)`); each is the current theme's colour (Visual.tsx reads them from the page).
 * `panel` is a raised surface, `border` a line colour; the hues are the theme's own.
 */
export const SCENE_PALETTE = ['accent', 'fg', 'bright', 'muted', 'bg', 'panel', 'border', 'red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'magenta'] as const
export type ScenePalette = Record<(typeof SCENE_PALETTE)[number], string>
/** Which CSS variable of the theme each palette name is (theme.ts sets them). */
export const PALETTE_VARS: ScenePalette = { accent: '--accent', fg: '--fg', bright: '--fg-bright', muted: '--muted', bg: '--bg', panel: '--bg-light', border: '--line-strong', red: '--red', orange: '--orange', yellow: '--yellow', green: '--green', cyan: '--cyan', blue: '--blue', magenta: '--magenta' }
/** Aliases models reach for. */
const PALETTE_ALIAS: Record<string, keyof ScenePalette> = { text: 'fg', foreground: 'fg', 'fg-bright': 'bright', background: 'bg', surface: 'panel', card: 'panel', 'bg-light': 'panel', line: 'border', 'line-strong': 'border', purple: 'magenta' }

// --- what is allowed ---------------------------------------------------------------------------

const ELEMENTS = ['g', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'path', 'text', 'tspan', 'defs', 'linearGradient', 'radialGradient', 'stop', 'marker', 'pattern', 'clipPath', 'use', 'title', 'desc', 'image', 'style']
const ELEMENT = new Map(ELEMENTS.map((e) => [e.toLowerCase(), e]))
/** Elements whose text is kept. */
const TEXTUAL = new Set(['text', 'tspan', 'title', 'desc', 'style'])
/** Elements that draw something (a drawing with none of these is empty). */
const DRAWS = new Set(['rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'path', 'text', 'use', 'image'])

const GEOMETRY = ['x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'fx', 'fy', 'fr', 'width', 'height', 'd', 'points', 'dx', 'dy', 'rotate', 'textLength', 'lengthAdjust', 'pathLength', 'viewBox', 'preserveAspectRatio', 'refX', 'refY', 'markerWidth', 'markerHeight', 'markerUnits', 'orient', 'patternUnits', 'patternContentUnits', 'patternTransform', 'gradientUnits', 'gradientTransform', 'spreadMethod', 'offset', 'clipPathUnits', 'transform']
/** Presentation attributes, which are also the CSS properties a style may set. */
const PAINT = ['fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-miterlimit', 'stroke-opacity', 'opacity', 'stop-color', 'stop-opacity', 'color', 'clip-path', 'clip-rule', 'visibility', 'display', 'paint-order', 'vector-effect', 'shape-rendering', 'marker-start', 'marker-mid', 'marker-end', 'marker', 'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant', 'text-anchor', 'dominant-baseline', 'alignment-baseline', 'baseline-shift', 'letter-spacing', 'word-spacing', 'text-decoration', 'writing-mode']
const ATTR = new Map([...GEOMETRY, ...PAINT, 'id', 'class', 'style'].map((a) => [a.toLowerCase(), a]))
const CSS_PROPS = new Set(PAINT)
/** Values that may hold url(#id): a paint server, a clip path or a marker. */
const URL_OK = new Set(['fill', 'stroke', 'clip-path', 'marker-start', 'marker-mid', 'marker-end', 'marker'])
/** Values that are colours, where palette names are resolved. */
const COLOUR = new Set(['fill', 'stroke', 'stop-color', 'color'])

// --- reading the markup ------------------------------------------------------------------------

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g
const NAMED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ' }
/** XML's own entities and character references; any other `&name;` stays as written (it is never expanded). */
function decode(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z]{2,6});/g, (all, e: string) => {
    if (e[0] !== '#') return NAMED[e] ?? all
    const n = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
    return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '�'
  })
}

type Token = { kind: 'open'; name: string; attrs: [string, string][]; self: boolean } | { kind: 'close'; name: string } | { kind: 'text'; text: string }

/** The markup as tags and text. Comments, processing instructions and a DOCTYPE (with its entities) are skipped. */
function tokens(s: string, warn: (m: string) => void): Token[] {
  const out: Token[] = []
  let i = 0
  let text = ''
  const flush = () => {
    if (text) out.push({ kind: 'text', text: decode(text) })
    text = ''
  }
  while (i < s.length) {
    const lt = s.indexOf('<', i)
    if (lt < 0) {
      text += s.slice(i)
      break
    }
    text += s.slice(i, lt)
    i = lt
    if (s.startsWith('<!--', i)) {
      const end = s.indexOf('-->', i + 4)
      i = end < 0 ? s.length : end + 3
      continue
    }
    if (s.startsWith('<![CDATA[', i)) {
      const end = s.indexOf(']]>', i + 9)
      flush()
      out.push({ kind: 'text', text: s.slice(i + 9, end < 0 ? s.length : end) })
      i = end < 0 ? s.length : end + 3
      continue
    }
    if (s.startsWith('<!', i)) {
      // A DOCTYPE, maybe with an internal subset in [ ]: skipped whole, so its entities never exist.
      let j = i + 2
      let depth = 0
      for (; j < s.length; j++) {
        if (s[j] === '[') depth++
        else if (s[j] === ']') depth = Math.max(0, depth - 1)
        else if (s[j] === '>' && !depth) break
      }
      warn('The DOCTYPE is ignored')
      i = j + 1
      continue
    }
    if (s.startsWith('<?', i)) {
      const end = s.indexOf('?>', i + 2)
      i = end < 0 ? s.length : end + 2
      continue
    }
    const close = /^<\/\s*([A-Za-z_][\w:.-]*)\s*>/.exec(s.slice(i, i + 200))
    if (close) {
      flush()
      out.push({ kind: 'close', name: close[1] })
      i += close[0].length
      continue
    }
    const open = /^<([A-Za-z_][\w:.-]*)/.exec(s.slice(i, i + 200))
    if (!open) {
      // A lone "<" is text.
      text += '<'
      i++
      continue
    }
    flush()
    const name = open[1]
    let j = i + open[0].length
    const attrs: [string, string][] = []
    let self = false
    for (;;) {
      while (j < s.length && /\s/.test(s[j])) j++
      if (j >= s.length) break
      if (s[j] === '>') {
        j++
        break
      }
      if (s.startsWith('/>', j)) {
        self = true
        j += 2
        break
      }
      const an = /^[^\s=/>"']+/.exec(s.slice(j, j + 200))
      if (!an) {
        j++
        continue
      }
      j += an[0].length
      while (j < s.length && /\s/.test(s[j])) j++
      let value = ''
      if (s[j] === '=') {
        j++
        while (j < s.length && /\s/.test(s[j])) j++
        const q = s[j]
        if (q === '"' || q === "'") {
          const end = s.indexOf(q, j + 1)
          value = s.slice(j + 1, end < 0 ? s.length : end)
          j = end < 0 ? s.length : end + 1
        } else {
          const m = /^[^\s>]+/.exec(s.slice(j)) ?? ['']
          value = m[0].endsWith('/') && s[j + m[0].length] === '>' ? m[0].slice(0, -1) : m[0]
          j += value.length
        }
      }
      attrs.push([an[0], decode(value)])
    }
    out.push({ kind: 'open', name, attrs, self })
    // A style element's text is raw up to its end tag.
    if (!self && name.toLowerCase() === 'style') {
      const end = s.toLowerCase().indexOf('</style', j)
      out.push({ kind: 'text', text: decode(s.slice(j, end < 0 ? s.length : end)) })
      j = end < 0 ? s.length : end
    }
    i = j
  }
  flush()
  return out
}

// --- checking values ---------------------------------------------------------------------------

const ID = /^[A-Za-z_][\w.-]{0,63}$/
/** url(...) that points inside the drawing: url(#id), with or without quotes. */
const LOCAL_URL = /url\(\s*(['"]?)#[A-Za-z_][\w.-]{0,63}\1\s*\)/gi
/** A value that could reach outside the drawing or run something. */
function unsafe(v: string, urlOk: boolean): boolean {
  const flat = v.replace(/\s+/g, '').toLowerCase()
  if (/(javascript|vbscript|livescript|data|https?|ftp|file|blob|about):/.test(flat) || flat.includes('//')) return true
  if (/expression\(|\\|@import|-moz-binding|behavior:|image-set|src\(/.test(flat)) return true
  const rest = v.replace(LOCAL_URL, '')
  if (/url\(/i.test(rest)) return true
  return !urlOk && /url\(/i.test(v)
}

/** A style attribute kept to allowed properties with safe values; '' when nothing is left. */
function cleanStyle(style: string): string {
  const out: string[] = []
  for (const decl of style.split(';')) {
    const at = decl.indexOf(':')
    if (at < 0) continue
    const prop = decl.slice(0, at).trim().toLowerCase()
    const value = decl.slice(at + 1).trim().replace(/\s*!important$/i, '')
    if (!CSS_PROPS.has(prop) || !value || value.length > 500 || /[{}<>]/.test(value) || unsafe(value, URL_OK.has(prop))) continue
    out.push(`${prop}:${value}`)
  }
  return out.join(';')
}

/** A <style> element's CSS, or null when it holds anything that could load or hide something. */
function cleanCss(css: string): string | null {
  const c = css.replace(CONTROL, '')
  if (c.length > 8000 || /[<\\@]|\/\*/.test(c)) return null
  if (unsafe(c, true)) return null
  // Only rules of allowed properties: selector { prop: value; ... }.
  const rules = [...c.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  if (c.replace(/([^{}]+)\{([^{}]*)\}/g, '').trim()) return null
  const out = rules.map((r) => {
    const sel = r[1].trim()
    if (!/^[\w\s.#,>:*()+~-]+$/.test(sel)) return ''
    const body = cleanStyle(r[2])
    return body ? `${sel}{${body}}` : ''
  })
  return out.join('')
}

const num = (v: string | undefined) => {
  const n = v === undefined ? NaN : parseFloat(v)
  return Number.isFinite(n) ? n : undefined
}

// --- the sanitizer -----------------------------------------------------------------------------

export type SanitizeOptions = { width?: number; height?: number; viewBox?: string; icons?: IconPlacement[] }
export type SanitizeResult = { ok: true; scene: SceneSvg; warnings: string[] } | { ok: false; message: string; warnings: string[] }

/** Reads model-written SVG into a tree of allowed elements and attributes only (see the top of the file). */
export function sanitizeSvg(src: string, opts: SanitizeOptions = {}): SanitizeResult {
  const warnings: string[] = []
  const warned = new Set<string>()
  const warn = (m: string) => {
    if (!warned.has(m)) warnings.push(m)
    warned.add(m)
  }
  if (src.length > SCENE_LIMITS.chars) return { ok: false, message: `The drawing is too long (${src.length} characters; at most ${SCENE_LIMITS.chars})`, warnings }
  const toks = tokens(src.replace(CONTROL, ''), warn)
  const dropped = new Set<string>()
  const icons = new Set<string>()
  let elements = 0
  let rootAttrs: [string, string][] | null = null
  let rootSeen = false
  const top: SvgNode = { tag: '#root', attrs: [], children: [] }
  // The open elements: a node, or null for an element that is dropped with everything in it.
  const stack: { name: string; node: SvgNode | null }[] = [{ name: '#root', node: top }]
  const parent = () => stack[stack.length - 1]

  const attrsOf = (tag: string, raw: [string, string][]): [string, string][] | null => {
    const out: [string, string][] = []
    const seen = new Set<string>()
    for (const [rawName, rawValue] of raw) {
      const lower = rawName.toLowerCase()
      const value = rawValue.replace(CONTROL, '').trim()
      if (value.length > SCENE_LIMITS.value) continue
      if (lower === 'href' || lower === 'xlink:href') {
        if ((tag === 'use' || tag === 'linearGradient' || tag === 'radialGradient' || tag === 'pattern') && /^#[A-Za-z_][\w.-]{0,63}$/.test(value)) out.push(['href', value])
        else if (tag === 'image' && /^icon:[a-z0-9_-]{1,64}$/i.test(value)) out.push(['href', value.toLowerCase()])
        else if (tag === 'image' && /^image:[A-Za-z0-9_-]{6,64}$/.test(value)) out.push(['href', value])
        else if (tag === 'image' || tag === 'use') return null
        continue
      }
      const name = ATTR.get(lower)
      if (!name || seen.has(name)) continue
      if (name === 'id' && !ID.test(value)) continue
      if (name === 'class' && !/^[\w\s-]{0,200}$/.test(value)) continue
      if (name === 'style') {
        const s = cleanStyle(value)
        if (s) out.push(['style', s]), seen.add(name)
        continue
      }
      if (unsafe(value, URL_OK.has(name))) continue
      if (COLOUR.has(name) && !/^[#\w\s.,%()+-]*$/.test(value)) continue
      out.push([name, value])
      seen.add(name)
    }
    return out
  }

  for (const t of toks) {
    const p = parent()
    if (t.kind === 'text') {
      if (!p.node || !TEXTUAL.has(p.node.tag)) continue
      const text = p.node.tag === 'style' ? t.text : t.text.replace(/\s+/g, ' ')
      if (text.trim() || (p.node.children.length && text)) p.node.children.push(text.slice(0, p.node.tag === 'style' ? 8000 : SCENE_LIMITS.text))
      continue
    }
    if (t.kind === 'close') {
      // Close the nearest open element of that name (markup from a model is not always tidy).
      for (let k = stack.length - 1; k > 0; k--)
        if (stack[k].name.toLowerCase() === t.name.toLowerCase()) {
          stack.length = k
          break
        }
      continue
    }
    const lower = t.name.toLowerCase()
    const close = () => !t.self && stack.push({ name: t.name, node: null })
    // The outermost <svg> is the drawing; its viewBox and size are read, its children kept.
    if (lower === 'svg' && !rootSeen && p.node === top && !top.children.length) {
      rootSeen = true
      const keep: [string, string][] = []
      const vb = t.attrs.find(([n]) => n.toLowerCase() === 'viewbox')?.[1]
      const w = num(t.attrs.find(([n]) => n.toLowerCase() === 'width')?.[1])
      const h = num(t.attrs.find(([n]) => n.toLowerCase() === 'height')?.[1])
      rootAttrs = keep
      for (const [n, v] of attrsOf('svg', t.attrs) ?? []) if (PAINT.includes(n) || n === 'style' || n === 'class') keep.push([n, v])
      opts = { ...opts, viewBox: opts.viewBox ?? vb, width: opts.width ?? w, height: opts.height ?? h }
      if (!t.self) stack.push({ name: t.name, node: top })
      continue
    }
    const tag = ELEMENT.get(lower)
    if (!p.node || !tag || stack.length > SCENE_LIMITS.depth) {
      if (p.node) dropped.add(lower === 'svg' ? 'a nested svg' : t.name)
      close()
      continue
    }
    if (elements >= SCENE_LIMITS.elements) {
      warn(`Only the first ${SCENE_LIMITS.elements} elements are drawn`)
      close()
      continue
    }
    const attrs = attrsOf(tag, t.attrs)
    if (!attrs) {
      dropped.add(`${tag} with an outside link`)
      close()
      continue
    }
    if (tag === 'image') {
      const href = attrs.find(([n]) => n === 'href')?.[1]
      if (!href) {
        dropped.add('image without icon:<slug> or image:<id>')
        close()
        continue
      }
      icons.add(pictureKey(href))
    }
    const node: SvgNode = { tag, attrs, children: [] }
    p.node.children.push(node)
    elements++
    if (!t.self) stack.push({ name: t.name, node })
  }

  // <style>: its CSS kept only when it is plain rules of allowed properties.
  const walk = (n: SvgNode, fn: (n: SvgNode, parent: SvgNode) => boolean) => {
    n.children = n.children.filter((k) => typeof k === 'string' || fn(k, n))
    for (const k of n.children) if (typeof k !== 'string') walk(k, fn)
  }
  walk(top, (n) => {
    if (n.tag !== 'style') return true
    const css = cleanCss(n.children.filter((k): k is string => typeof k === 'string').join(''))
    if (css === null) dropped.add('style that loads or hides something')
    n.children = css ? [css] : []
    return !!css
  })

  // <use>: only to an element of the drawing that is not its own ancestor and holds no <use>
  // itself, so a drawing cannot make the browser copy copies of copies.
  const byId = new Map<string, SvgNode>()
  const hasUse = (n: SvgNode): boolean => n.children.some((k) => typeof k !== 'string' && (k.tag === 'use' || hasUse(k)))
  walk(top, (n) => {
    const id = n.attrs.find(([a]) => a === 'id')?.[1]
    if (id && !byId.has(id)) byId.set(id, n)
    return true
  })
  let uses = 0
  const usesOk = (n: SvgNode, ancestors: SvgNode[]) => {
    n.children = n.children.filter((k) => {
      if (typeof k === 'string' || k.tag !== 'use') return true
      const target = byId.get(k.attrs.find(([a]) => a === 'href')?.[1]?.slice(1) ?? '')
      const ok = !!target && target !== k && !ancestors.includes(target) && target !== n && !hasUse(target) && target.tag !== 'use' && ++uses <= SCENE_LIMITS.uses
      if (!ok) dropped.add('use that points nowhere or at itself')
      return ok
    })
    for (const k of n.children) if (typeof k !== 'string') usesOk(k, [...ancestors, n])
  }
  usesOk(top, [])

  // Icons from the spec's "icons" list, drawn on top.
  for (const ic of opts.icons ?? []) {
    if (icons.size >= SCENE_LIMITS.icons && !icons.has(ic.slug)) break
    icons.add(ic.slug)
    top.children.push({ tag: 'image', attrs: [['href', ic.slug.startsWith('image:') ? ic.slug : `icon:${ic.slug}`], ['x', String(ic.x)], ['y', String(ic.y)], ['width', String(ic.width)], ['height', String(ic.height)]], children: [] })
  }
  if (icons.size > SCENE_LIMITS.icons) warn(`At most ${SCENE_LIMITS.icons} different icons are shown`)

  if (dropped.size) warn(`Left out: ${[...dropped].slice(0, 6).join(', ')}`)

  // The size: viewBox, else width and height, else a default.
  let vb: [number, number, number, number] | null = null
  const parts = (opts.viewBox ?? '').trim().split(/[\s,]+/).map(Number)
  if (parts.length === 4 && parts.every(Number.isFinite) && parts[2] > 0 && parts[3] > 0) vb = parts as [number, number, number, number]
  else if (opts.width && opts.height && opts.width > 0 && opts.height > 0) vb = [0, 0, opts.width, opts.height]
  else {
    vb = [0, 0, 640, 400]
    warn('No viewBox or width and height: drawn as 640 × 400')
  }
  // A very large viewBox stays (nothing is cut off); serializeSvg caps the size it is shown at.
  if (vb[2] > SCENE_LIMITS.size || vb[3] > SCENE_LIMITS.size) warn(`The drawing is larger than ${SCENE_LIMITS.size} units; it is shown smaller`)

  const draws = (n: SvgNode): boolean => n.children.some((k) => typeof k !== 'string' && ((DRAWS.has(k.tag) && !['defs', 'clipPath', 'marker', 'pattern'].includes(n.tag)) || (!['defs', 'title', 'desc', 'style'].includes(k.tag) && draws(k))))
  if (!draws(top)) return { ok: false, message: dropped.size ? `Nothing safe to draw is left (left out: ${[...dropped].slice(0, 6).join(', ')})` : 'The drawing is empty: it needs shapes such as <rect>, <path> or <text>', warnings }

  const labels: string[] = []
  const collect = (n: SvgNode) => {
    if (n.tag === 'text') {
      const t = textOf(n).trim()
      if (t && !labels.includes(t) && labels.length < 40) labels.push(t.slice(0, 60))
      return
    }
    if (n.tag === 'defs' || n.tag === 'style' || n.tag === 'title' || n.tag === 'desc') return
    for (const k of n.children) if (typeof k !== 'string') collect(k)
  }
  collect(top)
  return { ok: true, scene: { children: top.children, rootAttrs: rootAttrs ?? [], viewBox: vb, icons: [...icons], labels }, warnings }
}

const textOf = (n: SvgNode): string => n.children.map((k) => (typeof k === 'string' ? k : textOf(k))).join('')

// --- writing it out ----------------------------------------------------------------------------

const escText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escAttr = (s: string) => escText(s).replace(/"/g, '&quot;').replace(/\n/g, '&#10;')

/** A palette name (accent, fg, …, or an alias) as its colour, or undefined. */
function paletteColour(name: string, colours: ScenePalette): string | undefined {
  const n = name.trim().toLowerCase().replace(/^--/, '')
  const key = (SCENE_PALETTE as readonly string[]).includes(n) ? (n as keyof ScenePalette) : PALETTE_ALIAS[n]
  return key ? colours[key] : undefined
}

/** var(--name[, fallback]) and bare palette names in a colour value, as the theme's colours. */
export function resolveColours(value: string, colours: ScenePalette, bare = true): string {
  const v = value.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\))?[^()]*))?\)/g, (_, name: string, fallback?: string) => paletteColour(name, colours) ?? (fallback?.trim() || colours.fg))
  if (!bare) return v
  return paletteColour(v, colours) ?? v
}

function styleColours(style: string, colours: ScenePalette): string {
  return style
    .split(';')
    .map((d) => {
      const at = d.indexOf(':')
      if (at < 0) return d
      const prop = d.slice(0, at)
      return `${prop}:${resolveColours(d.slice(at + 1), colours, COLOUR.has(prop.trim()))}`
    })
    .join(';')
}

export type SerializeOptions = {
  colours: ScenePalette
  /** Icon slug (or image:<id>) → data:image/... URL; missing (or null) draws a placeholder tile */
  icons?: Map<string, string | null>
  font?: string
  /** A colour to fill the whole drawing with first (a saved file has no page behind it) */
  background?: string
}

const DATA_IMAGE = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/

/** The sanitized drawing as an SVG document, with the theme's colours and icon pictures filled in. */
export function serializeSvg(scene: SceneSvg, o: SerializeOptions): string {
  const c = o.colours
  const [x, y, w, h] = scene.viewBox
  const k = Math.min(1, SCENE_LIMITS.size / Math.max(w, h))
  const attr = (n: string, v: string) => ` ${n}="${escAttr(v)}"`
  const attrs = (list: [string, string][]) =>
    list
      .map(([n, v]) => {
        if (n === 'style') return attr(n, styleColours(v, c))
        if (COLOUR.has(n)) return attr(n, resolveColours(v, c))
        return attr(n, v)
      })
      .join('')
  const node = (n: SvgNode | string, parent: string): string => {
    if (typeof n === 'string') return escText(parent === 'style' ? resolveColours(n, c, false) : n)
    if (n.tag === 'image') {
      const slug = pictureKey(n.attrs.find(([a]) => a === 'href')?.[1] ?? '')
      const url = o.icons?.get(slug)
      const rest = n.attrs.filter(([a]) => a !== 'href')
      if (url && DATA_IMAGE.test(url)) return `<image${attr('href', url)}${attrs(rest)}/>`
      // A missing icon: a dashed tile with the first letter, where the picture would be.
      const g = (a: string, d: number) => num(n.attrs.find(([b]) => b === a)?.[1]) ?? d
      const [ix, iy, iw, ih] = [g('x', 0), g('y', 0), g('width', 32), g('height', g('width', 32))]
      const letter = slug.startsWith('image:') ? '' : (slug.replace(/[_-]+/g, ' ').trim()[0] ?? '?').toUpperCase()
      const t = n.attrs.find(([a]) => a === 'transform')
      return `<g${t ? attr('transform', t[1]) : ''}><rect${attr('x', String(ix))}${attr('y', String(iy))}${attr('width', String(iw))}${attr('height', String(ih))}${attr('rx', String(Math.min(iw, ih) * 0.18))}${attr('fill', c.panel)}${attr('stroke', c.border)} stroke-dasharray="4 3"/><text${attr('x', String(ix + iw / 2))}${attr('y', String(iy + ih / 2))}${attr('fill', c.muted)}${attr('font-size', String(Math.max(8, Math.min(iw, ih) * 0.45)))} text-anchor="middle" dominant-baseline="central">${escText(letter)}</text></g>`
    }
    const inner = n.children.map((k) => node(k, n.tag)).join('')
    return inner ? `<${n.tag}${attrs(n.attrs)}>${inner}</${n.tag}>` : `<${n.tag}${attrs(n.attrs)}/>`
  }
  // Defaults the drawing's own root attributes may override: text and shapes in the theme's foreground.
  const root = new Map<string, string>([
    ['fill', c.fg],
    ['color', c.fg],
    ['font-family', o.font ?? 'system-ui, -apple-system, "Segoe UI", sans-serif'],
    ['font-size', '14'],
  ])
  for (const [n, v] of scene.rootAttrs) root.set(n, v)
  const back = o.background ? `<rect${attr('x', String(x))}${attr('y', String(y))}${attr('width', String(w))}${attr('height', String(h))}${attr('fill', o.background)}/>` : ''
  const body = back + scene.children.map((k) => node(k, 'svg')).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${[x, y, w, h].join(' ')}" width="${Math.round(w * k)}" height="${Math.round(h * k)}"${attrs([...root])}>${body}</svg>`
}
