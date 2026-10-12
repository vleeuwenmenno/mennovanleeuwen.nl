import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { faviconOf, launch as launchLink, useLaunchers } from '../data/launchers'
import { widgetDef } from '../widgets/registry'
import type { WidgetDef } from '../widgets/types'
import { useRecents } from '../data/recents'
import { APP_META } from './apps'
import { Launchpad } from './Launchpad'
import { setOverlay, toggleOverlay, useOverlay } from './overlays'
import { Spotlight } from './Spotlight'
import { useSnapPreview } from './snapPreview'
import { DOCK_MODES, getDockMode, setDockMode, type DockMode } from './dockPrefs'
import { ContextMenuHost, openContextMenu, type MenuItem } from './ContextMenu'
import { Desktop } from './Desktop'
import { PowerScreens } from './Power'
import { Notifications } from './Notifications'
import { Uploads } from './Uploads'
import { HANDLE } from './identity'
import { cvMode } from './cvMode'
import { Dialogs, tell } from './Dialogs'
import { FolderPicker } from './FolderPicker'
import { initBackButton, setBackFocus } from './backButton'
import { startActivityAlerts } from './activityAlerts'
import { startAlerts, useAlerts } from './alerts'
import { startStorageMove } from './storageMove'
import { startAgentWatch } from './agentWatch'
import { startPush } from './push'
import { startNotifyStream } from './notifyStream'
import { NotificationCenter } from './NotificationCenter'
import { followLinkSettings, linkSettings } from '../data/links'
import { newTab, usePower } from './powerState'
import { notify } from './notify'
import { isDefaultDock, isDockableApp, isLauncherId, pinToDock, resetDock, setDockOrder, unpinFromDock, useCanCustomizeDock, useDock, type DockId } from './dockItems'
import { AppIcon } from './icons'
import { appearanceMenu } from './appearanceMenu'
import { toggleMode, useTheme } from './theme'
import { ClockWidget, MinecraftWidget, SystemMenu } from './TopbarWidgets'
import { useIsMobile } from './useIsMobile'
import { NOTE_APPS, notesHidden } from './deskPrefs'
import { NoteStackSlot, Window } from './Window'
import { SINGLE_INSTANCE, useWM, workspaceOf, WORKSPACES, type AppId, type Geometry, type WinState } from './wm'

const TOP = 28
const DOCK_SPACE = 96

