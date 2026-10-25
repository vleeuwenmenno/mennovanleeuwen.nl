// Checks find_image (server/findImage.ts): real-world pictures for the agents, found on result
// pages, downloaded by the server and served from /api/agents/images/<id>. Against stand-ins only:
// the real server (server/index.ts) with a scratch DATA_DIR, a stand-in for Ollama (its web search
// and scripted find_image calls) and a stand-in web of shops (scripts/find-image-fake-net.ts),
// whose names still go through the server's address checks.
//
//   - Reading pages: og:image, JSON-LD Product images, a big <img> as the fallback; logos, icons,
//     tiny and SVG pictures are passed over; hostile pages stay fast.
//   - Pictures: PNG, JPEG, WebP and still GIF by their bytes; SVG, HTML posing as PNG, animations,
//     banners, tiny and oversize pictures are refused; a big PNG is scaled down to 768 px.
//   - Safety: private, loopback and metadata addresses are refused (after DNS and after
//     redirects, for pages and pictures), IP addresses in links too, no cookies are sent; the
//     picture is served to its account only, with its own type, nosniff and a sandbox CSP.
//   - The second search for the same thing reads nothing again (cache hit); SearXNG's image search
//     goes first when it is the provider.
//
//   node scripts/agents-find-image.ts
//
// Exits 1 on any failure.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { Server, check, finish } from './empires-harness.ts'
import { asPage } from './as-page.ts'
import { encodePng, pngSize } from '../server/pngResize.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// server/db.ts takes DATA_DIR when it is first imported: one scratch folder for this script and
// the server it starts.
const DATA = mkdtempSync(join(tmpdir(), 'find-image-check-'))
process.env.DATA_DIR = DATA
const { extractImages, inspectImage, refuseImage } = await import('../server/findImage.ts')

const MODEL = 'check-model'

// --- pictures --------------------------------------------------------------------------------------

function png(w: number, h: number): Buffer {
  const data = Buffer.alloc(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set([(x * 255) / w, (y * 255) / h, 120, 255], (y * w + x) * 4)
  return encodePng({ width: w, height: h, data })
}
function jpeg(w: number, h: number): Buffer {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]
  return Buffer.concat([Buffer.from([0xff, 0xd8, ...app0, ...sof]), Buffer.alloc(2000, 7), Buffer.from([0xff, 0xd9])])
}
function webp(w: number, h: number, animated = false): Buffer {
  const b = Buffer.alloc(400)
  b.write('RIFF', 0, 'ascii')
  b.writeUInt32LE(392, 4)
  b.write('WEBPVP8X', 8, 'ascii')
  b.writeUInt32LE(10, 16)
  b[20] = animated ? 0x02 : 0
  b.writeUIntLE(w - 1, 24, 3)
  b.writeUIntLE(h - 1, 27, 3)
  return b
}
function gif(w: number, h: number, frames: number): Buffer {
  const head = Buffer.alloc(13)
  head.write('GIF89a', 0, 'ascii')
  head.writeUInt16LE(w, 6)
  head.writeUInt16LE(h, 8)
  const frame = Buffer.from([0x21, 0xf9, 0x04, 0, 0, 0, 0, 0, 0x2c, 0, 0, 0, 0, w & 255, w >> 8, h & 255, h >> 8, 0, 0x02, 0x02, 0x44, 0x01, 0x00])
  return Buffer.concat([head, ...Array(frames).fill(frame), Buffer.from([0x3b])])
}

// --- unit checks: pages and pictures ---------------------------------------------------------------

