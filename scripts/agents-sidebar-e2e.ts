// The Agents sidebar in each of its four styles (classic, compact, detailed, focus), on a desktop
// and on a phone, with 46 threads in three projects (and 3 archived): switching from the sidebar's right-click menu,
// search, selection, a row's menu, the archived view, the rail, running / unread / stopped marks,
// the Focus chips, the phone's list and conversation taking turns, and the keyboard. Muted,
// isolated profile and scratch account. SHOTS=<dir> keeps a screenshot of every view there (never
// in the repo); DUMP=<file> writes the classic sidebar's HTML, to compare two checkouts.
// pnpm check:agents-sidebar (PORT overrides the isolated dev server port, WT the checkout).
import { randomBytes, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'

const WT = process.env.WT ?? process.cwd()
const PORT = Number(process.env.PORT ?? 5293)
const SHOTS = process.env.SHOTS
const data = mkdtempSync('/tmp/mvlos-agents-sidebar-')
process.env.DATA_DIR = data
const { database, encrypt, sha256 } = await import(`${WT}/server/db.ts`)
const { launch, newPage, sleep } = await import(`${WT}/scripts/perf/cdp.ts`)
if (SHOTS) mkdirSync(SHOTS, { recursive: true })

let failed = 0
const check = (what: string, ok: boolean, extra?: unknown) => {
  console.log(ok ? 'PASS' : 'FAIL', what, ok || extra === undefined ? '' : JSON.stringify(extra))
  if (!ok) failed++
}

// ----- A scratch account with 46 threads ---------------------------------------------------------
const now = Date.now()
const H = 3600_000
const sid = randomBytes(24).toString('hex')
const login = 'agents-sidebar-check'
const db = database()
db.prepare('INSERT INTO users (id, github_id, login, github_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(1, 1, login, encrypt('none'), now, now)
db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(sid), 1, now, now + 86400_000)
db.prepare('INSERT INTO integrations (user_id, name, secret, created_at) VALUES (?, ?, ?, ?)').run(1, 'ollama', encrypt('none'), now)
const PROJECTS = ['Home lab', 'Thesis', 'Trip to Japan']
for (const [i, name] of PROJECTS.entries()) db.prepare('INSERT INTO agent_projects (id, user_id, name, sort, created_at) VALUES (?, ?, ?, ?, ?)').run(i + 1, 1, name, i, now)

type Seed = { title: string; ago: number; project?: number; deep?: boolean; pinned?: boolean; archived?: boolean; model?: string; fail?: boolean }
const LONG = 'How do I migrate a self-hosted Gitea instance with 14 repositories and their issues, wikis and webhooks to a new server without losing the SSH keys of the CI runners'
const SEEDS: Seed[] = [
  { title: 'Why does my Traefik router return 404 for the second domain', ago: 0.5, project: 1 },
  { title: 'Compare Nextcloud and Seafile for a family of five', ago: 1.5, project: 1, deep: true },
  { title: LONG, ago: 2.5 },
  { title: 'Rust borrow checker error in the PTY reader', ago: 3.5 },
  { title: 'Explain the lockstep hash mismatch', ago: 4.5, pinned: true },
  { title: 'Best way to back up a ZFS pool offsite', ago: 5.5, project: 1 },
  { title: 'Kubernetes ingress annotations cheat sheet', ago: 7 },
  { title: 'Summarise the Nature paper on protein folding', ago: 9, project: 2, deep: true },
  { title: 'Failed export of the bibliography', ago: 11, project: 2, fail: true },
  { title: 'Regex for Dutch postcodes', ago: 13 },
  { title: 'Ryokan versus hotel in Kyoto for two nights', ago: 20, project: 3 },
  { title: 'JR Pass worth it for 10 days?', ago: 22, project: 3 },
  { title: 'Tailscale subnet router on a Raspberry Pi', ago: 26, project: 1 },
  { title: 'Chapter 3 outline: related work', ago: 28, project: 2 },
  { title: 'Convert a MOV to an Apple friendly mp4 with ffmpeg', ago: 30 },
  { title: 'Which model for long documents', ago: 33 },
  { title: 'Fix flaky Playwright test on CI', ago: 36 },
  { title: 'Spanish subjunctive: when to use it', ago: 40 },
  { title: 'Day trip from Tokyo: Nikko or Kamakura', ago: 44, project: 3 },
  { title: 'Statistics: Mann-Whitney vs t-test for my survey', ago: 52, project: 2 },
  { title: 'Reverse proxy headers for websockets', ago: 60 },
  { title: 'Sourdough starter smells like acetone', ago: 72 },
  { title: 'Rewrite the abstract in 150 words', ago: 80, project: 2 },
  { title: 'Cheapest way to ship a 40 kg box to Germany', ago: 96 },
  { title: 'PostgreSQL vacuum settings for a write heavy table', ago: 110 },
  { title: 'Draft a polite reminder to the landlord', ago: 130 },
  { title: 'systemd unit that waits for the network mount', ago: 150, project: 1 },
  { title: 'What changed in Vite 7', ago: 200 },
  { title: 'Learn kanji: the 100 most common', ago: 260, project: 3 },
  { title: 'Is a 4K 144Hz monitor worth it for coding', ago: 330 },
  { title: 'Docker compose healthcheck for Postgres', ago: 400 },
  { title: 'LaTeX: float placement keeps moving my figure', ago: 480, project: 2 },
  { title: 'Rank three laptops for Linux', ago: 560 },
  { title: 'Gift ideas for a cyclist', ago: 640 },
  { title: 'DNS split horizon with Unbound', ago: 700, project: 1 },
  { title: 'Old thread about tax returns', ago: 900 },
  { title: 'Terraform state locking on S3', ago: 1000 },
  { title: 'Translate this email to Japanese', ago: 1100, project: 3 },
  { title: 'Meal prep plan for a week', ago: 1300 },
  { title: 'What is a monad, really', ago: 1500 },
  { title: 'Bash: loop over files with spaces', ago: 1700 },
  { title: 'Vim macros for repetitive edits', ago: 1900 },
  { title: 'Fan speed curve on a Framework laptop', ago: 2100 },
  { title: 'Archived: pricing for the old project', ago: 300, archived: true },
  { title: 'Archived: wedding speech draft', ago: 800, archived: true },
  { title: 'Archived: how to read a balance sheet', ago: 1500, archived: true },
]
const LIVE = SEEDS.filter((s) => !s.archived).length
const ids: string[] = []
for (const s of SEEDS) {
  const id = randomUUID()
  ids.push(id)
  const at = now - s.ago * H
  const interrupted = s.fail ? JSON.stringify({ reason: 'failed', error: 'The model stopped answering', at }) : null
  db.prepare('INSERT INTO agent_threads (id, user_id, title, mode, model, archived, quick, project_id, title_history, created_at, updated_at, pinned, interrupted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    id, 1, s.title, s.deep ? 'deep' : 'quick', s.model ?? (s.deep ? 'glm-5:cloud' : 'gpt-oss:120b-cloud'), s.archived ? 1 : 0, 0, s.project ?? null, '[]', at - H, at, s.pinned ? 1 : 0, interrupted,
  )
}
// Running (the list is patched in the page: nothing really answers): one in a project, two loose.
const RUNNING = [ids[1], ids[2], ids[3]]
// This browser has looked at everything older than 6 hours: the newest threads are new answers.
const SEEN = JSON.stringify({ since: now - 6 * H, at: {} })
const inject = `(() => {
  try { if (!localStorage.getItem('mvlos.u.1.agents.seen')) localStorage.setItem('mvlos.u.1.agents.seen', ${JSON.stringify(SEEN)}) } catch {}
  const running = new Set(${JSON.stringify(RUNNING)})
  const real = window.fetch.bind(window)
  window.fetch = async (...a) => {
    const res = await real(...a)
    const url = String(a[0] && a[0].url ? a[0].url : a[0])
    if (!/\\/api\\/agents\\/threads(\\?archived=1)?$/.test(url) || !res.ok) return res
    const list = await res.clone().json()
    if (!Array.isArray(list)) return res
    for (const t of list) if (running.has(t.id)) t.running = true
    return new Response(JSON.stringify(list), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
})()`

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
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGPIPE'] as const) process.on(sig, () => void stop().finally(() => process.exit(1)))
let log = ''
vite.stdout.on('data', (d) => (log += d))
vite.stderr.on('data', (d) => (log += d))
const origin = `http://127.0.0.1:${PORT}`
for (let i = 0; i < 150 && !log.includes('ready') && vite.exitCode === null; i++) await sleep(200)
if (!log.includes('ready') || vite.exitCode !== null) throw new Error(`vite did not start:\n${log}`)

type Opened = Awaited<ReturnType<typeof newPage>>
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'

async function open(kind: 'phone' | 'desktop'): Promise<Opened> {
  const [w, h] = kind === 'phone' ? [390, 844] : [1400, 900]
  const b = await launch(w, h)
  browsers.push(b)
  const page = await newPage(b, w, h, inject)
  if (kind === 'phone') {
    await page.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true })
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    await page.send('Emulation.setUserAgentOverride', { userAgent: IPHONE })
  }
  for (const [name, value] of [['mvlos_sid', sid], ['mvlos_login', login], ['mvlos_uid', '1']]) await page.send('Network.setCookie', { name, value, url: origin })
  await page.send('Page.navigate', { url: `${origin}/?open=agents` })
  await page.waitFor(`!!document.querySelector('.agt-side')`, 90_000)
  await sleep(1500)
  await page.eval(`document.querySelectorAll('.toast, .notification, [class*="notif"]').forEach((e) => e.remove())`)
  return page
}
const shot = async (p: Opened, name: string, whole = false) => {
  if (!SHOTS) return
  // The sidebar (and the pane beside it, when there is one), at twice the size.
  const r = whole ? null : await rect(p, '.agt')
  const { data: png } = await p.send('Page.captureScreenshot', { format: 'png', ...(r ? { clip: { x: r.x, y: r.y, width: Math.min(r.w, 700), height: r.h, scale: 1.5 } } : {}) })
  writeFileSync(`${SHOTS}/${name}.png`, Buffer.from(png, 'base64'))
}
const rect = (p: Opened, sel: string) => p.eval<{ x: number; y: number; w: number; h: number } | null>(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })()`)
const count = (p: Opened, sel: string) => p.eval<number>(`document.querySelectorAll(${JSON.stringify(sel)}).length`)
const visibleRows = (p: Opened) => p.eval<number>(`(() => { const l = document.querySelector('.agt-list').getBoundingClientRect(); return [...document.querySelectorAll('.agt-list .agt-row')].filter((e) => { const r = e.getBoundingClientRect(); return r.bottom > l.top && r.top < l.bottom }).length })()`)
const tap = async (p: Opened, x: number, y: number, phone: boolean) => {
  if (!phone) return p.click(x, y)
  await p.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
  await p.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await sleep(200)
}
const tapSel = async (p: Opened, sel: string, phone: boolean, text?: string) => {
  const at = await p.eval<{ x: number; y: number } | null>(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].filter((e) => e.getClientRects().length).find((e) => ${text ? `e.textContent.includes(${JSON.stringify(text)})` : 'true'}); if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
  if (!at) throw new Error(`Nothing to tap: ${sel} ${text ?? ''}`)
  await tap(p, at.x, at.y, phone)
  await sleep(250)
}
const rightClick = async (p: Opened, x: number, y: number) => {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await p.send('Input.dispatchMouseEvent', { type, x, y, button: 'right', buttons: type === 'mousePressed' ? 2 : 0, clickCount: 1 })
  await sleep(250)
}
const type = async (p: Opened, text: string) => {
  await p.send('Input.insertText', { text })
  await sleep(300)
}
const key = async (p: Opened, k: string, code: string, vk: number, modifiers: string[] = []) => {
  // CDP's modifiers: Alt 1, Ctrl 2, Meta 4, Shift 8.
  const bits = (['Alt', 'Control', 'Meta', 'Shift'] as const).reduce((n, name, i) => n + (modifiers.includes(name) ? 1 << i : 0), 0)
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers: bits })
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers: bits })
  await sleep(120)
}
/** Clicks a thread's row with Ctrl, Shift or plain (a plain click opens it). */
const clickRow = async (p: Opened, title: string, mods: Record<string, boolean> = {}) => {
  const init = Object.entries(mods)
    .filter(([, on]) => on)
    .map(([k]) => `${k}: true`)
    .join(', ')
  const there = await p.eval<boolean>(`(() => { const b = [...document.querySelectorAll('.agt-list .agt-row .agt-item')].find((e) => e.textContent.includes(${JSON.stringify(title)})); if (!b) return false; b.scrollIntoView({ block: 'nearest' }); b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true${init ? `, ${init}` : ''} })); return true })()`)
  if (!there) throw new Error(`No row: ${title}`)
  await sleep(220)
}
const focusedIn = (p: Opened) => p.eval<string>(`(() => { const a = document.activeElement; return a ? (a.getAttribute('aria-label') || a.className || a.tagName) + '|' + (a.textContent || '').slice(0, 40) : '' })()`)

/** Picks a style from the sidebar's own right-click menu (on its foot, where no row is). */
async function pick(p: Opened, label: string) {
  const foot = (await rect(p, '.agt-side-foot'))!
  await rightClick(p, foot.x + foot.w / 2, foot.y + foot.h / 2)
  await p.waitFor(`!!document.querySelector('.ctx-menu')`, 5000)
  await p.clickText('.ctx-item', 'Sidebar style')
  await sleep(300)
  const menus = await count(p, '.ctx-menu')
  check(`the menu has a Sidebar style submenu (${label})`, menus === 2, menus)
  await p.eval(`(() => { const items = [...document.querySelectorAll('.ctx-menu')].pop().querySelectorAll('.ctx-item'); [...items].find((e) => e.textContent.includes(${JSON.stringify(label)})).dispatchEvent(new MouseEvent('click', { bubbles: true })) })()`)
  await sleep(500)
  const open = await count(p, '.ctx-menu')
  check(`the menu closes after picking ${label}`, open === 0, open)
}

/** The same choice from Settings → General → Sidebar, in the app's own settings pane (what a phone has: no right-click). */
async function pickInSettings(p: Opened, label: string, phone: boolean) {
  if (await p.eval(`!!document.querySelector('.agt-fx-foot')`)) await tapSel(p, '.agt-fx-foot button[title="Agents settings"]', phone)
  else await tapSel(p, '.agt-side-foot button', phone, 'Settings')
  await p.waitFor(`!!document.querySelector('.agt-set')`, 10_000)
  if (!(await p.eval(`!!document.querySelector('.agt-set-styles')`))) await tapSel(p, '.agt-ov-card, .agt-set-nav button', phone, 'General')
  await p.waitFor(`!!document.querySelector('.agt-set-styles')`, 10_000)
  await tapSel(p, '.agt-set-styles .set-choice', phone, label)
  await sleep(300)
  check(`settings: ${label} is the checked choice`, await p.eval(`document.querySelector('.agt-set-styles .set-choice.is-on')?.textContent.includes(${JSON.stringify(label)}) ?? false`))
  await tapSel(p, '.agt-toolbar .agt-back', phone)
  await sleep(300)
}

const STYLES = ['classic', 'compact', 'detailed', 'focus'] as const
const rowHeight = new Map<string, number>()
const visible = new Map<string, number>()

try {
  for (const kind of ['desktop', 'phone'] as const) {
    const phone = kind === 'phone'
    const p = await open(kind)
    check(`${kind}: the app is up with the classic sidebar`, !!(await rect(p, '.agt-side.is-side-classic')))
    if (phone) check('phone: the emulation is a touch screen and the list shows on its own', (await p.eval(`matchMedia('(pointer: coarse)').matches`)) && (await p.eval(`!!document.querySelector('.agt.is-list')`)))
    check(`${kind}: classic shows the 3 projects and every thread`, (await count(p, '.agt-project')) === 3 && (await count(p, '.agt-list .agt-row')) === LIVE, await count(p, '.agt-list .agt-row'))
    if (process.env.DUMP && !phone) {
      const html = await p.eval<string>(`document.querySelector('.agt-side').outerHTML.replace(/ is-side-classic/, '')`)
      writeFileSync(process.env.DUMP, html)
    }
    await shot(p, `${kind}-classic`)

    for (const style of STYLES) {
      if (style !== 'classic') await (phone ? pickInSettings(p, style[0].toUpperCase() + style.slice(1), true) : pick(p, style[0].toUpperCase() + style.slice(1)))
      await p.waitFor(`!!document.querySelector('.agt-side.is-side-${style}')`, 5000)
      const tag = `${kind} ${style}`
      const list = (await rect(p, '.agt-list'))!
      const side = (await rect(p, '.agt-side'))!
      // Focus lists what runs twice: under Running now, and where it belongs.
      const want = style === 'focus' ? LIVE + RUNNING.length : LIVE
      check(`${tag}: all live threads are listed`, (await count(p, '.agt-list .agt-row')) === want, await count(p, '.agt-list .agt-row'))
      check(`${tag}: no sideways scrolling`, await p.eval(`(() => { const l = document.querySelector('.agt-list'); return l.scrollWidth <= l.clientWidth + 1 })()`))
      if (phone) check(`${tag}: the sidebar fills the phone`, side.w >= 340 && side.x + side.w <= 390, side)
      rowHeight.set(tag, (await rect(p, '.agt-list .agt-project .agt-row'))!.h)
      visible.set(tag, await visibleRows(p))
      check(`${tag}: the list scrolls inside the sidebar`, list.h > 150 && list.y + list.h <= side.y + side.h + 1, list)

      // Marks: running (patched), a new answer, a stopped thread.
      const running = await count(p, '.agt-list .agt-dot-mode.is-running, .agt-list .agt-fx-state.is-running, .agt-list .agt-dx-item.is-running')
      if (style === 'classic') check(`${tag}: running threads pulse`, running === 3, running)
      else {
        const unread = await count(p, '.agt-list .agt-item.is-unread')
        const stopped = await count(p, '.agt-list .agt-item.is-attention')
        check(`${tag}: 3 running, new answers and a stopped thread are marked`, running >= 3 && unread >= 3 && stopped === 1, { running, unread, stopped })
      }

      // Style specifics.
      if (style === 'compact') {
        check(`${tag}: rows are denser than classic`, rowHeight.get(tag)! < rowHeight.get(`${kind} classic`)! - 3 || phone, [rowHeight.get(tag), rowHeight.get(`${kind} classic`)])
        check(`${tag}: a New thread button sits beside the search`, !!(await rect(p, '.agt-cx-head .agt-search')) && !!(await rect(p, '.agt-cx-head .agt-cx-new')))
        check(`${tag}: group headers stick`, await p.eval(`getComputedStyle(document.querySelector('.agt-cx-day')).position === 'sticky'`))
      }
      if (style === 'detailed') {
        const lines = await p.eval<number>(`document.querySelectorAll('.agt-dx-meta').length`)
        check(`${tag}: every row has a second line`, lines === LIVE, lines)
        const long = await p.eval<number>(`(() => { const t = [...document.querySelectorAll('.agt-dx-title')].find((e) => e.textContent.startsWith('How do I migrate')); const lh = parseFloat(getComputedStyle(t).lineHeight); return Math.round(t.getBoundingClientRect().height / lh) })()`)
        check(`${tag}: a long title wraps to two lines`, long === 2, long)
        check(`${tag}: the badges say Running, New and Failed`, await p.eval(`['Running', 'New', 'Failed'].every((w) => [...document.querySelectorAll('.agt-dx-badge')].some((b) => b.textContent === w))`))
        check(`${tag}: one small New thread button, on the Threads header`, !(await rect(p, '.agt-dx-new')) && !!(await rect(p, '.agt-group-row .agt-mini[aria-label="New thread"]')))
      }
      if (style === 'focus') {
        check(`${tag}: chips All, Running, Unread, Stopped and one per project`, await p.eval(`(() => { const c = [...document.querySelectorAll('.agt-fx-chip')].map((e) => e.firstChild.textContent); return ['All', 'Running', 'Unread', 'Stopped', 'Home lab', 'Thesis', 'Trip to Japan'].every((w) => c.includes(w)) })()`))
        check(`${tag}: Running now is on top`, await p.eval(`(() => { const s = document.querySelector('.agt-fx-live'); return !!s && s.querySelectorAll('.agt-row').length === 3 && s === document.querySelector('.agt-list').firstElementChild })()`))
        check(`${tag}: the foot has icon buttons with tooltips`, await p.eval(`[...document.querySelectorAll('.agt-fx-foot button')].length === 4 && [...document.querySelectorAll('.agt-fx-foot button')].every((b) => b.title && !b.textContent.trim())`))
        check(`${tag}: one small New thread button, on the Threads header`, !(await rect(p, '.agt-fx-new')) && !!(await rect(p, '.agt-group-row .agt-mini[aria-label="New thread"]')))
        await shot(p, `${kind}-${style}-all`)
        await tapSel(p, '.agt-fx-chip', phone, 'Running')
        check(`${tag}: the Running chip lists the 3 that run`, (await count(p, '.agt-list .agt-row')) === 3 && !(await count(p, '.agt-fx-live')), await count(p, '.agt-list .agt-row'))
        await shot(p, `${kind}-${style}-running`)
        await tapSel(p, '.agt-fx-chip', phone, 'Unread')
        const unread = await count(p, '.agt-list .agt-row')
        check(`${tag}: the Unread chip lists the new answers`, unread >= 3 && unread < LIVE && (await count(p, '.agt-list .agt-item.is-unread')) === unread, unread)
        await tapSel(p, '.agt-fx-chip', phone, 'Thesis')
        check(`${tag}: a project chip lists that project's threads`, await p.eval(`(() => { const n = document.querySelectorAll('.agt-list .agt-row').length; return n === ${SEEDS.filter((s) => s.project === 2 && !s.archived).length} })()`))
        await shot(p, `${kind}-${style}-project`)
        await tapSel(p, '.agt-fx-chip', phone, 'All')
        check(`${tag}: All brings everything back`, (await count(p, '.agt-list .agt-row')) === LIVE + 3)
      }
      await shot(p, `${kind}-${style}`)
      await p.eval(`(() => { const l = document.querySelector('.agt-list'); l.scrollTop = l.scrollHeight * 0.55 })()`)
      await sleep(150)
      await shot(p, `${kind}-${style}-scrolled`)
      await p.eval(`document.querySelector('.agt-list').scrollTop = 0`)

      // Search: narrows, finds an earlier word in a long title, and Escape clears.
      await tapSel(p, '.agt-search input', phone)
      await type(p, 'kubernetes')
      check(`${tag}: search narrows the list`, (await count(p, '.agt-list .agt-row')) === 1 || (style === 'focus' && (await count(p, '.agt-list .agt-row')) <= 2), await count(p, '.agt-list .agt-row'))
      await shot(p, `${kind}-${style}-search`)
      await key(p, 'Escape', 'Escape', 27)
      check(`${tag}: Escape clears the search`, (await count(p, '.agt-list .agt-row')) >= LIVE)

      // Keyboard: Down from the search walks into the list, Up comes back.
      await p.eval(`document.querySelector('.agt-search input').focus()`)
      await key(p, 'ArrowDown', 'ArrowDown', 40)
      const first = await focusedIn(p)
      await key(p, 'ArrowDown', 'ArrowDown', 40)
      const second = await focusedIn(p)
      await key(p, 'ArrowUp', 'ArrowUp', 38)
      await key(p, 'ArrowUp', 'ArrowUp', 38)
      check(`${tag}: arrow keys walk the list and back to the search`, first !== second && /Search threads/.test(await focusedIn(p)) && !/Search/.test(first), [first, second, await focusedIn(p)])

      // Selection and the row's menu.
      await tapSel(p, '.agt-list .agt-row .agt-item', phone, 'Rust borrow checker')
      check(`${tag}: tapping a thread selects it`, await p.eval(`document.querySelector('.agt-item.is-active')?.textContent.includes('Rust borrow checker') ?? false`), await p.eval(`document.querySelector('.agt-item.is-active')?.textContent`))
      if (phone) {
        check('phone: the conversation takes over, with a way back', (await p.eval(`!!document.querySelector('.agt.is-chat')`)) && (await rect(p, '.agt-side')) !== null && !(await p.eval(`!!document.querySelector('.agt-side').offsetParent`)))
        await shot(p, `${kind}-${style}-chat`)
        await tapSel(p, '.agt-back', true)
        check('phone: back shows the list again', (await p.eval(`!!document.querySelector('.agt.is-list')`)))
      }
      const row = await p.eval<{ x: number; y: number } | null>(`(() => { const e = [...document.querySelectorAll('.agt-list .agt-item')].find((e) => e.textContent.includes('Sourdough')); if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return { x: r.x + 40, y: r.y + r.height / 2 } })()`)
      if (!phone) {
        await rightClick(p, row!.x, row!.y)
        const items = await p.eval<string[]>(`[...document.querySelectorAll('.ctx-menu .ctx-item')].map((e) => e.textContent)`)
        check(`${tag}: right-click on a thread opens its menu`, ['Open', 'Pin', 'Rename…', 'Archive'].every((w) => items.some((i) => i.includes(w))), items)
        await key(p, 'Escape', 'Escape', 27)
        await p.eval(`document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); document.body.click()`)
        await sleep(200)
      } else {
        // On a phone the row has its own ... button (no hover).
        await tapSel(p, '.agt-list .agt-row .agt-item-more', true)
        check(`${tag}: the ... button on a thread is there to tap`, (await count(p, '.ctx-menu')) === 1)
        await p.eval(`document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); document.body.click()`)
        await sleep(200)
      }

      // Archived view and back.
      if (style === 'focus') await tapSel(p, '.agt-fx-foot button[title="Archived threads"]', phone)
      else await tapSel(p, '.agt-side-foot button', phone, 'Archived')
      const archived = await count(p, '.agt-list .agt-row')
      check(`${tag}: the archived view lists the 3 archived threads`, archived === 3 && !!(await rect(p, '.agt-side-title')), archived)
      await shot(p, `${kind}-${style}-archived`)
      await tapSel(p, '.agt-side-title .agt-icon', phone)
      check(`${tag}: back from archived`, (await count(p, '.agt-list .agt-row')) >= LIVE)

      // The rail (desktop only: a narrow window has nothing to fold).
      if (!phone) {
        await tapSel(p, '.agt-side-head .agt-icon[aria-label="Hide the sidebar"]', false)
        check(`${tag}: hiding the sidebar leaves the rail`, !!(await rect(p, '.agt-rail')) && !(await rect(p, '.agt-side')))
        check(`${tag}: the rail lists the threads as chips`, (await count(p, '.agt-rail .agt-rail-chip')) === LIVE, await count(p, '.agt-rail .agt-rail-chip'))
        check(`${tag}: the rail marks the 3 that run and the open thread`, (await count(p, '.agt-rail .agt-rail-dot.is-running')) === 3 && !!(await rect(p, '.agt-rail-chip.is-active')))
        await shot(p, `${kind}-${style}-rail`)
        await tapSel(p, '.agt-rail .agt-icon[aria-label="Search threads"]', false)
        check(`${tag}: search from the rail unfolds it with the cursor in the search`, !!(await rect(p, `.agt-side.is-side-${style}`)) && /Search threads/.test(await focusedIn(p)), await focusedIn(p))
      }

      // Selecting several threads: Ctrl+click, Shift+click, the bar that acts on them (desktop).
      if (!phone) {
        await clickRow(p, 'Regex for Dutch postcodes', { ctrlKey: true })
        await clickRow(p, 'Spanish subjunctive', { ctrlKey: true })
        check(`${tag}: Ctrl+click ticks two threads and the bar counts them`, (await count(p, '.agt-list .agt-row.is-selected')) === 2 && (await p.eval(`document.querySelector('.agt-bulk-count')?.textContent ?? ''`)).includes('2 selected'), await p.eval(`document.querySelector('.agt-bulk-count')?.textContent`))
        check(`${tag}: every row shows a tick box while a selection goes on`, (await count(p, '.agt-list .agt-row.is-selecting')) === (await count(p, '.agt-list .agt-row')) && (await count(p, '.agt-list .agt-row.is-selecting .agt-check')) === (await count(p, '.agt-list .agt-row')))
        await clickRow(p, 'Sourdough starter', { shiftKey: true })
        check(`${tag}: Shift+click adds the range from the last row`, (await count(p, '.agt-list .agt-row.is-selected')) >= 3, await count(p, '.agt-list .agt-row.is-selected'))
        // A right-click on one of them talks about all of them.
        const picked = (await p.eval<{ x: number; y: number } | null>(`(() => { const r = document.querySelector('.agt-list .agt-row.is-selected'); if (!r) return null; const b = r.querySelector('.agt-item').getBoundingClientRect(); return { x: b.x + 40, y: b.y + b.height / 2 } })()`))!
        await rightClick(p, picked.x, picked.y)
        const pickedItems = await p.eval<string[]>(`[...document.querySelectorAll('.ctx-menu .ctx-item')].map((e) => e.textContent)`)
        check(`${tag}: the menu of a selected row acts on the whole selection`, ['Archive', 'Move to project', 'Delete'].every((w) => pickedItems.some((i) => i.includes(w))) && !pickedItems.some((i) => i.startsWith('Open')), pickedItems)
        await key(p, 'Escape', 'Escape', 27)
        await p.eval(`document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); document.body.click()`)
        await sleep(200)
        await shot(p, `${kind}-${style}-selected`)
        await key(p, 'Escape', 'Escape', 27)
        check(`${tag}: Escape clears the selection`, !(await count(p, '.agt-bulk')) && !(await count(p, '.agt-list .agt-row.is-selected')))
        if (style === 'classic') {
          // Ctrl+A takes every row, and a drag over the list (the rubber band) ticks what it touches.
          await clickRow(p, 'Regex for Dutch postcodes', { ctrlKey: true })
          await p.eval(`document.querySelector('.agt-list .agt-row .agt-item').focus()`)
          await key(p, 'a', 'KeyA', 65, ['Control'])
          check(`${tag}: Ctrl+A selects every row in the list`, (await count(p, '.agt-list .agt-row.is-selected')) === LIVE, await count(p, '.agt-list .agt-row.is-selected'))
          await key(p, 'Escape', 'Escape', 27)
          // A drag over the list (the rubber band) ticks what it touches; the events go to the list itself.
          // The band lives in the list's coordinates, so it scrolls with the rows.
          const band = await p.eval<{ w: number; h: number; shown: string }>(`(() => {
            const l = document.querySelector('.agt-list')
            const r = l.getBoundingClientRect()
            const at = (x, y) => ({ clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0, buttons: 1 })
            const x = r.left + r.width - 60
            l.dispatchEvent(new MouseEvent('mousedown', at(x, r.top + 50)))
            for (let i = 1; i <= 8; i++) window.dispatchEvent(new MouseEvent('mousemove', at(x - i * 8, r.top + 50 + i * 18)))
            const b = document.querySelector('.agt-band').getBoundingClientRect()
            return { w: Math.round(b.width), h: Math.round(b.height), shown: document.querySelector('.agt-band').style.display }
          })()`)
          check(`${tag}: dragging over the list shows a rubber band and ticks the rows`, band.shown === 'block' && band.w > 20 && band.h > 20 && (await count(p, '.agt-list .agt-row.is-selected')) > 0, band)
          await p.eval(`window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 0, clientY: 0 }))`)
          await sleep(200)
          check(`${tag}: the band is gone when the drag ends`, (await p.eval(`document.querySelector('.agt-band').style.display`)) !== 'block')
          await key(p, 'Escape', 'Escape', 27)
        }
        // A bulk action, round trip: archive two, unarchive them again from the archived view.
        await clickRow(p, 'Regex for Dutch postcodes', { ctrlKey: true })
        await clickRow(p, 'Spanish subjunctive', { ctrlKey: true })
        await tapSel(p, '.agt-bulk-actions button', false, 'Archive')
        await sleep(1200)
        check(`${tag}: Archive takes the selected threads out of the list`, (await count(p, '.agt-list .agt-row')) === want - 2 && !(await count(p, '.agt-bulk')), await count(p, '.agt-list .agt-row'))
        if (style === 'focus') await tapSel(p, '.agt-fx-foot button[title="Archived threads"]', false)
        else await tapSel(p, '.agt-side-foot button', false, 'Archived')
        await sleep(900)
        check(`${tag}: the archived view holds them`, (await count(p, '.agt-list .agt-row')) === 5, await count(p, '.agt-list .agt-row'))
        // Only those two go back: the 3 that were archived already stay archived.
        await clickRow(p, 'Regex for Dutch postcodes', { ctrlKey: true })
        await clickRow(p, 'Spanish subjunctive', { ctrlKey: true })
        await tapSel(p, '.agt-bulk-actions button', false, 'Unarchive')
        await sleep(1200)
        await tapSel(p, '.agt-side-title .agt-icon', false)
        await sleep(900)
        check(`${tag}: Unarchive brings them back to the threads`, (await count(p, '.agt-list .agt-row')) === want && (await count(p, '.agt-bulk')) === 0, await count(p, '.agt-list .agt-row'))
        // Delete asks about the whole selection first, and Cancel leaves it alone.
        await clickRow(p, 'Regex for Dutch postcodes', { ctrlKey: true })
        await clickRow(p, 'Spanish subjunctive', { ctrlKey: true })
        await p.eval(`[...document.querySelectorAll('.agt-bulk-actions button')].find((b) => b.textContent.includes('Delete')).click()`)
        await sleep(700)
        const dialog = await p.eval<string>(`document.querySelector('.dlg')?.textContent?.slice(0, 120) ?? ''`)
        check(`${tag}: Delete asks about both before anything goes`, dialog.includes('2 threads'), dialog)
        await p.eval(`(() => { const d = document.querySelector('.dlg'); const b = d && [...d.querySelectorAll('button')].find((x) => /Cancel/i.test(x.textContent)); if (b) b.click(); return !!b })()`)
        await sleep(600)
        check(`${tag}: Cancel keeps the threads and the selection`, (await count(p, '.agt-list .agt-row')) === want && (await count(p, '.agt-list .agt-row.is-selected')) === 2)
        await key(p, 'Escape', 'Escape', 27)
      } else {
        // A long press on a row starts touch selection; a tap then ticks another one.
        const spot = await p.eval<{ x: number; y: number; title: string } | null>(`(() => {
          const l = document.querySelector('.agt-list')
          const rows = [...l.querySelectorAll('.agt-row[data-thread]')]
          for (const row of rows) {
            // Not one that runs: Focus lists those twice, and the tick then counts twice.
            if (row.querySelector('.agt-dot-mode.is-running') || row.closest('[data-dup]')) continue
            row.scrollIntoView({ block: 'nearest' })
            const r = row.getBoundingClientRect()
            const x = r.x + Math.min(40, r.width / 3)
            const y = r.y + r.height / 2
            const hit = document.elementFromPoint(x, y)
            if (hit && hit.closest('.agt-row') === row) return { x, y, title: row.querySelector('.agt-item').textContent.slice(0, 40) }
          }
          return null
        })()`)
        if (!spot) throw new Error('No row to long-press')
        await p.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: spot.x, y: spot.y }] })
        await sleep(700)
        await p.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
        await sleep(400)
        const ticked = () => p.eval<number>(`new Set([...document.querySelectorAll('.agt-list .agt-row.is-selecting .agt-check.is-on')].map((e) => e.closest('.agt-row').dataset.thread)).size`)
        check('phone: a long press starts selecting and ticks that row', (await ticked()) === 1 && !!(await rect(p, '.agt-bulk')), { spot, ticks: await ticked() })
        const other = await p.eval<{ x: number; y: number } | null>(`(() => {
          const row = [...document.querySelectorAll('.agt-list .agt-row:not(.is-selected)')][1]
          if (!row) return null
          row.scrollIntoView({ block: 'nearest' })
          const r = row.getBoundingClientRect()
          return { x: r.x + Math.min(40, r.width / 3), y: r.y + r.height / 2 }
        })()`)
        await tap(p, other!.x, other!.y, true)
        await sleep(300)
        check('phone: a tap ticks another row instead of opening it', (await ticked()) === 2 && !(await p.eval(`document.querySelector('.agt.is-chat') !== null`)), await ticked())
        await shot(p, `${kind}-${style}-selected`)
        await tapSel(p, '.agt-bulk-head .agt-icon', true)
        await sleep(300)
        check("phone: the bar's × clears the selection", !(await count(p, '.agt-bulk')))
      }
      // The window is back on the thread list.
      await tapSel(p, '.agt-list .agt-row .agt-item', phone, 'Sourdough')
      if (phone) await tapSel(p, '.agt-back', true)
    }
    for (const style of STYLES) if (style !== 'classic') check(`${kind} ${style}: shows more threads than classic at a glance`, phone || visible.get(`${kind} ${style}`)! >= visible.get(`${kind} classic`)! || style !== 'compact', [...visible])
    check(`${kind}: no errors in the page`, p.errors.length === 0, p.errors)

    // A reload keeps the style (it is a synced setting).
    await p.send('Page.reload')
    await p.waitFor(`!!document.querySelector('.agt-side')`, 90_000)
    // The boot screen of a fresh load covers the app for a few seconds.
    await p.waitFor(`document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2)?.closest('.agt') !== null`, 30_000)
    await sleep(800)
    check(`${kind}: the last style is still on after a reload`, !!(await rect(p, '.agt-side.is-side-focus')))
    if (phone) await pickInSettings(p, 'Classic', true)
    else await pick(p, 'Classic')
    check(`${kind}: back to Classic`, !!(await rect(p, '.agt-side.is-side-classic')))
  }
} catch (e) {
  console.log('FAIL', (e as Error).message)
  failed++
} finally {
  await stop()
}
console.log(failed ? `${failed} failed` : 'all passed')
process.exit(failed ? 1 : 0)
