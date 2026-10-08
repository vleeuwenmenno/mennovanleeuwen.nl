import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useRecents } from '../data/recents'
import { APP_META } from './apps'
import { Launchpad } from './Launchpad'
import { setOverlay, toggleOverlay, useOverlay } from './overlays'
import { Spotlight } from './Spotlight'
import { useSnapPreview } from './snapPreview'
import { DOCK_MODES, getDockMode, setDockMode, type DockMode } from './dockPrefs'
import { ContextMenuHost, openContextMenu } from './ContextMenu'
import { Desktop } from './Desktop'
import { AppIcon } from './icons'
import { appearanceMenu } from './appearanceMenu'
import { toggleMode, useTheme } from './theme'
import { ClockWidget, MinecraftWidget } from './TopbarWidgets'
import { Window } from './Window'
import { SINGLE_INSTANCE, useWM, type AppId, type Geometry, type WinState } from './wm'

const DOCK: (AppId | '|')[] = ['terminal', 'files', 'projects', 'recents', 'cv', 'games', 'notes', 'contact', '|', 'trash']

const TOP = 28
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

/** The opening layout: sticky note on the left, terminal beside it (just the note on phones). */
export function initialLayout(): { app: AppId; geometry: Geometry; props?: WinState['props'] }[] {
  const vw = window.innerWidth
  const vh = window.innerHeight
  // Phones only have room for one thing: the headline note. The terminal is a tap away in the dock.
  if (vw < 720) return [{ app: 'notes', geometry: { x: 16, y: TOP + 16, w: vw - 32, h: 340 } }]
  const noteW = 310

  // Big screens get a composed desk: notes on the left (shortcuts tucked under the headline
  // note), the terminal in the middle and the CV on top, overlapping its lower right.
  if (vw >= 1600 && vh >= 860) {
    const compW = 644 + 790
    const compH = 700
    const ox = Math.max(40, Math.round((vw - compW) / 2) - 40) // a little left of centre, clear of the icons
    const oy = Math.max(TOP + 30, Math.round((vh - TOP - DOCK_SPACE - compH) / 2) + TOP)
    return [
      { app: 'terminal', geometry: { x: ox + 440, y: oy - 18, w: 680, h: 450 }, props: { motd: '1' } },
      { app: 'keys', geometry: { x: ox + 150, y: oy + 330, w: 300, h: 360 }, props: { under: '1' } },
      { app: 'notes', geometry: { x: ox, y: oy, w: noteW, h: 330 } },
      { app: 'cv', geometry: { x: ox + 644, y: oy + 87, w: 790, h: 560 } },
    ]
  }

  const termH = Math.min(520, vh - TOP - DOCK_SPACE - 60)
  const top = Math.max(TOP + 24, Math.round((vh - TOP - DOCK_SPACE - termH) / 2) + TOP - 10)
  // The headline note sits high so the shortcuts note fits underneath it, slightly tucked in.
  const noteY = TOP + 22
  // A first guess; the shortcuts note measures the headline note once rendered (props.under).
  const keysY = noteY + 380
  const keysH = Math.min(400, vh - DOCK_SPACE - 14 - keysY)
  const notes = (x: number) => [
    ...(keysH >= 150 ? [{ app: 'keys' as const, geometry: { x: x + 8, y: keysY, w: noteW, h: keysH }, props: { under: '1' } }] : []),
    { app: 'notes' as const, geometry: { x, y: noteY, w: noteW, h: 330 } },
  ]
  if (vw < 1180) {
    // Not enough room side by side: the notes overlap the terminal's left edge, like they were stuck on.
    const gutter = vw >= 900 ? 124 : 24 // keep the desktop icons visible when there is room
    const termW = Math.min(760, Math.max(420, vw - noteW - 36 - gutter))
    return [{ app: 'terminal', geometry: { x: vw - termW - gutter, y: top, w: termW, h: termH }, props: { motd: '1' } }, ...notes(28)]
  }
  const termW = 780
  const left = Math.round((vw - (noteW + 40 + termW)) / 2)
  return [{ app: 'terminal', geometry: { x: left + noteW + 40, y: top, w: termW, h: termH }, props: { motd: '1' } }, ...notes(left)]
}

