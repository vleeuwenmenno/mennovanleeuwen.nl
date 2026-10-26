// Checks the baseline response headers: HSTS and the general CSP on API answers, the nonce CSP of
// the app's HTML pages (fresh per response, on every script and modulepreload tag, in every
// encoding and variant), and that the stricter policies of untrusted bytes and share pages replace
// it. Then, in headless Chromium, that the real page still boots under its policy and, under that
// same policy, a script added by a trusted script from another origin (OnlyOffice's api.js) runs
// while an inline or injected one does not.
//
//   pnpm build && node scripts/headers-check.ts
//
// Boots server/index.ts on a scratch port and DATA_DIR. Exits 1 on any failure.

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { CACHE_PURGE_COOKIE, CACHE_PURGE_EPOCH, SECURITY, UNTRUSTED, cachePurge, documentCsp } from '../server/http.ts'
import { launch, newPage, sleep } from './perf/cdp.ts'

let failed = false
const check = (what: string, test: boolean, detail?: unknown) => {
  if (test) console.log('PASS', what)
  else {
    failed = true
    console.log('FAIL', what, detail ?? '')
  }
}

const GENERAL = "script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'"
check('SECURITY carries HSTS without includeSubDomains or preload', SECURITY['Strict-Transport-Security'] === 'max-age=31536000')
check('SECURITY carries the general CSP', SECURITY['Content-Security-Policy'] === GENERAL)
// The merge order every untrusted-bytes route uses: SECURITY first, UNTRUSTED after.
check('UNTRUSTED replaces the general CSP when spread after SECURITY', ({ ...SECURITY, ...UNTRUSTED })['Content-Security-Policy'] === "default-src 'none'; sandbox")

