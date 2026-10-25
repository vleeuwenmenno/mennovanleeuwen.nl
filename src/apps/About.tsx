import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useAccount } from '../os/account'
import { DOCK_MODES, getDockMode } from '../os/dockPrefs'
import { HANDLE } from '../os/identity'
import { playMode } from '../os/playMode'
import { useTheme } from '../os/theme'
import { ReleaseStatus, releaseText, useLatestRelease } from '../os/TopbarWidgets'
import { useIsMobile } from '../os/useIsMobile'
import { useWM } from '../os/wm'
import { BUILT, COMMIT, REPO, VERSION } from '../version'

// Everything a browser is willing to say about the machine it runs on, in the spirit of the
// terminal's fastfetch: the same facts, readable, with a line beside each. Anything a browser
// does not expose says so plainly instead of guessing, and nothing here is invented: a value is
// either read at runtime or it is missing.

type Row = { label: string; value: ReactNode; text: string }
type Section = { title: string; rows: Row[] }

const NOT_SHARED = 'not shared by this browser'

/** The UA's browser, by the order that matters: Edge, Opera and Samsung all call themselves Chrome. */
const BROWSERS: [string, RegExp][] = [
  ['Microsoft Edge', /Edg(?:e|A|iOS)?\/([\d.]+)/],
  ['Opera', /(?:OPR|OPiOS)\/([\d.]+)/],
  ['Samsung Internet', /SamsungBrowser\/([\d.]+)/],
  ['Firefox', /(?:Firefox|FxiOS)\/([\d.]+)/],
  ['Chrome', /(?:Chrome|CriOS)\/([\d.]+)/],
  ['Safari', /Version\/([\d.]+).*Safari/],
]

function detectBrowser(ua: string): { name: string; version: string | null } {
  for (const [name, re] of BROWSERS) {
    const m = re.exec(ua)
    if (m) return { name, version: m[1] }
  }
  // Safari on iOS leaves the version out now and then; it is still Safari.
  if (/Safari/.test(ua)) return { name: 'Safari', version: null }
  return { name: 'unknown browser', version: null }
}

/** The engine, which is not the browser's name: every browser on iOS runs WebKit whatever it is called. */
function detectEngine(ua: string): string {
  if (/iPhone|iPad|iPod/.test(ua)) return 'WebKit'
  if (/Gecko\/|Firefox|FxiOS/.test(ua)) return 'Gecko'
  if (!/AppleWebKit/.test(ua)) return NOT_SHARED
  return /Chrome|Chromium|Edg|OPR/.test(ua) ? 'Blink' : 'WebKit'
}

/** The OS as the user agent spells it, for the browsers that do not answer `userAgentData`. */
function detectOs(ua: string, touchPoints: number): string | null {
  const win = /Windows NT ([\d.]+)/.exec(ua)
  // 10.0 is both Windows 10 and 11; nothing in the UA tells them apart.
  if (win) return win[1] === '10.0' ? 'Windows 10 or 11' : `Windows NT ${win[1]}`
  const ios = /(?:iPhone|iPad|iPod).*? OS ([\d_]+)/.exec(ua)
  if (ios) return `iOS ${ios[1].replace(/_/g, '.')}`
  const mac = /Mac OS X ([\d_.]+)/.exec(ua)
  // An iPad's user agent says Mac; the touch points give it away.
  if (mac) return touchPoints > 1 ? 'iPadOS (the user agent says Mac)' : `macOS ${mac[1].replace(/_/g, '.')}`
  const android = /Android ([\d.]+)/.exec(ua)
  if (android) return `Android ${android[1]}`
  const cros = /CrOS \S+ ([\d.]+)/.exec(ua)
  if (cros) return `ChromeOS ${cros[1]}`
  if (/Linux/.test(ua)) return 'Linux'
  return null
}

/** User-agent client hints: the only place a Chromium browser states its platform version. */
type UAData = { platform?: string; getHighEntropyValues?: (hints: string[]) => Promise<{ platformVersion?: string }> }
const uaData = (navigator as Navigator & { userAgentData?: UAData }).userAgentData

/** Bytes as a person reads them: 1.5 GB, 240 MB, 12 KB. */
function bytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

function uptime(ms: number): string {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h) return `${h} h ${m} min`
  if (m) return `${m} min ${s % 60} s`
  return `${s} s`
}

