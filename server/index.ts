import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, normalize, sep } from 'node:path'
import { handleApi } from './api.ts'
import { startMinecraftWatch } from './minecraft.ts'
import { SECURITY } from './http.ts'

// Serves the built site and the /api routes in server/api.ts: live status, GitHub sign-in,
// synced desktop state and code search. No dependencies, just Node.

const ROOT = join(import.meta.dirname, '..', 'dist')
const PORT = Number(process.env.PORT ?? 80)

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json'
}

/** Hashed bundles never change; data snapshots refresh per release; the page itself always revalidates. */
function cacheFor(path: string) {
  if (path.startsWith('/assets/')) return 'public, max-age=31536000, immutable'
  if (path.endsWith('.json')) return 'public, max-age=300'
  return 'no-cache'
}

async function file(path: string) {
  // Resolve inside ROOT only: normalize, then refuse anything that climbs out.
  const full = normalize(join(ROOT, decodeURIComponent(path)))
  if (full !== ROOT && !full.startsWith(ROOT + sep)) return null
  const s = await stat(full).catch(() => null)
  return s?.isFile() ? { full, size: s.size } : null
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname

  if (await handleApi(req, res)) return

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end()
    return
  }
  if (path === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok\n')
    return
  }

  let found = await file(path).catch(() => null)
  let served = path
  // Unknown paths get the app (it has no client-side routes, but a stray link shouldn't 404).
  if (!found && !extname(path)) {
    found = await file('/index.html')
    served = '/index.html'
  }
  if (!found) {
    res.writeHead(404, { 'Content-Type': 'text/plain', ...SECURITY }).end('Not found\n')
    return
  }
  res.writeHead(200, {
    'Content-Type': TYPES[extname(found.full)] ?? 'application/octet-stream',
    'Content-Length': found.size,
    'Cache-Control': cacheFor(served),
    ...SECURITY,
  })
  if (req.method === 'HEAD') res.end()
  else createReadStream(found.full).pipe(res)
}).listen(PORT, () => {
  console.log(`MvL OS on :${PORT}`)
  startMinecraftWatch()
})
