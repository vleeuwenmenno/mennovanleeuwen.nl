// Real touch input against an isolated, muted Chromium. Checks top-bar edits only.
// pnpm check:topbar-touch (PORT overrides the scratch dev-server port).
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { launch, newPage, sleep } from './perf/cdp.ts'

const port = Number(process.env.PORT ?? 5291)
const data = mkdtempSync('/tmp/mvlos-topbar-touch-')
const vite = spawn(`${process.cwd()}/node_modules/.bin/vite`, ['--port', String(port), '--strictPort'], {
  env: { ...process.env, DATA_DIR: data, MC_WATCH: 'off' }, stdio: ['ignore', 'pipe', 'pipe'],
})
let log = ''
vite.stdout.on('data', (d) => (log += d))
vite.stderr.on('data', (d) => (log += d))
let browser: Awaited<ReturnType<typeof launch>> | undefined
const stop = async () => { await browser?.close(); vite.kill(); rmSync(data, { recursive: true, force: true }) }
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => void stop().finally(() => process.exit(1)))
let failed = 0
const check = (label: string, ok: boolean) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); if (!ok) failed++ }
try {
  for (let i = 0; i < 150 && !log.includes('ready') && vite.exitCode === null; i++) await sleep(200)
  if (!log.includes('ready')) throw new Error(log)
  browser = await launch(390, 844)
  const p = await newPage(browser, 390, 844, '')
  await p.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
  await p.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  const prefs = 'window.__topbar'
  const load = async () => {
    await p.send('Page.navigate', { url: `http://127.0.0.1:${port}/` })
    await p.waitFor(`document.querySelector('.topbar') && !document.querySelector('.boot')`, 90_000)
    await p.eval(`(async () => { window.__topbar = await import('/src/os/topbarPrefs.ts') })()`)
  }
  const order = () => p.eval<string>(`${prefs}.topbarPrefs().order.join('|')`)
  const point = (sel: string) => p.eval<{ x: number; y: number }>(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
  const handle = '.topbar-slot[data-id="search"] .topbar-reorder-handle'
  const touch = async (type: string, at?: { x: number; y: number }) => {
    await p.send('Input.dispatchTouchEvent', { type, touchPoints: at ? [{ ...at, id: 1 }] : [] })
    await sleep(60)
  }
  const startDrag = async () => {
    const from = await point(handle)
    const to = await point('.topbar-slot[data-id="menu"]')
    await touch('touchStart', from)
    for (let i = 1; i <= 8; i++) await touch('touchMove', { x: from.x + (to.x - from.x - 8) * i / 8, y: from.y })
  }
  await load()
  await p.eval(`${prefs}.setTopbarLocked(false)`)
  await p.waitFor(`!!document.querySelector(${JSON.stringify(handle)})`)
  const original = await order()
  const widget = await point('.topbar-slot[data-id="search"] > button')
  await touch('touchStart', widget)
  await touch('touchEnd')
  check('unlocked widget taps still open search without reordering', await p.eval(`!!document.querySelector('.spotlight')`) && await order() === original)
  await p.eval(`(async () => { (await import('/src/os/overlays.ts')).setOverlay(null) })()`)

  check('handles reserve gestures; widget surfaces allow native panning', await p.eval(`getComputedStyle(document.querySelector(${JSON.stringify(handle)})).touchAction === 'none' && getComputedStyle(document.querySelector('.topbar-slot[data-id="search"]')).touchAction === 'auto'`))
  await startDrag()
  check('touch drag previews reorder without saving', await p.eval(`document.querySelector('.topbar').classList.contains('is-reordering') && document.querySelector('.topbar > [data-id]').dataset.id === 'search'`) && await order() === original)
  await touch('touchCancel')
  check('touch cancellation restores order and clears drag state', await order() === original && await p.eval(`!document.body.classList.contains('is-dragging') && document.querySelector('.topbar > [data-id]').dataset.id === 'menu'`))
  await startDrag()
  await touch('touchEnd')
  const saved = await order()
  check('touch drop saves new order', saved !== original && saved.startsWith('search|'))
  await load()
  check('order persists after reload', await order() === saved)
  await p.eval(`document.querySelector(${JSON.stringify(handle)}).focus()`)
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 })
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 })
  await sleep(100)
  const keyboard = await order()
  check('keyboard fallback moves item and keeps focus', keyboard.startsWith('menu|search|') && await p.eval(`document.activeElement === document.querySelector(${JSON.stringify(handle)})`))
  await startDrag()
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await touch('touchEnd')
  check('Escape cancels without persistence', await order() === keyboard && await p.eval(`!document.body.classList.contains('is-dragging')`))
  const at = await point(handle)
  await touch('touchStart', at)
  await touch('touchEnd')
  await p.waitFor(`!!document.querySelector('.ctx-menu')`)
  check('tap fallback offers move and lock actions', await p.eval(`document.querySelector('.ctx-menu').textContent.includes('Move left') && document.querySelector('.ctx-menu').textContent.includes('Lock the top bar')`))
  const move = await point('.ctx-menu button')
  await touch('touchStart', move)
  await touch('touchEnd')
  await sleep(100)
  check('tap fallback saves reorder', (await order()).startsWith('search|menu|'))
  // A second touch cancelling must not finish the primary pointer's drag.
  await startDrag()
  await p.eval(`window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 999, pointerType: 'touch' }))`)
  check('unrelated pointer cancellation does not interrupt active drag', await p.eval(`document.body.classList.contains('is-dragging')`))
  await p.eval(`window.dispatchEvent(new Event('blur'))`)
  await touch('touchEnd')
  check('losing focus cancels preview', await order() === saved && await p.eval(`!document.body.classList.contains('is-dragging')`))
  await startDrag()
  await p.eval(`${prefs}.setTopbarLocked(true)`)
  await touch('touchEnd')
  check('locking during drag cancels without saving', await order() === saved && await p.eval(`!document.body.classList.contains('is-dragging')`))
  check('locking removes handles', await p.eval(`!document.querySelector('.topbar-reorder-handle')`))
  const locked = await order()
  const search = await point('.topbar-slot[data-id="search"] > button')
  await touch('touchStart', search)
  await touch('touchEnd')
  check('widget activation still opens search while locked', await p.eval(`!!document.querySelector('.spotlight')`) && await order() === locked)
  await p.eval(`(async () => { (await import('/src/os/overlays.ts')).setOverlay(null) })()`)
  await p.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false })
  await p.send('Emulation.setTouchEmulationEnabled', { enabled: false })
  await p.eval(`${prefs}.setTopbarLocked(false)`)
  await sleep(100)
  const mouseFrom = await point('.topbar-slot[data-id="search"] > button')
  const mouseTo = await point('.topbar-slot[data-id="notifications"]')
  await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...mouseFrom })
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...mouseFrom, button: 'left', buttons: 1, clickCount: 1 })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: mouseTo.x + 10, y: mouseTo.y, buttons: 1 })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: mouseTo.x + 10, y: mouseTo.y, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(100)
  check('desktop mouse drag still saves reorder without activating widget', (await order()).endsWith('|search') && await p.eval(`!document.querySelector('.spotlight')`))

} finally {
  await stop()
}
if (failed) process.exitCode = 1
