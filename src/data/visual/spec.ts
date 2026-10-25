// Visual blocks: a fenced ```visual block in Markdown holding a small JSON spec that renders as a
// flow diagram, crafting grids, a tree, a timeline, a chart, cards, a list, a table or a free drawing
// (Visual.tsx draws them, the terminal and shared pages show visualText's lines). This file reads
// and checks the spec and turns it into one normalised shape; it imports only lang.ts and svg.ts
// (the drawing's sanitizer), so the server (server/shares.ts) and the check script
// (scripts/visual-check.ts) use it as well.
//
// The spec is written by models, small local ones included, so reading it is forgiving: comments,
// trailing commas, single quotes, unquoted keys and missing commas are fine, most fields have
// aliases (edges or links, from or source), a missing `type` is guessed from the fields, and an
// edge to a node that was never listed makes that node. Only a spec that leaves nothing to draw is
// an error, and the error names the field.

/**
 * What a ```visual block holds: one spec, or a list of them (`[{...}, {...}]` or
 * `{"visuals": [...]}`). Every spec has a `type`; the other fields depend on it. Anything named
 * `Item` below is either a string or an object:
 *
 * - `"Oak planks"`: a label. `"icon:oak_planks"`: a picture from the icon library (the label is
 *   the slug, made readable), `"icon:oak_planks Oak planks"` both. `"app:files"`: an MvL OS app's
 *   icon. `"image:<id>"`: a real-world picture the agent found with find_image (served from
 *   /api/agents/images/<id>). An emoji, alone or before the label (`"🍞 Bread"`). `"4x Stick"` or
 *   `"Stick x4"`: a count.
 * - `{ "label": "Oak planks", "icon": "oak_planks", "emoji": "🪵", "count": 4, "note": "any wood" }`
 *   (`icon` may be a slug, `icon:<slug>`, `image:<id>`, `app:<id>` or an emoji; the emoji is the fallback when the
 *   picture is missing).
 *
 * `null`, `""`, `"."` or `"-"` is an empty slot in a grid or an empty table cell.
 */
export type VisualSpec =
  | {
      type: 'flow'
      title?: string
      /** down (default), right, up or left; also TB, LR, BT, RL */
      direction?: string
      /** Items with an `id` (or plain strings, which are their own id); may be left out when every node is in an edge */
      nodes?: (string | (ItemObject & { id?: string; shape?: 'box' | 'round' | 'diamond' | 'circle'; group?: string }))[]
      /** `{ "from": "a", "to": "b", "label": "yes", "dashed": true }`, `["a", "b", "yes"]` or `"a -> b: yes"` */
      edges?: (string | [string, string, string?] | { from: string; to: string; label?: string; dashed?: boolean })[]
      /** Boxes round nodes that name them in `group` */
      groups?: { id: string; label?: string }[]
    }
  | {
      type: 'grid'
      title?: string
      /** Several grids in a row of steps (a recipe chain); or the fields of one grid right here */
      grids?: GridSpec[]
    }
  | ({ type: 'grid'; title?: string } & GridSpec)
  | {
      type: 'tree'
      title?: string
      /** down (default) or right */
      direction?: string
      /** `{ "label": "Root", "children": [ ... ] }`; a list of them for several roots */
      root: TreeSpec | TreeSpec[]
    }
  | {
      type: 'timeline'
      title?: string
      /** In order; `when` is free text (a date, "Day 1", "10:30") */
      events: (string | (ItemObject & { when?: string }))[]
    }
  | {
      type: 'chart'
      title?: string
      /** bar (default), line or pie */
      chart?: 'bar' | 'line' | 'pie'
      /** One value per label in each series; or `data` instead */
      labels?: string[]
      series?: { name?: string; values: (number | null)[] }[]
      /** `[{ "label": "Mon", "value": 3 }]` or `{ "Mon": 3, "Tue": 5 }`: one series */
      data?: { label: string; value: number }[] | Record<string, number>
      /** Shown after the values ("kg", "%") */
      unit?: string
      /** Axis titles */
      x?: string
      y?: string
    }
  | {
      type: 'cards'
      title?: string
      cards: (string | (ItemObject & { text?: string; value?: string | number; tags?: string[] }))[]
    }
  | {
      type: 'list'
      title?: string
      /** Numbers before the titles (default true) */
      numbered?: boolean
      /** Rows with a picture on the left: a shopping list, places to visit, mods to install */
      items: (string | ListItemSpec)[]
    }
  | {
      type: 'table'
      title?: string
      columns: string[]
      /** Each cell an Item (so a cell can have an icon) or a number */
      rows: (Item | number | null)[][]
    }
  | {
      type: 'scene'
      title?: string
      /** Under the drawing */
      caption?: string
      /**
       * The drawing as SVG (a list of strings is joined with newlines): an <svg viewBox="..."> or
       * just its shapes. Only drawing elements and attributes are kept (svg.ts). Colours may be the
       * theme's: "accent", "fg", "muted", "bg", "panel", "border" and the hues ("blue", "red"...),
       * bare or as var(--accent). <image href="icon:<slug>"> places an icon library picture.
       */
      svg: string | string[]
      /** The drawing's size when the svg has no viewBox */
      width?: number
      height?: number
      viewBox?: string | number[]
      /** Icon library pictures on top of the drawing */
      icons?: { icon: string; x: number; y: number; size?: number; width?: number; height?: number }[]
    }

/** One grid: rows × cols of slots, an arrow (with `via` on it) and what comes out. */
export type GridSpec = {
  title?: string
  /** Rows of slots (`[["a", null], ["b", "c"]]`), or one flat list with `cols` */
  slots?: (Item | null)[] | (Item | null)[][]
  cols?: number
  /** Minecraft style: rows of letters, each letter an Item from `key` (space or . is empty) */
  pattern?: string[]
  key?: Record<string, Item>
  /** Written on the arrow: "Crafting table", "Furnace", "Bake 20 min" */
  via?: string
  result?: Item | Item[]
}

/** One row of a list: picture, bold title, a line of text, bold label rows, a note. */
export type ListItemSpec = {
  title?: string
  /** `image:<id>` (find_image), `icon:<slug>`, an emoji or `app:<id>` */
  image?: string
  emoji?: string
  /** One line under the title (`subtitle` or `description` also work) */
  text?: string
  /** Label → value rows, `{"Quantity": "Lots!"}`, or `[["Quantity", "Lots!"]]` */
  fields?: Record<string, string | number> | [string, string | number][] | { label: string; value: string | number }[]
  note?: string
  /** Shows a checkbox (ticking it changes only what is shown, not the answer) */
  checked?: boolean
  /** A short badge after the title ("¥398") */
  value?: string | number
}

export type TreeSpec = string | (ItemObject & { children?: TreeSpec[] })
export type ItemObject = { label?: string; icon?: string; emoji?: string; count?: number; note?: string }
export type Item = string | ItemObject

// --- the normalised shapes the renderer draws -------------------------------------------------

