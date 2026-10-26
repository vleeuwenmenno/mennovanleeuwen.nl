// The Terminal on a phone, in a touch-emulated Chromium: a tap brings the keyboard back, the block
// cursor sits on the caret's cell, the agents TUI stays inside its columns and redraws for every
// size, and the suggestions row above the keyboard offers and inserts completions. Muted, isolated
// profile and scratch account. A real iOS keyboard is not emulated: see README (Terminal).
// pnpm check:terminal-mobile (PORT overrides the isolated dev server port).
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'

const WT = process.env.WT ?? process.cwd()
const PORT = Number(process.env.PORT ?? 5289)
const data = mkdtempSync('/tmp/mvlos-terminal-mobile-')
process.env.DATA_DIR = data
const { database, encrypt, sha256 } = await import(`${WT}/server/db.ts`)
const { launch, newPage, sleep } = await import(`${WT}/scripts/perf/cdp.ts`)

let failed = 0
const check = (what: string, ok: boolean, extra?: unknown) => {
  console.log(ok ? 'PASS' : 'FAIL', what, ok || extra === undefined ? '' : JSON.stringify(extra))
  if (!ok) failed++
}

// A signed-in account with an Ollama key on file: that is all `agents` asks for to open.
const now = Date.now()
const sid = randomBytes(24).toString('hex')
const login = 'terminal-mobile-check'
database().prepare('INSERT INTO users (id, github_id, login, github_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(1, 1, login, encrypt('none'), now, now)
database().prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(sid), 1, now, now + 86400_000)
database().prepare('INSERT INTO integrations (user_id, name, secret, created_at) VALUES (?, ?, ?, ?)').run(1, 'ollama', encrypt('none'), now)

const vite = spawn(`${WT}/node_modules/.bin/vite`, ['--port', String(PORT), '--strictPort'], {
  cwd: WT,
  env: { ...process.env, DATA_DIR: data, GITHUB_CLIENT_ID: 'x', GITHUB_CLIENT_SECRET: 'x', ADMIN_USERS: 'nobody', MC_WATCH: 'off' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
const browsers: { close: () => Promise<void> }[] = []
const stop = async () => {
  for (const b of browsers) await b.close().catch(() => {})
  vite.kill()
  rmSync(data, { recursive: true, force: true })
}
// Stopped with the script, however it ends.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGPIPE'] as const) process.on(sig, () => void stop().finally(() => process.exit(1)))
let log = ''
vite.stdout.on('data', (d) => (log += d))
vite.stderr.on('data', (d) => (log += d))
const origin = `http://127.0.0.1:${PORT}`
for (let i = 0; i < 150 && !log.includes('ready') && vite.exitCode === null; i++) await sleep(200)
if (!log.includes('ready') || vite.exitCode !== null) throw new Error(`vite did not start:\n${log}`)

type Opened = Awaited<ReturnType<typeof newPage>>
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'

/** A phone (touch, 2x, a mobile user agent), or a desktop window, on the terminal. */
async function open(kind: 'phone' | 'desktop'): Promise<Opened> {
  const [w, h] = kind === 'phone' ? [390, 844] : [1400, 900]
  const b = await launch(w, h)
  browsers.push(b)
  const page = await newPage(b, w, h, '')
  if (kind === 'phone') {
    await page.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true })
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    await page.send('Emulation.setUserAgentOverride', { userAgent: IPHONE })
  }
  for (const [name, value] of [['mvlos_sid', sid], ['mvlos_login', login], ['mvlos_uid', '1']]) await page.send('Network.setCookie', { name, value, url: origin })
  await page.send('Page.navigate', { url: `${origin}/?open=terminal` })
  await page.waitFor(`!!document.querySelector('.terminal')`, 90_000)
  await sleep(1500)
  // The "set up file storage" notice covers the top of the screen and has nothing to do with this.
  await page.eval(`document.querySelectorAll('.toast, .notification, [class*="notif"]').forEach((e) => e.remove())`)
  return page
}

const tap = async (p: Opened, x: number, y: number) => {
  await p.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
  await p.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await sleep(150)
}
const tapEl = async (p: Opened, sel: string) => {
  const at = await p.eval<{ x: number; y: number }>(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
  await tap(p, at.x, at.y)
}
const typeText = async (p: Opened, text: string) => {
  await p.send('Input.insertText', { text })
  await sleep(350)
}
const press = async (p: Opened, key: string, code: string, vk: number, text?: string) => {
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, ...(text ? { text } : {}) })
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk })
}
const hasFocus = (p: Opened) => p.eval<boolean>(`document.activeElement === document.querySelector('.t-input input')`)
const chips = (p: Opened) => p.eval<string[]>(`[...document.querySelectorAll('.t-hint')].map((b) => b.textContent)`)
const typed = (p: Opened) => p.eval<string>(`document.querySelector('.t-input input').value`)
const clearLine = async (p: Opened) => {
  for (let i = 0; i < 40; i++) await press(p, 'Backspace', 'Backspace', 8)
  await sleep(250)
}