function TopBar() {
  const wm = useWM()
  const recents = useRecents()
  const theme = useTheme()
  const ordered = wm.windows.slice().sort((a, b) => a.pid - b.pid)
  return (
    <header className="topbar">
      <div className="topbar-left">
        <button className="logo" onClick={() => toggleOverlay('launchpad')} title="All apps">
          <svg viewBox="0 0 64 64" width="14" height="14" aria-hidden>
            <path d="M14 46V18l18 16 18-16v28" fill="none" stroke="currentColor" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          MvL OS
        </button>
        {/* One numbered "workspace" per window, like the Omarchy bar. */}
        <nav className="workspaces" aria-label="Open windows">
          {ordered.slice(0, 9).map((w, i) => (
            <button
              key={w.pid}
              className={`ws ${w.pid === wm.focusedPid && !w.minimized ? 'is-active' : ''} ${w.minimized ? 'is-min' : ''}`}
              onClick={() => (w.pid === wm.focusedPid && !w.minimized ? wm.minimize(w.pid) : wm.focus(w.pid))}
              title={`${APP_META[w.app].dock}${w.minimized ? ' (minimized)' : ''}`}
            >
              {i + 1}
            </button>
          ))}
          {ordered.length > 9 && <span className="ws-more">+{ordered.length - 9}</span>}
        </nav>
      </div>
      <ClockWidget />
      <div className="topbar-right">
        <button className="tb-icon" onClick={() => toggleOverlay('spotlight')} title="Search (Ctrl+K)" aria-label="Search">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
        </button>
        <button className="tb-icon tb-activity" onClick={() => wm.open('recents')} title={recents.live ? 'Activity · GitHub live' : recents.status === 'loading' ? 'Activity · syncing' : 'Activity · offline'} aria-label="Recent activity">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M3 12h4l2.5-6 4 12 2.5-6H21" />
          </svg>
          <span className={`tb-dot ${recents.live ? 'is-live' : ''}`} />
        </button>
        <MinecraftWidget />
        <button
          className="tb-icon"
          title={`${theme.label} · click for ${theme.palette.mode === 'light' ? 'night' : 'day'}, right-click for themes`}
          aria-label="Toggle light and dark theme"
          onClick={toggleMode}
          onContextMenu={(e) => openContextMenu(e, appearanceMenu())}
        >
          {theme.palette.mode === 'light' ? (
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />
            </svg>
          )}
        </button>
      </div>
    </header>
  )
}

const DOCK_KEY = 'mvlos.dock.v1'
const DEFAULT_ORDER = DOCK.filter((x): x is AppId => x !== '|' && x !== 'trash')

/** Saved dock order, with apps added since it was saved appended and removed ones dropped. */
function loadOrder(): AppId[] {
  try {
    const saved: AppId[] = JSON.parse(localStorage.getItem(DOCK_KEY) ?? '[]')
    const known = saved.filter((a) => DEFAULT_ORDER.includes(a))
    return [...known, ...DEFAULT_ORDER.filter((a) => !known.includes(a))]
  } catch {
    return DEFAULT_ORDER
  }
}

function saveOrder(order: AppId[]) {
  try {
    if (order.join() === DEFAULT_ORDER.join()) localStorage.removeItem(DOCK_KEY)
    else localStorage.setItem(DOCK_KEY, JSON.stringify(order))
  } catch {
    /* order just won't persist */
  }
}

/**
 * Dock visibility per the chosen mode. When it is hiding, it slides away and comes back when the
 * pointer reaches the bottom edge (or rests on the dock). Touch screens have no hover, so there it
 * always stays; it also stays while the launcher is open or icons are being dragged.
 */