export type VItem = {
  label: string
  /** An icon library slug, [a-z0-9_-] */
  icon?: string
  /** An MvL OS app id */
  app?: string
  /** A found picture's id (find_image), served from /api/agents/images/<id> */
  image?: string
  emoji?: string
  count?: number
  note?: string
}
export type Shape = 'box' | 'round' | 'diamond' | 'circle'
export type Direction = 'down' | 'right' | 'up' | 'left'
export type FlowNode = VItem & { id: string; shape: Shape; group?: string }
export type FlowEdge = { from: string; to: string; label?: string; dashed?: boolean }
export type Grid = { title?: string; rows: number; cols: number; slots: (VItem | null)[]; via?: string; result: VItem[] }
export type TreeNode = VItem & { children: TreeNode[] }
export type Series = { name: string; values: (number | null)[] }
export type Card = VItem & { text?: string; value?: string; tags: string[] }
export type TimelineEvent = VItem & { when?: string }
export type ListRow = { title: string; picture?: VItem; text?: string; fields: [string, string][]; note?: string; checked?: boolean; value?: string; tags: string[] }

export type Visual =
  | { type: 'flow'; title?: string; direction: Direction; nodes: FlowNode[]; edges: FlowEdge[]; groups: { id: string; label: string }[] }
  | { type: 'grid'; title?: string; grids: Grid[] }
  | { type: 'tree'; title?: string; direction: Direction; roots: TreeNode[] }
  | { type: 'timeline'; title?: string; events: TimelineEvent[] }
  | { type: 'chart'; title?: string; chart: 'bar' | 'line' | 'pie'; labels: string[]; series: Series[]; unit?: string; x?: string; y?: string }
  | { type: 'cards'; title?: string; cards: Card[] }
  | { type: 'list'; title?: string; numbered: boolean; items: ListRow[] }
  | { type: 'table'; title?: string; columns: string[]; rows: (VItem | null)[][] }
  | { type: 'scene'; title?: string; caption?: string; scene: SceneSvg }

export type VisualType = Visual['type']
export const VISUAL_TYPES: VisualType[] = ['flow', 'grid', 'tree', 'timeline', 'chart', 'cards', 'list', 'table', 'scene']

export type VisualProblem = { path: string; message: string }
export type VisualResult = { ok: true; visuals: Visual[]; warnings: VisualProblem[] } | { ok: false; errors: VisualProblem[]; warnings: VisualProblem[] }

/** Limits that keep a spec cheap to lay out and draw; past them the rest is left out (a warning). */
export const LIMITS = { visuals: 12, nodes: 150, edges: 300, gridSide: 12, grids: 24, results: 6, series: 8, points: 400, cards: 100, items: 100, fields: 12, events: 200, treeNodes: 300, columns: 20, rows: 300, text: 200 }

import { sanitizeSvg, type IconPlacement, type SceneSvg } from './svg.ts'

// --- loose JSON -------------------------------------------------------------------------------

/** Where in the text a JSON problem is, as line and column (1-based). */
function lineCol(text: string, at: number) {
  const before = text.slice(0, at).split('\n')
  return { line: before.length, col: before[before.length - 1].length + 1 }
}

class LooseError extends Error {
  at: number
  constructor(message: string, at: number) {
    super(message)
    this.at = at
  }
}

/**
 * JSON as models write it: also comments (// and /* *\/), trailing commas, single-quoted strings,
 * unquoted keys, bare words as strings and a missing comma between items.
 */