/** The UTC offset of the time zone this browser is in, now (DST included). */
function utcOffset(): string {
  const min = -new Date().getTimezoneOffset()
  const abs = Math.abs(min)
  return `UTC${min < 0 ? '-' : '+'}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
}

const offsetLine = () => utcOffset()

/** How the pointer this device is used with answers; some browsers say nothing. */
function pointerLine(): string {
  if (matchMedia('(pointer: coarse)').matches) return 'touch (coarse pointer)'
  if (matchMedia('(pointer: fine)').matches) return 'mouse or trackpad (fine pointer)'
  if (matchMedia('(pointer: none)').matches) return 'no pointer'
  return NOT_SHARED
}

/** `navigator.connection`, which is Chromium's: Firefox and Safari do not have it. */
type Connection = { effectiveType?: string; downlink?: number; rtt?: number; saveData?: boolean }
const connection = (): Connection | undefined => (navigator as Navigator & { connection?: Connection }).connection

/** The facts, as a fastfetch-style plain-text block for the clipboard. */
function summary(sections: Section[]): string {
  const width = Math.max(...sections.flatMap((s) => s.rows.map((r) => r.label.length))) + 2
  const lines = [`${HANDLE}@mvlos`, '─'.repeat(22)]
  for (const s of sections) {
    lines.push(s.title)
    for (const r of s.rows) lines.push(`  ${r.label.padEnd(width)}${r.text}`)
  }
  return lines.join('\n')
}

export function About() {
  const wm = useWM()
  const theme = useTheme()
  const account = useAccount()
  const mobile = useIsMobile()
  const latest = useLatestRelease()

  // Session uptime, the viewport and the network can change while this window is open; the rest of
  // the machine cannot (a device pixel ratio can, after a zoom, so that rides on the same resize).
  const [now, setNow] = useState(() => performance.now())
  const [viewport, setViewport] = useState(() => `${window.innerWidth} × ${window.innerHeight}`)
  const [online, setOnline] = useState(() => navigator.onLine)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const tick = setInterval(() => setNow(performance.now()), 1000)
    const resize = () => setViewport(`${window.innerWidth} × ${window.innerHeight}`)
    const up = () => setOnline(true)
    const down = () => setOnline(false)
    window.addEventListener('resize', resize)
    window.addEventListener('online', up)
    window.addEventListener('offline', down)
    return () => {
      clearInterval(tick)
      window.removeEventListener('resize', resize)
      window.removeEventListener('online', up)
      window.removeEventListener('offline', down)
    }
  }, [])

  // Platform version, device memory and storage are asked for asynchronously; until an answer
  // arrives (or if the browser has none) the rows say what is known.
  const [he, setHe] = useState<{ platform?: string; platformVersion?: string } | null>(null)
  const [storage, setStorage] = useState<{ used: number; quota: number } | null>(null)
  useEffect(() => {
    let live = true
    uaData?.getHighEntropyValues?.(['platformVersion']).then(
      (v) => live && setHe({ platform: uaData.platform, platformVersion: v.platformVersion }),
      () => {},
    )
    navigator.storage?.estimate?.().then(
      (v) => live && v.usage != null && v.quota != null && setStorage({ used: v.usage, quota: v.quota }),
      () => {},
    )
    return () => {
      live = false
    }
  }, [])

  const sections = useMemo<Section[]>(() => {
    const ua = navigator.userAgent
    const browser = detectBrowser(ua)
    const touchPoints = navigator.maxTouchPoints ?? 0
    const os = he?.platform ? [he.platform, he.platformVersion].filter(Boolean).join(' ') : (detectOs(ua, touchPoints) ?? NOT_SHARED)
    const engine = detectEngine(ua)
    const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory
    const conn = connection()
    const builtDate = new Date(BUILT)
    const built = `${builtDate.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })} ${builtDate.toTimeString().slice(0, 5)}`
    const who = account.status === 'user' && account.user ? (account.user.name ?? account.user.login) : 'guest'
    const dock = DOCK_MODES.find(([id]) => id === getDockMode())?.[1] ?? NOT_SHARED
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || NOT_SHARED
    const langs = navigator.languages?.length ?? 1
    const lang = `${navigator.language} (${langs} language${langs === 1 ? '' : 's'} offered)`

    return [
      {
        title: 'MvL OS',
        rows: [
          { label: 'Version', value: VERSION, text: VERSION },
          { label: 'Release', value: <ReleaseStatus />, text: releaseText(latest) },
          {
            label: 'Build',
            value: COMMIT ? (
              <>
                <a href={`https://github.com/${REPO}/commit/${COMMIT}`} target="_blank" rel="noopener noreferrer">
                  {COMMIT.slice(0, 7)}
                </a>{' '}
                <span className="muted">· {built}</span>
              </>
            ) : (
              <span className="muted">local build · {built}</span>
            ),
            text: `${COMMIT ? COMMIT.slice(0, 7) : 'local build'} · ${built}`,
          },
          { label: 'Host', value: location.host || 'localhost', text: location.host || 'localhost' },
          { label: 'Uptime', value: uptime(now), text: uptime(now) },
          {
            label: 'User',
            value: account.status === 'user' && account.user ? `${HANDLE} · ${who}` : HANDLE,
            text: account.status === 'user' && account.user ? `${HANDLE} · ${who}` : HANDLE,
          },
          { label: 'Theme', value: `${theme.label} (${theme.palette?.mode ?? NOT_SHARED})`, text: `${theme.label} (${theme.palette?.mode ?? NOT_SHARED})` },
          { label: 'Dock', value: dock, text: dock },
          { label: 'Windows', value: `${wm.windows.length} open`, text: `${wm.windows.length} open` },
          { label: 'Page', value: playMode() ? 'a /play page: one game, without MvL OS' : 'MvL OS', text: playMode() ? '/play page' : 'MvL OS' },
        ],
      },
      {
        title: 'Browser',
        rows: [
          {
            label: 'Browser',
            value: browser.version ? `${browser.name} ${browser.version}` : `${browser.name} (version not shared)`,
            text: browser.version ? `${browser.name} ${browser.version}` : `${browser.name} (version not shared)`,
          },
          { label: 'Engine', value: engine, text: engine },
          { label: 'Platform', value: os, text: os },
        ],
      },
      {
        title: 'Display',
        rows: [
          { label: 'Screen', value: `${screen.width} × ${screen.height} CSS px`, text: `${screen.width} × ${screen.height}` },
          {
            label: 'Pixel ratio',
            value: `${window.devicePixelRatio}× (${Math.round(screen.width * window.devicePixelRatio)} × ${Math.round(screen.height * window.devicePixelRatio)} physical px)`,
            text: `${window.devicePixelRatio}×`,
          },
          { label: 'Colour depth', value: `${screen.colorDepth}-bit`, text: `${screen.colorDepth}-bit` },
          { label: 'Viewport', value: `${viewport} CSS px`, text: viewport },
          { label: 'Pointer', value: pointerLine(), text: pointerLine() },
        ],
      },
      {
        title: 'Hardware',
        rows: [
          { label: 'CPU cores', value: navigator.hardwareConcurrency ? `${navigator.hardwareConcurrency} logical` : NOT_SHARED, text: navigator.hardwareConcurrency ? `${navigator.hardwareConcurrency} logical` : NOT_SHARED },
          { label: 'Memory', value: memory ? `${memory} GB (as the browser reports it)` : NOT_SHARED, text: memory ? `${memory} GB` : NOT_SHARED },
          {
            label: 'Storage',
            value: storage ? `${bytes(storage.used)} of ${bytes(storage.quota)} used by this site` : navigator.storage ? 'checking…' : NOT_SHARED,
            text: storage ? `${bytes(storage.used)} of ${bytes(storage.quota)}` : NOT_SHARED,
          },
        ],
      },
      {
        title: 'Network and region',
        rows: [
          { label: 'Network', value: online ? 'online' : 'offline', text: online ? 'online' : 'offline' },
          {
            label: 'Connection',
            value: conn
              ? [conn.effectiveType ? `${conn.effectiveType}` : null, conn.downlink != null ? `${conn.downlink} Mb/s down` : null, conn.rtt != null ? `${conn.rtt} ms round trip` : null, conn.saveData ? 'data saver on' : null].filter(Boolean).join(' · ') || NOT_SHARED
              : NOT_SHARED,
            text: conn
              ? [conn.effectiveType, conn.downlink != null ? `${conn.downlink} Mb/s` : null, conn.rtt != null ? `${conn.rtt} ms` : null, conn.saveData ? 'data saver on' : null].filter(Boolean).join(', ') || NOT_SHARED
              : NOT_SHARED,
          },
          { label: 'Language', value: lang, text: lang },
          { label: 'Time zone', value: `${zone} (${offsetLine()})`, text: `${zone} (${offsetLine()})` },
        ],
      },
    ]
  }, [account, he, latest, now, online, storage, theme, viewport, wm.windows.length])

  const copy = () => {
    navigator.clipboard
      ?.writeText(summary(sections))
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1600)
      })
      .catch(() => {})
  }

  return (
    <div className={`about ${mobile ? 'is-mobile' : ''}`}>
      <div className="about-body">
        <div className="about-brand">
          <svg className="about-mark" viewBox="0 0 64 64" width="72" height="72" aria-hidden>
            <path d="M14 46V18l18 16 18-16v28" fill="none" stroke="currentColor" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <h2>MvL OS</h2>
          <p className="muted">Version {VERSION}</p>
          <p className="about-tagline muted">A desktop in a browser tab: windows, a dock, a terminal and its own apps, on a small Node server.</p>
        </div>
        <div className="about-facts">
          {sections.map((s) => (
            <section className="about-section" key={s.title}>
              <h3>{s.title}</h3>
              <dl className="about-rows">
                {s.rows.map((r) => (
                  <div className="about-row" key={r.label}>
                    <dt>{r.label}</dt>
                    <dd>{r.value}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
      <div className="about-actions">
        <button className="btn btn-small" onClick={copy}>
          {copied ? 'Copied' : 'Copy summary'}
        </button>
        <button className="btn btn-small" onClick={() => wm.open('changelog', { t: String(Date.now()) })}>
          Changelog
        </button>
        <a className="btn btn-small" href={`https://github.com/${REPO}`} target="_blank" rel="noopener noreferrer">
          Source code
        </a>
        <a className="btn btn-small" href={`https://github.com/${REPO}/releases`} target="_blank" rel="noopener noreferrer">
          Release notes
        </a>
      </div>
    </div>
  )
}
