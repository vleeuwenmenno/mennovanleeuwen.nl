// Build first. Uses an isolated browser profile and static server: no live accounts or API.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import assert from 'node:assert/strict'
import { launch, newPage, sleep } from './perf/cdp.ts'

const root = new URL('../dist', import.meta.url).pathname
const port = Number(process.env.PWA_CHECK_PORT || 5296)
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' }
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname
  if (path.startsWith('/api/')) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end('{}')
    return
  }
  let body, name = path === '/' ? '/index.html' : path
  try {
    body = await readFile(root + name)
  } catch {
    name = '/index.html'
    body = await readFile(root + name)
  }
  res.setHeader('Content-Type', types[extname(name)] || 'application/octet-stream')
  res.end(body)
})
await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(port, '127.0.0.1', resolve)
})
let browser, page
try {
  browser = await launch(1280, 800)
  page = await newPage(browser, 390, 844, '')
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: true })
  await page.send('Page.navigate', { url: `http://127.0.0.1:${port}/` })
  await page.waitFor(`document.readyState === 'complete'`)
  for (let i = 0; i < 40; i++) {
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await sleep(150)
    if (await page.eval(`!document.querySelector('.boot')`)) break
  }
  await page.waitFor(`!!document.querySelector('.topbar') && !document.querySelector('.boot')`)
  await sleep(300)
  await page.eval(`window.dispatchEvent(new CustomEvent('mvlos:open', { detail: 'notebook' }))`)
  await page.waitFor(`!!document.querySelector('.notebook')`)
  assert.equal(await page.eval(`getComputedStyle(document.querySelector('.notebook .nb-main')).display`), 'none')
  await page.clickText('.nb-search button')
  await page.waitFor(`!!document.querySelector('.nb-editor')`)
  assert.equal(await page.eval(`getComputedStyle(document.querySelector('.notebook .nb-side')).display`), 'none')
  await page.eval(`(() => {
    const e = document.querySelector('.nb-editor')
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(e, '# Mobile test\\n\\nSaved text')
    e.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await page.clickText('.nb-back')
  await page.clickText('.nb-item', 'Mobile test')
  assert.equal(await page.eval(`document.querySelector('.nb-editor').value`), '# Mobile test\n\nSaved text')
  console.log('PASS Notes list, create, edit, back, reopen')

  await sleep(400) // Let the window entrance animation settle before tapping a title-bar control.
  await page.clickText('[data-app="notebook"] .ctl-max')
  await page.waitFor(`document.querySelector('[data-app="notebook"]').classList.contains('is-max')`)
  const bounds = () => page.eval(`(() => {
    const e = document.querySelector('[data-app="notebook"]')
    const r = e.getBoundingClientRect(), c = getComputedStyle(e)
    return { x: r.x, y: r.y, w: r.width, h: r.height, border: c.borderTopWidth, radius: c.borderRadius, shadow: c.boxShadow }
  })()`)
  assert.deepEqual(await bounds(), { x: 0, y: 0, w: 390, h: 844, border: '0px', radius: '0px', shadow: 'none' })
  assert.equal(await page.eval(`getComputedStyle(document.querySelector('.topbar')).visibility`), 'hidden')
  await page.send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 1, mobile: false })
  await sleep(300)
  assert.deepEqual(await bounds(), { x: 0, y: 0, w: 844, h: 390, border: '0px', radius: '0px', shadow: 'none' })
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false })
  await sleep(300)
  await page.clickText('.mobile-window-restore')
  assert.equal(await page.eval(`document.querySelector('[data-app="notebook"]').classList.contains('is-max')`), false)
  assert.equal(await page.eval(`getComputedStyle(document.querySelector('.topbar')).visibility`), 'visible')
  console.log('PASS Maximize edges, chrome, landscape rotation, restore')

  await page.waitFor(`!!navigator.serviceWorker.controller`)
  assert.equal(await page.eval(`(async () => {
    const keys = await caches.keys()
    const c = await caches.open(keys.find(k => k.startsWith('mvlos-shell-')))
    return !!await c.match('/')
  })()`), true)
  await page.send('Network.enable')
  await page.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 })
  await page.send('Page.reload')
  await page.waitFor(`!!document.querySelector('#root')?.children.length`)
  assert.equal(await page.eval('document.title'), 'MvL OS')
  console.log('PASS Production service worker caches shell and reloads offline')
  assert.deepEqual(page.errors, [])
} catch (error) {
  console.error(error)
  if (page) console.error('Browser errors:', page.errors, 'Page:', await page.eval('document.body.innerText.slice(0, 1000)'))
  process.exitCode = 1
} finally {
  if (browser) await browser.close()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