export function parseLoose(text: string): { ok: true; value: unknown } | { ok: false; message: string; line: number; col: number } {
  let i = 0
  const s = text
  const fail = (message: string, at = i): never => {
    throw new LooseError(message, at)
  }
  const space = () => {
    for (;;) {
      while (i < s.length && /\s/.test(s[i])) i++
      if (s.startsWith('//', i) || s[i] === '#') {
        while (i < s.length && s[i] !== '\n') i++
      } else if (s.startsWith('/*', i)) {
        const end = s.indexOf('*/', i + 2)
        i = end < 0 ? s.length : end + 2
      } else return
    }
  }
  const str = (): string => {
    const q = s[i++]
    let out = ''
    while (i < s.length && s[i] !== q) {
      const c = s[i++]
      if (c === '\\') {
        const e = s[i++]
        if (e === 'n') out += '\n'
        else if (e === 't') out += '\t'
        else if (e === 'r') out += ''
        else if (e === 'u') {
          const hex = s.slice(i, i + 4)
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('A \\u escape needs four hex digits', i)
          out += String.fromCharCode(parseInt(hex, 16))
          i += 4
        } else if (e === undefined) fail('The text ends inside a string')
        else out += e
      } else if (c === '\n' && q !== '`') fail('A string runs past the end of its line (a closing quote is missing)', i - 1)
      else out += c
    }
    if (i >= s.length) fail('The text ends inside a string (a closing quote is missing)')
    i++
    return out
  }
  const BARE = /[A-Za-z_$\u00c0-\uffff][^\s,[\]{}"'`]*/y
  const bare = (key: boolean): string => {
    // A key ends at its colon; a bare value may hold one (icon:stick).
    const re = key ? /[A-Za-z_$\u00c0-\uffff][\w$\-\u00c0-\uffff]*/y : BARE
    re.lastIndex = i
    const m = re.exec(s)
    if (!m) fail(`Unexpected ${s[i] === undefined ? 'end of the text' : `"${s[i]}"`}`)
    i += m![0].length
    return m![0]
  }
  const value = (depth: number): unknown => {
    if (depth > 40) fail('Nested too deeply')
    space()
    const c = s[i]
    if (c === undefined) fail('The text ends where a value should be')
    if (c === '{') {
      i++
      const out: Record<string, unknown> = {}
      for (;;) {
        space()
        if (s[i] === '}') {
          i++
          return out
        }
        if (s[i] === ',') {
          i++
          continue
        }
        if (i >= s.length) fail('The text ends inside an object (a } is missing)')
        const keyAt = i
        const key = s[i] === '"' || s[i] === "'" || s[i] === '`' ? str() : bare(true)
        space()
        if (s[i] !== ':' && s[i] !== '=') fail(`A ":" should follow the key "${key}"`, i < s.length ? i : keyAt)
        i++
        if (key !== '__proto__') out[key] = value(depth + 1)
        else value(depth + 1)
        space()
        if (s[i] === ',') i++
      }
    }
    if (c === '[') {
      i++
      const out: unknown[] = []
      for (;;) {
        space()
        if (s[i] === ']') {
          i++
          return out
        }
        if (s[i] === ',') {
          i++
          continue
        }
        if (i >= s.length) fail('The text ends inside a list (a ] is missing)')
        out.push(value(depth + 1))
        space()
        if (s[i] === ',') i++
      }
    }
    if (c === '"' || c === "'" || c === '`') return str()
    const num = /[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/y
    num.lastIndex = i
    const n = num.exec(s)
    if (n && !/[A-Za-z_]/.test(s[i + n[0].length] ?? '')) {
      i += n[0].length
      return Number(n[0])
    }
    if (c === '}' || c === ']' || c === ':' || c === ',') fail(`Unexpected "${c}"`)
    const word = bare(false)
    if (word === 'true') return true
    if (word === 'false') return false
    if (word === 'null' || word === 'undefined') return null
    return word
  }
  try {
    const v = value(0)
    space()
    if (i < s.length) fail('More text follows the spec (only one JSON value fits in a block; wrap several in [ ])')
    return { ok: true, value: v }
  } catch (e) {
    const at = e instanceof LooseError ? e.at : i
    return { ok: false, message: (e as Error).message, ...lineCol(text, Math.min(at, text.length)) }
  }
}

// --- reading the spec -------------------------------------------------------------------------

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const clip = (s: string, n = LIMITS.text) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
/** The first of `keys` that `o` has (aliases), or undefined. */
const pick = (o: Obj, ...keys: string[]) => {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k]
  return undefined
}
const text = (v: unknown): string | undefined => (typeof v === 'string' ? (v.trim() ? clip(v.trim()) : undefined) : typeof v === 'number' && Number.isFinite(v) ? String(v) : undefined)

const EMOJI = /^(\p{Extended_Pictographic}|\p{Regional_Indicator})(\p{Emoji_Modifier}|\uFE0F|\u200D(\p{Extended_Pictographic}|\p{Emoji_Modifier})|\uFE0F|\u20E3|\p{Regional_Indicator})*/u
/** A slug as the icon library writes them: lower case, [a-z0-9_-]. */
export function iconSlug(raw: string): string | undefined {
  const s = raw
    .trim()
    .toLowerCase()
    .replace(/^icon:/, '')
    .replace(/\.png$/, '')
    .replace(/[\s.]+/g, '_')
  return /^[a-z0-9_-]{1,64}$/.test(s) ? s : undefined
}
/** "oak_planks" as "Oak planks". */
export const humanize = (slug: string) => {
  const t = slug.replace(/[_-]+/g, ' ').trim()
  return t ? t[0].toUpperCase() + t.slice(1) : slug
}
/** A found picture's id as image:<id> carries it (find_image's ids; generated pictures' too). */
export const IMAGE_ID = /^[A-Za-z0-9_-]{6,64}$/
/** "image:<id>" as its id, or undefined. */
export function imageRef(raw: string): string | undefined {
  const m = /^image:([A-Za-z0-9_-]{6,64})$/i.exec(raw.trim())
  return m ? m[1] : undefined
}
const EMPTY = new Set(['', '.', '-', '_', 'empty', 'none', 'null'])

/** Puts an icon field's value (slug, icon:slug, app:id or emoji) on `it`. */
function iconInto(it: VItem, raw: string) {
  const r = raw.trim()
  const e = EMOJI.exec(r)
  if (e && e[0].length === r.length) return void (it.emoji ??= r)
  const img = imageRef(r)
  if (img) return void (it.image = img)
  if (/^image:/i.test(r)) return
  if (/^app:/i.test(r)) {
    const id = r.slice(4).trim().toLowerCase()
    if (/^[a-z][a-z0-9-]{0,30}$/.test(id)) it.app = id
    return
  }
  const slug = iconSlug(r)
  if (slug) it.icon = slug
}

/** An Item: a string with its shorthands, or an object. Null for an empty slot. */
export function readItem(v: unknown): VItem | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'number' || typeof v === 'boolean') return { label: String(v) }
  if (typeof v === 'string') {
    let s = v.trim()
    if (EMPTY.has(s.toLowerCase())) return null
    const it: VItem = { label: '' }
    // A count: "4x Stick", "4 × Stick", "Stick x4".
    const pre = /^(\d{1,5})\s*[x×]\s+(.+)$/i.exec(s) ?? /^(\d{1,5})[x×](\S.*)$/i.exec(s)
    const post = /^(.+?)\s+[x×]\s?(\d{1,5})$/i.exec(s)
    if (pre) {
      it.count = Number(pre[1])
      s = pre[2].trim()
    } else if (post) {
      it.count = Number(post[2])
      s = post[1].trim()
    }
    const ref = /^(icon|app|image):([A-Za-z0-9_-]+)\s*(.*)$/i.exec(s)
    if (ref) {
      const kind = ref[1].toLowerCase()
      if (kind === 'app') it.app = ref[2].toLowerCase()
      else if (kind === 'image') {
        if (IMAGE_ID.test(ref[2])) it.image = ref[2]
      } else it.icon = iconSlug(ref[2])
      s = ref[3].trim()
      if (!s && kind !== 'image') s = humanize(ref[2].toLowerCase())
    }
    const e = EMOJI.exec(s)
    if (e) {
      it.emoji = e[0]
      s = s.slice(e[0].length).trim()
    }
    it.label = clip(s)
    return it
  }
  if (isObj(v)) {
    const it: VItem = { label: text(pick(v, 'label', 'name', 'title', 'item', 'text')) ?? '' }
    const icon = pick(v, 'icon', 'image', 'img', 'picture', 'photo')
    if (typeof icon === 'string') iconInto(it, icon)
    // An image next to an icon: the icon is the fallback picture.
    const photo = pick(v, 'image', 'photo', 'picture')
    if (typeof photo === 'string' && photo !== icon) iconInto(it, photo)
    const emoji = text(v.emoji)
    if (emoji) it.emoji = emoji
    const app = text(v.app)
    if (app && /^[a-z][a-z0-9-]{0,30}$/i.test(app.replace(/^app:/i, ''))) it.app = app.replace(/^app:/i, '').toLowerCase()
    const count = Number(pick(v, 'count', 'qty', 'quantity', 'amount', 'n'))
    if (Number.isFinite(count) && count > 0 && pick(v, 'count', 'qty', 'quantity', 'amount', 'n') !== undefined) it.count = Math.round(count * 100) / 100
    const note = text(pick(v, 'note', 'description', 'desc', 'subtitle', 'detail'))
    if (note) it.note = note
    if (!it.label && it.icon) it.label = humanize(it.icon)
    return it
  }
  return null
}

const DIRS: Record<string, Direction> = { down: 'down', tb: 'down', td: 'down', 'top-down': 'down', vertical: 'down', right: 'right', lr: 'right', horizontal: 'right', 'left-right': 'right', up: 'up', bt: 'up', left: 'left', rl: 'left' }
const direction = (v: unknown, fallback: Direction): Direction => (typeof v === 'string' ? (DIRS[v.trim().toLowerCase()] ?? fallback) : fallback)
const SHAPES: Record<string, Shape> = { box: 'box', rect: 'box', square: 'box', round: 'round', rounded: 'round', pill: 'round', stadium: 'round', diamond: 'diamond', decision: 'diamond', rhombus: 'diamond', circle: 'circle', oval: 'circle', ellipse: 'circle', start: 'round', end: 'round' }

/** What the fields say a spec without a `type` is. */
function guessType(o: Obj): VisualType | undefined {
  if (o.svg || o.drawing) return 'scene'
  if (o.edges || o.links || o.connections || o.nodes) return 'flow'
  if (o.grids || o.recipes || o.slots || o.pattern || o.ingredients || o.grid) return 'grid'
  if (o.root || o.children || o.tree) return 'tree'
  if (o.events || o.timeline || o.milestones) return 'timeline'
  if (o.series || o.data || o.values) return 'chart'
  if (o.cards) return 'cards'
  if (o.items || o.products) return 'list'
  if (o.columns || o.rows || o.headers) return 'table'
  return undefined
}

const TYPE_ALIASES: Record<string, VisualType> = { flowchart: 'flow', diagram: 'flow', graph: 'flow', process: 'flow', recipe: 'grid', recipes: 'grid', crafting: 'grid', bar: 'chart', line: 'chart', pie: 'chart', card: 'cards', list: 'list', checklist: 'list', shopping: 'list', shopping_list: 'list', shoppinglist: 'list', items: 'list', timeline: 'timeline', events: 'timeline', table: 'table', tree: 'tree', mindmap: 'tree', drawing: 'scene', svg: 'scene', picture: 'scene', illustration: 'scene', sketch: 'scene' }