{
  const base = new URL('https://shop.test/products/jagabee')
  const og = extractImages('<html><head><meta property="og:image" content="/img/jagabee.png"><meta property="og:type" content="product"><title>Jagabee</title></head><body><img src="/logo.png" class="site-logo" width="300" height="300"></body></html>', base, ['jagabee'])
  check('page: og:image first, relative to the page', og.candidates[0]?.url === 'https://shop.test/img/jagabee.png' && og.product && og.title === 'Jagabee')
  check('page: a logo <img> is passed over', !og.candidates.some((c) => c.url.includes('logo')))
  const ld = extractImages(`<head><meta property="og:image" content="https://shop.test/share-default.png"></head><script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebSite"},{"@type":"Product","name":"Menturm Q","image":[{"@type":"ImageObject","url":"https://cdn.test/menturm.jpg","width":900}]}]}</script>`, base)
  check('page: JSON-LD Product image beats a default share picture', ld.candidates[0]?.url === 'https://cdn.test/menturm.jpg' && ld.candidates[0].why === 'json-ld product' && ld.product)
  const imgs = extractImages('<body><img src="/assets/logo.png" width="200" height="60"><img src="/t/a.jpg" width="50" height="50"><img src="/icons/cart.png"><img data-src="/photos/kyusoku.webp" width="600" height="600" alt="Kyusoku Jikan"><img srcset="/s/small.jpg 200w, /s/big.jpg 1200w" alt="other"><img src="/x.svg" width="500" height="500"></body>', base, ['kyusoku'])
  check('page: a big <img> (lazy data-src) is the fallback, matching alt first', imgs.candidates[0]?.url === 'https://shop.test/photos/kyusoku.webp', imgs.candidates)
  check('page: srcset gives its biggest picture', imgs.candidates.some((c) => c.url === 'https://shop.test/s/big.jpg'))
  check('page: logos, tiny pictures, icons and SVG are left out', !imgs.candidates.some((c) => /logo|\/t\/a|cart|\.svg/.test(c.url)), imgs.candidates)
  check('page: silicone is not an icon', extractImages('<meta property="og:image" content="/p/silicone-case.jpg">', base).candidates[0]?.url === 'https://shop.test/p/silicone-case.jpg')
  check('page: data: and javascript: pictures are ignored', extractImages('<meta property="og:image" content="javascript:alert(1)"><img src="data:image/png;base64,AAAA" width="500" height="500">', base).candidates.length === 0)
  const t0 = performance.now()
  extractImages(`<head>${'<meta property="og:image" content="'.repeat(30_000)}</head>${'<script type="application/ld+json">{'.repeat(5000)}${'<img src="'.repeat(50_000)}`, base)
  const ms = performance.now() - t0
  check(`page: a hostile 1.5 MB page reads fast (${ms.toFixed(0)} ms < 500)`, ms < 500)

  const p = inspectImage(png(300, 200))
  check('picture: PNG with its size', p?.mime === 'image/png' && p.width === 300 && p.height === 200 && !refuseImage(p))
  const j = inspectImage(jpeg(640, 480))
  check('picture: JPEG with its size', j?.mime === 'image/jpeg' && j.width === 640 && j.height === 480)
  const w = inspectImage(webp(600, 500))
  check('picture: WebP with its size', w?.mime === 'image/webp' && w.width === 600 && w.height === 500)
  check('picture: a still GIF is fine, an animated GIF or WebP is refused', !refuseImage(inspectImage(gif(300, 300, 1))) && refuseImage(inspectImage(gif(300, 300, 3))) === 'an animation' && refuseImage(inspectImage(webp(300, 300, true))) === 'an animation')
  check('picture: SVG and HTML are not pictures', inspectImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')) === null && inspectImage(Buffer.from('<!doctype html><script>')) === null)
  check('picture: tiny, huge and banner shapes are refused', /too small/.test(refuseImage(inspectImage(png(100, 300))) ?? '') && /too large/.test(refuseImage(inspectImage(webp(9000, 9000))) ?? '') && /banner/.test(refuseImage(inspectImage(png(1000, 200))) ?? ''))
}

// --- the stand-in web --------------------------------------------------------------------------------

const BIG_PNG = png(1000, 800)
const SECRET = 'secret-should-never-be-fetched'
type Hit = { host: string; path: string; headers: IncomingMessage['headers'] }
const hits: Hit[] = []
const html = (head: string, body = '') => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`
const pages: Record<string, (res: ServerResponse) => void> = {
  'shop-a.test/products/jagabee': (r) => send(r, 200, html('<title>Calbee Jagabee</title><meta property="og:image" content="https://cdn-a.test/img/jagabee.png"><meta property="og:type" content="product">', '<img src="/logo.png" class="logo" width="400" height="400">'), 'text/html; charset=utf-8'),
  'cdn-a.test/img/jagabee.png': (r) => send(r, 200, BIG_PNG, 'image/png'),
  'shop-b.test/item/menturm': (r) => send(r, 200, html('<title>Menturm Q</title>', '<script type="application/ld+json">{"@type":"Product","name":"Menturm Q","image":"https://cdn-b.test/menturm.jpg"}</script>'), 'text/html'),
  'cdn-b.test/menturm.jpg': (r) => send(r, 200, jpeg(800, 800), 'image/jpeg'),
  'shop-c.test/kyusoku': (r) => send(r, 200, html('<title>Kyusoku Jikan</title>', '<img class="site-logo" src="/assets/logo.png" width="200" height="60"><img src="/thumbs/a.jpg" width="50" height="50"><img src="/photos/kyusoku-box.webp" width="600" height="600" alt="Kyusoku Jikan box">'), 'text/html'),
  'shop-c.test/photos/kyusoku-box.webp': (r) => send(r, 200, webp(600, 600), 'image/webp'),
  'shop-c.test/assets/logo.png': (r) => send(r, 200, png(200, 200), 'image/png'),
  // Blocked ones: a page that redirects inside, a page whose pictures are private, a picture that redirects inside.
  'redir.test/page': (r) => r.writeHead(302, { Location: 'https://evil.test/inner' }).end(),
  'shop-d.test/page': (r) => send(r, 200, html(`<meta property="og:image" content="http://127.0.0.1/${SECRET}.png"><meta name="twitter:image" content="https://meta.test/${SECRET}">`), 'text/html'),
  'shop-f.test/page': (r) => send(r, 200, html('<meta property="og:image" content="https://cdn-f.test/go">'), 'text/html'),
  'cdn-f.test/go': (r) => r.writeHead(301, { Location: `https://evil.test/${SECRET}.png` }).end(),
  // Bad pictures: too big, SVG, HTML posing as a PNG.
  'shop-e.test/page': (r) => send(r, 200, html('<meta property="og:image" content="https://cdn-e.test/huge.jpg"><meta name="twitter:image" content="https://cdn-e.test/sneaky.png">'), 'text/html'),
  'shop-g.test/page': (r) => send(r, 200, html('<meta property="og:image" content="https://cdn-e.test/vector">'), 'text/html'),
  'cdn-e.test/huge.jpg': (r) => send(r, 200, Buffer.concat([jpeg(4000, 3000), Buffer.alloc(6 * 1024 * 1024)]), 'image/jpeg'),
  'cdn-e.test/sneaky.png': (r) => send(r, 200, '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>', 'image/png'),
  'cdn-e.test/vector': (r) => send(r, 200, '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="500"></svg>', 'image/svg+xml'),
  // SearXNG's image search result.
  'cdn-s.test/matcha.png': (r) => send(r, 200, png(400, 400), 'image/png'),
}
function send(res: ServerResponse, status: number, body: unknown, type = 'application/json') {
  const b = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': String(b.length) }).end(b)
}
const web = createServer((req, res) => {
  const [, host, ...rest] = new URL(req.url ?? '/', 'http://x').pathname.split('/')
  const path = `/${rest.join('/')}`
  hits.push({ host, path, headers: req.headers })
  const page = pages[`${host}${path}`]
  if (page) page(res)
  else send(res, 404, 'not here', 'text/plain')
})
await new Promise<void>((r) => web.listen(0, '127.0.0.1', r))
const webUrl = `http://127.0.0.1:${(web.address() as { port: number }).port}`