export function placement(app: AppId, openCount: number, props?: WinState['props']): Geometry {
  const [w0, h0] = (props && APP_META[app].sizeOf?.(props)) || APP_META[app].size
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

/** The opening layout: sticky note on the left, terminal beside it (just the note on phones).
 * The note is the welcome note, or Menno's headlines at /cv (src/apps/Notes.tsx). */
export function initialLayout(): { app: AppId; geometry: Geometry; props?: WinState['props'] }[] {
  const vw = window.innerWidth
  const vh = window.innerHeight
  // Phones only have room for one thing: the headline note. The terminal is a tap away in the dock.
  if (vw < 720) return [{ app: 'notes', geometry: { x: 16, y: TOP + 16, w: vw - 32, h: 340 } }]
  const noteW = 310

  // Big screens on the CV page get a composed desk: notes on the left (shortcuts tucked under
  // the headline note), the terminal in the middle and the CV on top, overlapping its lower right.
  if (cvMode() && vw >= 1600 && vh >= 860) {
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

/** A window's name in menus: its own title when it shows one thing, else its app's dock name. */
const winTitle = (w: WinState) => APP_META[w.app].titleOf?.(w) ?? APP_META[w.app].dock

function TopBar() {
  const wm = useWM()
  const recents = useRecents()
  const theme = useTheme()
  // Workspaces, like Omarchy's bar: 1 to 5 always, and any later one that has windows on it.
  const onWs = (n: number) => wm.windows.filter((w) => workspaceOf(w) === n).sort((a, b) => a.pid - b.pid)
  const occupied = new Set(wm.windows.map(workspaceOf).filter((n): n is number => n !== null))
  const count = Math.min(WORKSPACES, Math.max(5, wm.workspace, ...occupied))
  const mine = wm.windows.filter((w) => wm.shown(w))
  // The bar's own menu, for its background and anything on it without a menu of its own.
  const barMenu = (): MenuItem[] => [
    { label: 'Search…', shortcut: 'Ctrl K', onSelect: () => toggleOverlay('spotlight') },
    { label: 'All apps', onSelect: () => toggleOverlay('launchpad') },
    { label: 'Show desktop', disabled: !mine.some((w) => !w.minimized), onSelect: () => mine.forEach((w) => wm.minimize(w.pid)) },
    { separator: true },
    { label: 'Settings', onSelect: () => wm.open('settings', { t: String(Date.now()) }) },
    { label: 'About this system', onSelect: () => wm.open('terminal', { run: 'fastfetch', t: String(Date.now()) }) },
  ]
  // A workspace's menu: its windows to pick from, and bringing the focused window over.
  const focusedWin = wm.windows.find((w) => w.pid === wm.focusedPid && workspaceOf(w) !== null)
  const workspaceMenu = (n: number): MenuItem[] => {
    const wins = onWs(n)
    return [
      { label: `Workspace ${n}`, disabled: true },
      { separator: true },
      ...(n !== wm.workspace ? [{ label: 'Go to workspace', shortcut: `Alt ${n}`, onSelect: () => wm.setWorkspace(n) }] : []),
      ...(focusedWin && workspaceOf(focusedWin) !== n ? [{ label: `Move ${winTitle(focusedWin)} here`, shortcut: `Alt Shift ${n}`, onSelect: () => wm.moveToWorkspace(focusedWin.pid, n) }] : []),
      ...(wins.length ? [{ separator: true as const }, ...wins.map((w) => ({ label: `${winTitle(w)}${w.minimized ? ' (minimized)' : ''}`, onSelect: () => wm.focus(w.pid) }))] : [{ label: 'No windows', disabled: true }]),
      ...(wins.length ? [{ separator: true as const }, { label: wins.length > 1 ? `Close all ${wins.length} windows` : 'Close its window', danger: true, onSelect: () => wins.forEach((w) => wm.close(w.pid)) }] : []),
    ]
  }
  // Scrolling over the numbers walks through the workspaces, as in Waybar.
  const onWheel = (e: React.WheelEvent) => {
    const by = Math.sign(e.deltaY || e.deltaX)
    if (by) wm.setWorkspace(Math.min(count, Math.max(1, wm.workspace + by)))
  }
  return (
    <header className="topbar" onContextMenu={(e) => openContextMenu(e, barMenu())}>
      <div className="topbar-left">
        <SystemMenu />
        {/* Workspaces, like the Omarchy bar: the one on screen underlined, empty ones dimmed.
            Phones have room for one workspace, so they don't show (styles.css). */}
        <nav className="workspaces" aria-label="Workspaces" onWheel={onWheel}>
          {Array.from({ length: count }, (_, i) => i + 1).map((n) => {
            const wins = onWs(n)
            return (
              <button
                key={n}
                data-ws={n}
                className={`ws ${n === wm.workspace ? 'is-active' : ''} ${wins.length ? '' : 'is-empty'}`}
                onClick={() => wm.setWorkspace(n)}
                onContextMenu={(e) => openContextMenu(e, workspaceMenu(n))}
                title={`Workspace ${n} (Alt ${n})${wins.length ? ` · ${[...new Set(wins.map((w) => APP_META[w.app].dock))].join(', ')}` : ' · empty'}`}
                aria-current={n === wm.workspace ? 'true' : undefined}
              >
                {n}
              </button>
            )
          })}
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
        {/* Menno's Minecraft server: his CV page only (src/os/cvMode.ts) */}
        {cvMode() && <MinecraftWidget />}
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
        <NotificationCenter />
      </div>
    </header>
  )
}

/** A launcher's dock icon: the site's favicon (or your emoji) on a flat tile like the apps'. */
function LauncherIcon({ url, glyph, size = 48 }: { url: string; glyph?: string; size?: number }) {
  const [broken, setBroken] = useState(false)
  return (
    <span className="app-icon is-tone dock-launcher" style={{ width: size, height: size, ['--hue' as string]: 'var(--accent)' }}>
      {glyph || broken ? <span className="dock-launcher-glyph">{glyph ?? '↗'}</span> : <img src={faviconOf(url)} alt="" draggable={false} onError={() => setBroken(true)} />}
    </span>
  )
}

/**
 * Dock visibility per the chosen mode. When it is hiding, it slides away and comes back when the
 * pointer reaches the bottom edge (or rests on the dock). It also stays while the launcher is open
 * or icons are being dragged.
 *
 * Phones have no room for it next to a window: it tucks away while any app window is open (sticky
 * notes don't count) and comes back once they are all closed. A bar at the bottom brings it up;
 * it goes again when a window opens or the screen is tapped elsewhere.
 */
function useDockVisibility(pinned: boolean, covered: boolean, appOpen: boolean, openKey: string) {
  const [mode, setMode] = useState<DockMode>(getDockMode)
  const [hover, setHover] = useState(false)
  const [peek, setPeek] = useState(false)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const touch = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches
  const mobile = useIsMobile()

  useEffect(() => {
    const sync = () => setMode(getDockMode())
    window.addEventListener('mvlos:dock', sync)
    return () => {
      window.removeEventListener('mvlos:dock', sync)
      if (hideTimer.current) clearTimeout(hideTimer.current)
    }
  }, [])

  // Opening or switching to a window puts a peeking dock away again.
  useEffect(() => setPeek(false), [openKey])

  // So does tapping anywhere outside it.
  useEffect(() => {
    if (!peek) return
    const away = (e: PointerEvent) => {
      if (!(e.target as Element).closest?.('.dock, .dock-handle, .ctx-menu')) setPeek(false)
    }
    window.addEventListener('pointerdown', away)
    return () => window.removeEventListener('pointerdown', away)
  }, [peek])

  const tucked = mobile && appOpen
  useEffect(() => {
    document.documentElement.toggleAttribute('data-dock-tucked', tucked)
  }, [tucked])

  const show = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current)
    setHover(true)
  }
  const hideSoon = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => setHover(false), 450)
  }
  if (mobile) return { visible: !tucked || peek || pinned, autohide: false, tucked, peek: () => setPeek(true), mode, show() {}, hideSoon() {} }
  const hiding = !touch && (mode === 'hide' || (mode === 'maximized' && covered))
  return { visible: !hiding || pinned || hover, autohide: hiding, tucked: false, peek: () => setPeek(true), mode, show, hideSoon }
}