type Ctx = { errors: VisualProblem[]; warnings: VisualProblem[] }
const warn = (c: Ctx, path: string, message: string) => void c.warnings.push({ path, message })
const err = (c: Ctx, path: string, message: string) => void c.errors.push({ path, message })
const list = (v: unknown): unknown[] | undefined => (Array.isArray(v) ? v : undefined)
/** `arr` cut to `max`, with a warning when that left some out. */
function capped<T>(c: Ctx, path: string, arr: T[], max: number): T[] {
  if (arr.length <= max) return arr
  warn(c, path, `Only the first ${max} of ${arr.length} are shown`)
  return arr.slice(0, max)
}

function readFlow(o: Obj, c: Ctx, p: string): Visual | null {
  const nodes: FlowNode[] = []
  const byId = new Map<string, FlowNode>()
  const byLabel = new Map<string, FlowNode>()
  const add = (n: FlowNode) => {
    if (byId.has(n.id)) return byId.get(n.id)!
    if (nodes.length >= LIMITS.nodes) return null
    nodes.push(n)
    byId.set(n.id, n)
    if (n.label) byLabel.set(n.label.toLowerCase(), n)
    return n
  }
  const rawNodes = pick(o, 'nodes', 'steps', 'items', 'boxes')
  if (rawNodes !== undefined && !list(rawNodes) && !isObj(rawNodes)) err(c, `${p}nodes`, 'Should be a list of nodes')
  // `nodes` as an object: { "a": "Label", "b": { "label": ... } }.
  const entries: [string | null, unknown][] = list(rawNodes) ? (rawNodes as unknown[]).map((n) => [null, n]) : isObj(rawNodes) ? Object.entries(rawNodes) : []
  if (entries.length > LIMITS.nodes) warn(c, `${p}nodes`, `Only the first ${LIMITS.nodes} of ${entries.length} are shown`)
  entries.slice(0, LIMITS.nodes).forEach(([k, raw], i) => {
    const it = readItem(raw)
    if (!it) return warn(c, `${p}nodes[${k ?? i}]`, 'Empty node left out')
    const r = isObj(raw) ? raw : {}
    const id = text(pick(r, 'id', 'key')) ?? k ?? (typeof raw === 'string' ? raw.trim() : it.label || `n${i}`)
    if (!it.label) it.label = isObj(raw) && !it.icon && !it.emoji && !it.app ? id : it.label
    const shape = SHAPES[String(pick(r, 'shape', 'kind') ?? '').toLowerCase()] ?? 'box'
    const group = text(pick(r, 'group', 'parent', 'lane'))
    if (byId.has(id)) warn(c, `${p}nodes[${k ?? i}].id`, `"${id}" is used twice; the first one is kept`)
    add({ ...it, id, shape, ...(group ? { group } : {}) })
  })
  /** A node an edge names: by id, else by label, else a new node with that text. */
  const ref = (v: unknown, path: string): string | null => {
    if (isObj(v)) {
      const id = text(pick(v, 'id', 'key', 'label', 'name'))
      if (!id) return (err(c, path, 'An edge end needs a node id'), null)
      if (!byId.has(id)) add({ ...(readItem(v) ?? { label: id }), id, shape: 'box' })
      return id
    }
    const t = text(v)
    if (!t) return (err(c, path, 'Missing: which node this edge connects'), null)
    if (byId.has(t)) return t
    const found = byLabel.get(t.toLowerCase())
    if (found) return found.id
    const it = readItem(t) ?? { label: t }
    const made = add({ ...it, label: it.label || t, id: t, shape: 'box' })
    return made ? made.id : null
  }
  const rawEdges = pick(o, 'edges', 'links', 'connections', 'arrows')
  if (rawEdges !== undefined && !list(rawEdges)) err(c, `${p}edges`, 'Should be a list of edges')
  const edges: FlowEdge[] = []
  capped(c, `${p}edges`, list(rawEdges) ?? [], LIMITS.edges).forEach((raw, i) => {
    const path = `${p}edges[${i}]`
    let from: unknown, to: unknown, label: unknown, dashed = false
    if (typeof raw === 'string') {
      // "a -> b", "a --> b: label", "a -> b -> c" (a chain)
      const [chain, ...lab] = raw.split(/:(?![^\s])|\s:\s|\s\|\s/)
      const parts = chain.split(/\s*(?:-+>|=+>|→|⟶|\.+>)\s*/).filter((s) => s.trim())
      if (parts.length < 2) return err(c, path, `"${clip(raw, 40)}" is not an edge: write "a -> b"`)
      dashed = /\.+>|-{3,}>/.test(chain)
      for (let j = 0; j < parts.length - 1; j++) {
        const a = ref(parts[j].trim(), path)
        const b = ref(parts[j + 1].trim(), path)
        if (a && b) edges.push({ from: a, to: b, ...(j === parts.length - 2 && lab.length && lab.join(':').trim() ? { label: clip(lab.join(':').trim(), 60) } : {}), ...(dashed ? { dashed } : {}) })
      }
      return
    }
    if (Array.isArray(raw)) [from, to, label] = raw
    else if (isObj(raw)) {
      from = pick(raw, 'from', 'source', 'src', 'start', 'a')
      to = pick(raw, 'to', 'target', 'dst', 'end', 'b')
      label = pick(raw, 'label', 'text', 'name', 'when')
      dashed = raw.dashed === true || raw.style === 'dashed' || raw.style === 'dotted'
      if (from === undefined) return err(c, `${path}.from`, 'Missing: the node this edge starts at')
      if (to === undefined) return err(c, `${path}.to`, 'Missing: the node this edge goes to')
    } else return err(c, path, 'An edge is {"from": "a", "to": "b"}, ["a", "b"] or "a -> b"')
    // `to` may be a list: one edge to each.
    const targets = Array.isArray(to) ? to : [to]
    const a = ref(from, `${path}.from`)
    for (const t of targets) {
      const b = ref(t, `${path}.to`)
      const l = text(label)
      if (a && b) edges.push({ from: a, to: b, ...(l ? { label: clip(l, 60) } : {}), ...(dashed ? { dashed } : {}) })
    }
  })
  if (!nodes.length) {
    if (!c.errors.length) err(c, `${p}nodes`, 'A flow needs nodes or edges ("edges": ["a -> b"])')
    return null
  }
  // Groups: listed, or made from what nodes name.
  const groups: { id: string; label: string }[] = []
  const seen = new Set<string>()
  for (const [i, g] of (list(o.groups) ?? []).entries()) {
    const id = isObj(g) ? text(pick(g, 'id', 'key', 'label', 'name')) : text(g)
    if (!id) {
      warn(c, `${p}groups[${i}]`, 'A group needs an id')
      continue
    }
    if (seen.has(id)) continue
    seen.add(id)
    groups.push({ id, label: (isObj(g) ? text(pick(g, 'label', 'name', 'title')) : undefined) ?? id })
    // Groups that list their members: { "id": "g", "nodes": ["a", "b"] }
    if (isObj(g)) for (const m of list(pick(g, 'nodes', 'members', 'children')) ?? []) {
      const n = byId.get(String(m)) ?? byLabel.get(String(m).toLowerCase())
      if (n) n.group = id
    }
  }
  for (const n of nodes)
    if (n.group && !seen.has(n.group)) {
      seen.add(n.group)
      groups.push({ id: n.group, label: n.group })
    }
  return { type: 'flow', title: text(o.title), direction: direction(pick(o, 'direction', 'dir', 'layout', 'orientation'), 'down'), nodes, edges, groups }
}