function useDockVisibility(pinned: boolean, anyMaximized: boolean) {
  const [mode, setMode] = useState<DockMode>(getDockMode)
  const [hover, setHover] = useState(false)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const touch = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches

  useEffect(() => {
    const sync = () => setMode(getDockMode())
    window.addEventListener('mvlos:dock', sync)
    return () => {
      window.removeEventListener('mvlos:dock', sync)
      if (hideTimer.current) clearTimeout(hideTimer.current)
    }
  }, [])

  const show = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current)
    setHover(true)
  }
  const hideSoon = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => setHover(false), 450)
  }
  const hiding = !touch && (mode === 'hide' || (mode === 'maximized' && anyMaximized))
  return { visible: !hiding || pinned || hover, autohide: hiding, mode, show, hideSoon }
}

function Dock() {
  const wm = useWM()
  const overlay = useOverlay()
  const [order, setOrder] = useState<AppId[]>(loadOrder)
  const [dragging, setDragging] = useState<{ app: AppId; dx: number } | null>(null)
  const drag = useRef<{ app: AppId; startX: number; moved: boolean } | null>(null)
  const items = useRef(new Map<AppId, HTMLElement>())
  const prevRects = useRef<Map<AppId, number> | null>(null)
  const orderRef = useRef(order)
  orderRef.current = order
  const suppressClick = useRef(false)
  const [fit, setFit] = useState(order.length)
  const [moreOpen, setMoreOpen] = useState(false)
  const navRef = useRef<HTMLElement>(null)
  const firstRef = useRef<HTMLButtonElement>(null)
  const dock = useDockVisibility(!!dragging || overlay === 'launchpad' || moreOpen, wm.windows.some((w) => w.maximized && !w.minimized))

  // How many apps fit between "All apps" and Trash. The rest go behind a "More" button, so the dock
  // never scrolls or runs off a phone screen. Every item is as wide as the "All apps" button.
  useLayoutEffect(() => {
    const measure = () => {
      const nav = navRef.current
      const first = firstRef.current
      if (!nav || !first) return
      const cs = getComputedStyle(nav)
      const gap = parseFloat(cs.columnGap) || 0
      const chrome = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth)
      const sep = nav.querySelector<HTMLElement>('.dock-sep')
      const sepW = sep ? sep.offsetWidth + parseFloat(getComputedStyle(sep).marginLeft) * 2 : 0
      const room = window.innerWidth - 16 - chrome - 2 * sepW
      const W = first.offsetWidth
      // n apps plus All apps and Trash (plus More when it is needed), with gaps between all children.
      const width = (n: number, more: boolean) => (n + 2 + +more) * W + (n + 3 + +more) * gap
      const n = order.length
      if (width(n, false) <= room) return setFit(n)
      let k = n - 1
      while (k > 0 && width(k, true) > room) k--
      setFit(k)
    }
    measure()
    window.addEventListener('resize', measure)
    document.fonts?.ready.then(measure)
    return () => window.removeEventListener('resize', measure)
  }, [order.length])

  const shown = order.slice(0, fit)
  const overflow = order.slice(fit)
  useEffect(() => {
    if (!overflow.length) setMoreOpen(false)
  }, [overflow.length])

  // FLIP: icons that changed slot slide from where they were instead of jumping.
  useLayoutEffect(() => {
    const prev = prevRects.current
    if (!prev) return
    prevRects.current = null
    for (const [app, el] of items.current) {
      if (app === drag.current?.app) continue
      const before = prev.get(app)
      if (before === undefined) continue
      const dx = before - el.getBoundingClientRect().left
      if (!dx) continue
      el.style.transition = 'none'
      el.style.transform = `translateX(${dx}px)`
      requestAnimationFrame(() => {
        el.style.transition = 'transform 0.2s ease'
        el.style.transform = ''
      })
    }
  }, [order])

  // Mouse and pen only: on touch the dock scrolls sideways instead. Move/up are tracked on window
  // because React moving the icon in the DOM mid-drag drops its pointer capture.
  const dxRef = useRef(0)
  const onPointerDown = (e: React.PointerEvent, app: AppId) => {
    if (e.button !== 0 || e.pointerType === 'touch') return
    drag.current = { app, startX: e.clientX, moved: false }
    dxRef.current = 0

    const onMove = (ev: PointerEvent) => {
      const d = drag.current
      if (!d) return
      if (!d.moved && Math.abs(ev.clientX - d.startX) < 6) return
      d.moved = true
      document.body.classList.add('is-dragging')
      const el = items.current.get(d.app)!
      const r = el.getBoundingClientRect()
      const naturalCenter = r.left + r.width / 2 - dxRef.current
      const others = orderRef.current.filter((a) => a !== d.app)
      let idx = 0
      for (const a of others) {
        const o = items.current.get(a)!.getBoundingClientRect()
        if (ev.clientX > o.left + o.width / 2) idx++
      }
      const next = [...others.slice(0, idx), d.app, ...others.slice(idx)]
      if (next.join() !== orderRef.current.join()) {
        prevRects.current = new Map([...items.current].map(([a, node]) => [a, node.getBoundingClientRect().left]))
        orderRef.current = next // a quick drop can land before the re-render
        setOrder(next)
      }
      dxRef.current = ev.clientX - naturalCenter
      setDragging({ app: d.app, dx: dxRef.current })
    }

    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      const d = drag.current
      drag.current = null
      document.body.classList.remove('is-dragging')
      if (d?.moved) {
        suppressClick.current = true
        // The click that follows a drag lands on whatever is under the pointer; drop the flag soon either way.
        setTimeout(() => (suppressClick.current = false), 50)
        saveOrder(orderRef.current)
      }
      setDragging(null)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  const launch = (app: AppId) => {
    const wins = wm.windows.filter((x) => x.app === app)
    const focused = wins.find((x) => x.pid === wm.focusedPid && !x.minimized)
    if (focused && app !== 'trash') wm.minimize(focused.pid)
    else wm.open(app)
  }

  const appButton = (app: AppId) => {
    const isDragged = dragging?.app === app
    return (
      <button
        key={app}
        ref={(el) => {
          if (el) items.current.set(app, el)
          else items.current.delete(app)
        }}
        className={`dock-item ${isDragged ? 'is-dragged' : ''}`}
        style={isDragged ? { transform: `translate(${dragging.dx}px, -10px) scale(1.12)` } : undefined}
        onPointerDown={app === 'trash' ? undefined : (e) => onPointerDown(e, app)}
        onClick={() => {
          if (suppressClick.current) {
            suppressClick.current = false
            return
          }
          launch(app)
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
            ...(order.join() !== DEFAULT_ORDER.join()
              ? [
                  { separator: true as const },
                  {
                    label: 'Reset dock order',
                    onSelect: () => {
                      setOrder(DEFAULT_ORDER)
                      saveOrder(DEFAULT_ORDER)
                    },
                  },
                ]
              : []),
            { separator: true as const },
            { label: 'Dock', submenu: DOCK_MODES.map(([m, label]) => ({ label, checked: getDockMode() === m, onSelect: () => setDockMode(m) })) },
            ...(wins.length ? [{ separator: true as const }, { label: wins.length > 1 ? `Quit all ${wins.length}` : 'Quit', danger: true, onSelect: () => wins.forEach((w) => wm.close(w.pid)) }] : []),
          ])
        }}
      >
        <AppIcon app={app} />
        <span className="dock-label">{APP_META[app].dock}</span>
        <span className="dock-dots">
          {Array.from({ length: Math.min(3, wm.windows.filter((w) => w.app === app).length) }, (_, n) => (
            <span key={n} className="dock-dot is-on" />
          ))}
        </span>
      </button>
    )
  }

  return (
    <>
    {dock.autohide && <div className="dock-hotzone" onPointerEnter={dock.show} onPointerLeave={dock.hideSoon} aria-hidden />}
    <nav
      ref={navRef}
      className={`dock ${dragging ? 'is-reordering' : ''} ${dock.visible ? '' : 'is-hidden'}`}
      aria-label="Dock"
      onPointerEnter={dock.show}
      onPointerLeave={() => !dragging && dock.hideSoon()}
      onFocus={dock.show}
    >
      <button ref={firstRef} className="dock-item" onClick={() => toggleOverlay('launchpad')} aria-label="All apps">
        <span className="app-icon lp-dock-icon" style={{ width: 48, height: 48 }}>
          {Array.from({ length: 9 }, (_, i) => (
            <span key={i} />
          ))}
        </span>
        <span className="dock-label">All apps</span>
      </button>
      <span className="dock-sep" />
      {shown.map(appButton)}
      {overflow.length > 0 && (
        <DockMore apps={overflow} open={moreOpen} setOpen={setMoreOpen} onLaunch={launch} running={(app) => wm.windows.filter((w) => w.app === app).length} />
      )}
      <span className="dock-sep" />
      {appButton('trash')}
    </nav>
    </>
  )
}