// --- the stand-in for Ollama (web search, chat) and SearXNG -------------------------------------------

type Message = { role: string; content: string }
const SEARCH: Record<string, string[]> = {
  jagabee: ['https://shop-a.test/products/jagabee'],
  menturm: ['https://shop-b.test/item/menturm'],
  kyusoku: ['https://shop-c.test/kyusoku'],
  blocked: ['https://redir.test/page', 'https://shop-d.test/page', 'https://shop-f.test/page', 'http://127.0.0.1:9/private'],
  bad: ['https://shop-e.test/page', 'https://shop-g.test/page'],
  nothing: [],
}
const CALLS: Record<string, Record<string, unknown>> = {
  jagabee: { query: 'jagabee' },
  menturm: { query: 'menturm' },
  kyusoku: { query: 'kyusoku' },
  blocked: { query: 'blocked', count: 3 },
  bad: { query: 'bad', count: 3 },
  page: { query: 'nothing', page: 'https://shop-c.test/kyusoku' },
  matcha: { query: 'matcha' },
}
let lastTools: string[] = []
const ollama = createServer((req, res) => {
  let raw = ''
  req.on('data', (d) => (raw += d))
  req.on('end', () => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    if (path === '/api/tags') return send(res, 200, { models: [{ name: MODEL }] })
    if (path === '/api/show') return send(res, 200, { capabilities: ['completion', 'tools'], model_info: { 'x.context_length': 32768 } })
    if (path === '/api/web_search') {
      const q = (JSON.parse(raw) as { query: string }).query
      return send(res, 200, { results: (SEARCH[q] ?? []).map((url) => ({ title: q, url, content: q })) })
    }
    if (path === '/searx/search') {
      const u = new URL(req.url ?? '/', 'http://x')
      return send(res, 200, { results: u.searchParams.get('categories') === 'images' ? [{ title: 'Matcha tin', url: 'https://tea.test/matcha', img_src: 'https://cdn-s.test/matcha.png' }] : [] })
    }
    if (path !== '/api/chat') return send(res, 404, {})
    const body = JSON.parse(raw) as { messages: Message[]; stream?: boolean; tools?: { function: { name: string } }[] }
    if (body.stream === false) return send(res, 200, { model: MODEL, message: { role: 'assistant', content: '{"title":"Find image check"}' }, done: true })
    lastTools = (body.tools ?? []).map((t) => t.function.name)
    const at = body.messages.map((m) => m.role === 'user' && m.content.startsWith('SCENARIO ')).lastIndexOf(true)
    const scenario = body.messages[at]?.content.slice('SCENARIO '.length) ?? ''
    const round = body.messages.slice(at + 1).filter((m) => m.role === 'assistant').length
    const message = round === 0 && CALLS[scenario] ? { role: 'assistant', content: '', tool_calls: [{ function: { name: 'find_image', arguments: CALLS[scenario] } }] } : { role: 'assistant', content: `DONE ${scenario}` }
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
    res.write(`${JSON.stringify({ model: MODEL, message, done: false })}\n`)
    res.end(`${JSON.stringify({ model: MODEL, message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 10, eval_count: 5 })}\n`)
  })
})
await new Promise<void>((r) => ollama.listen(0, '127.0.0.1', r))
const ollamaUrl = `http://127.0.0.1:${(ollama.address() as { port: number }).port}`