function readGrid(o: Obj, c: Ctx, p: string): Grid | null {
  let rows: (VItem | null)[][] = []
  const pattern = list(o.pattern)
  const slots = pick(o, 'slots', 'grid', 'input', 'inputs', 'ingredients', 'cells')
  if (pattern) {
    const key = isObj(o.key) ? o.key : isObj(o.keys) ? o.keys : isObj(o.legend) ? o.legend : {}
    const items = new Map<string, VItem | null>()
    for (const [k, v] of Object.entries(key)) items.set(k, readItem(v))
    pattern.forEach((line, r) => {
      if (typeof line !== 'string') return err(c, `${p}pattern[${r}]`, 'Each pattern row is a string of letters')
      rows.push(
        [...line].map((ch, col) => {
          if (ch === ' ' || ch === '.' || ch === '_') return null
          if (!items.has(ch)) {
            warn(c, `${p}key`, `"${ch}" (pattern row ${r + 1}, column ${col + 1}) is not in the key`)
            return { label: ch }
          }
          return items.get(ch) ?? null
        }),
      )
    })
  } else if (list(slots)) {
    const arr = slots as unknown[]
    if (arr.some(Array.isArray)) rows = arr.map((r) => (Array.isArray(r) ? r.map(readItem) : [readItem(r)]))
    else {
      const items = arr.map(readItem)
      const cols = Math.max(1, Math.min(LIMITS.gridSide, Math.round(Number(o.cols ?? o.columns ?? o.width)) || (items.length <= 3 ? items.length : 3)))
      for (let i = 0; i < items.length; i += cols) rows.push(items.slice(i, i + cols))
    }
  } else if (slots !== undefined) {
    err(c, `${p}slots`, 'Should be a list of slots, or of rows of slots')
    return null
  }
  if (rows.length > LIMITS.gridSide) {
    warn(c, `${p}slots`, `Only the first ${LIMITS.gridSide} rows are shown`)
    rows = rows.slice(0, LIMITS.gridSide)
  }
  const cols = Math.min(LIMITS.gridSide, Math.max(0, ...rows.map((r) => r.length)))
  const resRaw = pick(o, 'result', 'results', 'output', 'outputs', 'makes', 'yields', 'produces')
  const result = (Array.isArray(resRaw) ? resRaw : resRaw === undefined ? [] : [resRaw]).slice(0, LIMITS.results).map(readItem).filter((x): x is VItem => !!x)
  if (!rows.length && !result.length) {
    err(c, `${p}slots`, 'A grid needs slots (or a pattern) or a result')
    return null
  }
  const flat: (VItem | null)[] = []
  for (const r of rows) for (let i = 0; i < cols; i++) flat.push(r[i] ?? null)
  const via = text(pick(o, 'via', 'station', 'using', 'with', 'action', 'method'))
  return { title: text(pick(o, 'title', 'name', 'label')), rows: rows.length, cols, slots: flat, ...(via ? { via: clip(via, 60) } : {}), result }
}

function readTree(v: unknown, c: Ctx, path: string, count: { n: number }, depth = 0): TreeNode | null {
  if (count.n >= LIMITS.treeNodes) return null
  if (depth > 30) return (warn(c, path, 'Nested too deeply; the rest is left out'), null)
  const it = readItem(v)
  if (!it) return null
  count.n++
  if (!it.label && isObj(v) && !it.icon && !it.emoji) it.label = '…'
  const kids = isObj(v) ? list(pick(v, 'children', 'items', 'nodes', 'kids')) ?? [] : []
  // { "label": "x", "children": { "a": [...], "b": "..." } } is left alone; only lists are read.
  return { ...it, children: kids.map((k, i) => readTree(k, c, `${path}.children[${i}]`, count, depth + 1)).filter((x): x is TreeNode => !!x) }
}

/** A number from a value that may be a string ("12", "3.5 kg", "1,200"). */
function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string') {
    const m = /^[^\d-+.]*([-+]?[\d,]*\.?\d+)/.exec(v.trim())
    const n = m ? Number(m[1].replace(/,/g, '')) : NaN
    return Number.isFinite(n) ? n : null
  }
  return null
}

function readChart(o: Obj, c: Ctx, p: string): Visual | null {
  const kind = String(pick(o, 'chart', 'kind', 'style', 'mark') ?? (o.type === 'bar' || o.type === 'line' || o.type === 'pie' ? o.type : 'bar')).toLowerCase()
  const chart = kind.startsWith('line') || kind === 'area' ? 'line' : kind.startsWith('pie') || kind === 'donut' || kind === 'doughnut' ? 'pie' : 'bar'
  let labels: string[] = (list(pick(o, 'labels', 'categories', 'x_labels', 'xLabels')) ?? []).map((l) => text(l) ?? '')
  let series: Series[] = []
  const data = pick(o, 'data', 'values', 'points')
  const rawSeries = list(o.series)
  if (rawSeries) {
    rawSeries.forEach((s, i) => {
      if (isObj(s)) {
        const vals = pick(s, 'values', 'data', 'points', 'y')
        if (isObj(vals)) {
          if (!labels.length) labels = Object.keys(vals)
          series.push({ name: text(pick(s, 'name', 'label', 'title')) ?? `Series ${i + 1}`, values: labels.map((l) => num((vals as Obj)[l])) })
        } else if (list(vals)) {
          const arr = vals as unknown[]
          // [{label, value}] inside a series.
          if (arr.every(isObj)) {
            if (!labels.length) labels = arr.map((d) => text(pick(d as Obj, 'label', 'x', 'name', 'key')) ?? '')
            series.push({ name: text(pick(s, 'name', 'label')) ?? `Series ${i + 1}`, values: arr.map((d) => num(pick(d as Obj, 'value', 'y', 'v', 'count'))) })
          } else series.push({ name: text(pick(s, 'name', 'label', 'title')) ?? `Series ${i + 1}`, values: arr.map(num) })
        } else err(c, `${p}series[${i}].values`, 'Missing: the numbers of this series')
      } else if (list(s)) series.push({ name: `Series ${i + 1}`, values: (s as unknown[]).map(num) })
      else err(c, `${p}series[${i}]`, 'A series is {"name": "...", "values": [1, 2, 3]}')
    })
  } else if (list(data)) {
    const arr = data as unknown[]
    if (arr.every((d) => isObj(d))) {
      const objs = arr as Obj[]
      labels = objs.map((d) => text(pick(d, 'label', 'name', 'x', 'key', 'category')) ?? '')
      // Several value fields in each row ({label, apples, pears}) make one series each.
      const valueKeys = Object.keys(objs[0] ?? {}).filter((k) => !['label', 'name', 'x', 'key', 'category'].includes(k) && objs.some((d) => num(d[k]) !== null))
      const keys = valueKeys.includes('value') ? ['value'] : valueKeys.length ? valueKeys : ['value']
      series = keys.map((k) => ({ name: k === 'value' || k === 'y' ? (text(o.name) ?? '') : k, values: objs.map((d) => num(d[k])) }))
    } else if (arr.every((d) => Array.isArray(d))) {
      labels = arr.map((d) => text((d as unknown[])[0]) ?? '')
      series = [{ name: text(o.name) ?? '', values: arr.map((d) => num((d as unknown[])[1])) }]
    } else series = [{ name: text(o.name) ?? '', values: arr.map(num) }]
  } else if (isObj(data)) {
    labels = Object.keys(data)
    series = [{ name: text(o.name) ?? '', values: labels.map((l) => num(data[l])) }]
  } else {
    if (!c.errors.length) err(c, `${p}series`, 'A chart needs numbers: "data": [{"label": "A", "value": 3}] or "labels" with "series"')
    return null
  }
  series = capped(c, `${p}series`, series, LIMITS.series)
  const n = Math.min(LIMITS.points, Math.max(labels.length, ...series.map((s) => s.values.length)))
  if (labels.length > n || series.some((s) => s.values.length > LIMITS.points)) warn(c, `${p}data`, `Only the first ${n} values are shown`)
  labels = Array.from({ length: n }, (_, i) => clip(labels[i] || String(i + 1), 40))
  series = series.map((s) => ({ name: clip(s.name, 40), values: Array.from({ length: n }, (_, i) => s.values[i] ?? null) }))
  series.forEach((s, i) => s.values.some((v) => v === null) && warn(c, `${p}series[${i}]`, 'Some values are not numbers and are left out'))
  if (!n || series.every((s) => s.values.every((v) => v === null))) {
    err(c, `${p}data`, 'The chart has no numbers to draw')
    return null
  }
  if (chart === 'pie' && series.length > 1) warn(c, `${p}series`, 'A pie shows one series; only the first is drawn')
  if (chart === 'pie' && series[0].values.some((v) => v !== null && v < 0)) warn(c, `${p}data`, 'A pie cannot show negative values; they are left out')
  const unit = text(pick(o, 'unit', 'units', 'suffix'))
  const x = text(pick(o, 'x', 'xLabel', 'x_label', 'xAxis'))
  const y = text(pick(o, 'y', 'yLabel', 'y_label', 'yAxis'))
  return { type: 'chart', title: text(o.title), chart, labels, series, ...(unit ? { unit: clip(unit, 12) } : {}), ...(x ? { x } : {}), ...(y ? { y } : {}) }
}