function Dock() {
  const alerts = useAlerts()
  const wm = useWM()
  const overlay = useOverlay()
  const dockItems = useDock()
  const canCustomize = useCanCustomizeDock()
  const launchers = useLaunchers()
  const [order, setOrder] = useState<DockId[]>(dockItems)
  const [dragging, setDragging] = useState<{ app: DockId; dx: number } | null>(null)
  const drag = useRef<{ app: DockId; startX: number; moved: boolean; running: boolean } | null>(null)
  const dockItemsRef = useRef(dockItems)
  dockItemsRef.current = dockItems
  // Follow pins, removals and other devices, except in the middle of a drag.
  useEffect(() => {
    if (!drag.current) setOrder(dockItems)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dockItems.join()])
  const items = useRef(new Map<DockId, HTMLElement>())
  const prevRects = useRef<Map<DockId, number> | null>(null)
  const orderRef = useRef(order)
  orderRef.current = order
  const suppressClick = useRef(false)
  // Open apps that aren't pinned get an item of their own after the pinned ones, like macOS, so
  // a minimized window can always be brought back. They go when their last window closes. Notes
  // and widgets are part of the desktop, not windows to come back to, so they never get one.
  const runningApps = [...new Set(wm.windows.filter((w) => workspaceOf(w) !== null).sort((a, b) => a.pid - b.pid).map((w) => w.app))].filter((a) => !order.includes(a))
  const [fit, setFit] = useState(order.length + runningApps.length)
  const [moreOpen, setMoreOpen] = useState(false)
  const navRef = useRef<HTMLElement>(null)
  const firstRef = useRef<HTMLButtonElement>(null)
  const appWindows = wm.windows.filter((w) => !w.minimized && wm.shown(w) && APP_META[w.app].chrome !== 'note')
  // Whether a window sits where the dock is (or is maximized), for "auto-hide when a window covers it".
  // The dock's spot is worked out from its size, since a hidden dock is moved off-screen.
  const covered = wm.windows.some((w) => {
    if (w.minimized || !wm.shown(w)) return false
    if (w.maximized) return true
    const nav = navRef.current
    if (!nav) return false
    const dw = nav.offsetWidth
    const dh = nav.offsetHeight
    const dx = (window.innerWidth - dw) / 2
    const dy = window.innerHeight - 10 - dh
    return w.x < dx + dw && w.x + w.w > dx && w.y < dy + dh && w.y + w.h > dy
  })
  const dock = useDockVisibility(
    !!dragging || overlay === 'launchpad' || moreOpen,
    covered,
    appWindows.length > 0,
    `${appWindows.map((w) => w.pid).join()}|${wm.focusedPid}`,
  )

  // How many apps (pinned and open ones) fit between "All apps" and Trash. The rest go behind a "More" button, so the dock
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
      const room = window.innerWidth - 16 - chrome - (runningApps.length ? 3 : 2) * sepW
      const W = first.offsetWidth
      // n apps plus All apps and Trash (plus More when it is needed), with gaps between all children.
      const width = (n: number, more: boolean) => (n + 2 + +more) * W + (n + 3 + +more) * gap
      const n = order.length + runningApps.length
      if (width(n, false) <= room) return setFit(n)
      let k = n - 1
      while (k > 0 && width(k, true) > room) k--
      setFit(k)
    }
    measure()
    window.addEventListener('resize', measure)
    document.fonts?.ready.then(measure)
    return () => window.removeEventListener('resize', measure)
  }, [order.length, runningApps.length])

  // Open apps keep their place when room runs out; pinned ones go behind More first.
  const runShown = runningApps.slice(0, fit)
  const pinShown = order.slice(0, Math.max(0, fit - runShown.length))
  const shown = [...pinShown, ...runShown]
  const overflow = [...order.slice(pinShown.length), ...runningApps.slice(runShown.length)]
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
  // An open app that isn't pinned can be dragged in among the pinned ones to pin it there (signed
  // in, and only apps that can sit on the dock); let go to the right of them and it stays unpinned.
  const onPointerDown = (e: React.PointerEvent, app: DockId, running = false) => {
    if (e.button !== 0 || e.pointerType === 'touch') return
    if (running && !(canCustomize && !isLauncherId(app) && isDockableApp(app))) return
    drag.current = { app, startX: e.clientX, moved: false, running }
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
      // Only the icons on show count (the ones behind More come after them anyway).
      const onShow = others.filter((a) => items.current.has(a))
      let idx = 0
      for (const a of onShow) {
        const o = items.current.get(a)!.getBoundingClientRect()
        if (ev.clientX > o.left + o.width / 2) idx++
      }
      const last = onShow.length ? items.current.get(onShow[onShow.length - 1])! : firstRef.current
      const inPinned = !d.running || (!!last && ev.clientX <= last.getBoundingClientRect().right + last.offsetWidth / 2)
      const next = inPinned ? [...others.slice(0, idx), d.app, ...others.slice(idx)] : others
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
        if (!d.running) setDockOrder(orderRef.current)
        else if (orderRef.current.includes(d.app)) pinToDock(d.app, orderRef.current.indexOf(d.app))
        else setOrder(dockItemsRef.current)
      }
      setDragging(null)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  const launcherOf = (id: DockId) => (isLauncherId(id) ? launchers.find((l) => `launcher:${l.id}` === id) : undefined)
  const labelOf = (id: DockId) => (isLauncherId(id) ? (launcherOf(id)?.label ?? 'Link') : APP_META[id].dock)
  const runningOf = (id: DockId) => (isLauncherId(id) ? 0 : wm.windows.filter((w) => w.app === id).length)
  const iconOf = (id: DockId, size = 48) => {
    const l = launcherOf(id)
    return l ? <LauncherIcon url={l.url} glyph={l.glyph} size={size} /> : <AppIcon app={id as AppId} size={size} tone />
  }

  // Clicking an app: open it, or bring its window back (from being minimized, or from another
  // workspace, which comes on screen with it). Its focused window minimizes; with several windows,
  // each click brings the next one forward instead.
  const launch = (id: DockId) => {
    const l = launcherOf(id)
    if (l) return void launchLink(l)
    const app = id as AppId
    const wins = wm.windows.filter((x) => x.app === app).sort((a, b) => a.pid - b.pid)
    if (!wins.length || app === 'trash') return wm.open(app)
    const focused = wins.find((x) => x.pid === wm.focusedPid && !x.minimized)
    if (focused && wins.length === 1) return wm.minimize(focused.pid)
    if (focused) return wm.focus(wins[(wins.indexOf(focused) + 1) % wins.length].pid)
    // The most recent window, on this workspace if it has one there.
    const here = wins.filter((w) => wm.shown(w))
    wm.focus((here.length ? here : wins).reduce((a, w) => (w.z > a.z ? w : a)).pid)
  }

  // An item's own menu ends with taking it off the dock (signed in); the dock's settings live on
  // the dock itself (right-click its background, edges or separators).
  // An open app that isn't pinned offers to stay instead.
  const removeItem = (id: DockId): MenuItem[] => {
    if (!canCustomize || id === 'trash') return []
    if (order.includes(id)) return [{ separator: true }, { label: 'Remove from dock', onSelect: () => unpinFromDock(id) }]
    return !isLauncherId(id) && isDockableApp(id) ? [{ separator: true }, { label: 'Keep in dock', onSelect: () => pinToDock(id) }] : []
  }
  const dockSettingsMenu = (): MenuItem[] => [
    { label: 'Show the dock', submenu: DOCK_MODES.map(([m, label]) => ({ label, checked: getDockMode() === m, onSelect: () => setDockMode(m) })) },
    { separator: true },
    ...(canCustomize ? [{ label: 'Customize dock…', onSelect: () => wm.open('settings', { section: 'dock', t: String(Date.now()) }) }] : []),
    { label: canCustomize ? 'Restore default dock' : 'Reset dock order', disabled: isDefaultDock(), onSelect: resetDock },
  ]

  const itemMenu = (id: DockId) => {
    const l = launcherOf(id)
    if (l)
      return [
        { label: 'Open ↗', onSelect: () => launchLink(l) },
        { label: 'Copy link', onSelect: () => navigator.clipboard?.writeText(l.url).catch(() => {}) },
        { label: 'Edit launchers…', onSelect: () => wm.open('settings', { section: 'launchers', t: String(Date.now()) }) },
        ...removeItem(id),
      ]
    const app = id as AppId
    const wins = wm.windows.filter((x) => x.app === app).sort((a, b) => a.pid - b.pid)
    const multi = !SINGLE_INSTANCE.has(app)
    return [
      ...wins.map((w) => {
        const notes = [w.minimized && 'minimized', wm.workspaces && workspaceOf(w) !== null && `workspace ${workspaceOf(w)}`].filter(Boolean)
        return { label: `${winTitle(w)} · pid ${w.pid}${notes.length ? ` (${notes.join(', ')})` : ''}`, onSelect: () => wm.focus(w.pid) }
      }),
      ...(wins.length ? [{ separator: true as const }] : []),
      wins.length && multi ? { label: 'New window', onSelect: () => wm.openNew(app) } : { label: wins.length ? 'Show' : 'Open', onSelect: () => wm.open(app) },
      ...(wins.some((w) => !w.minimized) ? [{ label: wins.length > 1 ? 'Minimize all' : 'Minimize', onSelect: () => wins.forEach((w) => wm.minimize(w.pid)) }] : []),
      ...removeItem(id),
      ...(wins.length ? [{ separator: true as const }, { label: wins.length > 1 ? `Quit all ${wins.length}` : 'Quit', danger: true, onSelect: () => wins.forEach((w) => wm.close(w.pid)) }] : []),
    ]
  }

  const appButton = (app: DockId, running = false) => {
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
        onPointerDown={app === 'trash' ? undefined : (e) => onPointerDown(e, app, running)}
        onClick={() => {
          if (suppressClick.current) {
            suppressClick.current = false
            return
          }
          launch(app)
        }}
        aria-label={labelOf(app)}
        onContextMenu={(e) => openContextMenu(e, itemMenu(app))}
      >
        {iconOf(app)}
        {app === 'settings' && alerts.length > 0 && <span className="app-badge">{alerts.length}</span>}
        <span className="dock-label">{labelOf(app)}</span>
        <span className="dock-dots">
          {Array.from({ length: Math.min(3, runningOf(app)) }, (_, n) => (
            <span key={n} className="dock-dot is-on" />
          ))}
        </span>
        {runningOf(app) > 1 && <span className="dock-count">{runningOf(app)}</span>}
      </button>
    )
  }

  return (
    <>
    {dock.autohide && <div className="dock-hotzone" onPointerEnter={dock.show} onPointerLeave={dock.hideSoon} aria-hidden />}
    {dock.tucked && !dock.visible && (
      <button className="dock-handle" onClick={dock.peek} aria-label="Show the dock">
        <span />
      </button>
    )}
    <nav
      ref={navRef}
      className={`dock ${dragging ? 'is-reordering' : ''} ${dock.visible ? '' : 'is-hidden'}`}
      aria-label="Dock"
      onPointerEnter={dock.show}
      onPointerLeave={() => !dragging && dock.hideSoon()}
      onFocus={dock.show}
      // Items with a menu of their own stop the event; everything else (background, separators,
      // All apps, More) gets the dock's settings.
      onContextMenu={(e) => openContextMenu(e, dockSettingsMenu())}
    >
      <button ref={firstRef} className="dock-item" onClick={() => toggleOverlay('launchpad')} aria-label="All apps">
        <span className="app-icon is-tone lp-dock-icon" style={{ width: 48, height: 48 }}>
          {Array.from({ length: 9 }, (_, i) => (
            <span key={i} />
          ))}
        </span>
        {/* Settings needs you (src/os/alerts.ts): on its own icon when it is in the dock, else here. */}
        {alerts.length > 0 && !shown.includes('settings') && <span className="app-badge">{alerts.length}</span>}
        <span className="dock-label">All apps</span>
      </button>
      <span className="dock-sep" />
      {/* One flat, keyed list, so an open app dragged in among the pinned ones moves rather than
          remounts. More closes the pinned part, before the open apps. */}
      {[
        ...pinShown.map((id) => appButton(id)),
        ...(overflow.length
          ? [<DockMore key="more" apps={overflow} open={moreOpen} setOpen={setMoreOpen} onLaunch={launch} running={runningOf} icon={iconOf} label={labelOf} menu={itemMenu} />]
          : []),
        ...(runShown.length ? [<span key="sep-running" className="dock-sep" />] : []),
        ...runShown.map((id) => appButton(id, true)),
      ]}
      <span className="dock-sep" />
      {appButton('trash')}
    </nav>
    </>
  )
}