// --- the site, with a signed-in (admin) account: admins may reach their LAN, find_image never ----------

const LOGIN = 'find-image-check'
const server = new Server({
  OLLAMA_URL: ollamaUrl,
  OLLAMA_API_KEY: 'fake-ollama',
  GITHUB_CLIENT_ID: 'x',
  GITHUB_CLIENT_SECRET: 'x',
  ADMIN_USERS: LOGIN,
  DATA_DIR: DATA,
  NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ./scripts/find-image-fake-net.ts`,
  FIND_IMAGE_FAKE_WEB: webUrl,
  FIND_IMAGE_FAKE_DNS: JSON.stringify({ 'evil.test': '10.0.0.5', 'meta.test': '169.254.169.254' }),
})
const { database, encrypt, sha256 } = await import('../server/db.ts')
const sid = randomBytes(24).toString('hex')
const now = Date.now()
database().prepare('INSERT INTO users (id, github_id, login, github_token, created_at, updated_at) VALUES (1, 1, ?, ?, ?, ?)').run(LOGIN, encrypt('none'), now, now)
database().prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, 1, ?, ?)').run(sha256(sid), now, now + 86400_000)
await server.start()

const call = async (method: string, path: string, body?: unknown, cookie = true) =>
  fetch(`${server.origin}${path}`, { method, headers: { ...(cookie ? { Cookie: `mvlos_sid=${sid}`, ...(await asPage(sid)) } : {}), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
const api = async <T = Record<string, any>>(method: string, path: string, body?: unknown): Promise<T> => {
  const res = await call(method, path, body)
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`)
  return (await res.json()) as T
}
type Found = { images: { reference: string; title: string; site: string; page: string; width: number; height: number }[]; skipped?: string[]; message?: string; error?: string }
async function scenario(name: string): Promise<Found> {
  const id = (await api<{ id: string }>('POST', '/api/agents/threads', { model: MODEL, mode: 'quick', tools: ['web'] })).id
  await (await call('POST', `/api/agents/threads/${id}/messages`, { text: `SCENARIO ${name}` })).text()
  const t = await api<{ messages: { role: string; content: string; toolName?: string }[] }>('GET', `/api/agents/threads/${id}`)
  const tool = t.messages.find((m) => m.role === 'tool' && m.toolName === 'find_image')
  return tool ? (JSON.parse(tool.content) as Found) : { images: [], error: 'no find_image result' }
}
const idOf = (ref: string) => ref.slice('image:'.length)
const hitCount = () => hits.length