function readScene(o: Obj, c: Ctx, p: string): Visual | null {
  const raw = pick(o, 'svg', 'drawing', 'markup', 'content', 'code')
  const src = typeof raw === 'string' ? raw : Array.isArray(raw) && raw.every((l) => typeof l === 'string') ? raw.join('\n') : undefined
  if (src === undefined || !src.trim()) return (err(c, `${p}svg`, raw === undefined ? 'Missing: the drawing, as "svg": "<svg viewBox=\'0 0 400 200\'>...</svg>"' : 'Should be the drawing as one string of SVG'), null)
  const n = (v: unknown) => {
    const x = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN
    return Number.isFinite(x) && x > 0 ? x : undefined
  }
  const vbRaw = pick(o, 'viewBox', 'viewbox', 'view_box')
  const viewBox = Array.isArray(vbRaw) ? vbRaw.join(' ') : typeof vbRaw === 'string' ? vbRaw : undefined
  const icons: IconPlacement[] = []
  ;(list(o.icons) ?? []).forEach((ic, i) => {
    if (!isObj(ic)) return warn(c, `${p}icons[${i}]`, 'An icon is {"icon": "slug", "x": 10, "y": 10, "size": 32}')
    const named = pick(ic, 'icon', 'image', 'slug', 'name')
    // A found picture (image:<id>) goes by its whole reference, an icon by its slug.
    const found = typeof named === 'string' ? imageRef(named) : undefined
    const slug = found ? `image:${found}` : typeof named === 'string' ? iconSlug(named) : undefined
    const x = Number(ic.x)
    const y = Number(ic.y)
    if (!slug || !Number.isFinite(x) || !Number.isFinite(y)) return warn(c, `${p}icons[${i}]`, 'An icon needs a slug, "x" and "y"; left out')
    const size = n(ic.size) ?? 32
    icons.push({ slug, x, y, width: n(ic.width) ?? size, height: n(ic.height) ?? n(ic.width) ?? size })
  })
  const r = sanitizeSvg(src, { width: n(o.width), height: n(o.height), viewBox, icons })
  for (const m of r.warnings) warn(c, `${p}svg`, m)
  if (!r.ok) return (err(c, `${p}svg`, r.message), null)
  const caption = text(pick(o, 'caption', 'note', 'description', 'subtitle'))
  return { type: 'scene', title: text(o.title), ...(caption ? { caption: clip(caption, 400) } : {}), scene: r.scene }
}

/** A list row's picture: image:<id>, icon:<slug>, app:<id> or an emoji. */
function pictureOf(r: Obj): VItem | undefined {
  const it: VItem = { label: '' }
  for (const k of ['icon', 'image', 'img', 'picture', 'photo', 'thumbnail']) {
    const v = r[k]
    if (typeof v === 'string' && v.trim()) iconInto(it, v)
  }
  const emoji = text(r.emoji)
  if (emoji) it.emoji = emoji
  return it.image || it.icon || it.app || it.emoji ? it : undefined
}

/** Label → value rows from an object, a list of pairs, a list of {label, value} or "Label: value" strings. */
function readFields(v: unknown): [string, string][] {
  const out: [string, string][] = []
  const add = (k: unknown, val: unknown) => {
    const label = text(k)
    const value = typeof val === 'boolean' ? (val ? 'Yes' : 'No') : text(val)
    if (label && value && out.length < LIMITS.fields) out.push([clip(label, 40), value])
  }
  if (isObj(v)) for (const [k, val] of Object.entries(v)) add(k, val)
  else if (Array.isArray(v))
    for (const f of v) {
      if (Array.isArray(f)) add(f[0], f[1])
      else if (isObj(f)) add(pick(f, 'label', 'name', 'key'), pick(f, 'value', 'text', 'val'))
      else if (typeof f === 'string' && /^[^:]{1,40}:\s*\S/.test(f)) add(f.slice(0, f.indexOf(':')), f.slice(f.indexOf(':') + 1))
    }
  return out
}

function readList(o: Obj, c: Ctx, p: string): Visual | null {
  const raw = list(pick(o, 'items', 'products', 'entries', 'cards', 'rows', 'list'))
  if (!raw) return (err(c, `${p}items`, 'A list needs "items": [{"title": "...", "image": "image:<id>", "text": "..."}]'), null)
  const items = capped(c, `${p}items`, raw, LIMITS.items)
    .map((x, i): ListRow | null => {
      if (typeof x === 'string' || typeof x === 'number') {
        const it = readItem(x)
        if (!it) return null
        const { label, count, ...pic } = it
        const has = pic.image || pic.icon || pic.app || pic.emoji
        return { title: count !== undefined && count !== 1 ? `${count}× ${label}` : label, ...(has ? { picture: { ...pic, label } } : {}), fields: [], tags: [] }
      }
      if (!isObj(x)) return (warn(c, `${p}items[${i}]`, 'An item is {"title": "...", "text": "..."}; left out'), null)
      const title = text(pick(x, 'title', 'label', 'name', 'item', 'product')) ?? ''
      const picture = pictureOf(x)
      const body = text(pick(x, 'text', 'subtitle', 'description', 'desc', 'summary', 'body'))
      const fields = readFields(pick(x, 'fields', 'details', 'attributes', 'props', 'properties', 'info'))
      // Common fields written on the item itself.
      for (const [k, name] of [['quantity', 'Quantity'], ['qty', 'Quantity'], ['price', 'Price'], ['where', 'Where'], ['store', 'Store'], ['shop', 'Shop']] as const)
        if (x[k] !== undefined && !fields.some(([l]) => l.toLowerCase() === name.toLowerCase())) fields.push(...readFields({ [name]: x[k] }))
      const note = text(pick(x, 'note', 'notes', 'tip', 'comment'))
      const checked = pick(x, 'checked', 'done', 'bought', 'got')
      const value = text(pick(x, 'value', 'badge'))
      const tags = (list(x.tags) ?? []).map((t) => text(t)).filter((t): t is string => !!t).slice(0, 8)
      if (!title && !body && !picture && !fields.length) return (warn(c, `${p}items[${i}]`, 'Empty item left out'), null)
      return { title, ...(picture ? { picture: { ...picture, label: title } } : {}), ...(body ? { text: body } : {}), fields, ...(note ? { note } : {}), ...(typeof checked === 'boolean' ? { checked } : {}), ...(value ? { value: clip(value, 30) } : {}), tags }
    })
    .filter((x): x is ListRow => !!x)
  if (!items.length) return (err(c, `${p}items`, 'The list has no items'), null)
  const numbered = pick(o, 'numbered', 'numbers', 'ordered')
  return { type: 'list', title: text(o.title), numbered: numbered === undefined ? true : numbered !== false && numbered !== 'false', items }
}

