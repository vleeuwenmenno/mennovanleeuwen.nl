import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { openSticky } from '../apps/Sticky'
import { faviconOf, launch, removeLauncher, updateLauncher, useLaunchers } from '../data/launchers'
import { createNote } from '../data/notes'
import { addWidgetItems } from '../widgets/registry'
import { projects } from '../data/profile'
import { HOME } from '../terminal/vfs'
import { closeContextMenu, openContextMenu, type MenuItem } from './ContextMenu'
import { resetLayout, restoreIcons, trashIcons, updateDesktop, useDesktop, type IconPos } from './desktopStore'
import { appearanceMenu } from './appearanceMenu'
import { openLink } from '../data/links'
import { DOCK_MODES, getDockMode, setDockMode } from './dockPrefs'
import { useSwing } from './swing'
import { useWM, type AppId } from './wm'

// A desktop that behaves like one: click to select, Ctrl/Shift-click to add, drag a marquee over
// empty space, drag icons around (they snap to a grid), double-click or Enter to open, F2 to
// rename, Delete to move to the Trash, and right-click for everything else.

export type DesktopIcon = {
  id: string
  label: string
  glyph: string
  /** A real logo, shown instead of the emoji glyph */
  image?: string
  /** `link`: a launcher of the visitor's own (src/data/launchers.ts) */
  kind: 'file' | 'folder' | 'project' | 'link'
  path: string
  open: { app: AppId; props?: Record<string, string> }
  terminal: string
  url?: string
}

// Order is the default layout, top to bottom: folders, projects, then files. Folders and projects
// get capitalized names like apps; files keep their real file names.
export const DESKTOP_ICONS: DesktopIcon[] = [
  { id: 'projects', label: 'Projects', glyph: '📁', kind: 'folder', path: '~/projects', open: { app: 'files', props: { path: `${HOME}/projects` } }, terminal: 'cd ~/projects && ls -l' },
  { id: 'contributions', label: 'Contributions', glyph: '📂', kind: 'folder', path: '~/contributions', open: { app: 'files', props: { path: `${HOME}/contributions` } }, terminal: 'cd ~/contributions && ls -l' },
  { id: 'games', label: 'Games', glyph: '🎮', kind: 'folder', path: '~/games', open: { app: 'files', props: { path: `${HOME}/games` } }, terminal: 'cd ~/games && ls -l' },
  ...(['boltwarden', 'pepper'] as const).map((slug) => {
    const p = projects.find((x) => x.slug === slug)!
    return {
      id: slug,
      label: p.name,
      glyph: slug === 'boltwarden' ? '🔐' : '🌶️',
      image: slug === 'boltwarden' ? '/icons/boltwarden.svg' : undefined,
      kind: 'project' as const,
      path: `~/projects/${slug}`,
      open: { app: 'projects' as const, props: { slug } },
      terminal: `cat ~/projects/${slug}/README.md`,
      url: p.url,
    }
  }),
  { id: 'cv', label: 'cv.md', glyph: '📄', kind: 'file', path: '~/cv.md', open: { app: 'zed', props: { path: `${HOME}/cv.md`, view: 'preview' } }, terminal: 'cat ~/cv.md' },
  { id: 'readme', label: 'README.md', glyph: '📝', kind: 'file', path: '~/README.md', open: { app: 'zed', props: { path: `${HOME}/README.md`, view: 'preview' } }, terminal: 'cat ~/README.md' },
]

const CELL_W = 100
const CELL_H = 96
const TOP = 28 + 12
const LEFT = 14
const DOCK_SPACE = 100

function gridSize() {
  return { cols: Math.max(1, Math.floor((window.innerWidth - LEFT * 2) / CELL_W)), rows: Math.max(1, Math.floor((window.innerHeight - TOP - DOCK_SPACE) / CELL_H)) }
}

// Columns count from the right edge (col 0 is rightmost), like macOS, so icons keep their place
// relative to that edge when the window resizes and the default column stays clear of windows.
const rightX = () => window.innerWidth - LEFT - CELL_W
const toPx = (p: IconPos) => ({ x: rightX() - p.col * CELL_W, y: TOP + p.row * CELL_H })
const key = (p: IconPos) => `${p.col},${p.row}`