/** The "More" button and the stack of apps that did not fit in the dock. */
function DockMore({
  apps,
  open,
  setOpen,
  onLaunch,
  running,
  icon,
  label,
  menu,
}: {
  apps: DockId[]
  open: boolean
  setOpen: (o: boolean) => void
  onLaunch: (app: DockId) => void
  running: (app: DockId) => number
  icon: (app: DockId, size?: number) => ReactNode
  label: (app: DockId) => string
  menu: (app: DockId) => MenuItem[]
}) {
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
        <span className="app-icon is-tone dock-more-icon" style={{ width: 48, height: 48 }}>
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
              onContextMenu={(e) => openContextMenu(e, menu(app))}
            >
              {icon(app, 40)}
              <span>{label(app)}</span>
              {running(app) > 0 && <span className="dock-dot is-on" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** A window with its app inside. */
function AppWindow({ w }: { w: WinState }) {
  const wm = useWM()
  const meta = APP_META[w.app]
  const def = w.app === 'widget' ? widgetDef(w.props.kind) : undefined
  if (def && w.props.id) return <WidgetWindow w={w} def={def} id={w.props.id} />
  return (
    <Window win={w} title={meta.titleOf?.(w) ?? meta.title} chrome={meta.chrome} menuItems={meta.menu?.(w, wm)}>
      {meta.render(w)}
    </Window>
  )
}

/** A widget's window: its frame look, its menu items and its close label come from its definition. */
function WidgetWindow({ w, def, id }: { w: WinState; def: WidgetDef; id: string }) {
  const wm = useWM()
  const style = def.useFrame?.(id)
  const menuItems = def.useMenu?.(id, wm) ?? []
  return (
    <Window win={w} title={def.name} chrome="note" className={`widget widget-${def.kind}`} style={style} menuItems={menuItems} closeLabel={def.closeLabel} resizableWidth={def.resizable}>
      {APP_META.widget.render(w)}
    </Window>
  )
}

const AUTH_NOTICES: Record<string, { title: string; body?: string }> = {
  ok: { title: 'Signed in', body: 'Notes, launchers and layouts now sync. Spotlight searches your repositories too (try #123 or repo@branch).' },
  error: { title: 'Sign-in failed', body: 'GitHub did not complete the sign-in. Try again.' },
  off: { title: 'Sign-in is not set up', body: 'This server has no GitHub OAuth app configured.' },
}

/** Sign-ins the server turned away (server/auth.ts finishLogin), shown as a dialog. */
const REFUSED: Record<string, (reason: string | null) => { title: string; body: string }> = {
  full: () => ({ title: "We're full", body: 'MvL OS has room for a limited number of accounts, and they are all taken. Your GitHub account was not added. Try again later; you can keep using this desktop as a guest.' }),
  closed: () => ({ title: 'Sign-up is closed', body: 'New accounts are not being made right now. Your GitHub account was not added; you can keep using this desktop as a guest.' }),
  banned: (reason) => ({ title: 'This account is blocked', body: reason ? `The admin blocked this account: ${reason.slice(0, 200)}` : 'The admin blocked this account from signing in.' }),
}

const GOOGLE_NOTICES: Record<string, { title: string; body?: string }> = {
  ok: { title: 'Google Calendar connected', body: 'Add an Agenda widget from the desktop menu (Add widget) to see it.' },
  denied: { title: 'Google Calendar not connected', body: 'Access was not granted.' },
  error: { title: 'Google Calendar could not connect', body: 'Google did not complete it. Try again from Settings.' },
  signin: { title: 'Sign in first', body: 'Google Calendar attaches to your GitHub sign-in.' },
  off: { title: 'Google Calendar is not set up', body: 'This server has no Google OAuth client configured.' },
}

function SnapPreview() {
  const g = useSnapPreview()
  if (!g) return null
  return <div className="snap-preview" style={{ left: g.x, top: g.y, width: g.w, height: g.h }} aria-hidden />
}

export function Shell() {
  const wm = useWM()
  const power = usePower()
  const overlay = useOverlay()

  // Notes and widgets put away from the MvL OS menu come back by themselves when another one is
  // added: a new note that doesn't show would look like nothing happened.
  const hidden = notesHidden.use()
  const noteCount = wm.windows.filter((w) => NOTE_APPS.has(w.app)).length
  const notesBefore = useRef(noteCount)
  useEffect(() => {
    if (noteCount > notesBefore.current) notesHidden.set(false)
    notesBefore.current = noteCount
  }, [noteCount])

  // Phones: app windows are full-screen sheets, and the notes (sticky widgets too) go one under
  // the other down a desktop that scrolls when they don't fit (styles.css). A note brought to
  // the front, or just added, scrolls into view.
  const mobile = useIsMobile()
  useEffect(() => {
    if (!mobile || wm.focusedPid === null) return
    const el = document.querySelector(`.window.chrome-note[data-pid="${wm.focusedPid}"]`)
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [mobile, wm.focusedPid])

  // The mouse's Back and Forward buttons (and the browser's Back) work in the focused window.
  useEffect(initBackButton, [])
  useEffect(() => setBackFocus(wm.focusedPid), [wm.focusedPid])

  // App shortcuts from the installed app's icon menu (manifest.webmanifest): /?open=terminal.
  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const app = params.get('open') as AppId | null
    // A system notification about an Agents answer opens its thread: /?open=agents&thread=<id>.
    const thread = params.get('thread')
    if (app === 'agents' && thread && /^[0-9a-f-]{36}$/.test(thread)) wm.open('agents', { thread, t: String(Date.now()) })
    else if (app && app in APP_META && app !== 'trash') wm.open(app)
    // As the browser's new tab page, start in Spotlight, ready to type where to go.
    else if (newTab && linkSettings().newTabPageSpotlight) setOverlay('spotlight')
    // Back from GitHub's sign-in page: /?auth=ok|denied|error|off.
    const refused = REFUSED[params.get('auth') ?? '']
    const auth = AUTH_NOTICES[params.get('auth') ?? ''] ?? GOOGLE_NOTICES[params.get('google') ?? '']
    // A refused sign-up is worth more than a toast: the account was not made.
    if (refused) setTimeout(() => void tell(refused(params.get('reason'))), 1200)
    else if (auth) setTimeout(() => notify(auth), 1200)
    if (params.has('open') || params.has('auth') || params.has('google') || params.has('reason')) history.replaceState(null, '', location.pathname)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Fresh activity notifications start counting once the desktop is up.
  useEffect(() => {
    if (power.phase === 'up') startActivityAlerts(), startAgentWatch(), startPush(), startNotifyStream(), startAlerts(), startStorageMove()
  }, [power.phase])

  // Links in apps open where Settings > Links says.
  useEffect(followLinkSettings, [])

  // Notifications (and anything else outside React's tree) can ask for an app to open, by its id
  // or as { app, props }.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const d = (e as CustomEvent<AppId | { app: AppId; props?: WinState['props'] }>).detail
      if (typeof d === 'string') wm.open(d)
      else wm.open(d.app, d.props)
    }
    window.addEventListener('mvlos:open', onOpen)
    return () => window.removeEventListener('mvlos:open', onOpen)
  }, [wm.open])

  // A reboot (or powering on again) starts from a clean desk, like a real one.
  useEffect(() => {
    if (power.run > 0) wm.reset()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [power.run])

  // Workspaces from the keyboard, from anywhere (like Ctrl+K): Alt+1 to Alt+9 go to one,
  // Alt+Shift+1 to 9 take the focused window there, Ctrl+Alt+← and → step through them. Super
  // would be Omarchy's key, but the system keeps it, so it never reaches a web page. Captured
  // before the apps see the keys (the terminal would send them on as Meta keys). On a Mac,
  // Option+digit types a character (™, £), so a text field keeps those.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (power.phase !== 'up' || !wm.workspaces || !e.altKey || e.metaKey) return
      const digit = /^Digit([1-9])$/.exec(e.code)
      if (digit && !e.ctrlKey) {
        const el = document.activeElement as HTMLElement | null
        if (/Mac/.test(navigator.platform) && el && (el.isContentEditable || /^(INPUT|TEXTAREA)$/.test(el.tagName))) return
        e.preventDefault()
        e.stopPropagation()
        const n = Number(digit[1])
        const focused = wm.windows.find((w) => w.pid === wm.focusedPid)
        if (e.shiftKey) focused && workspaceOf(focused) !== null && wm.moveToWorkspace(focused.pid, n)
        else wm.setWorkspace(n)
      } else if (e.ctrlKey && !e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault()
        e.stopPropagation()
        wm.setWorkspace(Math.min(WORKSPACES, Math.max(1, wm.workspace + (e.key === 'ArrowRight' ? 1 : -1))))
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [power.phase, wm])

  // Ctrl+K / Cmd+K opens Spotlight from anywhere, including inside the terminal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (power.phase !== 'up') return
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        toggleOverlay('spotlight')
      } else if (e.key === 'Escape' && overlay) setOverlay(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [overlay, power.phase])

  return (
    <div className="desktop">
      <div className="wallpaper" aria-hidden>
        <div className="wp-glow wp-a" />
        <div className="wp-glow wp-b" />
        <div className="wp-grid" />
        <div className="wp-sig">
          {HANDLE}
          <span>@</span>mvlos
        </div>
      </div>
      <TopBar />
      {/* Icons and windows. On phones this layer scrolls down when windows reach below the
          screen; the top bar, the dock and the wallpaper stay where they are. */}
      <div className={`desk-scroll ${hidden ? 'is-notes-hidden' : ''}`}>
        <Desktop />
        <main className="windows">
          {wm.windows.map((w) => (
            <AppWindow key={w.pid} w={w} />
          ))}
          {/* Phones: where a note being moved up or down the column will land. */}
          <NoteStackSlot />
        </main>
      </div>
      <SnapPreview />
      <Dock />
      {overlay === 'launchpad' && <Launchpad />}
      {overlay === 'spotlight' && <Spotlight />}
      <ContextMenuHost />
      <Notifications />
      <Uploads />
      <Dialogs />
      <FolderPicker />
      <PowerScreens />
    </div>
  )
}