function readOne(raw: unknown, c: Ctx, p: string): Visual | null {
  if (!isObj(raw)) {
    err(c, p || '(spec)', 'A visual is a JSON object with a "type", such as {"type": "flow", ...}')
    return null
  }
  const o = raw
  const rawType = typeof pick(o, 'type', 'kind') === 'string' ? String(pick(o, 'type', 'kind')).trim().toLowerCase() : ''
  // The fields only decide when no type was given: a type that is not known is an error, not a guess.
  const type: VisualType | undefined = (VISUAL_TYPES as string[]).includes(rawType) ? (rawType as VisualType) : rawType ? TYPE_ALIASES[rawType] : guessType(o)
  if (!type) {
    err(c, `${p}type`, rawType ? `Unknown type "${clip(rawType, 30)}"; use one of ${VISUAL_TYPES.join(', ')}` : `Missing: the type (${VISUAL_TYPES.join(', ')})`)
    return null
  }
  const title = text(o.title)
  switch (type) {
    case 'flow':
      return readFlow(o, c, p)
    case 'grid': {
      const many = list(pick(o, 'grids', 'recipes', 'steps'))
      const grids = many
        ? capped(c, `${p}grids`, many, LIMITS.grids)
            .map((g, i) => (isObj(g) ? readGrid(g, c, `${p}grids[${i}].`) : (err(c, `${p}grids[${i}]`, 'Each grid is an object with "slots" and "result"'), null)))
            .filter((g): g is Grid => !!g)
        : [readGrid(o, c, p)].filter((g): g is Grid => !!g)
      if (!grids.length) {
        if (!c.errors.length) err(c, `${p}grids`, 'No grids to draw')
        return null
      }
      // The block's title is not also the only grid's title.
      if (!many && grids[0].title === title) delete grids[0].title
      return { type: 'grid', title, grids }
    }
    case 'tree': {
      const r = pick(o, 'root', 'tree', 'roots')
      const count = { n: 0 }
      const roots = (r === undefined ? (o.children ? [{ label: o.label ?? o.name ?? title ?? '', icon: o.icon, emoji: o.emoji, children: o.children }] : []) : Array.isArray(r) ? r : [r])
        .map((x, i) => readTree(x, c, `${p}root${Array.isArray(r) ? `[${i}]` : ''}`, count))
        .filter((x): x is TreeNode => !!x)
      if (count.n >= LIMITS.treeNodes) warn(c, `${p}root`, `Only the first ${LIMITS.treeNodes} nodes are shown`)
      if (!roots.length) {
        err(c, `${p}root`, 'A tree needs a root: {"label": "...", "children": [...]}')
        return null
      }
      return { type: 'tree', title: r === undefined ? undefined : title, direction: direction(pick(o, 'direction', 'dir'), 'down'), roots }
    }
    case 'timeline': {
      const raw = list(pick(o, 'events', 'items', 'timeline', 'milestones', 'steps'))
      if (!raw) {
        err(c, `${p}events`, 'A timeline needs a list of "events"')
        return null
      }
      const events = capped(c, `${p}events`, raw, LIMITS.events)
        .map((e): TimelineEvent | null => {
          const it = readItem(e)
          if (!it) return null
          const when = isObj(e) ? text(pick(e, 'when', 'date', 'time', 'at', 'year', 'day')) : undefined
          return when ? { ...it, when: clip(when, 40) } : it
        })
        .filter((x): x is TimelineEvent => !!x)
      if (!events.length) return (err(c, `${p}events`, 'The timeline has no events'), null)
      return { type: 'timeline', title, events }
    }
    case 'chart':
      return readChart(o, c, p)
    case 'cards': {
      const raw = list(pick(o, 'cards', 'items', 'entries'))
      if (!raw) return (err(c, `${p}cards`, 'Cards need a list of "cards"'), null)
      const cards = capped(c, `${p}cards`, raw, LIMITS.cards)
        .map((x): Card | null => {
          const it = readItem(x)
          if (!it) return null
          const r = isObj(x) ? x : {}
          const body = text(pick(r, 'text', 'body', 'content'))
          const value = text(pick(r, 'value', 'price', 'stat', 'badge'))
          return { ...it, ...(r.label === undefined && r.name === undefined && r.title === undefined && body && it.label === body ? { label: '' } : {}), ...(body ? { text: body } : {}), ...(value ? { value: clip(value, 30) } : {}), tags: (list(r.tags) ?? []).map((t) => text(t)).filter((t): t is string => !!t).slice(0, 8) }
        })
        .filter((x): x is Card => !!x)
      if (!cards.length) return (err(c, `${p}cards`, 'There are no cards'), null)
      return { type: 'cards', title, cards }
    }
    case 'scene':
      return readScene(o, c, p)
    case 'list':
      return readList(o, c, p)
    case 'table': {
      let columns = (list(pick(o, 'columns', 'headers', 'head', 'header')) ?? []).map((h) => (isObj(h) ? text(pick(h, 'label', 'name', 'title')) : text(h)) ?? '')
      const raw = list(pick(o, 'rows', 'data', 'body'))
      if (!raw) return (err(c, `${p}rows`, 'A table needs "rows"'), null)
      // Rows as objects: their keys are the columns.
      if (raw.every(isObj) && raw.length) {
        if (!columns.length) columns = [...new Set((raw as Obj[]).flatMap((r) => Object.keys(r)))]
        const keys = columns
        return { type: 'table', title, columns: capped(c, `${p}columns`, columns, LIMITS.columns), rows: capped(c, `${p}rows`, raw as Obj[], LIMITS.rows).map((r) => keys.slice(0, LIMITS.columns).map((k) => readItem(r[k]))) }
      }
      const rows = capped(c, `${p}rows`, raw, LIMITS.rows).map((r, i) => {
        if (!Array.isArray(r)) {
          warn(c, `${p}rows[${i}]`, 'A row is a list of cells')
          return [readItem(r)]
        }
        return r.slice(0, LIMITS.columns).map(readItem)
      })
      const width = Math.max(columns.length, ...rows.map((r) => r.length))
      columns = capped(c, `${p}columns`, columns, LIMITS.columns)
      return { type: 'table', title, columns: Array.from({ length: Math.min(width, LIMITS.columns) }, (_, i) => columns[i] ?? ''), rows: rows.map((r) => Array.from({ length: Math.min(width, LIMITS.columns) }, (_, i) => r[i] ?? null)) }
    }
  }
}

