import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { extname, join, normalize, sep } from 'node:path'
import { handleApi } from './api.ts'
import { empiresUpgrade } from './empires.ts'
import { startMinecraftWatch } from './minecraft.ts'
import { startNotifications } from './watchers.ts'
import { SECURITY } from './http.ts'

// Serves the built site and the /api routes in server/api.ts: live status, GitHub sign-in,
// synced desktop state and code search, plus the Empires At War multiplayer WebSocket
// (server/empires.ts). No dependencies, just Node.

const ROOT = join(import.meta.dirname, '..', 'dist')
const PORT = Number(process.env.PORT ?? 80)

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  // pdf.js's worker is a module: served as anything else, the browser refuses to run it.
  '.mjs': 'text/javascript; charset=utf-8',
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

// mennovanleeuwen.nl/cv is Menno's CV (src/os/cvMode.ts): the same app, with the page title,
// description and link preview of the CV, so a shared /cv link shows his card.
const CV_META = `<title>Menno van Leeuwen — MvL OS</title>
    <meta name="description" content="Menno van Leeuwen, DevOps engineer. A CV you can boot: projects, open source contributions and a terminal that actually works." />
    <meta property="og:title" content="Menno van Leeuwen — MvL OS" />
    <meta property="og:description" content="DevOps engineer. Builder of Boltwarden, Savuvo, Pepper and Omasoloist." />`
const CV_NOSCRIPT = `<noscript>
      <main style="font-family:sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;color:#ddd">
        <h1>Menno van Leeuwen</h1>
        <p>DevOps engineer. This site is a small operating system and needs JavaScript.</p>
        <p>Projects: Savuvo, Boltwarden, Pepper, Omasoloist. GitHub: <a href="https://github.com/vleeuwenmenno">vleeuwenmenno</a>.</p>
      </main>
    </noscript>`
let cvPage: Buffer | null = null
async function cvIndex(full: string): Promise<Buffer> {
  if (cvPage) return cvPage
  const html = await readFile(full, 'utf8')
  cvPage = Buffer.from(html.replace(/<!-- meta[^>]*-->[\s\S]*?<!-- \/meta -->/, CV_META).replace(/<!-- noscript -->[\s\S]*?<!-- \/noscript -->/, CV_NOSCRIPT))
  return cvPage
}

/** One request: an /api route, or a file of the built site. */
async function serve(req: IncomingMessage, res: ServerResponse) {
  let path: string
  try {
    path = new URL(req.url ?? '/', 'http://localhost').pathname
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain', ...SECURITY }).end('Bad request\n')
    return
  }

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
  if (served === '/index.html' && /^\/cv\/?$/.test(path)) {
    const body = await cvIndex(found.full)
    res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Content-Length': body.length, 'Cache-Control': 'no-cache', ...SECURITY })
    res.end(req.method === 'HEAD' ? undefined : body)
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
}

// Anyone can send anything: a request that breaks something gets an error, and the server and
// everyone else's requests go on.
// The last line of defence: logged, and the server stays up (a restart would end every battle,
// Agents turn and upload in flight).
process.on('uncaughtException', (e) => console.error('uncaught:', e))
process.on('unhandledRejection', (e) => console.error('unhandled rejection:', e))

createServer((req, res) => {
  serve(req, res).catch((e: unknown) => {
    console.error('request failed:', (e as Error)?.message ?? e)
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain', ...SECURITY }).end('Something went wrong\n')
    else res.destroy()
  })
})
  .on('upgrade', (req, socket, head) => {
    try {
      if (!empiresUpgrade(req, socket, head)) socket.destroy()
    } catch (e) {
      console.error('upgrade failed:', (e as Error).message)
      socket.destroy()
    }
  })
  .listen(PORT, () => {
    console.log(`MvL OS on :${PORT}`)
    if (process.env.NODE_ENV === 'production' && !process.env.PUBLIC_URL)
      console.warn('PUBLIC_URL is not set: OAuth redirects and cookie flags follow the Host and X-Forwarded-* headers of each request. Set it to the site\'s address (https://example.com).')
    startMinecraftWatch()
    startNotifications()
  })