/** What the agents TUI drew against what fits: its box rows must be as wide as the columns, on one line each. */
const probe = (p: Opened) =>
  p.eval<{ cols: number; boxRow: number; wrapped: number; rowsFit: number }>(`(() => {
    const t = document.querySelector('.terminal')
    const out = [...t.querySelectorAll('.t-out')].pop()
    const lines = out.textContent.split('\\n')
    const cs = getComputedStyle(t)
    const probe = document.createElement('span')
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre'
    probe.textContent = 'M'.repeat(40)
    t.appendChild(probe)
    const cw = probe.offsetWidth / 40
    probe.remove()
    const inner = t.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
    const lh = parseFloat(cs.lineHeight)
    const innerH = t.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)
    return { cols: Math.floor(inner / cw), boxRow: lines[0].length, wrapped: Math.round((out.getBoundingClientRect().height / lh - lines.length) * 100) / 100, rowsFit: Math.floor(innerH / lh) }
  })()`)

try {
  // ----- A phone ---------------------------------------------------------------------------------
  const phone = await open('phone')
  check('the emulation is a touch screen', await phone.eval(`matchMedia('(pointer: coarse)').matches`))

  // 1. A tap brings the keyboard (the focus) back, in the shell and in agents.
  await tap(phone, 100, 90)
  check('a tap on the prompt line focuses it', await hasFocus(phone))
  await phone.eval(`document.activeElement.blur()`)
  check('(blurred, as iOS does for Done)', !(await hasFocus(phone)))
  await tap(phone, 200, 500)
  check('a tap on the empty screen focuses the prompt again', await hasFocus(phone))
  await phone.eval(`document.activeElement.blur()`)
  await phone.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 200, y: 500 }] })
  await phone.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 200, y: 400 }] })
  await phone.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await sleep(150)
  check('a drag (scrolling) does not', !(await hasFocus(phone)))
  await tap(phone, 200, 500)
  // Still the active element, keyboard gone (Android's Back): the tap starts over.
  await phone.eval(`window.__refocus = 0; document.querySelector('.t-input input').addEventListener('focus', () => window.__refocus++)`)
  await phone.eval(`document.documentElement.classList.remove('keyboard-open')`)
  await tap(phone, 200, 500)
  // (Chromium also sends mouse events for the tap, which focus again by themselves; iOS does not.)
  check('a tap while still focused without a keyboard focuses it again', (await phone.eval<number>(`window.__refocus`)) >= 1 && (await hasFocus(phone)))

  // 3. The cursor sits right after what was typed.
  await typeText(phone, 'agents')
  const cur = await phone.eval<{ at: number; text: number; scale: number }>(`(() => {
    const i = document.querySelector('.t-input input')
    const c = document.querySelector('.t-cursor')
    const cs = getComputedStyle(i)
    const k = i.getBoundingClientRect().width / i.offsetWidth
    const ctx = document.createElement('canvas').getContext('2d')
    ctx.font = cs.fontSize + ' ' + cs.fontFamily
    return { at: c.getBoundingClientRect().left - i.getBoundingClientRect().left, text: ctx.measureText(i.value).width * k, scale: k }
  })()`)
  check('the field is scaled to the terminal text size', cur.scale < 0.9 && cur.scale > 0.7, cur)
  check('the cursor is where the typed text ends', Math.abs(cur.at - cur.text) < 0.8, cur)
  const lineH = await phone.eval<{ field: number; row: number }>(`({ field: document.querySelector('.t-field').getBoundingClientRect().height, row: document.querySelector('.t-input').getBoundingClientRect().height })`)
  check('the prompt row is one text line tall', lineH.row < 21, lineH)

  // 2. agents: boxes stay on one line each, and it redraws for every size.
  await press(phone, 'Enter', 'Enter', 13, '\r')
  await phone.waitFor(`document.querySelector('.terminal').classList.contains('is-takeover')`, 20_000)
  await sleep(800)
  const symbols = await phone.eval<string>(`JSON.stringify([...document.fonts].filter((f) => f.unicodeRange.includes('2500')).map((f) => f.status))`)
  check('the symbols font loaded for the box drawing', symbols === '["loaded"]', symbols)
  const sizes: [number, number][] = [[390, 844], [320, 568], [390, 500], [360, 740]]
  for (const [w, h] of sizes) {
    await phone.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true })
    await sleep(900)
    const r = await probe(phone)
    check(`agents at ${w}x${h}: box rows are as wide as the columns (${r.cols - 1})`, r.boxRow === r.cols - 1, r)
    check(`agents at ${w}x${h}: no row wraps`, r.wrapped === 0, r)
  }
  for (const px of [18, 10, 13]) {
    await phone.eval(`import('/src/terminal/prefs.ts').then((m) => m.setTerminalPrefs({ fontMobile: ${px} }))`)
    await sleep(900)
    const r = await probe(phone)
    check(`agents at text size ${px}: redrawn to ${r.cols - 1} wide, no row wraps`, r.boxRow === r.cols - 1 && r.wrapped === 0, r)
  }
  // The keyboard opening takes room from the bottom: the rows it has follow.
  const before = await probe(phone)
  await phone.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 500, deviceScaleFactor: 2, mobile: true })
  await sleep(900)
  const after = await probe(phone)
  check('a shorter screen (keyboard open) gives agents fewer rows', after.rowsFit < before.rowsFit, { before, after })
  await phone.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
  await sleep(900)

  // 1 again, in the TUI (its own prompt is hidden): a tap brings the focus back.
  await phone.eval(`document.activeElement.blur()`)
  await tap(phone, 200, 600)
  check('a tap on the agents screen focuses the prompt again', await hasFocus(phone))

  // 4. The suggestions in agents.
  check('no suggestions with nothing typed', (await chips(phone)).length === 0)
  await typeText(phone, '/')
  let c = await chips(phone)
  check('"/" offers slash commands, at most eight', c.length > 0 && c.length <= 8 && c.every((x) => x.startsWith('/')), c)
  await typeText(phone, 'st')
  c = await chips(phone)
  check('"/st" narrows to /stats and /status', c.includes('/status') && c.includes('/stats') && c.every((x) => x.startsWith('/st')), c)
  const hintBox = await phone.eval<{ w: number; sh: number; h: number }>(`(() => { const e = document.querySelector('.t-hints'); return { w: e.clientWidth, sh: e.scrollHeight, h: e.clientHeight } })()`)
  check('the suggestions are one line', hintBox.sh <= hintBox.h + 1, hintBox)
  await tapEl(phone, '.t-hint')
  check('a tapped suggestion goes on the line, the keyboard stays', (await hasFocus(phone)) && (await phone.eval<boolean>(`[...document.querySelectorAll('.t-out')].pop().textContent.includes('> /stat')`)))
  await phone.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67, modifiers: 2 })
  await phone.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67, modifiers: 2 })
  await sleep(300)
  await typeText(phone, '!l')
  c = await chips(phone)
  check('"!l" offers the shell\'s commands', c.includes('ls') && c.length <= 8, c)
  await clearLine(phone)
  await typeText(phone, '@./')
  c = await chips(phone)
  check('"@./" offers the folder\'s files', c.length > 0 && c.length <= 8 && c.every((x) => x.startsWith('@./')), c)
  await tapEl(phone, '.t-hint')
  check('a tapped path replaces the word', (await phone.eval<boolean>(`[...document.querySelectorAll('.t-out')].pop().textContent.includes('> @./')`)))
  await clearLine(phone)
  check('the suggestions go when there is nothing to offer', (await chips(phone)).length === 0)
  // Leave agents: Ctrl+C twice.
  await phone.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67, modifiers: 2 })
  await phone.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67, modifiers: 2 })
  await phone.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67, modifiers: 2 })
  await phone.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67, modifiers: 2 })
  await phone.waitFor(`!document.querySelector('.terminal').classList.contains('is-takeover')`, 10_000)
  check('(left agents)', true)
  await sleep(500)

  // 4. The suggestions at the shell prompt.
  await tap(phone, 200, 500)
  await typeText(phone, 'he')
  c = await chips(phone)
  check('"he" offers commands from the shell\'s completion', c.includes('help') && c.length <= 8, c)
  await tapEl(phone, '.t-hint')
  check('a tapped command goes in with its space, the keyboard stays', (await typed(phone)) === 'help ' && (await hasFocus(phone)), await typed(phone))
  await clearLine(phone)
  await typeText(phone, 'ls ~/')
  c = await chips(phone)
  check('a path word offers files and folders', c.length > 0 && c.length <= 8, c)
  await clearLine(phone)
  check('nothing typed, nothing offered', (await chips(phone)).length === 0)
  check('the phone page had no errors', phone.errors.length === 0, phone.errors)

  // ----- A desktop window: nothing changes -------------------------------------------------------
  const desk = await open('desktop')
  await desk.eval(`document.querySelector('.t-input input').focus()`)
  await typeText(desk, 'he')
  const d = await desk.eval<{ chips: number; fs: string; transform: string; keys: number }>(`(() => { const cs = getComputedStyle(document.querySelector('.t-input input')); return { chips: document.querySelectorAll('.t-hints').length, fs: cs.fontSize, transform: cs.transform, keys: document.querySelectorAll('.t-keys').length } })()`)
  check('on a desktop there is no suggestions row', d.chips === 0 && d.keys === 0, d)
  check('on a desktop the prompt field is not scaled', d.transform === 'none' && d.fs === '13px', d)
  check('the desktop page had no errors', desk.errors.length === 0, desk.errors)
} catch (e) {
  console.error(e)
  failed++
} finally {
  await stop()
}
console.log(failed ? `${failed} check(s) failed` : 'all passed')
process.exit(failed ? 1 : 0)
