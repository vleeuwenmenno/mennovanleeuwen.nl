import { useEffect, useState, type ReactNode } from 'react'
import { Contact } from '../apps/Contact'
import { Cv } from '../apps/Cv'
import { Notes } from '../apps/Notes'
import { Projects } from '../apps/Projects'
import { Recents } from '../apps/Recents'
import { Terminal } from '../apps/Terminal'
import { Trash } from '../apps/Trash'
import { useRecents } from '../data/recents'
import { ContextMenuHost, openContextMenu } from './ContextMenu'
import { Desktop } from './Desktop'
import { AppIcon } from './icons'
import { ACCENTS, currentAccent, setAccent } from './theme'
import { Window } from './Window'
import { SINGLE_INSTANCE, useWM, type AppId, type Geometry, type WinState } from './wm'

export const APP_META: Record<AppId, { title: string; dock: string; size: [number, number]; chrome?: 'note'; render: (w: WinState) => ReactNode }> = {
  terminal: { title: 'menno@mvlos: ~', dock: 'Terminal', size: [760, 500], render: (w) => <Terminal win={w} /> },
  notes: { title: 'Sticky note', dock: 'Note', size: [310, 340], chrome: 'note', render: () => <Notes /> },
  projects: { title: 'Files — Projects', dock: 'Projects', size: [880, 580], render: (w) => <Projects win={w} /> },
  recents: { title: 'Activity', dock: 'Activity', size: [620, 620], render: () => <Recents /> },
  cv: { title: 'cv.md — Viewer', dock: 'CV', size: [760, 680], render: () => <Cv /> },
  contact: { title: 'New message', dock: 'Contact', size: [560, 500], render: () => <Contact /> },
  trash: { title: 'Trash', dock: 'Trash', size: [560, 360], render: () => <Trash /> },
}

const DOCK: (AppId | '|')[] = ['terminal', 'projects', 'recents', 'cv', 'notes', 'contact', '|', 'trash']

const TOP = 34
const DOCK_SPACE = 96

export const isMobile = () => window.innerWidth < 720

export function placement(app: AppId, openCount: number): Geometry {
  const [w0, h0] = APP_META[app].size
  const vw = window.innerWidth
  const vh = window.innerHeight
  const w = Math.min(w0, vw - 32)
  const h = Math.min(h0, vh - TOP - DOCK_SPACE - 16)
  const offset = (openCount % 6) * 28
  const x = Math.round((vw - w) / 2) + offset - 60
  const y = Math.round((vh - TOP - DOCK_SPACE - h) / 2) + TOP + offset - 30
  return {
    x: Math.max(16, Math.min(x, vw - w - 16)),
    y: Math.max(TOP + 12, Math.min(y, vh - DOCK_SPACE - h)),
    w,
    h,
  }
}

/** The opening layout: sticky note on the left, terminal beside it. */
export function initialLayout(): { app: AppId; geometry: Geometry; props?: WinState['props'] }[] {
  const vw = window.innerWidth
  const vh = window.innerHeight
  if (vw < 720) {
    return [
      { app: 'terminal', geometry: placement('terminal', 0), props: { motd: '1' } },
      { app: 'notes', geometry: { x: 16, y: TOP + 16, w: vw - 32, h: 340 } },
    ]
  }
  const noteW = 310
  const termH = Math.min(520, vh - TOP - DOCK_SPACE - 60)
  const top = Math.max(TOP + 24, Math.round((vh - TOP - DOCK_SPACE - termH) / 2) + TOP - 10)
  if (vw < 1180) {
    // Not enough room side by side: the note overlaps the terminal's left edge, like it was stuck on.
    const gutter = vw >= 900 ? 124 : 24 // keep the desktop icons visible when there is room
    const termW = Math.min(760, Math.max(420, vw - noteW - 36 - gutter))
    return [
      { app: 'terminal', geometry: { x: vw - termW - gutter, y: top, w: termW, h: termH }, props: { motd: '1' } },
      { app: 'notes', geometry: { x: 28, y: top + 30, w: noteW, h: 350 } },
    ]
  }
  const termW = 780
  const left = Math.round((vw - (noteW + 40 + termW)) / 2)
  return [
    { app: 'terminal', geometry: { x: left + noteW + 40, y: top, w: termW, h: termH }, props: { motd: '1' } },
    { app: 'notes', geometry: { x: left, y: top + 20, w: noteW, h: 350 } },
  ]
}

function Clock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000 * 15)
    return () => clearInterval(t)
  }, [])
  return (
    <span className="clock">
      <span className="clock-date">{now.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}</span>
      {now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
    </span>
  )
}