/** Stored positions, clamped to the current grid; icons without one fill columns from the right. */
function layout(ids: string[], stored: Record<string, IconPos>): Record<string, IconPos> {
  const { cols, rows } = gridSize()
  const out: Record<string, IconPos> = {}
  const taken = new Set<string>()
  for (const id of ids) {
    const s = stored[id]
    if (!s) continue
    const p = { col: Math.min(s.col, cols - 1), row: Math.min(s.row, rows - 1) }
    if (taken.has(key(p))) continue
    out[id] = p
    taken.add(key(p))
  }
  let col = 0
  let row = 0
  for (const id of ids) {
    if (out[id]) continue
    // A full grid (tiny window, many launchers) stacks the rest on the last spot instead of looping forever.
    if (taken.size >= cols * rows) {
      out[id] = { col, row }
      continue
    }
    while (taken.has(key({ col, row }))) {
      row++
      if (row >= rows) {
        row = 0
        col = Math.min(cols - 1, col + 1)
      }
    }
    out[id] = { col, row }
    taken.add(key({ col, row }))
  }
  return out
}

/**
 * Several icons dragged at once gather in a pile under the pointer, like Finder's, the grabbed one
 * on top. The pile is their arrangement shrunk: each icon sits off the grabbed one in the
 * direction it really is, a quarter as far (and no further than PILE_REACH), so you can see the
 * shape they will fan back out into. `dx`/`dy` is how far the icon is from the grabbed one; `k`
 * is its place in the pile, 0 on top.
 */
const PILE_SCALE = 0.25
const PILE_REACH = 52
const pileOffset = (dx: number, dy: number, k: number) => {
  const shrink = (v: number) => Math.max(-PILE_REACH, Math.min(PILE_REACH, v * PILE_SCALE))
  return { x: shrink(dx), y: shrink(dy), tilt: k ? (k % 2 ? 1 : -1) * 1.5 : 0 }
}

/** Nearest free cell to a pixel position, spiralling outwards from the closest one. */
function snap(x: number, y: number, taken: Set<string>): IconPos {
  const { cols, rows } = gridSize()
  const c0 = Math.min(cols - 1, Math.max(0, Math.round((rightX() - x) / CELL_W)))
  const r0 = Math.min(rows - 1, Math.max(0, Math.round((y - TOP) / CELL_H)))
  for (let d = 0; d < Math.max(cols, rows); d++) {
    for (let dc = -d; dc <= d; dc++) {
      for (let dr = -d; dr <= d; dr++) {
        if (Math.max(Math.abs(dc), Math.abs(dr)) !== d) continue
        const p = { col: c0 + dc, row: r0 + dr }
        if (p.col < 0 || p.row < 0 || p.col >= cols || p.row >= rows || taken.has(key(p))) continue
        return p
      }
    }
  }
  return { col: c0, row: r0 }
}

type Drag =
  | { kind: 'icons'; startX: number; startY: number; ids: string[]; moved: boolean; clickedId: string; additive: boolean }
  | { kind: 'marquee'; startX: number; startY: number; base: Set<string> }

