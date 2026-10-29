// Mounted React lifecycle regression, using the same hook as Agents and real msh execution.
// The repo's CDP harness launches a muted browser; no screenshots or real account data.
import { mkdtempSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { launch, newPage, sleep } from './perf/cdp.ts'

const data = mkdtempSync('/tmp/mvlos-executor-')
const port = Number(process.env.PORT ?? 5287)
const server = spawn('./node_modules/.bin/vite', ['--host', '127.0.0.1', '--port', String(port), '--strictPort'], { env: { ...process.env, DATA_DIR: data }, stdio: 'ignore' })
let browser: Awaited<ReturnType<typeof launch>> | undefined
try {
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error(`Vite exited ${server.exitCode}`)
    if (await fetch(`http://127.0.0.1:${port}/`).then((r) => r.ok).catch(() => false)) break
    await sleep(100)
  }
  browser = await launch(800, 600)
  const page = await newPage(browser, 800, 600, '')
  await page.send('Page.navigate', { url: `http://127.0.0.1:${port}/` })
  await page.waitFor('document.readyState === "complete"')
  const results = await page.eval(`import('/scripts/agents-executor-fixture.ts').then(m => m.run())`)
  for (const r of results) console.log(r.ok ? 'PASS' : 'FAIL', r.name)
  if (results.some((r: { ok: boolean }) => !r.ok)) process.exitCode = 1
} finally {
  await browser?.close()
  server.kill('SIGTERM')
  await new Promise<void>((resolve) => server.exitCode !== null ? resolve() : server.once('exit', () => resolve()))
  rmSync(data, { recursive: true, force: true })
}