function TopBar() {
  const wm = useWM()
  const recents = useRecents()
  const focused = wm.windows.find((w) => w.pid === wm.focusedPid)
  const accents = Object.keys(ACCENTS)
  const [accentIdx, setAccentIdx] = useState(() => Math.max(0, accents.indexOf(currentAccent())))
  return (
    <header className="topbar">
      <div className="topbar-left">
        <button className="logo" onClick={() => wm.open('cv')} title="About this Menno">
          <svg viewBox="0 0 64 64" width="16" height="16" aria-hidden>
            <path d="M14 46V18l18 16 18-16v28" fill="none" stroke="currentColor" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          MvL OS
        </button>
        <span className="focused-app">{focused ? APP_META[focused.app].dock : 'Desktop'}</span>
      </div>
      <div className="workspaces" aria-label="Open windows">
        {wm.windows
          .slice()
          .sort((a, b) => a.pid - b.pid)
          .map((w) => (
            <button key={w.pid} className={`ws ${w.pid === wm.focusedPid ? 'is-active' : ''} ${w.minimized ? 'is-min' : ''}`} onClick={() => wm.focus(w.pid)} title={APP_META[w.app].dock} />
          ))}
      </div>
      <div className="topbar-right">
        <button className="status" onClick={() => wm.open('recents')} title="Recent activity">
          <span className={`live-dot ${recents.live ? 'is-live' : ''}`} />
          {recents.live ? 'GitHub live' : recents.status === 'loading' ? 'syncing' : 'offline'}
        </button>
        <button
          className="accent-btn"
          title="Change accent (or run `theme` in the terminal)"
          onClick={() => {
            const next = (accentIdx + 1) % accents.length
            setAccentIdx(next)
            setAccent(accents[next])
          }}
        />
        <Clock />
      </div>
    </header>
  )
}

function Dock() {
  const wm = useWM()
  return (
    <nav className="dock" aria-label="Dock">
      {DOCK.map((app, i) =>
        app === '|' ? (
          <span key={i} className="dock-sep" />
        ) : (
          <button
            key={app}
            className="dock-item"
            onClick={() => {
              const wins = wm.windows.filter((x) => x.app === app)
              const focused = wins.find((x) => x.pid === wm.focusedPid && !x.minimized)
              if (focused) wm.minimize(focused.pid)
              else wm.open(app)
            }}
            aria-label={APP_META[app].dock}
            onContextMenu={(e) => {
              const wins = wm.windows.filter((x) => x.app === app).sort((a, b) => a.pid - b.pid)
              const multi = !SINGLE_INSTANCE.has(app)
              openContextMenu(e, [
                ...wins.map((w) => ({ label: `${APP_META[w.app].dock} · pid ${w.pid}${w.minimized ? ' (minimized)' : ''}`, onSelect: () => wm.focus(w.pid) })),
                ...(wins.length ? [{ separator: true as const }] : []),
                wins.length && multi ? { label: 'New window', onSelect: () => wm.openNew(app) } : { label: wins.length ? 'Show' : 'Open', onSelect: () => wm.open(app) },
                ...(wins.some((w) => !w.minimized) ? [{ label: wins.length > 1 ? 'Minimize all' : 'Minimize', onSelect: () => wins.forEach((w) => wm.minimize(w.pid)) }] : []),
                ...(wins.length ? [{ separator: true as const }, { label: wins.length > 1 ? `Quit all ${wins.length}` : 'Quit', danger: true, onSelect: () => wins.forEach((w) => wm.close(w.pid)) }] : []),
              ])
            }}
          >
            <AppIcon app={app} />
            <span className="dock-label">{APP_META[app].dock}</span>
            <span className="dock-dots">
              {Array.from({ length: Math.max(1, Math.min(3, wm.windows.filter((w) => w.app === app).length)) }, (_, n) => (
                <span key={n} className={`dock-dot ${wm.windows.some((w) => w.app === app) ? 'is-on' : ''}`} />
              ))}
            </span>
          </button>
        ),
      )}
    </nav>
  )
}

const BOOT = [
  '[    0.000000] MvL OS 1.0 booting on ' + (typeof navigator !== 'undefined' ? navigator.platform || 'the web' : 'the web'),
  '[    0.041337] Mounting /home/menno (read-only, for your safety)',
  '[    0.090210] Starting react-wm window manager',
  '[    0.130077] Loading projects: boltwarden savuvo pepper omasoloist',
  '[    0.171995] Connecting to api.github.com',
  '[  OK  ] Reached target Graphical Interface',
]

function Boot({ onDone }: { onDone: () => void }) {
  const [n, setN] = useState(0)
  useEffect(() => {
    if (n >= BOOT.length) {
      const t = setTimeout(onDone, 260)
      return () => clearTimeout(t)
    }
    const t = setTimeout(() => setN(n + 1), 110)
    return () => clearTimeout(t)
  }, [n, onDone])
  return (
    <div className="boot" onClick={onDone}>
      <pre>
        {BOOT.slice(0, n).map((l) => (
          <div key={l} className={l.includes('OK') ? 't-green' : ''}>
            {l}
          </div>
        ))}
      </pre>
    </div>
  )
}

function shouldBoot() {
  try {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches || sessionStorage.getItem('mvlos.booted')) return false
    sessionStorage.setItem('mvlos.booted', '1')
  } catch {
    /* storage blocked: boot every time, it's short */
  }
  return true
}

export function Shell() {
  const wm = useWM()
  const [booting, setBooting] = useState(shouldBoot)

  return (
    <div className={`desktop ${booting ? 'is-booting' : ''}`}>
      <div className="wallpaper" aria-hidden>
        <div className="wp-glow wp-a" />
        <div className="wp-glow wp-b" />
        <div className="wp-grid" />
        <div className="wp-sig">
          menno<span>@</span>mvlos
        </div>
      </div>
      <TopBar />
      <Desktop />
      <main className="windows">
        {wm.windows.map((w) => (
          <Window key={w.pid} win={w} title={APP_META[w.app].title} chrome={APP_META[w.app].chrome}>
            {APP_META[w.app].render(w)}
          </Window>
        ))}
      </main>
      <Dock />
      <ContextMenuHost />
      {booting && <Boot onDone={() => setBooting(false)} />}
    </div>
  )
}
