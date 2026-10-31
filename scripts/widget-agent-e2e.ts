// The agents' widget workflow in a real browser: template folder -> `widget validate` -> `widget test` -> `widget preview`
// -> `widget activate --new` (the user's approval dialog) -> widget on the desktop, working -> retry changes nothing.
// The calls are the terminal's `widget` command (the one an agent reaches through the terminal tool) run in the page;
// the work folder is in the browser's files, which the terminal reads without an agent policy (the policy's reads and
// refusals are checked without a browser by `pnpm check:widget-agent`). Synthetic data, nothing played.
// pnpm check:widget-agent-ui (PORT overrides the isolated dev server port).
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'

const WT = process.env.WT ?? process.cwd()
const PORT = Number(process.env.PORT ?? 5294)
const data = mkdtempSync('/tmp/mvlos-widget-agent-')
process.env.DATA_DIR = data
const { database, encrypt, sha256 } = await import(`${WT}/server/db.ts`)
const { launch, newPage, sleep } = await import(`${WT}/scripts/perf/cdp.ts`)

let failed = 0
const check = (what: string, ok: boolean, extra?: unknown) => {
  console.log(ok ? 'PASS' : 'FAIL', what, ok || extra === undefined ? '' : JSON.stringify(extra))
  if (!ok) failed++
}

const now = Date.now()
const sid = randomBytes(24).toString('hex')
const login = 'ui-scale-check'
database().prepare('INSERT INTO users (id, github_id, login, github_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(1, 1, login, encrypt('none'), now, now)
database().prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(sid), 1, now, now + 86400_000)
const sid2 = randomBytes(24).toString('hex')
database().prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(sid2), 1, now, now + 86400_000)

