import { buildPackage, type Files } from './package'
// Vite bundles actual folder bytes. VFS, default builds and forks consume the same bytes.
const sources = (import.meta.env !== undefined ? import.meta.glob('../packages/**/*', { query: '?raw', import: 'default', eager: true }) : {}) as Record<string, string>
const docs = (import.meta.env !== undefined ? import.meta.glob('./SDK.md', { query: '?raw', import: 'default', eager: true }) : {}) as Record<string, string>
export const widgetSDK = docs['./SDK.md'] ?? 'Widget SDK documentation is available in the browser VFS.'
export const defaultFiles = (id: string): Files => Object.fromEntries(Object.entries(sources).filter(([p]) => p.startsWith(`../packages/${id}/`)).map(([p, text]) => [p.slice(`../packages/${id}/`.length), text]))
const trusted = new Set<string>()
export const isBuiltin = (path: string, digest: string) => trusted.has(`${path}:${digest}`)
const builds = new Map<string, ReturnType<typeof buildPackage>>()
export function defaultBuild(id: string) {
  let build = builds.get(id)
  if (!build) builds.set(id, build = buildPackage(defaultFiles(id)).then(snapshot => { trusted.add(`/usr/share/mvlos/widgets/${id}:${snapshot.digest}`); return snapshot }))
  return build
}
export const defaultSourceEntries = () => Object.fromEntries(Object.entries(sources).map(([p, text]) => [p.slice('../packages/'.length), text]))
