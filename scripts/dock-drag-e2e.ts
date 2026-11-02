// Real pointer regression checks, including rapid FLIP interruption, UI zoom and phone touch.
// pnpm check:dock-drag (PORT overrides the isolated scratch-data Vite server).
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { launch, newPage, sleep } from './perf/cdp.ts'

const data = mkdtempSync('/tmp/mvlos-dock-drag-')
process.env.DATA_DIR = data
const { database, encrypt, sha256 } = await import('../server/db.ts')
const port = Number(process.env.PORT ?? 5286)
const origin = `http://127.0.0.1:${port}`
const vite = spawn('./node_modules/.bin/vite', ['--port', String(port), '--strictPort'], {
  env: { ...process.env, DATA_DIR: data, MC_WATCH: 'off', GITHUB_CLIENT_ID: 'x', GITHUB_CLIENT_SECRET: 'x', ADMIN_USERS: 'nobody' }, stdio: ['ignore', 'pipe', 'pipe'],
})
let log = ''
vite.stdout.on('data', d => { log += d })
vite.stderr.on('data', d => { log += d })
const browser = await launch(1600, 900)
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => { vite.kill(); void browser.close().finally(() => process.exit(1)) })
const page = await newPage(browser, 1600, 900, '')
const order = () => page.eval<string[]>(`[...document.querySelectorAll('.dock > [data-drop]')].map(e => e.dataset.drop)`)
const allOrder = () => page.eval<string[]>(`import('/src/os/dockItems.ts').then(m => m.resolveDock())`)
const box = (id: string) => page.eval<{ left: number; top: number; width: number; height: number }>(`(() => { const r = document.querySelector('.dock > [data-drop="${id}"]').getBoundingClientRect(); return {left:r.left,top:r.top,width:r.width,height:r.height} })()`)
const mouse = (type: string, x: number, y: number, down = true) => page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: down ? 1 : 0, clickCount: 1 })
const touch = (type: string, x = 0, y = 0) => page.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' || type === 'touchCancel' ? [] : [{ x, y, id: 1 }] })
async function start(id: string, isTouch = false) {
  const r = await box(id)
  // Off-centre grab must stay off-centre, including when a sibling is still animated.
  const x = r.left + r.width * .3, y = r.top + r.height * .4
  if (isTouch) await touch('touchStart', x, y)
  else {
    await mouse('mouseMoved', x, y, false)
    await mouse('mousePressed', x, y)
  }
  return { x, y, grabX: r.width * .3, grabY: r.height * .4 }
}
async function follows(id: string, x: number, y: number, grab: { grabX: number; grabY: number }, isTouch = false) {
  if (isTouch) await touch('touchMove', x, y)
  else await mouse('mouseMoved', x, y)
  // Two frames allow React's reordered DOM and its layout effect to settle, not the 200ms FLIP.
  await page.eval(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`)
  const r = await box(id)
  assert.ok(Math.abs(r.left + grab.grabX - x) < 2, `pointer X drift: ${JSON.stringify({ r, x, grab })}`)
  assert.ok(Math.abs(r.top + grab.grabY - y) < 2, `pointer Y drift: ${JSON.stringify({ r, y, grab })}`)
}
const clean = async () => {
  await sleep(260)
  assert.equal(await page.eval(`!!document.querySelector('.dock.is-reordering, .dock-item.is-dragged, body.is-dragging')`), false)
  assert.equal(await page.eval(`!![...document.querySelectorAll('.dock-item')].find(e => e.style.transform)`), false)
}
async function release(x: number, y: number, isTouch = false) {
  if (isTouch) await touch('touchEnd')
  else await mouse('mouseReleased', x, y, false)
  await clean()
}

try {
  for (let i = 0; i < 150 && !log.includes('ready') && vite.exitCode === null; i++) await sleep(200)
  assert.ok(log.includes('ready'), log)
  await page.send('Page.navigate', { url: origin })
  await page.waitFor(`document.querySelector('.dock > [data-drop]') && !document.querySelector('.boot')`, 90_000)
  await sleep(1000)
  const initialWindows = await page.eval(`document.querySelectorAll('.window').length`)
  for (const scale of [.75, 1, 1.5, 2]) {
    await page.eval(`import('/src/os/uiScale.ts').then(m => m.uiScalePref.set(${scale}))`)
    await sleep(300)
    const before = await allOrder()
    const ids = (await order()).filter(id => id !== 'trash')
    const id = ids[0], target = await box(ids[2])
    const grab = await start(id)
    const x = target.left + target.width * .75, y = grab.y - 25
    await follows(id, x, y, grab)
    // Stationary pointer cannot accumulate transforms while FLIP is running.
    for (let n = 0; n < 6; n++) await follows(id, x, y, grab)
    assert.notDeepEqual(await order(), [...ids, 'trash'], 'live reorder changes slots')
    // Return across the same slots rapidly, interrupting sibling FLIP in both directions.
    await follows(id, grab.x, grab.y, grab)
    await follows(id, x, y, grab)
    await release(x, y)
    assert.equal((await allOrder())[2], id, `drop persisted at scale ${scale}`)
    assert.equal(await page.eval(`document.querySelectorAll('.window').length`), initialWindows, 'drag never launches app')
    console.log(`PASS mouse reorder, stationary pointer, rapid reversal, release at ${scale * 100}%`)

    const saved = await allOrder()
    const cancelGrab = await start(id)
    await follows(id, cancelGrab.x + 80, cancelGrab.y - 20, cancelGrab)
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await mouse('mouseReleased', cancelGrab.x + 80, cancelGrab.y - 20, false)
    await clean()
    assert.deepEqual(await allOrder(), saved)
    assert.deepEqual((await order()).filter(a => a !== 'trash'), saved.slice(0, ids.length))
    assert.equal(before.length, saved.length)
    console.log(`PASS Escape restores saved order at ${scale * 100}%`)
  }

  // Clamp excursions and clean up when the window loses focus or pointer capture is lost.
  await page.eval(`import('/src/os/uiScale.ts').then(m => m.uiScalePref.set(1))`)
  await sleep(300)
  for (const reason of ['blur', 'capture', 'resize']) {
    const saved = await allOrder(), id = saved[0]
    const grab = await start(id)
    await mouse('mouseMoved', 1599, 2)
    await sleep(40)
    const r = await box(id)
    assert.ok(r.left >= -1 && r.top >= -1 && r.left + r.width <= 1601 && r.top + r.height <= 901, 'icon clamped to viewport')
    await page.eval(reason === 'capture'
      ? `(() => { const nav = document.documentElement; for (let id=1; id<10; id++) if(nav.hasPointerCapture(id)) nav.releasePointerCapture(id) })()`
      : `window.dispatchEvent(new Event('${reason}'))`)
    await mouse('mouseReleased', grab.x, grab.y, false)
    await clean()
    assert.deepEqual(await allOrder(), saved)
    console.log(`PASS viewport clamp and ${reason} cancels reorder`)
  }

  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false })
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 })
  await page.eval(`import('/src/os/dockPrefs.ts').then(m => m.setDockMode('show'))`)
  await sleep(350)
  await page.eval(`document.querySelector('.dock-handle')?.click()`)
  await sleep(350)
  const ids = (await order()).filter(id => id !== 'trash')
  assert.ok(ids.length >= 2, 'phone shows at least two pinned apps')
  const target = await box(ids[1]), grab = await start(ids[0], true)
  const x = target.left + target.width * .8, y = grab.y - 20
  await follows(ids[0], x, y, grab, true)
  for (let n = 0; n < 3; n++) await follows(ids[0], x, y, grab, true)
  await release(x, y, true)
  assert.equal((await allOrder())[1], ids[0], 'touch drop persists')
  console.log('PASS phone touch reorder and release')
  const saved = await allOrder(), cancelGrab = await start(ids[0], true)
  await follows(ids[0], cancelGrab.x - 60, cancelGrab.y - 20, cancelGrab, true)
  await touch('touchCancel')
  await clean()
  assert.deepEqual(await allOrder(), saved)
  console.log('PASS touch cancellation restores saved order')
  // Signed-in running apps can cross into the pinned group without remounting or jumping.
  const sid = randomBytes(24).toString('hex'), now = Date.now()
  database().prepare('INSERT INTO users (id, github_id, login, github_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(1, 1, 'dock-check', encrypt('none'), now, now)
  database().prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(sid), 1, now, now + 86400_000)
  for (const [name, value] of [['mvlos_sid', sid], ['mvlos_login', 'dock-check'], ['mvlos_uid', '1']]) await page.send('Network.setCookie', { name, value, url: origin })
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: false })
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false })
  await page.send('Page.navigate', { url: origin + '/?open=settings' })
  await page.waitFor(`document.querySelector('.dock > [data-drop="settings"]') && !document.querySelector('.boot')`, 90_000)
  await sleep(800)
  const pinned = await allOrder()
  assert.ok(!pinned.includes('settings'))
  const pinTarget = await box(pinned[1]), pinGrab = await start('settings')
  const pinX = pinTarget.left + pinTarget.width * .2, pinY = pinGrab.y - 15
  await follows('settings', pinX, pinY, pinGrab)
  for (let n = 0; n < 3; n++) await follows('settings', pinX, pinY, pinGrab)
  await release(pinX, pinY)
  assert.equal((await allOrder())[1], 'settings')
  console.log('PASS signed-in running app pins in requested slot without pointer drift')
  // A press with no drag still launches normally; only completed drags suppress their click.
  const count = await page.eval(`document.querySelectorAll('.window[data-app="files"]').length`)
  const tap = await start('files')
  await release(tap.x, tap.y)
  assert.equal(await page.eval(`document.querySelectorAll('.window[data-app="files"]').length`), count + 1)
  console.log('PASS ordinary dock click still opens app')
  assert.deepEqual(page.errors, [])
} finally {
  await browser.close()
  vite.kill()
  await sleep(300)
  database().close()
  rmSync(data, { recursive: true, force: true })
}
