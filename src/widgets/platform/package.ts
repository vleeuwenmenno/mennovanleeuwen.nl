import type { BrokerProjection } from './brokerTypes'
/** Widget package format. Data only: no host imports, npm resolution, HTML or build hooks. */
export const BUILD_ID = 'mvlos-descriptors-1.2/quickjs-emscripten-0.32.0/release-sync'
export const LIMITS = Object.freeze({ customStateBytes: 4096, files: 48, sourceBytes: 128 * 1024, fileBytes: 32 * 1024, outputBytes: 64 * 1024, nodes: 256, depth: 12, memory: 8 * 1024 * 1024, stack: 256 * 1024, cpuMs: 40, jobs: 16, workers: 8, noteWindowBytes: 8 * 1024, noteWindowLines: 64, noteBytes: 256 * 1024 })
export const WIDGET_KINDS = ['sticky', 'weather', 'agenda', 'inbox', 'status', 'minecraft'] as const
export type WidgetKind = typeof WIDGET_KINDS[number]
/** Custom widgets are the open-ended seventh class: any number of instances, each from its own package folder. */
export const CUSTOM_KIND = 'custom'
export type InstanceKind = WidgetKind | typeof CUSTOM_KIND
export type Capability = 'custom.state' | 'note.read' | 'note.write' | 'weather.read' | 'agenda.read' | 'agenda.act' | 'inbox.read' | 'inbox.navigate' | 'status.read' | 'status.navigate' | 'minecraft.read' | 'minecraft.act'
export const KIND_CAPABILITIES: Record<InstanceKind, readonly Capability[]> = { custom: ['custom.state'], sticky: ['note.read','note.write'], weather: ['weather.read'], agenda: ['agenda.read','agenda.act'], inbox: ['inbox.read','inbox.navigate'], status: ['status.read','status.navigate'], minecraft: ['minecraft.read','minecraft.act'] }
export const isWidgetKind = (v: unknown): v is WidgetKind => WIDGET_KINDS.includes(v as WidgetKind)
export const isInstanceKind = (v: unknown): v is InstanceKind => v === CUSTOM_KIND || isWidgetKind(v)
export const supportsCapabilities = (kind: InstanceKind, capabilities: readonly Capability[]) => capabilities.every(c => KIND_CAPABILITIES[kind].includes(c))
export type Manifest = {
  schema: 1; sdk: 1; id: string; name: string; entry: string
  settings: { appearance: 'panel' | 'sticky' }
  sizing: { width: number; height: number }; capabilities: Capability[]
}
export type Files = Record<string, string>
export type SourceIdentity = { kind: 'system'; path: string } | { kind: 'browser'; account: number; storeUUID: string; path: string } | { kind: 'seafile'; account: number; repo: string; path: string }
export type Snapshot = { manifest: Manifest; files: Files; digest: string; build: typeof BUILD_ID }
export type Descriptor = { type: 'column' | 'row' | 'text' | 'button' | 'editor' | 'link' | 'action' | 'image' | 'dot' | 'details' | 'card'; resource?: string; hint?: string; checked?: boolean; text?: string; event?: string; tone?: 'normal' | 'muted' | 'accent' | 'danger' | 'success' | 'warning'; children?: Descriptor[] }
/** What a custom widget sees: host clock, and its own small JSON state when it holds custom.state. */
export type CustomInput = { now: number; today: string; state?: unknown; revision?: string }
export type WidgetInput = BrokerProjection & { custom?: CustomInput; note?: { text: string; revision: string; offset?: number; next?: number; continues?: boolean }; weather?: { place: string; units: string; summary: string; hours: string[]; days: string[] }; error?: string }
export type Mutation = { type: 'note.replace'; text: string; expectedRevision: string } | { type: 'note.edit'; start: number; end: number; text: string; expectedRevision: string } | { type: 'custom.replace'; state: unknown; expectedRevision: string }
const CAPABILITIES = new Set<Capability>(Object.values(KIND_CAPABILITIES).flat())
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k)
export function record(v: unknown): v is Record<string, unknown> { return !!v && typeof v === 'object' && !Array.isArray(v) }
export function relativePath(path: string): string {
  if (!/^[a-zA-Z0-9_./-]{1,160}$/.test(path) || path.startsWith('/') || path.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('Invalid package path')
  return path
}
function exact(v: Record<string, unknown>, fields: string[]) {
  if (Object.keys(v).some(k => !fields.includes(k))) throw new Error('Unknown field')
}
export function manifestOf(v: unknown): Manifest {
  if (!record(v)) throw new Error('Manifest must be an object')
  exact(v, ['schema', 'sdk', 'id', 'name', 'entry', 'settings', 'sizing', 'capabilities'])
  if (v.schema !== 1 || v.sdk !== 1 || typeof v.id !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(v.id) || typeof v.name !== 'string' || !v.name.trim() || v.name.length > 64 || typeof v.entry !== 'string' || !/^src\/.+\.js$/.test(relativePath(v.entry))) throw new Error('Unsupported widget manifest')
  if (!record(v.settings) || !['panel', 'sticky'].includes(String(v.settings.appearance))) throw new Error('Invalid settings')
  exact(v.settings, ['appearance'])
  if (!record(v.sizing)) throw new Error('Missing sizing')
  exact(v.sizing, ['width', 'height'])
  for (const key of ['width', 'height']) if (typeof v.sizing[key] !== 'number' || !Number.isInteger(v.sizing[key]) || v.sizing[key] < 120 || v.sizing[key] > 800) throw new Error('Invalid sizing')
  if (!Array.isArray(v.capabilities) || v.capabilities.length > 3 || v.capabilities.some(c => !CAPABILITIES.has(c)) || new Set(v.capabilities).size !== v.capabilities.length) throw new Error('Unknown capability')
  for (const [write, read] of [['note.write','note.read'],['agenda.act','agenda.read'],['inbox.navigate','inbox.read'],['status.navigate','status.read'],['minecraft.act','minecraft.read']]) if (v.capabilities.includes(write) && !v.capabilities.includes(read)) throw new Error(`${write} requires ${read}`)
  return JSON.parse(JSON.stringify(v)) as Manifest
}
export function sourceFiles(raw: unknown): Files {
  if (!record(raw) || Object.keys(raw).length > LIMITS.files) throw new Error('Too many package files')
  const files: Files = Object.create(null)
  let total = 0
  for (const [path, text] of Object.entries(raw)) {
    relativePath(path)
    // Imported executable output and build metadata carry no authority and never enter a build.
    if (path === 'build.json' || path.startsWith('dist/')) continue
    if (typeof text !== 'string') throw new Error('Only UTF-8 source files are supported')
    const bytes = new TextEncoder().encode(text).length
    if (bytes > LIMITS.fileBytes || (total += bytes) > LIMITS.sourceBytes) throw new Error('Package source is too large')
    if (!(path === 'manifest.json' || path === 'README.md' || /^(src\/.*\.js|styles\/tokens\.json|assets\/.*\.(txt|json)|tests\/.*\.json)$/.test(path))) throw new Error(`Unsupported file: ${path}`)
    files[path] = text
  }
  for (const required of ['manifest.json', 'README.md', 'styles/tokens.json']) if (!own(files, required)) throw new Error(`Missing ${required}`)
  const m = manifestOf(JSON.parse(files['manifest.json']))
  if (!own(files, m.entry)) throw new Error('Missing entry source')
  const style: unknown = JSON.parse(files['styles/tokens.json'])
  if (!record(style) || Object.keys(style).some(k => !['gap', 'padding'].includes(k)) || Object.values(style).some(x => !['compact', 'normal', 'roomy'].includes(String(x)))) throw new Error('Styles must use SDK spacing tokens')
  return files
}
export const canonical = (files: Files) => JSON.stringify([BUILD_ID, Object.keys(files).sort().map(k => [k, files[k]])])
export async function buildPackage(raw: unknown): Promise<Snapshot> {
  const files = sourceFiles(raw)
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(files))))].map(x => x.toString(16).padStart(2, '0')).join('')
  return Object.freeze({ manifest: manifestOf(JSON.parse(files['manifest.json'])), files: Object.freeze(files), digest, build: BUILD_ID })
}
export async function verifySnapshot(snapshot: Snapshot) {
  const rebuilt = await buildPackage(snapshot.files)
  if (rebuilt.digest !== snapshot.digest || snapshot.build !== BUILD_ID || JSON.stringify(rebuilt.manifest) !== JSON.stringify(snapshot.manifest)) throw new Error('Snapshot identity mismatch')
  return rebuilt
}
export function descriptor(raw: unknown): Descriptor {
  let nodes = 0
  const walk = (v: unknown, depth: number): Descriptor => {
    if (++nodes > LIMITS.nodes || depth > LIMITS.depth || !record(v)) throw new Error('Descriptor limit')
    exact(v, ['type', 'text', 'event', 'tone', 'children', 'resource', 'hint', 'checked'])
    if (!['column', 'row', 'text', 'button', 'editor', 'link', 'action', 'image', 'dot', 'details', 'card'].includes(String(v.type))) throw new Error('Unknown descriptor')
    if (v.text !== undefined && (typeof v.text !== 'string' || v.text.length > LIMITS.fileBytes)) throw new Error('Invalid text')
    if (v.event !== undefined && (typeof v.event !== 'string' || !/^[a-zA-Z0-9:._-]{1,80}$/.test(v.event) || v.type !== 'button')) throw new Error('Invalid event')
    if (v.tone !== undefined && !['normal', 'muted', 'accent', 'danger', 'success', 'warning'].includes(String(v.tone))) throw new Error('Invalid tone')
    if (v.children !== undefined && (!['column', 'row', 'details', 'card', 'link', 'action'].includes(String(v.type)) || !Array.isArray(v.children))) throw new Error('Invalid children')
    if (v.resource !== undefined && (typeof v.resource !== 'string' || !/^[a-f0-9-]{36}$/.test(v.resource) || !['link','action','image','dot','card'].includes(String(v.type)))) throw new Error('Invalid resource handle')
    if (v.hint !== undefined && (typeof v.hint !== 'string' || v.hint.length > 1024)) throw new Error('Invalid hint')
    if (v.checked !== undefined && (typeof v.checked !== 'boolean' || v.type !== 'action')) throw new Error('Invalid checkbox')
    return { type: v.type as Descriptor['type'], ...(v.resource ? { resource: v.resource as string } : {}), ...(v.hint ? { hint: v.hint as string } : {}), ...(v.checked === undefined ? {} : {checked:v.checked as boolean}), ...(v.text === undefined ? {} : { text: v.text as string }), ...(v.event ? { event: v.event as string } : {}), ...(v.tone ? { tone: v.tone as Descriptor['tone'] } : {}), ...(Array.isArray(v.children) ? { children: v.children.map(c => walk(c, depth + 1)) } : {}) }
  }
  if (new TextEncoder().encode(JSON.stringify(raw)).length > LIMITS.outputBytes) throw new Error('Output limit')
  return walk(raw, 0)
}
/** A custom widget's state: any JSON value that serializes to at most LIMITS.customStateBytes. */
export function customState(value: unknown): unknown {
  const json = JSON.stringify(value === undefined ? null : value)
  if (json === undefined || new TextEncoder().encode(json).length > LIMITS.customStateBytes) throw new Error(`Custom state exceeds ${LIMITS.customStateBytes} bytes`)
  return JSON.parse(json)
}
export function mutation(raw: unknown): Mutation | null {
  if (raw === null) return null
  if (!record(raw)) throw new Error('Invalid effect')
  if (raw.type === 'custom.replace') {
    exact(raw, ['type', 'state', 'expectedRevision'])
    if (typeof raw.expectedRevision !== 'string' || raw.expectedRevision.length > 100) throw new Error('Invalid custom state transaction')
    return { type: 'custom.replace', state: customState(raw.state), expectedRevision: raw.expectedRevision }
  }
  exact(raw, raw.type === 'note.edit' ? ['type', 'start', 'end', 'text', 'expectedRevision'] : ['type', 'text', 'expectedRevision'])
  if (raw.type === 'note.edit' && (!Number.isSafeInteger(raw.start) || !Number.isSafeInteger(raw.end) || Number(raw.start) < 0 || Number(raw.end) < Number(raw.start))) throw new Error('Invalid note range')
  if (!['note.replace', 'note.edit'].includes(String(raw.type)) || typeof raw.text !== 'string' || new TextEncoder().encode(raw.text).length > LIMITS.fileBytes || typeof raw.expectedRevision !== 'string' || raw.expectedRevision.length > 100) throw new Error('Invalid note transaction')
  return raw as Mutation
}