/** Checks a spec that is already a value (parsed JSON) and normalises it. */
export function validateVisual(value: unknown): VisualResult {
  const c: Ctx = { errors: [], warnings: [] }
  const many = Array.isArray(value) ? value : isObj(value) && Array.isArray(value.visuals) ? value.visuals : null
  const raw = many ? capped(c, 'visuals', many, LIMITS.visuals) : [value]
  const visuals = raw.map((v, i) => readOne(v, c, many ? `[${i}].` : '')).filter((v): v is Visual => !!v)
  // Paths at the top level read better without the trailing dot ("type", not ".type").
  const tidy = (ps: VisualProblem[]) => ps.map((e) => ({ ...e, path: e.path.replace(/\.$/, '') || '(spec)' }))
  if (!visuals.length || c.errors.length) return { ok: false, errors: tidy(c.errors.length ? c.errors : [{ path: '(spec)', message: 'Nothing to draw' }]), warnings: tidy(c.warnings) }
  return { ok: true, visuals, warnings: tidy(c.warnings) }
}

/** Reads a ```visual block's text: loose JSON, then validateVisual. */
export function parseVisual(source: string): VisualResult {
  if (!source.trim()) return { ok: false, errors: [{ path: '(spec)', message: 'The block is empty' }], warnings: [] }
  const json = parseLoose(source)
  if (!json.ok) return { ok: false, errors: [{ path: `line ${json.line}, column ${json.col}`, message: json.message }], warnings: [] }
  return validateVisual(json.value)
}

export { isVisualLang } from './lang.ts'

// --- as text: the terminal and shared pages ----------------------------------------------------

/** An item as words: "4× 🪵 Oak planks". */
export function itemText(it: VItem | null): string {
  if (!it) return ''
  const name = [it.emoji, it.label || (it.icon ? humanize(it.icon) : it.app ? humanize(it.app) : '')].filter(Boolean).join(' ')
  return `${it.count !== undefined && it.count !== 1 ? `${it.count}× ` : ''}${name}`
}
const fmt = (n: number) => (Math.abs(n) >= 1000 ? n.toLocaleString('en-US', { maximumFractionDigits: 1 }) : String(Math.round(n * 100) / 100))

function treeLines(n: TreeNode, prefix: string, last: boolean, top: boolean, out: string[]) {
  out.push(top ? itemText(n) : `${prefix}${last ? '└─ ' : '├─ '}${itemText(n)}${n.note ? ` (${n.note})` : ''}`)
  const next = top ? '' : prefix + (last ? '   ' : '│  ')
  n.children.forEach((k, i) => treeLines(k, next, i === n.children.length - 1, false, out))
}

/** A visual as plain lines of text (no colour), for the terminal and for shared pages. */
export function visualText(v: Visual): string[] {
  const out: string[] = []
  if (v.title) out.push(v.title)
  switch (v.type) {
    case 'flow': {
      const label = new Map(v.nodes.map((n) => [n.id, itemText(n) || n.id]))
      const linked = new Set<string>()
      for (const e of v.edges) {
        linked.add(e.from)
        linked.add(e.to)
        out.push(`${label.get(e.from)} ${e.dashed ? '⇢' : '→'} ${label.get(e.to)}${e.label ? `  (${e.label})` : ''}`)
      }
      for (const n of v.nodes) if (!linked.has(n.id)) out.push(label.get(n.id)!)
      break
    }
    case 'grid':
      v.grids.forEach((g, gi) => {
        if (gi) out.push('')
        if (g.title) out.push(g.title)
        const w = Math.max(1, ...g.slots.map((s) => itemText(s).length))
        const rows: string[] = []
        for (let r = 0; r < g.rows; r++) rows.push(g.slots.slice(r * g.cols, r * g.cols + g.cols).map((s) => `[${itemText(s).padEnd(w)}]`).join(' '))
        const result = g.result.map(itemText).join(', ')
        const arrow = `${g.via ? `─ ${g.via} ─▶` : '▶'} ${result}`
        if (!rows.length) out.push(arrow)
        const mid = Math.floor((rows.length - 1) / 2)
        rows.forEach((r, i) => out.push(i === mid && result ? `${r}  ${arrow}` : r))
      })
      break
    case 'tree':
      v.roots.forEach((r) => treeLines(r, '', true, true, out))
      break
    case 'timeline':
      for (const e of v.events) out.push(`${e.when ? `${e.when} · ` : '• '}${itemText(e)}${e.note ? ` — ${e.note}` : ''}`)
      break
    case 'chart': {
      const u = v.unit ? ` ${v.unit}` : ''
      if (v.chart === 'pie') {
        const vals = v.series[0].values.map((x) => (x !== null && x > 0 ? x : 0))
        const total = vals.reduce((a, b) => a + b, 0) || 1
        v.labels.forEach((l, i) => out.push(`${l}: ${fmt(vals[i])}${u} (${Math.round((vals[i] / total) * 100)}%)`))
      } else if (v.series.length === 1) {
        const vals = v.series[0].values
        const max = Math.max(...vals.map((x) => Math.abs(x ?? 0))) || 1
        const lw = Math.max(...v.labels.map((l) => l.length))
        v.labels.forEach((l, i) => out.push(`${l.padEnd(lw)} ${'█'.repeat(Math.round((Math.abs(vals[i] ?? 0) / max) * 20))} ${vals[i] === null ? '–' : fmt(vals[i]!) + u}`))
      } else {
        out.push(['', ...v.series.map((s) => s.name)].join(' | '))
        v.labels.forEach((l, i) => out.push([l, ...v.series.map((s) => (s.values[i] === null ? '–' : fmt(s.values[i]!) + u))].join(' | ')))
      }
      break
    }
    case 'cards':
      for (const c of v.cards) out.push(`• ${[itemText(c), c.value && `[${c.value}]`].filter(Boolean).join(' ')}${c.text || c.note ? ` — ${c.text ?? c.note}` : ''}${c.tags.length ? ` (${c.tags.join(', ')})` : ''}`)
      break
    case 'list':
      v.items.forEach((it, i) => {
        const box = it.checked === undefined ? '' : it.checked ? '[x] ' : '[ ] '
        const head = [it.picture?.emoji, it.title].filter(Boolean).join(' ')
        out.push(`${v.numbered ? `${i + 1}. ` : '• '}${box}${head}${it.value ? ` [${it.value}]` : ''}`)
        const pad = v.numbered ? ' '.repeat(String(i + 1).length + 2) : '  '
        if (it.text) out.push(`${pad}${it.text}`)
        for (const [l, val] of it.fields) out.push(`${pad}${l}: ${val}`)
        if (it.note) out.push(`${pad}Note: ${it.note}`)
        if (it.tags.length) out.push(`${pad}(${it.tags.join(', ')})`)
      })
      break
    case 'table':
      if (v.columns.some(Boolean)) out.push(v.columns.join(' | '))
      for (const r of v.rows) out.push(r.map(itemText).join(' | '))
      break
    case 'scene':
      if (v.caption) out.push(v.caption)
      out.push(v.scene.labels.length ? `(drawing: ${v.scene.labels.slice(0, 12).join(' · ')})` : '(drawing)')
      break
  }
  return out
}

/** Every visual in a block as text, or null when the block is not a valid spec. */
export function visualBlockText(source: string): string[] | null {
  const r = parseVisual(source)
  if (!r.ok) return null
  return r.visuals.flatMap((v, i) => (i ? ['', ...visualText(v)] : visualText(v)))
}