const vite = spawn(`${WT}/node_modules/.bin/vite`, ['--port', String(PORT), '--strictPort'], {
  cwd: WT,
  env: { ...process.env, DATA_DIR: data, GITHUB_CLIENT_ID: 'x', GITHUB_CLIENT_SECRET: 'x', ADMIN_USERS: 'nobody', MC_WATCH: 'off' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
// Stopped with the script, however it ends.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGPIPE'] as const) process.on(sig, () => (vite.kill(), process.exit(1)))
let log = ''
vite.stdout.on('data', (d) => (log += d))
vite.stderr.on('data', (d) => (log += d))
const origin = `http://127.0.0.1:${PORT}`
for (let i = 0; i < 150 && !log.includes('ready') && vite.exitCode === null; i++) await sleep(200)
if (!log.includes('ready') || vite.exitCode !== null) throw new Error(`vite did not start:\n${log}`)

const b = await launch(1500, 1000)
const p = await newPage(b, 1500, 1000, '')
const boot = async () => {
  await p.send('Page.navigate', { url: origin })
  await p.waitFor(`!!document.querySelector('.desktop') && !document.querySelector('.boot')`, 90_000)
  await p.eval(`import('/src/data/browserfs.ts').then(m=>m.browserFilesReady())`)
}
const instances = () => p.eval<string[]>(`import('/src/widgets/platform/installations.ts').then(m=>Object.values(m.installations.get()).filter(i=>i.kind==='custom').map(i=>i.instance))`)
const dialog = () => p.eval<string>(`document.querySelector('.dlg')?.textContent ?? ''`)
const clickDialog = (label: string) => p.eval(`[...document.querySelectorAll('.dlg-actions button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}).click()`)
const FOLDER = '.local/share/mvlos/widgets/agent-tally'
const WORK = `~/${FOLDER}`
try {
  for (const [name, value] of [['mvlos_sid', sid], ['mvlos_login', login], ['mvlos_uid', '1']]) await p.send('Network.setCookie', { name, value, url: origin })
  await boot()
  // The page-side "agent": runs a msh line the way a terminal call does, with an AbortController per call.
  await p.eval(`window.__ctl = {}; window.__run = async (line, key) => {
    const { runLine, strip } = await import('/src/terminal/commands.ts')
    const { HOME } = await import('/src/terminal/vfs.ts')
    const printed = []
    const ctl = new AbortController(); if (key) window.__ctl[key] = ctl
    const base = { args: [], stdin: null, cwd: HOME, setCwd() {}, env: { HOME, USER: 'agent' }, history: [], windows: [], openApp() {}, openNewApp() {}, closeWindow() {}, clear() {}, exit() {}, setAccent: () => true, print: t => printed.push(t), tty: false, live() {}, size: { cols: 100, rows: 30 }, signal: ctl.signal, onKey() {} }
    const results = await runLine(line, base)
    return { ok: results.length > 0 && results[results.length - 1].ok, output: strip(results.map(r => r.output).join('\\n')) }
  }; true`)
  const run = (line: string, key?: string) => p.eval<{ ok: boolean; output: string }>(`window.__run(${JSON.stringify(line)}, ${JSON.stringify(key ?? '')})`)

  // The agent's own discovery: the same function the Agents app calls, no work folder.
  const agent = await p.eval<{ docs: string; listed: boolean }>(`(async () => {
    const { runAgentCall } = await import('/src/terminal/agents/exec.ts')
    const grant = { mode: 'default', write: false, delete: false, network: false, steering: false }
    const docs = await runAgentCall({ name: 'terminal', arguments: { command: 'widget docs' }, workdir: null, fallbackDir: '/tmp', grant, signal: new AbortController().signal })
    const caps = await runAgentCall({ name: 'terminal_capabilities', arguments: { command: 'widget' }, workdir: null, fallbackDir: '/tmp', grant, signal: new AbortController().signal })
    const c = JSON.parse(caps.capabilities).commands[0]
    return { docs: docs.output, listed: c.name === 'widget' && c.available }
  })()`)
  check('an agent finds widget in terminal_capabilities and reads widget docs through runAgentCall', agent.listed && /widget activate/.test(agent.docs) && /custom\.state/.test(agent.docs) && /export function render/.test(agent.docs), agent.docs.slice(0, 200))

  // "write_file": the starter package, edited to be a different widget, lands in the folder.
  await p.eval(`(async () => {
    const fs = await import('/src/data/browserfs.ts'), d = await import('/src/widgets/platform/defaults.ts')
    const files = d.defaultFiles('custom-template')
    files['manifest.json'] = files['manifest.json'].replace('daily-tally', 'agent-tally').replace('Daily tally', 'Agent tally')
    files['src/main.js'] = files['src/main.js'].replaceAll('Daily tally', 'Agent tally')
    const root = '/${FOLDER}'
    const folders = new Set()
    for (const path of Object.keys(files)) { const all = (root + '/' + path).split('/').slice(1, -1); all.forEach((_, i) => folders.add('/' + all.slice(0, i + 1).join('/'))) }
    for (const f of [...folders].sort((a, b) => a.length - b.length)) await fs.mkdirBrowser(f, true)
    for (const [path, text] of Object.entries(files)) await fs.writeBrowserFile(root + '/' + path, text)
    await fs.writeBrowserFile(root + '/tests/state.json', JSON.stringify({ schema: 1, description: 'counts', input: { custom: { today: '2026-10-31', state: { day: '2026-10-31', count: 1, total: 4 }, revision: 'r1' } }, event: 'inc', expect: { text: ['4 all time'], mutation: { type: 'custom.replace', state: { day: '2026-10-31', count: 2, total: 5 }, expectedRevision: 'r1' } } }))
  })()`.replaceAll('${FOLDER}', FOLDER))
  const listing = await run('widget list')
  check('widget list finds the package folder from a parent folder', listing.ok && /installed widgets/.test(listing.output) && (await run(`cd ${WORK}/.. && widget list`)).output.includes('agent-tally  Agent tally (agent-tally)'), listing.output)

  const validated = await run(`widget validate ${WORK}`)
  check('widget validate: summary and digest of the folder', validated.ok && /"Agent tally" \(agent-tally\)/.test(validated.output) && /digest [a-f0-9]{64}/.test(validated.output), validated.output)
  const tested = await run(`widget test ${WORK}`)
  check('widget test: mock render, events and the case file pass in the real VM worker', tested.ok && /PASS mock render/.test(tested.output) && /PASS event inc/.test(tested.output) && /PASS tests\/state\.json/.test(tested.output) && /text "Agent tally" \[accent\]/.test(tested.output), tested.output)
  await p.eval(`import('/src/data/browserfs.ts').then(m=>m.writeBrowserFile('/${FOLDER}/tests/broken.json', JSON.stringify({schema:1,description:'wrong',expect:{text:['not there']}})))`)
  const broken = await run(`widget test ${WORK}`)
  check('a failing case fails the call with a FAIL line', !broken.ok && /FAIL tests\/broken\.json/.test(broken.output), broken.output)
  await p.eval(`import('/src/data/browserfs.ts').then(m=>m.removeBrowser('/${FOLDER}/tests/broken.json'))`)

  const preview = await run(`widget preview ${WORK}`)
  await p.waitFor(`document.querySelector('.wp-preview')?.textContent.includes('Agent tally')`, 20_000)
  check('widget preview opens the Workshop with a mock preview, activating nothing', preview.ok && /preview: opened/.test(preview.output) && (await instances()).length === 0 && await p.eval(`!document.querySelector('.widget-custom')`), preview.output)
  await p.eval(`document.querySelectorAll('[data-app="widgetworkshop"] .ctl-close').forEach(e=>e.click())`)

  // Activation: Deny first, then a cancelled thread, then Allow.
  const denying = run(`widget activate ${WORK} --new`)
  await p.waitFor(`!!document.querySelector('.dlg')`, 10_000)
  const text = await dialog()
  check('the approval dialog names the package, digest, widget, source folder and what it may access', /Agent tally \(agent-tally\)/.test(text) && /[a-f0-9]{64}/.test(text) && /new custom widget custom-[a-f0-9]{8}/.test(text) && /agent-tally/.test(text) && /saved state/.test(text), text)
  await clickDialog('Deny')
  const deniedRun = await denying
  check('Deny: exit failure "activation requires approval", no installation, nothing on the desktop', !deniedRun.ok && /activation requires approval/.test(deniedRun.output) && (await instances()).length === 0 && await p.eval(`!document.querySelector('.widget-custom')`), deniedRun.output)

  const closing = run(`widget activate ${WORK} --new`, 'thread')
  await p.waitFor(`!!document.querySelector('.dlg')`, 10_000)
  await p.eval(`window.__ctl.thread.abort()`)
  await p.waitFor(`!document.querySelector('.dlg')`, 5000)
  await closing
  check('a closed thread takes its approval dialog away and activates nothing', (await instances()).length === 0 && await p.eval(`!document.querySelector('.widget-custom')`))

  const activating = run(`widget activate ${WORK} --new`)
  await p.waitFor(`!!document.querySelector('.dlg')`, 10_000)
  await clickDialog('Allow')
  const allowed = await activating
  await p.waitFor(`(document.querySelector('.widget-custom .wp-package')?.textContent ?? '').includes('Agent tally')`, 20_000)
  const [id] = await instances()
  check('Allow: a new custom widget is installed and placed on the desktop, rendering', allowed.ok && /^custom-[a-f0-9]{8}$/.test(id) && /activated custom-[a-f0-9]{8}/.test(allowed.output) && await p.eval(`document.querySelectorAll('.widget-custom').length===1`), allowed.output)
  await p.eval(`[...document.querySelectorAll('.widget-custom .wp-package button')].find(b=>b.textContent.trim()==='+1').click()`)
  await p.waitFor(`(document.querySelector('.widget-custom .wp-package')?.textContent ?? '').includes('1 all time')`, 20_000)
  check('the activated widget works (its +1 button saves state)', true)

  // The lost-result retry: the same call again.
  const retry = await run(`widget activate ${WORK} --new`)
  check('retrying the same activate is a no-op: no dialog, one instance, one window', retry.ok && /already active/.test(retry.output) && !(await dialog()) && (await instances()).length === 1 && await p.eval(`document.querySelectorAll('.widget-custom').length===1`), retry.output)
  const generation = await p.eval<number>(`import('/src/widgets/platform/installations.ts').then(m=>m.installation(${JSON.stringify(id)}).generation)`)
  check('the installation is at generation 1', generation === 1)
  // Updating the installed widget: edited source, a stale generation is a conflict, the right one needs a new Allow.
  await p.eval(`import('/src/data/browserfs.ts').then(async m=>m.writeBrowserFile('/${FOLDER}/src/main.js',(await m.readBrowserText('/${FOLDER}/src/main.js')).replace("text(String(v.count)","text('#'+String(v.count)")))`)
  const stale = await run(`widget activate ${WORK} --instance ${id} --generation 7`)
  check('a stale generation is a conflict before any dialog, and writes nothing', !stale.ok && /conflict/.test(stale.output) && !(await dialog()) && (await instances()).length === 1)
  const updating = run(`widget activate ${WORK} --instance ${id} --generation 1`)
  await p.waitFor(`!!document.querySelector('.dlg')`, 10_000)
  check('updating asks again for the new revision', /generation 1/.test(await dialog()) && /update/i.test(await dialog()))
  await clickDialog('Allow')
  const updated = await updating
  await p.waitFor(`(document.querySelector('.widget-custom .wp-package')?.textContent ?? '').includes('#1')`, 20_000)
  check('Allow: the same widget runs the new revision at generation 2, still one window', updated.ok && /generation 2/.test(updated.output) && (await instances()).length === 1 && await p.eval(`document.querySelectorAll('.widget-custom').length===1`), updated.output)
  check('no unhandled browser exceptions', !p.errors.length, p.errors)
} catch (error) {
  console.log('Browser errors', p.errors)
  console.log('Browser diagnostic', await p.eval(`({dialog:document.querySelector('.dlg')?.textContent,widgets:[...document.querySelectorAll('.widget')].map(e=>e.textContent),workshop:document.querySelector('.wp-workshop')?.textContent})`).catch(() => null))
  throw error
} finally {
  await b.close()
  vite.kill('SIGTERM')
  rmSync(data, { recursive: true, force: true })
}
if (failed) process.exitCode = 1