try {
  // 1. Offered with the web tools; a product page's og:image, downloaded, scaled down, served.
  const a = await scenario('jagabee')
  check('find_image is offered with the web tools', lastTools.includes('find_image') && lastTools.includes('web_search'))
  check(`og:image found and kept (${JSON.stringify(a).slice(0, 160)})`, a.images.length === 1 && /^image:w[0-9a-f]{24}$/.test(a.images[0].reference) && a.images[0].site === 'shop-a.test' && a.images[0].page === 'https://shop-a.test/products/jagabee')
  check('the 1000 × 800 PNG is scaled down to 768 × 614', a.images[0]?.width === 768 && a.images[0]?.height === 614)
  check('the logo was not downloaded', !hits.some((h) => h.path.includes('logo')))
  check('no cookie or credentials went to the other sites', hits.every((h) => !h.headers.cookie && !h.headers.authorization) && hits.some((h) => /find_image/.test(String(h.headers['user-agent']))))
  const got = await call('GET', `/api/agents/images/${idOf(a.images[0].reference)}`)
  const bytes = Buffer.from(await got.arrayBuffer())
  check('served as image/png, nosniff, sandboxed, private cache', got.status === 200 && got.headers.get('content-type') === 'image/png' && got.headers.get('x-content-type-options') === 'nosniff' && /sandbox/.test(got.headers.get('content-security-policy') ?? '') && /private/.test(got.headers.get('cache-control') ?? ''))
  check('the served picture is the scaled PNG', JSON.stringify(pngSize(bytes)) === '{"width":768,"height":614}')
  const stranger = await call('GET', `/api/agents/images/${idOf(a.images[0].reference)}`, undefined, false)
  check(`not served without signing in (${stranger.status})`, stranger.status === 401 || stranger.status === 403)
  check('an unknown id is a 404', (await call('GET', '/api/agents/images/w000000000000000000000000')).status === 404)
  const used = (database().prepare('SELECT SUM(LENGTH(body)) AS n FROM agent_found_images WHERE user_id = 1').get() as { n: number }).n
  check('kept in the account (counts toward its storage)', used === bytes.length)

  // 2. JSON-LD Product image (JPEG), 3. a big <img> as the fallback (WebP), logo skipped.
  const b = await scenario('menturm')
  check('a JSON-LD Product image (JPEG)', b.images.length === 1 && b.images[0].width === 800)
  const bServed = await call('GET', `/api/agents/images/${idOf(b.images[0]?.reference ?? 'image:x')}`)
  check('served as image/jpeg', bServed.headers.get('content-type') === 'image/jpeg')
  const c = await scenario('kyusoku')
  check('a big <img> as the fallback (WebP 600 × 600)', c.images.length === 1 && c.images[0].width === 600 && c.images[0].height === 600)
  check('the logo and thumbnail <img>s were not downloaded', !hits.some((h) => h.host === 'shop-c.test' && (h.path.includes('logo') || h.path.includes('thumbs'))))

  // 4. Private addresses: a page redirecting inside, pictures at 127.0.0.1, the metadata address
  //    and a picture redirecting inside. Nothing reaches them, even for an admin.
  const before = hitCount()
  const d = await scenario('blocked')
  check('nothing found where everything points inside', d.images.length === 0 && /No usable picture/.test(d.message ?? ''))
  check(`each was refused for its address (${JSON.stringify(d.skipped)})`, (d.skipped ?? []).filter((s) => /refused/.test(s)).length >= 4)
  check('no request for a private address was sent', !hits.slice(before).some((h) => h.host === 'evil.test' || h.host === 'meta.test' || h.host.startsWith('127.') || h.path.includes(SECRET)))
  check('the redirect to inside was followed only up to the check', hits.slice(before).some((h) => h.host === 'redir.test') && hits.slice(before).some((h) => h.host === 'cdn-f.test'))

  // 5. Bad pictures: oversize, SVG, HTML posing as PNG.
  const e = await scenario('bad')
  check('oversize, SVG and a fake PNG are all refused', e.images.length === 0)
  const why = (e.skipped ?? []).join(' | ')
  check(`with their reasons (${why})`, /over 5 MB/.test(why) && /not a picture we keep \(image\/svg\+xml\)/.test(why) && /not a PNG, JPEG, WebP or GIF/.test(why))

  // 6. Cache: the same search again reads nothing and gives the same picture.
  const beforeAgain = hitCount()
  const again = await scenario('jagabee')
  check('the same search again is a cache hit: same id, nothing fetched', again.images[0]?.reference === a.images[0].reference && hitCount() === beforeAgain)

  // 7. A page the agent found goes first (the search finds nothing).
  const pg = await scenario('page')
  check('a given page is read first', pg.images.length === 1 && pg.images[0].reference === c.images[0].reference)

  // 8. SearXNG as the provider: its image search goes first.
  await api('PUT', '/api/agents/websearch', { provider: 'searxng', searxng: { url: `${ollamaUrl}/searx` } })
  const m = await scenario('matcha')
  check(`SearXNG image search (categories=images) is used (${JSON.stringify(m).slice(0, 160)})`, m.images.length === 1 && m.images[0].site === 'tea.test' && m.images[0].width === 400)

  // 9. Pruning: unused for 90 days and mentioned nowhere goes; mentioned stays.
  const { prune } = await import('../server/findImage.ts')
  database().prepare('UPDATE agent_found_images SET used_at = ? WHERE user_id = 1').run(Date.now() - 100 * 86400_000)
  database().prepare("UPDATE agent_messages SET content = content || ? WHERE id = (SELECT MAX(id) FROM agent_messages WHERE role = 'assistant')").run(` ${a.images[0].reference}`)
  prune({ id: 1 } as never, true)
  const left = (database().prepare('SELECT id FROM agent_found_images WHERE user_id = 1').all() as { id: string }[]).map((r) => r.id)
  check(`pruning keeps only what a thread mentions (${left.length} left)`, left.length === 1 && left[0] === idOf(a.images[0].reference))
} finally {
  await server.dispose()
  rmSync(DATA, { recursive: true, force: true })
  web.close()
  ollama.close()
}
finish()