export function sourceIdentityOf(value: unknown): SourceIdentity {
  if (!record(value) || typeof value.path !== 'string' || !value.path.startsWith('/') || value.path.length > 512 || value.path !== '/' && value.path.split('/').slice(1).some(p => !p || p === '.' || p === '..') || /[\\\u0000-\u001f]/.test(value.path)) throw new Error('Invalid source identity')
  if (value.kind === 'system') {
    exact(value, ['kind', 'path'])
    if (!/^\/usr\/share\/mvlos\/widgets\/(weather|sticky|agenda|inbox|status|minecraft)$/.test(value.path)) throw new Error('Unknown system source')
  } else {
    if (!Number.isSafeInteger(value.account) || Number(value.account) < 1) throw new Error('Invalid source account')
    if (value.kind === 'browser') {
      exact(value, ['kind', 'account', 'storeUUID', 'path'])
      if (typeof value.storeUUID !== 'string' || !/^[a-f0-9-]{36}$/.test(value.storeUUID)) throw new Error('Invalid browser store UUID')
    } else if (value.kind === 'seafile') {
      exact(value, ['kind', 'account', 'repo', 'path'])
      if (typeof value.repo !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(value.repo)) throw new Error('Invalid source repository')
    } else throw new Error('Unknown source kind')
  }
  return JSON.parse(JSON.stringify(value)) as SourceIdentity
}