export function Desktop() {
  const wm = useWM()
  const desk = useDesktop()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [offset, setOffset] = useState({ dx: 0, dy: 0 })
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [viewport, setViewport] = useState(0)
  const drag = useRef<Drag | null>(null)
  // Mirrors `offset` so pointerup sees the last move even if no render happened in between.
  const offsetRef = useRef({ dx: 0, dy: 0 })
  const surface = useRef<HTMLDivElement>(null)
  // Dragged icons sway (--swing on the surface, used by the selected icons).
  const swing = useSwing(surface, 'icons')
  // Just dropped: icons already in their new cell, still drawn where they were let go, so they
  // glide the last bit instead of jumping back to where they started.
  const [settle, setSettle] = useState<Record<string, { dx: number; dy: number }> | null>(null)

  const launchers = useLaunchers()
  const [broken, setBroken] = useState<Set<string>>(new Set())
  const linkIcons = launchers.filter((l) => l.desktop !== false).map<DesktopIcon>((l) => ({
    id: `launcher:${l.id}`,
    label: l.label,
    glyph: l.glyph ?? '🔗',
    image: l.glyph ? undefined : faviconOf(l.url),
    kind: 'link',
    path: l.url,
    open: { app: 'settings', props: { section: 'launchers' } },
    terminal: `curl -sI ${l.url}`,
    url: l.url,
  }))
  const visible = [...DESKTOP_ICONS.filter((i) => !desk.trashed.includes(i.id)), ...linkIcons]
  const positions = useMemo(() => layout(visible.map((i) => i.id), desk.positions), [visible.map((i) => i.id).join(), desk.positions, viewport])

  useEffect(() => {
    const onResize = () => setViewport((n) => n + 1)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const label = (i: DesktopIcon) => desk.names[i.id] ?? i.label
  const launcherId = (i: DesktopIcon | string) => (typeof i === 'string' ? i : i.id).replace(/^launcher:/, '')
  const open = (i: DesktopIcon) => {
    if (i.kind === 'link') return launcher(i) && launch(launcher(i)!)
    ;(i.kind === 'folder' ? wm.openNew : wm.open)(i.open.app, { ...i.open.props, t: String(Date.now()) })
  }
  const launcher = (i: DesktopIcon) => launchers.find((l) => l.id === launcherId(i))
  const newNote = () => openSticky(wm, createNote().id)
  const openInTerminal = (i: DesktopIcon) => wm.open('terminal', { run: i.terminal, t: String(Date.now()) })
  const selectedIcons = () => visible.filter((i) => selected.has(i.id))

  function moveToTrash(ids: string[]) {
    // Launchers are just removed; the trash is for the built-in icons.
    ids.filter((id) => id.startsWith('launcher:')).forEach((id) => removeLauncher(launcherId(id)))
    trashIcons(ids.filter((id) => !id.startsWith('launcher:')))
    setSelected(new Set())
  }

  // --- pointer handling -----------------------------------------------------------------

  function onIconPointerDown(e: ReactPointerEvent, icon: DesktopIcon) {
    if (e.button !== 0 || renaming) return
    e.stopPropagation()
    const additive = e.shiftKey || e.ctrlKey || e.metaKey
    let ids: string[]
    if (additive) {
      ids = [...selected, icon.id]
    } else if (selected.has(icon.id)) {
      ids = [...selected]
    } else {
      ids = [icon.id]
      setSelected(new Set(ids))
    }
    if (additive && !selected.has(icon.id)) setSelected(new Set(ids))
    // The grabbed icon first: it tops the pile and lands nearest the drop.
    ids = [icon.id, ...ids.filter((id) => id !== icon.id)]
    drag.current = { kind: 'icons', startX: e.clientX, startY: e.clientY, ids, moved: false, clickedId: icon.id, additive }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  function onSurfacePointerDown(e: ReactPointerEvent) {
    if (e.button !== 0 || e.target !== surface.current) return
    setRenaming(null)
    const base = e.shiftKey || e.ctrlKey || e.metaKey ? new Set(selected) : new Set<string>()
    setSelected(base)
    drag.current = { kind: 'marquee', startX: e.clientX, startY: e.clientY, base }
    surface.current?.setPointerCapture(e.pointerId)
  }

  function onPointerMove(e: ReactPointerEvent) {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY
    if (d.kind === 'icons') {
      if (!d.moved && Math.hypot(dx, dy) < 4) return
      if (!d.moved) swing.start(e.clientX)
      else swing.move(e.clientX)
      d.moved = true
      document.body.classList.add('is-dragging')
      offsetRef.current = { dx, dy }
      setOffset({ dx, dy })
    } else {
      const rect = { x: Math.min(d.startX, e.clientX), y: Math.min(d.startY, e.clientY), w: Math.abs(dx), h: Math.abs(dy) }
      setMarquee(rect)
      const hit = new Set(d.base)
      for (const i of visible) {
        const p = toPx(positions[i.id])
        if (p.x < rect.x + rect.w && p.x + CELL_W - 8 > rect.x && p.y < rect.y + rect.h && p.y + CELL_H - 8 > rect.y) hit.add(i.id)
      }
      setSelected(hit)
    }
  }

  function onPointerUp() {
    const d = drag.current
    drag.current = null
    document.body.classList.remove('is-dragging')
    swing.end()
    if (d?.kind === 'marquee') {
      setMarquee(null)
      return
    }
    if (!d) return
    if (!d.moved) {
      // A plain click on an already-selected icon narrows the selection to it; Ctrl-click toggles.
      if (d.additive && selected.has(d.clickedId) && d.ids.length > 1) setSelected(new Set([...selected].filter((s) => s !== d.clickedId)))
      else if (!d.additive) setSelected(new Set([d.clickedId]))
      return
    }
    const moving = new Set(d.ids)
    const taken = new Set(visible.filter((i) => !moving.has(i.id)).map((i) => key(positions[i.id])))
    const next: Record<string, IconPos> = {}
    const from: Record<string, { dx: number; dy: number }> = {}
    // Each icon lands where it was before the drag, moved by as much as the pointer moved, so a
    // pile fans back out into the shape it had. The grabbed icon goes first, so it gets the cell
    // under the pointer; a cell already taken sends an icon to the nearest free one.
    const top = toPx(positions[d.clickedId])
    const drop = { x: top.x + offsetRef.current.dx, y: top.y + offsetRef.current.dy }
    d.ids.forEach((id, k) => {
      const p = toPx(positions[id])
      const cell = snap(p.x + offsetRef.current.dx, p.y + offsetRef.current.dy, taken)
      taken.add(key(cell))
      next[id] = cell
      // It glides out from where it sat in the pile.
      const fan = d.ids.length > 1 ? pileOffset(p.x - top.x, p.y - top.y, k) : { x: 0, y: 0 }
      const to = toPx(cell)
      from[id] = { dx: drop.x + fan.x - to.x, dy: drop.y + fan.y - to.y }
    })
    // Pin every icon so the ones that did not move stay put too.
    updateDesktop((s) => ({ ...s, positions: { ...positions, ...next } }))
    offsetRef.current = { dx: 0, dy: 0 }
    setOffset({ dx: 0, dy: 0 })
    setSettle(from)
  }

  // One frame drawn where they were dropped, then the offset eases to nothing (see .is-settling).
  useEffect(() => {
    if (!settle) return
    let frame = requestAnimationFrame(() => (frame = requestAnimationFrame(() => setSettle(null))))
    return () => cancelAnimationFrame(frame)
  }, [settle])

  // --- keyboard ------------------------------------------------------------------------

  function onKeyDown(e: KeyboardEvent) {
    if (renaming) return
    const sel = selectedIcons()
    if (e.key === 'Enter' && sel.length) sel.forEach(open)
    else if ((e.key === 'Delete' || e.key === 'Backspace') && sel.length) moveToTrash(sel.map((i) => i.id))
    else if (e.key === 'F2' && sel.length === 1) setRenaming(sel[0].id)
    else if (e.key === 'Escape') setSelected(new Set())
    else if (e.key.toLowerCase() === 'a' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      setSelected(new Set(visible.map((i) => i.id)))
    } else return
    e.preventDefault()
  }

  // --- context menus ---------------------------------------------------------------------

  function iconMenu(icon: DesktopIcon): MenuItem[] {
    const many = selected.has(icon.id) && selected.size > 1
    if (many) {
      const ids = [...selected]
      return [
        { label: `Open ${ids.length} items`, onSelect: () => selectedIcons().forEach(open) },
        { separator: true },
        { label: `Move ${ids.length} items to Trash`, shortcut: 'Del', danger: true, onSelect: () => moveToTrash(ids) },
      ]
    }
    if (icon.kind === 'link')
      return [
        { label: 'Open ↗', shortcut: '↵', onSelect: () => open(icon) },
        { label: 'Copy link', onSelect: () => navigator.clipboard?.writeText(icon.path).catch(() => {}) },
        { separator: true },
        { label: 'Rename', shortcut: 'F2', onSelect: () => setRenaming(icon.id) },
        { label: 'Edit launchers…', onSelect: () => wm.open('settings', { section: 'launchers', t: String(Date.now()) }) },
        { separator: true },
        { label: 'Remove launcher', shortcut: 'Del', danger: true, onSelect: () => moveToTrash([icon.id]) },
      ]
    return [
      { label: 'Open', shortcut: '↵', onSelect: () => open(icon) },
      { label: 'Open in Terminal', onSelect: () => openInTerminal(icon) },
      ...(icon.url ? [{ label: 'Visit website ↗', onSelect: () => openLink(icon.url!) }] : []),
      { separator: true },
      { label: 'Copy path', onSelect: () => navigator.clipboard?.writeText(icon.path).catch(() => {}) },
      { label: 'Rename', shortcut: 'F2', onSelect: () => setRenaming(icon.id) },
      ...(desk.names[icon.id] ? [{ label: 'Restore original name', onSelect: () => updateDesktop((s) => ({ ...s, names: Object.fromEntries(Object.entries(s.names).filter(([k]) => k !== icon.id)) })) }] : []),
      { separator: true },
      { label: 'Move to Trash', shortcut: 'Del', danger: true, onSelect: () => moveToTrash([icon.id]) },
    ]
  }

  function desktopMenu(): MenuItem[] {
    return [
      { label: 'Open Terminal', onSelect: () => wm.open('terminal') },
      { label: 'Show activity', onSelect: () => wm.open('recents') },
      { label: 'About this system', onSelect: () => wm.open('terminal', { run: 'fastfetch', t: String(Date.now()) }) },
      { separator: true },
      { label: 'New sticky note', onSelect: newNote },
      { label: 'Add widget', submenu: addWidgetItems(wm) },
      { label: 'New launcher…', onSelect: () => wm.open('settings', { section: 'launchers', t: String(Date.now()) }) },
      { label: 'Notebook', onSelect: () => wm.open('notebook') },
      { separator: true },
      { label: 'Select all', shortcut: 'Ctrl A', onSelect: () => setSelected(new Set(visible.map((i) => i.id))) },
      { label: 'Clean up icons', onSelect: resetLayout },
      ...(desk.trashed.length ? [{ label: `Put back ${desk.trashed.length} trashed item${desk.trashed.length === 1 ? '' : 's'}`, onSelect: () => restoreIcons(desk.trashed) }] : []),
      { separator: true },
      { label: 'Appearance', submenu: appearanceMenu() },
      { label: 'Dock', submenu: DOCK_MODES.map(([m, label]) => ({ label, checked: getDockMode() === m, onSelect: () => setDockMode(m) })) },
    ]
  }

  return (
    <div
      ref={surface}
      className="desk"
      tabIndex={-1}
      onPointerDown={onSurfacePointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => {
        if (e.target !== surface.current) return
        setSelected(new Set())
        openContextMenu(e, desktopMenu())
      }}
    >
      {visible.map((icon) => {
        const p = toPx(positions[icon.id])
        const isSel = selected.has(icon.id)
        const dragging = isSel && (offset.dx || offset.dy)
        const landing = settle?.[icon.id]
        const d = drag.current?.kind === 'icons' ? drag.current : null
        const pile = dragging && d && d.ids.length > 1 ? d.ids : null
        const k = pile ? pile.indexOf(icon.id) : 0
        let transform: string | undefined
        if (dragging && pile) {
          const top = toPx(positions[pile[0]])
          const fan = pileOffset(p.x - top.x, p.y - top.y, k)
          transform = `translate(${top.x + offset.dx + fan.x - p.x}px, ${top.y + offset.dy + fan.y - p.y}px) rotate(${fan.tilt}deg)`
        } else if (dragging) transform = `translate(${offset.dx}px, ${offset.dy}px)`
        else if (landing) transform = `translate(${landing.dx}px, ${landing.dy}px)`
        return (
          <div
            key={icon.id}
            className={`desk-icon ${isSel ? 'is-selected' : ''} ${dragging ? 'is-moving' : ''} ${pile && k > 0 ? 'is-piled' : ''} ${landing ? 'is-settling' : ''}`}
            style={{ left: p.x, top: p.y, transform, zIndex: pile ? 3 + pile.length - k : undefined }}
            tabIndex={0}
            role="button"
            aria-label={label(icon)}
            aria-selected={isSel}
            onPointerDown={(e) => onIconPointerDown(e, icon)}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onDoubleClick={() => open(icon)}
            onFocus={() => !selected.has(icon.id) && !drag.current && setSelected(new Set([icon.id]))}
            onContextMenu={(e) => {
              closeContextMenu()
              if (!selected.has(icon.id)) setSelected(new Set([icon.id]))
              openContextMenu(e, iconMenu(icon))
            }}
          >
            {icon.image && !broken.has(icon.id) ? (
              <img className={`desk-img ${icon.kind === 'link' ? 'is-favicon' : ''}`} src={icon.image} alt="" draggable={false} onError={() => setBroken((b) => new Set(b).add(icon.id))} />
            ) : (
              <span className="desk-glyph">{icon.glyph}</span>
            )}
            {renaming === icon.id ? (
              <input
                className="desk-rename"
                defaultValue={label(icon)}
                autoFocus
                onFocus={(e) => e.currentTarget.select()}
                onPointerDown={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === 'Escape') setRenaming(null)
                  if (e.key === 'Enter') e.currentTarget.blur()
                }}
                onBlur={(e) => {
                  const v = e.currentTarget.value.trim().slice(0, 40)
                  if (v && v !== label(icon) && icon.kind === 'link') updateLauncher(launcherId(icon), { label: v })
                  else if (v && v !== label(icon)) updateDesktop((s) => ({ ...s, names: { ...s.names, [icon.id]: v } }))
                  setRenaming(null)
                }}
              />
            ) : (
              <span className="desk-label">{label(icon)}</span>
            )}
            {pile && k === 0 && (
              <span className="desk-count" aria-hidden>
                {pile.length}
              </span>
            )}
          </div>
        )
      })}
      {marquee && <div className="marquee" style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }} />}
    </div>
  )
}
