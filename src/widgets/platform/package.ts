/** Widget package format. Data only: no host imports, npm resolution, HTML or build hooks. */
export const BUILD_ID = 'mvlos-descriptors-1.1/quickjs-emscripten-0.32.0/release-sync'
export const LIMITS = Object.freeze({ files: 48, sourceBytes: 128 * 1024, fileBytes: 32 * 1024, outputBytes: 64 * 1024, nodes: 256, depth: 12, memory: 8 * 1024 * 1024, stack: 256 * 1024, cpuMs: 40, jobs: 16, workers: 8, noteWindowBytes: 8 * 1024, noteWindowLines: 64, noteBytes: 256 * 1024 })
export type Capability = 'note.read' | 'note.write' | 'weather.read'
export type Manifest = {
  schema: 1; sdk: 1; id: string; name: string; entry: string
  settings: { appearance: 'panel' | 'sticky' }
  sizing: { width: number; height: number }; capabilities: Capability[]
}
export type Files = Record<string, string>
export type SourceIdentity = { kind: 'system'; path: string } | { kind: 'browser'; account: number; storeUUID: string; path: string } | { kind: 'seafile'; account: number; repo: string; path: string }
export type Snapshot = { manifest: Manifest; files: Files; digest: string; build: typeof BUILD_ID }
export type Descriptor = { type: 'column' | 'row' | 'text' | 'button' | 'editor'; text?: string; event?: string; tone?: 'normal' | 'muted' | 'accent'; children?: Descriptor[] }
export type WidgetInput = { note?: { text: string; revision: string; offset?: number; next?: number; continues?: boolean }; weather?: { place: string; units: string; summary: string; hours: string[]; days: string[] }; error?: string }
export type Mutation = { type: 'note.replace'; text: string; expectedRevision: string } | { type: 'note.edit'; start: number; end: number; text: string; expectedRevision: string }
const CAPABILITIES = new Set<Capability>(['note.read', 'note.write', 'weather.read'])
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
  if (v.capabilities.includes('note.write') && !v.capabilities.includes('note.read')) throw new Error('note.write requires note.read')
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
    exact(v, ['type', 'text', 'event', 'tone', 'children'])
    if (!['column', 'row', 'text', 'button', 'editor'].includes(String(v.type))) throw new Error('Unknown descriptor')
    if (v.text !== undefined && (typeof v.text !== 'string' || v.text.length > LIMITS.fileBytes)) throw new Error('Invalid text')
    if (v.event !== undefined && (typeof v.event !== 'string' || !/^[a-zA-Z0-9:._-]{1,80}$/.test(v.event) || v.type !== 'button')) throw new Error('Invalid event')
    if (v.tone !== undefined && !['normal', 'muted', 'accent'].includes(String(v.tone))) throw new Error('Invalid tone')
    if (v.children !== undefined && (!['column', 'row'].includes(String(v.type)) || !Array.isArray(v.children))) throw new Error('Invalid children')
    return { type: v.type as Descriptor['type'], ...(v.text === undefined ? {} : { text: v.text as string }), ...(v.event ? { event: v.event as string } : {}), ...(v.tone ? { tone: v.tone as Descriptor['tone'] } : {}), ...(Array.isArray(v.children) ? { children: v.children.map(c => walk(c, depth + 1)) } : {}) }
  }
  if (new TextEncoder().encode(JSON.stringify(raw)).length > LIMITS.outputBytes) throw new Error('Output limit')
  return walk(raw, 0)
}
export function mutation(raw: unknown): Mutation | null {
  if (raw === null) return null
  if (!record(raw)) throw new Error('Invalid effect')
  exact(raw, raw.type === 'note.edit' ? ['type', 'start', 'end', 'text', 'expectedRevision'] : ['type', 'text', 'expectedRevision'])
  if (raw.type === 'note.edit' && (!Number.isSafeInteger(raw.start) || !Number.isSafeInteger(raw.end) || Number(raw.start) < 0 || Number(raw.end) < Number(raw.start))) throw new Error('Invalid note range')
  if (!['note.replace', 'note.edit'].includes(String(raw.type)) || typeof raw.text !== 'string' || new TextEncoder().encode(raw.text).length > LIMITS.fileBytes || typeof raw.expectedRevision !== 'string' || raw.expectedRevision.length > 100) throw new Error('Invalid note transaction')
  return raw as Mutation
}

export function sourceIdentityOf(value: unknown): SourceIdentity {
  if (!record(value) || typeof value.path !== 'string' || !value.path.startsWith('/') || value.path.length > 512 || value.path !== '/' && value.path.split('/').slice(1).some(p => !p || p === '.' || p === '..') || /[\\\u0000-\u001f]/.test(value.path)) throw new Error('Invalid source identity')
  if (value.kind === 'system') {
    exact(value, ['kind', 'path'])
    if (!/^\/usr\/share\/mvlos\/widgets\/(weather|sticky)$/.test(value.path)) throw new Error('Unknown system source')
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