// A free port, not a fixed one: another server may be on the usual ones.
const probe = createServer()
await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r))
const port = (probe.address() as { port: number }).port
await new Promise((r) => probe.close(r))
const dir = mkdtempSync(join(tmpdir(), 'headers-check-'))
const child = spawn('node', ['server/index.ts'], { env: { ...process.env, PORT: String(port), DATA_DIR: dir }, stdio: 'ignore' })
try {
  const base = `http://127.0.0.1:${port}`
  for (let i = 0; i < 100; i++) {
    if (await fetch(base + '/api/me').then(() => true, () => false)) break
    await new Promise((r) => setTimeout(r, 100))
  }
  const get = (path: string) => fetch(base + path).then((r) => r.headers)
  const get2 = (path: string, enc = 'identity') => fetch(base + path, { headers: { 'Accept-Encoding': enc } })
  const api = await get('/api/me')
  check('/api/me: HSTS', api.get('strict-transport-security') === 'max-age=31536000')
  check('/api/me: general CSP, no nonce', api.get('content-security-policy') === GENERAL, api.get('content-security-policy'))
  check('/api/me: nosniff and frame options kept', api.get('x-content-type-options') === 'nosniff' && api.get('x-frame-options') === 'SAMEORIGIN')

  const nonceOf = (csp: string | null) => /^script-src 'nonce-([A-Za-z0-9+/=]{22,})' 'strict-dynamic' 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'$/.exec(csp ?? '')?.[1]
  const seen = new Set<string>()
  for (const path of ['/', '/cv', '/play/empires', '/play', '/no/such/page', '/index.html']) {
    for (const enc of ['identity', 'gzip', 'br']) {
      const r = await get2(path, enc)
      const h = r.headers
      const nonce = nonceOf(h.get('content-security-policy'))
      check(`${path} (${enc}): document CSP with a nonce, strict-dynamic and the rest of the baseline`, !!nonce, h.get('content-security-policy'))
      check(`${path} (${enc}): HSTS, nosniff and frame options kept`, h.get('strict-transport-security') === 'max-age=31536000' && h.get('x-content-type-options') === 'nosniff' && h.get('x-frame-options') === 'SAMEORIGIN')
      check(`${path} (${enc}): revalidated, varies on encoding`, h.get('cache-control') === 'no-cache' && /accept-encoding/i.test(h.get('vary') ?? ''))
      const html = (await r.text())
      const tags = html.match(/<script\b[^>]*>|<link rel="modulepreload"[^>]*>/g) ?? []
      check(`${path} (${enc}): body has the boot script`, tags.some((t) => t.startsWith('<script') && t.includes('src="/assets/')))
      check(`${path} (${enc}): every script and modulepreload carries this response's nonce`, !!nonce && tags.every((t) => t.includes(`nonce="${nonce}"`)), tags.join(' '))
      check(`${path} (${enc}): no inline script, no placeholder left`, !/<script(?![^>]*\bsrc=)/.test(html) && !html.includes('__CSP_NONCE__'))
      if (nonce) {
        check(`${path} (${enc}): nonce is new for each response`, !seen.has(nonce))
        seen.add(nonce)
      }
    }
  }
  // One-time HTTP cache purge: Clear-Site-Data "cache" only, until the marker cookie is held.
  const marker = `${CACHE_PURGE_COOKIE}=${CACHE_PURGE_EPOCH}`
  const setCookies = (r: Response) => r.headers.getSetCookie()
  const purgeOk = (r: Response) => r.headers.get('clear-site-data') === '"cache"'
  const markerSet = (r: Response) => setCookies(r).filter((c) => c.startsWith(marker + ';'))
  for (const path of ['/', '/api/me']) {
    const first = await fetch(base + path)
    check(`${path}: first load clears the cache, only "cache"`, purgeOk(first), first.headers.get('clear-site-data'))
    const mc = markerSet(first)
    check(`${path}: marker cookie set once, HttpOnly, SameSite, 400 days`, mc.length === 1 && /; HttpOnly/.test(mc[0]) && /; SameSite=Lax/.test(mc[0]) && /; Max-Age=34560000/.test(mc[0]) && /; Path=\//.test(mc[0]), mc)
    check(`${path}: no other cookie, no storage or cookie directives`, setCookies(first).length === 1 && !/cookies|storage|executionContexts|\*/.test(first.headers.get('clear-site-data') ?? ''), setCookies(first))
    const again = await fetch(base + path, { headers: { Cookie: marker } })
    check(`${path}: marker present, no purge and no cookie`, !again.headers.has('clear-site-data') && setCookies(again).length === 0)
    const old = await fetch(base + path, { headers: { Cookie: `${CACHE_PURGE_COOKIE}=0` } })
    check(`${path}: an older epoch purges again`, purgeOk(old) && markerSet(old).length === 1)
  }
  const html1 = await fetch(base + '/')
  check('/: security, CSP and cache headers unchanged by the purge', html1.headers.get('cache-control') === 'no-cache' && html1.headers.get('strict-transport-security') === 'max-age=31536000' && !!nonceOf(html1.headers.get('content-security-policy')) && html1.headers.get('x-content-type-options') === 'nosniff')
  const me1 = await fetch(base + '/api/me')
  check('/api/me: security, CSP and cache headers unchanged by the purge', me1.headers.get('cache-control') === 'no-store' && me1.headers.get('content-security-policy') === GENERAL && me1.headers.get('strict-transport-security') === 'max-age=31536000')
  // A stale uid cookie with no session is cleared next to the marker: both Set-Cookie lines survive.
  const merged = await fetch(base + '/api/me', { headers: { Cookie: 'mvlos_uid=7' } })
  const mcs = setCookies(merged)
  check('/api/me: uid repair and purge marker are both set', mcs.length === 2 && mcs.some((c) => /^mvlos_uid=; .*Max-Age=0/.test(c)) && mcs.some((c) => c.startsWith(marker + ';')), mcs)
  const repairOnly = await fetch(base + '/api/me', { headers: { Cookie: `mvlos_uid=7; ${marker}` } })
  check('/api/me: marker present leaves just the uid repair', !repairOnly.headers.has('clear-site-data') && setCookies(repairOnly).length === 1 && setCookies(repairOnly)[0].startsWith('mvlos_uid=;'))
  // The marker is Secure on HTTPS and tolerates cookie noise and malformed values.
  const fake = (cookie: string | undefined) => ({ headers: { cookie, 'x-forwarded-proto': 'https', host: 'x.test' } }) as never
  check('purge marker is Secure on HTTPS', /; Secure$/.test(String(cachePurge(fake(undefined))['Set-Cookie'])))
  check('purge skipped with the marker among other cookies', Object.keys(cachePurge(fake(`a=b; ${marker}; mvlos_session=s`))).length === 0)
  check('purge repeats when cookies are blocked or malformed', 'Clear-Site-Data' in cachePurge(fake(undefined)) && 'Clear-Site-Data' in cachePurge(fake(`${CACHE_PURGE_COOKIE}=%E0%A4%A`)))

  // Compressed bodies decode to the same page as the plain one, apart from the nonce.
  const strip = (t: string) => t.replace(/nonce="[^"]*"/g, '')
  const plain = strip(await get2('/', 'identity').then((r) => r.text()))
  // fetch decodes Content-Encoding itself, so a body that came back garbled would fail here.
  const gz = strip(await get2('/', 'gzip').then((r) => r.text()))
  const brText = strip(await get2('/', 'br').then((r) => r.text()))
  check('gzip and Brotli bodies match the plain page', gz === plain && brText === plain)
  const head = await fetch(base + '/', { method: 'HEAD' })
  check('HEAD / carries a document CSP too', !!nonceOf(head.headers.get('content-security-policy')))
  const asset = await get('/assets/' + (await get2('/').then((r) => r.text())).match(/\/assets\/index-[^"]+\.js/)![0].slice(8))
  check('built script keeps the general CSP', asset.get('content-security-policy') === GENERAL, asset.get('content-security-policy'))
  // A share page (here the 404 every unknown token gets) keeps its own, tighter policy.
  const share = await get('/s/' + 'x'.repeat(24))
  const csp = share.get('content-security-policy') ?? ''
  check('share page: own CSP, not the general one', /^default-src 'none'; style-src 'nonce-/.test(csp) && csp.includes("frame-ancestors 'none'"), csp)
  check('share page: HSTS', share.get('strict-transport-security') === 'max-age=31536000')

  // --- Real browser ---------------------------------------------------------------------------
  // A second origin standing in for the OnlyOffice document server: it serves an api.js that sets a flag.
  const office = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/javascript', 'Access-Control-Allow-Origin': '*' }).end('window.__officeApi = true')
  })
  await new Promise<void>((r) => office.listen(0, '127.0.0.1', r))
  const officeOrigin = `http://127.0.0.1:${(office.address() as { port: number }).port}`
  // A page under the exact policy the server sends: a nonced boot script that loads api.js the way
  // src/apps/Office.tsx does, plus the things an attacker could get into a page.
  const fixture = createServer((req, res) => {
    const nonce = 'dGVzdG5vbmNlMTIzNDU2Nzg5MA=='
    const csp = documentCsp(nonce)
    const html = `<!doctype html><html><body><div id="victim"></div>
<script nonce="${nonce}">
  window.__violations = []
  document.addEventListener('securitypolicyviolation', (e) => window.__violations.push(e.violatedDirective + ' ' + (e.blockedURI || 'inline')))
  window.loadApi = (src) => new Promise((ok, no) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => no(new Error('blocked')); document.head.append(s) })
</script>
<script>window.__inlineRan = true</script>
<script src="${officeOrigin}/untrusted-markup.js"></script>
<script nonce="${nonce}">
  document.getElementById('victim').innerHTML = '<img src=x onerror="window.__handlerRan = true"><script>window.__innerHtmlRan = true<\/script>'
</script>
</body></html>`
    res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': csp }).end(html)
  })
  await new Promise<void>((r) => fixture.listen(0, '127.0.0.1', r))
  const browser = await launch(1000, 700)
  try {
    const open = async (url: string) => {
      const page = await newPage(browser, 1000, 700, '')
      await page.send('Page.navigate', { url })
      return page
    }
    const page = await open(`http://127.0.0.1:${(fixture.address() as { port: number }).port}/`)
    await page.waitFor("typeof window.loadApi === 'function'", 15_000)
    await sleep(500)
    check('browser: inline script without the nonce is blocked', (await page.eval('window.__inlineRan === true')) === false)
    check('browser: external script in markup, without the nonce, is blocked', (await page.eval('window.__officeApi === true')) === false)
    check('browser: script and event handler injected through innerHTML do not run', (await page.eval('!window.__innerHtmlRan && !window.__handlerRan')) === true)
    const loaded = await page.eval(`window.loadApi(${JSON.stringify(officeOrigin + '/api.js')}).then(() => window.__officeApi === true, () => false)`)
    check("browser: a trusted script's dynamic script from another origin (Office api.js) loads and runs", loaded === true)
    await page.close()

    // The real page, served by the real server, still boots under its policy.
    const real = await open(base + '/')
    await real.eval(`window.__v = []; document.addEventListener('securitypolicyviolation', (e) => window.__v.push(e.violatedDirective + ' ' + e.blockedURI))`).catch(() => {})
    await real.waitFor("document.getElementById('root') && document.getElementById('root').children.length > 0", 60_000).then(
      () => check('browser: the real page boots under the nonce policy', true),
      (e) => check('browser: the real page boots under the nonce policy', false, e.message),
    )
    check('browser: the boot raised no script errors', real.errors.length === 0, real.errors.join(' | '))
    await real.close()
  } finally {
    await browser.close()
    office.close()
    fixture.close()
  }
} finally {
  child.kill()
  rmSync(dir, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