/** The "More" button and the stack of apps that did not fit in the dock. */
function DockMore({ apps, open, setOpen, onLaunch, running }: { apps: AppId[]; open: boolean; setOpen: (o: boolean) => void; onLaunch: (app: AppId) => void; running: (app: AppId) => number }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('pointerdown', away)
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('pointerdown', away)
      window.removeEventListener('keydown', esc)
    }
  }, [open, setOpen])

  const anyRunning = apps.some((a) => running(a) > 0)
  return (
    <div ref={ref} className="dock-more">
      <button className={`dock-item ${open ? 'is-open' : ''}`} onClick={() => setOpen(!open)} aria-label="More apps" aria-expanded={open}>
        <span className="app-icon dock-more-icon" style={{ width: 48, height: 48 }}>
          <span />
          <span />
          <span />
        </span>
        <span className="dock-label">More</span>
        <span className="dock-dots">{anyRunning && <span className="dock-dot is-on" />}</span>
      </button>
      {open && (
        <div className="dock-stack" role="menu">
          {apps.map((app) => (
            <button
              key={app}
              role="menuitem"
              className="dock-stack-item"
              onClick={() => {
                setOpen(false)
                onLaunch(app)
              }}
            >
              <AppIcon app={app} size={40} />
              <span>{APP_META[app].dock}</span>
              {running(app) > 0 && <span className="dock-dot is-on" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function SnapPreview() {
  const g = useSnapPreview()
  if (!g) return null
  return <div className="snap-preview" style={{ left: g.x, top: g.y, width: g.w, height: g.h }} aria-hidden />
}

const platform = typeof navigator !== 'undefined' ? navigator.platform || 'the web' : 'the web'

// [kind, text, delay before the line in ms]. Kernel lines fly by, systemd takes its time.
type BootLine = ['k' | 'ok' | 'start' | 'info', string, number]
const BOOT: BootLine[] = [
  ['k', `[    0.000000] Linux version 6.42.0-mvl (menno@arch) (gcc 15.2.1) #1 SMP PREEMPT_DYNAMIC`, 0],
  ['k', `[    0.000000] Command line: BOOT_IMAGE=/vmlinuz-mvl root=/dev/cv rw quiet splash=no`, 30],
  ['k', `[    0.000000] DMI: ${platform}, BIOS curiosity 1.0 19/09/1996`, 30],
  ['k', '[    0.004211] Memory: 30 years available, 0 wasted', 30],
  ['k', '[    0.017302] smpboot: Allowing 1 human CPU, coffee-powered', 30],
  ['k', '[    0.041337] ACPI: Interpreter enabled, sleep states: S0 (coding) S3 (gaming)', 30],
  ['k', '[    0.083120] PCI: Using configuration type 1 for base access', 30],
  ['k', '[    0.120954] NET: Registered PF_TAILSCALE protocol family', 30],
  ['k', '[    0.162008] usb 1-1: new high-speed USB device: Mechanical Keyboard (very clicky)', 30],
  ['k', '[    0.210447] nvme0n1: p1 p2 p3 (projects, contributions, games)', 30],
  ['k', '[    0.264113] EXT4-fs (nvme0n1p2): mounted filesystem /home/menno ro, for your safety', 30],
  ['k', '[    0.301772] Run /sbin/init as init process', 40],
  ['info', '', 60],
  ['info', 'Welcome to MvL OS (Arch, Omarchy flavour)!', 120],
  ['info', '', 60],
  ['ok', 'Created slice Slice /system/getty.', 70],
  ['ok', 'Reached target Local Encrypted Volumes.', 60],
  ['ok', 'Listening on Journal Socket.', 60],
  ['start', 'Starting Journal Service...', 80],
  ['ok', 'Started Journal Service.', 110],
  ['start', 'Starting Load Kernel Module caffeine...', 70],
  ['ok', 'Finished Load Kernel Module caffeine.', 120],
  ['ok', 'Mounted /home/menno/Projects.', 70],
  ['ok', 'Reached target Local File Systems.', 60],
  ['start', 'Starting Network Manager...', 90],
  ['ok', 'Started Network Manager.', 140],
  ['start', 'Starting Tailscale node agent...', 80],
  ['ok', 'Started Tailscale node agent.', 150],
  ['ok', 'Reached target Network is Online.', 70],
  ['start', 'Starting Fetch recent activity from api.github.com...', 90],
  ['start', 'Starting Fetch recent activity from git.mvl.sh...', 60],
  ['ok', 'Finished Fetch recent activity from git.mvl.sh.', 160],
  ['ok', 'Finished Fetch recent activity from api.github.com.', 90],
  ['start', 'Starting Pepper cluster agent...', 80],
  ['ok', 'Started Pepper cluster agent.', 130],
  ['ok', 'Started Minecraft status probe for cloud.mvl.sh.', 90],
  ['ok', 'Started Boltwarden vault (locked, nice try).', 90],
  ['ok', 'Loaded projects: boltwarden savuvo pepper golinks omasoloist.', 100],
  ['start', 'Starting Hyprland compositor (react-wm)...', 90],
  ['ok', 'Started Hyprland compositor (react-wm).', 170],
  ['ok', 'Reached target Graphical Interface.', 110],
]

function Boot({ onDone }: { onDone: () => void }) {
  const [n, setN] = useState(0)
  const [leaving, setLeaving] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  // The parent passes a new callback every render; keep the timers below from restarting.
  const done = useRef(onDone)
  done.current = onDone

  useEffect(() => {
    if (n < BOOT.length) {
      const t = setTimeout(() => setN(n + 1), BOOT[n][2])
      return () => clearTimeout(t)
    }
    const t = setTimeout(() => setLeaving(true), 450)
    return () => clearTimeout(t)
  }, [n])

  useEffect(() => {
    if (!leaving) return
    const t = setTimeout(() => done.current(), 300)
    return () => clearTimeout(t)
  }, [leaving])

  // Any key skips, like a click.
  useEffect(() => {
    const skip = () => done.current()
    window.addEventListener('keydown', skip)
    return () => window.removeEventListener('keydown', skip)
  }, [])

  // Printed from the top; once the screen is full it scrolls like a real console.
  useLayoutEffect(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [n])

  return (
    <div ref={ref} className={`boot ${leaving ? 'is-leaving' : ''}`} onClick={() => done.current()}>
      <pre>
        {BOOT.slice(0, n).map(([kind, text], i) => (
          <div key={i} className={kind === 'k' ? 'boot-k' : undefined}>
            {kind === 'ok' && (
              <>
                [<span className="t-green">  OK  </span>]{' '}
              </>
            )}
            {kind === 'start' ? `         ${text}` : text || ' '}
          </div>
        ))}
        {n < BOOT.length && <span className="boot-cursor">_</span>}
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
  const overlay = useOverlay()

  // Ctrl+K / Cmd+K opens Spotlight from anywhere, including inside the terminal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        toggleOverlay('spotlight')
      } else if (e.key === 'Escape' && overlay) setOverlay(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [overlay])

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
      <SnapPreview />
      <Dock />
      {overlay === 'launchpad' && <Launchpad />}
      {overlay === 'spotlight' && <Spotlight />}
      <ContextMenuHost />
      {booting && <Boot onDone={() => setBooting(false)} />}
    </div>
  )
}
