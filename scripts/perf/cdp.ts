// A small Chrome DevTools Protocol client with no dependencies: it starts headless Chromium (or
// Chrome), opens pages and sends them commands over the browser's WebSocket (Node's own).
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

type Msg = { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown; sessionId?: string }
type Send = (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<any>

/** The browser to run: $PERF_CHROME, $CHROME_BIN, or the first of the usual names on the PATH. */
export function findChrome(): string {
  for (const c of [process.env.PERF_CHROME, process.env.CHROME_BIN]) if (c && existsSync(c)) return c
  const dirs = (process.env.PATH ?? '').split(':')
  for (const name of ['chromium', 'chromium-browser', 'google-chrome-stable', 'google-chrome', 'chrome'])
    for (const d of dirs) if (d && existsSync(join(d, name))) return join(d, name)
  throw new Error('No Chromium or Chrome found: set PERF_CHROME to its path')
}

export type Browser = { send: Send; on: (f: (m: Msg) => void) => void; close: () => Promise<void>; version: string }

export async function launch(width: number, height: number): Promise<Browser> {
  const dir = mkdtempSync(join(tmpdir(), 'mvlos-perf-'))
  const args = [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${dir}`,
    `--window-size=${width},${height}`,
    // The same pixels and counts on any machine: software drawing (no GPU), an sRGB screen, no
    // font hinting, no sound, no throttling of a page that isn't in front.
    '--disable-gpu',
    '--force-color-profile=srgb',
    '--font-render-hinting=none',
    '--disable-lcd-text',
    '--hide-scrollbars',
    '--mute-audio',
    '--autoplay-policy=user-gesture-required',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    // Nothing leaves the machine: every host but the local dev server fails to resolve.
    '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1',
    // CI runners (Ubuntu 24.04) don't allow the user namespaces Chromium's sandbox needs.
    ...(process.env.CI ? ['--no-sandbox'] : []),
    'about:blank',
  ]
  const proc: ChildProcess = spawn(findChrome(), args, { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  proc.stderr!.on('data', (d) => (stderr += d))
  const portFile = join(dir, 'DevToolsActivePort')
  for (let i = 0; i < 200 && !existsSync(portFile); i++) await sleep(100)
  if (!existsSync(portFile)) {
    proc.kill('SIGKILL')
    throw new Error(`Chromium did not start:\n${stderr.slice(-2000)}`)
  }
  const [port, path] = readFileSync(portFile, 'utf8').trim().split('\n')
  const { send, on, ws } = await connect(`ws://127.0.0.1:${port}${path}`)
  const { product } = await send('Browser.getVersion')
  return {
    send,
    on,
    version: product,
    close: async () => {
      try {
        await Promise.race([send('Browser.close'), sleep(1000)])
      } catch {}
      ws.close()
      proc.kill('SIGKILL')
      await sleep(200)
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

async function connect(url: string) {
  const ws = new WebSocket(url)
  await new Promise((res, rej) => ((ws.onopen = res), (ws.onerror = rej)))
  let id = 0
  const pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>()
  const listeners: ((m: Msg) => void)[] = []
  ws.onmessage = (m) => {
    const msg = JSON.parse(String(m.data)) as Msg
    const p = msg.id !== undefined ? pending.get(msg.id) : undefined
    if (p) {
      pending.delete(msg.id!)
      if (msg.error) p.rej(new Error(JSON.stringify(msg.error)))
      else p.res(msg.result)
    } else for (const l of listeners) l(msg)
  }
  const send: Send = (method, params = {}, sessionId) =>
    new Promise((res, rej) => {
      const i = ++id
      const to = setTimeout(() => pending.delete(i) && rej(new Error(`CDP timeout: ${method}`)), 120_000)
      pending.set(i, { res: (v) => (clearTimeout(to), res(v)), rej: (e) => (clearTimeout(to), rej(e)) })
      ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  return { ws, send, on: (f: (m: Msg) => void) => listeners.push(f) }
}

export type Page = {
  send: (method: string, params?: Record<string, unknown>) => Promise<any>
  eval: <T = any>(expr: string) => Promise<T>
  waitFor: (expr: string, ms?: number) => Promise<void>
  click: (x: number, y: number) => Promise<void>
  clickText: (sel: string, text?: string) => Promise<void>
  errors: string[]
  close: () => Promise<void>
}

/** A new tab, its viewport set, with `inject` run before any of its own scripts on every load. */
export async function newPage(b: Browser, width: number, height: number, inject: string): Promise<Page> {
  const { targetId } = await b.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await b.send('Target.attachToTarget', { targetId, flatten: true })
  const s = (method: string, params?: Record<string, unknown>) => b.send(method, params, sessionId)
  const errors: string[] = []
  b.on((m) => {
    if (m.sessionId !== sessionId) return
    if (m.method === 'Runtime.exceptionThrown') {
      const d = (m.params as any).exceptionDetails
      errors.push(String(d?.exception?.description ?? d?.text).split('\n')[0].slice(0, 300))
    }
  })
  await s('Page.enable')
  await s('Runtime.enable')
  await s('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  // The same colour scheme, motion, time zone and language on any machine.
  await s('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }, { name: 'prefers-reduced-motion', value: 'no-preference' }] })
  await s('Emulation.setTimezoneOverride', { timezoneId: 'Europe/Amsterdam' })
  await s('Emulation.setLocaleOverride', { locale: 'en-GB' })
  await s('Page.addScriptToEvaluateOnNewDocument', { source: inject })
  const page: Page = {
    send: s,
    errors,
    async eval(expr) {
      const r = await s('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
      if (r.exceptionDetails) throw new Error(`in page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`)
      return r.result.value
    },
    async waitFor(expr, ms = 60_000) {
      const t0 = Date.now()
      let last = ''
      while (Date.now() - t0 < ms) {
        try {
          if (await page.eval(expr)) return
        } catch (e) {
          last = (e as Error).message
        }
        await sleep(100)
      }
      throw new Error(`Timed out waiting for: ${expr}${last ? ` (${last})` : ''}`)
    },
    async click(x, y) {
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'])
        await s('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 })
    },
    async clickText(sel, text) {
      const at = await page.eval<{ x: number; y: number } | null>(`(() => {
        const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find((e) => ${text ? `e.textContent.includes(${JSON.stringify(text)})` : 'true'})
        if (!e) return null
        const b = e.getBoundingClientRect()
        return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
      })()`)
      if (!at) throw new Error(`Nothing to click: ${sel} ${text ?? ''}`)
      await page.click(at.x, at.y)
    },
    async close() {
      await b.send('Target.closeTarget', { targetId }).catch(() => {})
    },
  }
  return page
}
