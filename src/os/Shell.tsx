import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { getLaunchers, launch as launchLink, launcherImage, launchersAreFiles, useLaunchers, writeLauncherFile } from '../data/launchers'
import { dropInTrash, trashOp } from '../data/fileDrop'
import { openFromParams } from './openUrl'
import { useDropTarget, type Drag, type DragItem, type DropOp } from './dnd'
import { filesFor, openWith } from './appDrops'
import { HOME } from '../terminal/vfs'
import { whereIs } from '../data/mounts'
import { widgetDef } from '../widgets/registry'
import type { WidgetDef } from '../widgets/types'
import { APP_META } from './apps'
import { Launchpad } from './Launchpad'
import { setOverlay, toggleOverlay, useOverlay } from './overlays'
import { spotlightPrefs } from '../data/spotlightPrefs'
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
import { followLinkSettings, linkSettings } from '../data/links'
import { newTab, usePower } from './powerState'
import { notify } from './notify'
import { isDefaultDock, isDockableApp, isLauncherId, pinToDock, resetDock, setDockOrder, unpinFromDock, useCanCustomizeDock, useDock, type DockId } from './dockItems'
import { AppIcon } from './icons'
import { TopBar } from './TopBar'
import { useIsMobile } from './useIsMobile'
import { toUi, uiScale, viewH, viewW } from './uiScale'
import { NOTE_APPS, notesHidden } from './deskPrefs'
import { NoteStackSlot, Window } from './Window'
import { SINGLE_INSTANCE, useWM, workspaceOf, WORKSPACES, type AppId, type Geometry, type WinState } from './wm'

const TOP = 28
const DOCK_SPACE = 96

export function placement(app: AppId, openCount: number, props?: WinState['props']): Geometry {
  const [w0, h0] = (props && APP_META[app].sizeOf?.(props)) || APP_META[app].size
  const vw = viewW()
  const vh = viewH()
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
  const vw = viewW()
  const vh = viewH()
  // Phones only have room for one thing: the headline note. The terminal is a tap away in the dock.
  if (window.innerWidth < 720) return [{ app: 'notes', geometry: { x: 16, y: TOP + 16, w: vw - 32, h: 340 } }]
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

/** The next workspace `by` (1 or -1) from the one on screen, up to `last`, past the ones other
 * tabs have; the one on screen when there is none. */
function stepWorkspace(wm: { workspace: number; elsewhere: number[] }, by: number, last: number) {
  for (let n = wm.workspace + by; n >= 1 && n <= last; n += by) if (!wm.elsewhere.includes(n)) return n
  return wm.workspace
}

/** A window's name in menus: its own title when it shows one thing, else its app's dock name. */
export const winTitle = (w: WinState) => APP_META[w.app].titleOf?.(w) ?? APP_META[w.app].dock

/** A launcher's dock icon: the site's favicon (or your emoji) on a flat tile like the apps'. */
function LauncherIcon({ url, glyph, image, size = 48 }: { url: string; glyph?: string; image?: string; size?: number }) {
  const [broken, setBroken] = useState(false)
  const src = launcherImage({ url, image })
  return (
    <span className="app-icon is-tone dock-launcher" style={{ width: size, height: size, ['--hue' as string]: 'var(--accent)' }}>
      {glyph || broken || !src ? <span className="dock-launcher-glyph">{glyph ?? '↗'}</span> : <img src={src} alt="" draggable={false} onError={() => setBroken(true)} />}
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
    const dx = (viewW() - dw) / 2
    const dy = viewH() - 10 - dh
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
      const room = viewW() - 16 - chrome - (runningApps.length ? 3 : 2) * sepW
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
      const dx = toUi(before - el.getBoundingClientRect().left)
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
      // Screen pixels; the shift drawn (dxRef) is in page pixels (the UI scale, uiScale.ts).
      const naturalCenter = r.left + r.width / 2 - dxRef.current * uiScale()
      const others = orderRef.current.filter((a) => a !== d.app)
      // Only the icons on show count (the ones behind More come after them anyway).
      const onShow = others.filter((a) => items.current.has(a))
      let idx = 0
      for (const a of onShow) {
        const o = items.current.get(a)!.getBoundingClientRect()
        if (ev.clientX > o.left + o.width / 2) idx++
      }
      const last = onShow.length ? items.current.get(onShow[onShow.length - 1])! : firstRef.current
      const inPinned = !d.running || (!!last && ev.clientX <= last.getBoundingClientRect().right + last.getBoundingClientRect().width / 2)
      const next = inPinned ? [...others.slice(0, idx), d.app, ...others.slice(idx)] : others
      if (next.join() !== orderRef.current.join()) {
        prevRects.current = new Map([...items.current].map(([a, node]) => [a, node.getBoundingClientRect().left]))
        orderRef.current = next // a quick drop can land before the re-render
        setOrder(next)
      }
      dxRef.current = toUi(ev.clientX - naturalCenter)
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
    if (l?.app && !l.glyph) return <AppIcon app={l.app as AppId} size={size} tone />
    // A launcher whose file is not read (yet, or any more) still gets a launcher's tile.
    if (isLauncherId(id)) return <LauncherIcon url={l?.url ?? ''} glyph={l ? l.glyph : '↗'} image={l?.image} size={size} />
    return <AppIcon app={id as AppId} size={size} tone />
  }

  // Clicking an app: open it, or bring its window back (from being minimized, or from another
  // workspace, which comes on screen with it). Its focused window minimizes; with several windows,
  // each click brings the next one forward instead.
  const launch = (id: DockId) => {
    const l = launcherOf(id)
    if (l) return void launchLink(l, wm)
    const app = id as AppId
    const all = wm.windows.filter((x) => x.app === app).sort((a, b) => a.pid - b.pid)
    // Windows in other tabs (one workspace per tab) only when the app has none in this one.
    const near = all.filter((w) => !wm.elsewhere.includes(workspaceOf(w) ?? 0))
    const wins = near.length ? near : all
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
        { label: l.app ? 'Open' : 'Open ↗', onSelect: () => launchLink(l, wm) },
        ...(l.url ? [{ label: 'Copy link', onSelect: () => navigator.clipboard?.writeText(l.url).catch(() => {}) }] : []),
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

  // Dropping on the dock: a file on an app's icon opens it there (if that app opens it), a
  // launcher or an app anywhere on it pins it (at that spot, signed in), and anything on Trash
  // goes in the trash. Each icon is a spot (data-drop) of the dock's target.
  const pinnable = (d: Drag) => canCustomize && d.items.length > 0 && d.items.every((i) => (i.kind === 'app' ? isDockableApp(i.app) : i.kind === 'launcher' || (i.kind === 'file' && !!i.launcher)))
  const pinItems = async (items: DragItem[], at: number | undefined) => {
    for (const i of items) {
      if (i.kind === 'app') pinToDock(i.app, at)
      else if (i.kind === 'launcher') pinToDock(`launcher:${i.id}`, at)
      else if (i.kind === 'file' && i.launcher) {
        // A launcher file the dock does not read (one in Documents, say) gets a copy in the
        // applications folder, which it does.
        if (!getLaunchers().some((l) => l.id === i.launcher!.id) && launchersAreFiles()) {
          const apps = whereIs(`${HOME}/.local/share/applications`)
          const folder = apps.kind === 'sf' ? apps.sf : `${HOME}/.local/share/applications`
          await writeLauncherFile(folder, { ...i.launcher, id: i.launcher.id }).catch(() => null)
        }
        pinToDock(`launcher:${i.launcher.id}`, at)
      }
    }
  }
  useDropTarget(navRef, {
    accept: (d, spot): DropOp | null => {
      if (spot === 'trash') return trashOp(d)
      if (spot && !isLauncherId(spot) && filesFor(spot as AppId, d.items).length) return 'open'
      return pinnable(d) ? 'link' : null
    },
    drop: (d, spot, op) => {
      if (op === 'trash') return void dropInTrash(d)
      if (op === 'open' && spot) return filesFor(spot as AppId, d.items).forEach((f) => openWith(wm, spot as AppId, f))
      const at = spot ? order.indexOf(spot as DockId) : -1
      void pinItems(d.items, at >= 0 ? at : undefined)
    },
  })

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
        data-drop={app}
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
    {dock.autohide && <div className="dock-hotzone" onPointerEnter={dock.show} onPointerLeave={dock.hideSoon} onDragEnter={dock.show} aria-hidden />}
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

/** Sign-ins the server turned away (server/auth.ts finishLogin), shown as a dialog (here, and on a game's direct link: Play.tsx). */
export const REFUSED: Record<string, (reason: string | null) => { title: string; body: string }> = {
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

  // App shortcuts from the installed app's icon menu (manifest.webmanifest): /?open=terminal. A
  // system notification opens what it is about (/?open=agents&thread=<id>, /?open=tasks&task=<id>),
  // links back to a message open it (/?open=mail&message=<Message-ID>), and /?mailto= writes one
  // (src/os/openUrl.ts).
  useEffect(() => {
    const params = new URLSearchParams(location.search)
    if (openFromParams(params, (app, props) => wm.open(app, props))) {
      /* opened */
    }
    // As the browser's new tab page, start in Spotlight, ready to type where to go.
    else if (newTab && linkSettings().newTabPageSpotlight) setOverlay('spotlight')
    // Back from GitHub's sign-in page: /?auth=ok|denied|error|off.
    const refused = REFUSED[params.get('auth') ?? '']
    const auth = AUTH_NOTICES[params.get('auth') ?? ''] ?? GOOGLE_NOTICES[params.get('google') ?? '']
    // A refused sign-up is worth more than a toast: the account was not made.
    if (refused) setTimeout(() => void tell(refused(params.get('reason'))), 1200)
    else if (auth) setTimeout(() => notify(auth), 1200)
    if (params.has('open') || params.has('mailto') || params.has('auth') || params.has('google') || params.has('reason')) history.replaceState(null, '', location.pathname)
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
        wm.setWorkspace(stepWorkspace(wm, e.key === 'ArrowRight' ? 1 : -1, WORKSPACES))
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [power.phase, wm])

  // By default Ctrl+Space toggles Spotlight and Ctrl+K / Cmd+K toggles All apps. Settings →
  // Spotlight can point Ctrl+Space at All apps, which gives Ctrl+K back to Spotlight. Both from
  // anywhere, including the terminal. Ctrl+Space is best-effort: some OSes and IMEs keep it and
  // the page never sees it (same idea as Super for workspaces). Read when the key arrives, so a
  // change in Settings applies at once.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (power.phase !== 'up') return
      const spaceOpensSpotlight = spotlightPrefs().ctrlSpace !== 'launchpad'
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        toggleOverlay(spaceOpensSpotlight ? 'launchpad' : 'spotlight')
      } else if (e.ctrlKey && !e.metaKey && !e.altKey && e.code === 'Space') {
        e.preventDefault()
        toggleOverlay(spaceOpensSpotlight ? 'spotlight' : 'launchpad')
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
