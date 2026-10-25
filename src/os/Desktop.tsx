import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { openSticky } from '../apps/Sticky'
import { addLauncher, isLauncherApp, launch, launcherAt, launcherImage, launchersAreFiles, removeLauncher, updateLauncher, useLauncherFiles, useLaunchers, type Launcher } from '../data/launchers'
import { isLauncherName } from '../data/launcherFiles'
import { AppIcon } from './icons'
import { VideoThumb } from './VideoThumb'
import { createNote } from '../data/notes'
import { addWidgetItems } from '../widgets/registry'
import { projects } from '../data/profile'
import { HOME, kindOfName, type FileKind } from '../terminal/vfs'
import { pickAndUpload } from '../data/uploads'
import { isIcsName, isVcfName } from '../data/pimFiles'
import { getClipboard, setClipboard, openSeafile, refreshDirs, revalidateDir, setSeafilePrefs, useDir, useSeafileHome, useSeafilePrefs } from '../data/seafile'
import { deleteNoteFor as deleteNote, downloadFile as download, makeFile as createFile, makeFolder as mkdir, removePaths as deleteItems, renamePath as renameItem, transferPaths as transferItems } from '../data/fileOps'
import { dropIntoFolder, folderOp, undoLastMove, type Landed } from '../data/fileDrop'
import { beginPointerDrag, holdToDrag, keysOf, useDropTarget, type DragItem, type PointerDrag } from './dnd'
import { listBrowser, useBrowserFiles } from '../data/browserfs'
import { whereIs } from '../data/mounts'
import { notify } from './notify'
import { cvMode } from './cvMode'
import { useAccount } from './account'
import { ask } from './Dialogs'
import { cancelTouchMenu, closeContextMenu, openContextMenu, type MenuItem } from './ContextMenu'
import { resetLayout, restoreIcons, trashIcons, updateDesktop, useDesktop, type IconPos } from './desktopStore'
import { openLink } from '../data/links'
import { useSwing } from './swing'
import { useWM, type AppId } from './wm'
import { notesHidden } from './deskPrefs'
import { useIsMobile } from './useIsMobile'

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
  /** A file or folder in the Desktop folder (Seafile's, or the browser's): path is its path there */
  sf?: { dir: boolean }
  /** A launcher of your own; with `sf`, the .desktop file it is read from */
  launcher?: Launcher
  /** A video in the Desktop folder, shown as a frame from it (src/data/videoThumbs.ts): its version and bytes */
  video?: { version: string; size: number }
}

/** Emoji for what is in the Seafile Desktop folder, by kind. */
const SF_GLYPH: Partial<Record<FileKind, string>> = { folder: '📁', image: '🖼️', markdown: '📝', text: '📄', pdf: '📕', document: '📃', audio: '🎵', video: '🎬', archive: '🗜️', disc: '💿', link: '🔗' }

/** Menno's portfolio on the desktop: only on his CV page (src/os/cvMode.ts). */
const CV_ICONS = new Set(['projects', 'contributions', 'boltwarden', 'pepper', 'cv', 'readme'])

// Order is the default layout, top to bottom: folders, projects, then files. Folders and projects
// get capitalized names like apps; files keep their real file names.
export const DESKTOP_ICONS: DesktopIcon[] = ([
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
] as DesktopIcon[]).filter((i) => cvMode() || !CV_ICONS.has(i.id))

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
  | { kind: 'icons'; startX: number; startY: number; ids: string[]; moved: boolean; clickedId: string; additive: boolean; /** Finding targets under the pointer (src/os/dnd.ts) */ out?: PointerDrag }
  | { kind: 'marquee'; startX: number; startY: number; base: Set<string> }

export function Desktop() {
  const wm = useWM()
  const desk = useDesktop()
  // A phone with its notes put away shows the icons as a grid of tiles, opened with a tap.
  // Both hooks every render (not `mobile && hidden`): a screen crossing the phone width would
  // otherwise change the order of hooks.
  const mobile = useIsMobile()
  const hidden = notesHidden.use()
  const phoneGrid = mobile && hidden
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
  useLauncherFiles()
  const [broken, setBroken] = useState<Set<string>>(new Set())
  // Launchers on the desktop: .desktop files in its folder when launchers are files (signed in),
  // else the list kept in this browser.
  const filesMode = launchersAreFiles()
  const linkIcon = (l: Launcher): DesktopIcon => ({
    id: `launcher:${l.id}`,
    label: l.label,
    glyph: l.glyph ?? (l.app ? '▦' : '🔗'),
    image: l.glyph ? undefined : launcherImage(l),
    kind: 'link',
    path: l.file ?? l.url,
    open: { app: 'settings', props: { section: 'launchers' } },
    terminal: l.file ? `cat ${l.file}` : `curl -sI ${l.url}`,
    url: l.url,
    sf: l.file ? { dir: false } : undefined,
    launcher: l,
  })
  const linkIcons = filesMode ? [] : launchers.filter((l) => l.desktop !== false && !l.file).map(linkIcon)
  // With Seafile as home, its Desktop folder (as in Files) joins the site's icons and your launchers.
  const { home: sfHome, places } = useSeafileHome()
  const { siteIcons, officeDesktop } = useSeafilePrefs()
  const account = useAccount()
  // New Document and friends, when OnlyOffice is set up and asked for on the desktop.
  const officeIcons: DesktopIcon[] =
    officeDesktop && account.seafile?.office
      ? [
          { id: 'office:docx', label: 'New Document', glyph: '📝', kind: 'file', path: 'New Document', open: { app: 'newdoc' }, terminal: '' },
          { id: 'office:xlsx', label: 'New Spreadsheet', glyph: '📊', kind: 'file', path: 'New Spreadsheet', open: { app: 'newsheet' }, terminal: '' },
          { id: 'office:pptx', label: 'New Presentation', glyph: '📽️', kind: 'file', path: 'New Presentation', open: { app: 'newslides' }, terminal: '' },
        ]
      : []
  const seafileDesktop = sfHome && places ? places.desktop : null
  // Without Seafile as home, ~/Desktop is kept in this browser: its files are on the desktop too.
  useBrowserFiles()
  const browserDesk = !seafileDesktop ? whereIs(`${HOME}/Desktop`) : null
  const browserDesktop = browserDesk?.kind === 'browser' ? `${HOME}/Desktop` : null
  /** The folder the desktop shows and drops into: Seafile's Desktop, or the browser's. */
  const sfDesktop = seafileDesktop ?? browserDesktop
  const sfDir = useDir(seafileDesktop, 15_000)
  useEffect(() => {
    if (!seafileDesktop) return
    const again = () => document.visibilityState === 'visible' && revalidateDir(seafileDesktop)
    const t = setInterval(again, 60_000)
    window.addEventListener('focus', again)
    return () => {
      clearInterval(t)
      window.removeEventListener('focus', again)
    }
  }, [seafileDesktop])
  const entries = browserDesk?.kind === 'browser' ? listBrowser(browserDesk.path).map((e) => ({ name: e.path.split('/').pop()!, dir: e.dir, mtime: e.mtime, size: e.size })) : (sfDir.listing?.entries ?? [])
  const byFile = new Map(launchers.filter((l) => l.file).map((l) => [l.file!, l]))
  const sfIcons = entries
    .filter((e) => !e.name.startsWith('.'))
    .flatMap<DesktopIcon>((e) => {
      // A .desktop file shows as the launcher it is (its name and icon), not as a file; one still
      // being read shows once it is.
      if (!e.dir && isLauncherName(e.name) && sfDesktop) {
        const at = `${sfDesktop}/${e.name}`
        const l = byFile.get(at) ?? launcherAt(at, e.mtime)
        if (l) return [linkIcon(byFile.has(at) ? l : { ...l, desktop: true })]
        if (l === undefined) return []
      }
      const kind = kindOfName(e.name, e.dir)
      // Spreadsheets and presentations get their own picture; other Office files the document one.
      const glyph = /\.(xlsx?|xlsm|ods|csv|numbers)$/i.test(e.name) ? '📊' : /\.(pptx?|ppsx|odp|key)$/i.test(e.name) ? '📽️' : (SF_GLYPH[kind] ?? '📄')
      const video = !e.dir && kind === 'video' ? { version: `${e.mtime}-${e.size}`, size: e.size } : undefined
      return [{ id: `sf:${e.name}`, label: e.name, glyph, kind: e.dir ? 'folder' : 'file', path: `${sfDesktop}/${e.name}`, open: { app: 'files' }, terminal: '', sf: { dir: e.dir }, video } satisfies DesktopIcon]
    })
  // The site's own icons stay unless switched off (then the desktop is just the Seafile Desktop folder and launchers).
  const siteShown = !seafileDesktop || siteIcons
  const visible = [...(siteShown ? DESKTOP_ICONS.filter((i) => !desk.trashed.includes(i.id)) : []), ...sfIcons, ...officeIcons, ...linkIcons]
  const positions = useMemo(() => layout(visible.map((i) => i.id), desk.positions), [visible.map((i) => i.id).join(), desk.positions, viewport])

  useEffect(() => {
    const onResize = () => setViewport((n) => n + 1)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const label = (i: DesktopIcon) => desk.names[i.id] ?? i.label
  const launcherId = (i: DesktopIcon | string) => (typeof i === 'string' ? i : i.id).replace(/^launcher:/, '')
  const open = (i: DesktopIcon) => {
    if (i.launcher) return launch(i.launcher, wm)
    if (i.sf) return void openSeafile(wm, i.path, { dir: i.sf.dir }).catch((e: Error) => notify({ title: 'Could not open it', body: e.message }))
    ;(i.kind === 'folder' ? wm.openNew : wm.open)(i.open.app, { ...i.open.props, t: String(Date.now()) })
  }
  const newNote = () => openSticky(wm, createNote().id)
  const openInTerminal = (i: DesktopIcon) => wm.open('terminal', { run: i.terminal, t: String(Date.now()) })
  const selectedIcons = () => visible.filter((i) => selected.has(i.id))

  const sfPathOf = (id: string) => visible.find((i) => i.id === id)?.path
  const failed = (title: string) => (e: Error) => notify({ title, body: e.message })

  function moveToTrash(ids: string[]) {
    // New Document and friends just leave the desktop (Settings → Integrations → OnlyOffice brings them back).
    if (ids.some((id) => id.startsWith('office:'))) {
      setSeafilePrefs({ officeDesktop: false })
      ids = ids.filter((id) => !id.startsWith('office:'))
    }
    // Launchers are just removed (their .desktop file too); the trash is for the built-in icons.
    ids.filter((id) => id.startsWith('launcher:')).forEach((id) => removeLauncher(launcherId(id)))
    ids = ids.filter((id) => !id.startsWith('launcher:'))
    // Seafile's own files and folders are deleted there (into the library's trash), after asking.
    const sfPaths = ids.filter((id) => id.startsWith('sf:')).map(sfPathOf).filter((p): p is string => !!p)
    if (sfPaths.length) {
      const what = sfPaths.length === 1 ? sfPaths[0].split('/').pop() : `${sfPaths.length} items`
      void deleteNote(sfPaths)
        .then((note) => ask({ title: note.final ? `Delete ${what} for good?` : `Delete ${what}?`, body: note.body, confirm: 'Delete', danger: true }))
        .then((ok) => {
          if (ok) deleteItems(sfPaths).catch(failed('Could not delete it'))
        })
      ids = ids.filter((id) => !id.startsWith('sf:'))
    }
    trashIcons(ids)
    setSelected(new Set())
  }

  // --- pointer handling -----------------------------------------------------------------

  function onIconPointerDown(e: ReactPointerEvent, icon: DesktopIcon) {
    if (e.button !== 0 || renaming) return
    e.stopPropagation()
    // The phone's grid has no positions to drag icons to: a finger there scrolls, taps or holds
    // (and held still, lifts the icon to drag it into a folder, the dock or the trash).
    if (phoneGrid) {
      setSelected(new Set([icon.id]))
      return holdToDrag(e, () => itemsFor([icon.id]), 'desktop')
    }
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
    if (phoneGrid) return void setSelected(new Set())
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
      if (!d.moved) {
        swing.start(e.clientX)
        // Icons on the move: a finger resting again mid-drag is not a long press.
        cancelTouchMenu()
        // Folders, Files windows, the dock and the trash can take them; the desktop draws the
        // icons itself, so the ghost only shows once they are over something else.
        d.out = beginPointerDrag(itemsFor(d.ids), 'desktop', { ghost: 'away', home: surface.current })
      } else swing.move(e.clientX)
      d.moved = true
      document.body.classList.add('is-dragging')
      offsetRef.current = { dx, dy }
      setOffset({ dx, dy })
      d.out?.move(e.clientX, e.clientY, keysOf(e))
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

  /** What dragging these icons carries: their files, launchers, or (for the trash) the icons themselves. */
  function itemsFor(ids: string[]): DragItem[] {
    return ids.flatMap<DragItem>((id) => {
      const i = visible.find((v) => v.id === id)
      if (!i || i.id.startsWith('office:')) return []
      const l = i.launcher
      if (l && i.sf) return [{ kind: 'file', path: i.path, name: i.path.split('/').pop()!, dir: false, launcher: { id: l.id, label: l.label, url: l.url, glyph: l.glyph, image: l.image, app: l.app } }]
      if (l) return [{ kind: 'launcher', id: l.id, label: l.label, url: l.url, glyph: l.glyph, image: l.image, app: l.app, props: l.props }]
      if (i.sf) return [{ kind: 'file', path: i.path, name: i.label, dir: i.sf.dir }]
      return [{ kind: 'icon', id: i.id, label: label(i), glyph: i.glyph }]
    })
  }

  function onPointerUp(e?: ReactPointerEvent) {
    const d = drag.current
    drag.current = null
    document.body.classList.remove('is-dragging')
    swing.end()
    if (d?.kind === 'marquee') {
      setMarquee(null)
      return
    }
    if (!d) return
    // Let go over something that takes them (a folder, a Files window, the dock): it has them now.
    const tookIt = d.out && e ? d.out.end(e.clientX, e.clientY, keysOf(e)) : (d.out?.cancel(), false)
    if (d.moved && tookIt) {
      offsetRef.current = { dx: 0, dy: 0 }
      setOffset({ dx: 0, dy: 0 })
      return
    }
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

  /** Puts what was just dropped where it was let go, side by side. */
  function placeLanded(landed: Landed, at: { x: number; y: number }) {
    if (!landed.length) return
    const taken = new Set(visible.map((i) => key(positions[i.id])))
    const next: Record<string, IconPos> = {}
    landed.forEach((l, k) => {
      const cell = snap(at.x - CELL_W / 2 - k * CELL_W, at.y - 30, taken)
      taken.add(key(cell))
      next[l.launcherId ? `launcher:${l.launcherId}` : `sf:${l.path.split('/').pop()}`] = cell
    })
    updateDesktop((s) => ({ ...s, positions: { ...positions, ...s.positions, ...next } }))
  }

  // Dropping on the desktop: into its folder (files from Files windows and the computer, rows from
  // Archive, launchers and apps as .desktop files), or onto a folder icon (data-drop). The desktop's
  // own icons moved about are not drops: onPointerUp puts them in their new cells.
  const launcherDrop = (items: DragItem[]) => items.length > 0 && items.every((i) => i.kind === 'launcher' || i.kind === 'app')
  useDropTarget(surface, {
    accept: (d, spot) => {
      if (spot) return folderOp(d, spot)
      if (d.source === 'desktop') return null
      // Without a Desktop folder (a visitor), launchers and apps still go on the desktop, as before.
      if (!filesMode && launcherDrop(d.items)) return d.items.some((i) => i.kind === 'app' || (i.kind === 'launcher' && launchers.find((l) => l.id === i.id)?.desktop === false)) ? 'link' : null
      return sfDesktop ? folderOp(d, sfDesktop) : null
    },
    drop: (d, spot, op, at) => {
      if (spot) return void dropIntoFolder(d, spot, op)
      if (!filesMode && launcherDrop(d.items)) {
        const landed: Landed = []
        for (const i of d.items) {
          if (i.kind === 'launcher') updateLauncher(i.id, { desktop: true })
          if (i.kind === 'app') landed.push({ path: '', launcherId: addLauncher({ label: i.label, url: '', app: i.app }).id })
          else if (i.kind === 'launcher') landed.push({ path: '', launcherId: i.id })
        }
        return placeLanded(landed, at)
      }
      if (sfDesktop) void dropIntoFolder(d, sfDesktop, op).then((landed) => placeLanded(landed, at))
    },
    spring: (spot) => wm.openNew('files', { path: spot }),
  })

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
    else if (e.key.toLowerCase() === 'z' && (e.ctrlKey || e.metaKey)) void undoLastMove()
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
    if (icon.launcher) {
      const l = icon.launcher
      return [
        { label: l.app ? 'Open' : 'Open ↗', shortcut: '↵', onSelect: () => open(icon) },
        ...(l.url ? [{ label: 'Copy link', onSelect: () => navigator.clipboard?.writeText(l.url).catch(() => {}) }] : []),
        ...(l.file ? [{ label: 'Show in Files', onSelect: () => wm.openNew('files', { path: l.file!.split('/').slice(0, -1).join('/'), select: l.file }) }, { label: 'Edit the file in Zed', onSelect: () => void openSeafile(wm, l.file!, { how: 'zed' }) }] : []),
        { separator: true },
        { label: 'Rename', shortcut: 'F2', onSelect: () => setRenaming(icon.id) },
        { label: 'Edit launchers…', onSelect: () => wm.open('settings', { section: 'launchers', t: String(Date.now()) }) },
        { separator: true },
        { label: 'Remove launcher', shortcut: 'Del', danger: true, onSelect: () => moveToTrash([icon.id]) },
      ]
    }
    if (icon.sf) {
      const folder = icon.path.split('/').slice(0, -1).join('/')
      return [
        { label: 'Open', shortcut: '↵', onSelect: () => open(icon) },
        ...(icon.sf.dir
          ? []
          : [
              {
                label: 'Open with',
                submenu: [
                  ...(isIcsName(icon.path) ? [{ label: 'Calendar', onSelect: () => void openSeafile(wm, icon.path, { how: 'calendar' }) }] : []),
                  ...(isVcfName(icon.path) ? [{ label: 'Contacts', onSelect: () => void openSeafile(wm, icon.path, { how: 'contacts' }) }] : []),
                  { label: 'Zed', onSelect: () => void openSeafile(wm, icon.path, { how: 'zed' }) },
                  { label: 'Viewer', onSelect: () => void openSeafile(wm, icon.path, { how: 'viewer' }) },
                  { label: 'Preview', onSelect: () => void openSeafile(wm, icon.path, { how: 'preview' }) },
                  { label: 'Player', onSelect: () => void openSeafile(wm, icon.path, { how: 'player' }) },
                  { label: 'Omamp', onSelect: () => void openSeafile(wm, icon.path, { how: 'amp' }) },
                  { label: 'Office', onSelect: () => void openSeafile(wm, icon.path, { how: 'office' }) },
                ],
              },
              { label: 'Download', onSelect: () => void download(icon.path).catch((e: Error) => notify({ title: 'Could not download it', body: e.message })) },
            ]),
        { label: 'Show in Files', onSelect: () => wm.openNew('files', { path: folder, select: icon.path }) },
        { separator: true },
        { label: 'Rename', shortcut: 'F2', onSelect: () => setRenaming(icon.id) },
        { label: 'Delete', shortcut: 'Del', danger: true, onSelect: () => moveToTrash([icon.id]) },
      ]
    }
    if (icon.id.startsWith('office:'))
      return [
        { label: `${icon.label}`, shortcut: '↵', onSelect: () => open(icon) },
        { separator: true },
        { label: 'Remove from desktop', onSelect: () => moveToTrash([icon.id]) },
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

  /** A new Seafile folder or file where the desktop was right-clicked, named straight away. */
  function createHere(kind: 'folder' | 'file', at: { x: number; y: number }) {
    if (!sfDesktop) return
    const taken = new Set(sfIcons.map((i) => i.label))
    const base = kind === 'folder' ? 'New folder' : 'untitled.txt'
    let name = base
    for (let n = 2; taken.has(name); n++) name = kind === 'folder' ? `New folder ${n}` : `untitled-${n}.txt`
    const cell = snap(at.x - CELL_W / 2, at.y - 30, new Set(visible.map((i) => key(positions[i.id]))))
    ;(kind === 'folder' ? mkdir(`${sfDesktop}/${name}`) : createFile(`${sfDesktop}/${name}`))
      .then((made) => {
        const id = `sf:${made.split('/').pop()}`
        updateDesktop((s) => ({ ...s, positions: { ...s.positions, [id]: cell } }))
        setSelected(new Set([id]))
        setRenaming(id)
      })
      .catch(failed(kind === 'folder' ? 'Could not make the folder' : 'Could not make the file'))
  }

  function desktopMenu(at: { x: number; y: number }): MenuItem[] {
    const clip = getClipboard()
    return [
      {
        label: 'New',
        submenu: [
          ...(sfDesktop
            ? [{ label: 'Folder', onSelect: () => createHere('folder', at) }, { label: 'Text file', onSelect: () => createHere('file', at) }, { separator: true } as MenuItem]
            : []),
          { label: 'Sticky note', onSelect: newNote },
          { label: 'Widget', submenu: addWidgetItems(wm) },
          { label: 'Launcher…', onSelect: () => wm.open('settings', { section: 'launchers', t: String(Date.now()) }) },
        ],
      },
      ...(sfDesktop
        ? [
            { label: 'Upload files…', onSelect: () => pickAndUpload(sfDesktop) },
            { label: 'Upload folder…', onSelect: () => pickAndUpload(sfDesktop, true) },
            ...(clip ? [{ label: `Paste ${clip.paths.length === 1 ? clip.paths[0].split('/').pop() : `${clip.paths.length} items`}`, onSelect: () => void transferItems(clip.op, clip.paths, sfDesktop).then(() => clip.op === 'move' && setClipboard(null)).catch(failed('Could not paste')) }] : []),
            { label: 'Show in Files', onSelect: () => wm.openNew('files', { path: sfDesktop }) },
          ]
        : []),
      { separator: true },
      { label: 'Select all', shortcut: 'Ctrl A', onSelect: () => setSelected(new Set(visible.map((i) => i.id))) },
      { label: 'Clean up icons', onSelect: resetLayout },
      ...(seafileDesktop ? [{ label: 'Show the site’s icons', checked: siteIcons, onSelect: () => setSeafilePrefs({ siteIcons: !siteIcons }) }, { label: 'Refresh', onSelect: () => refreshDirs(seafileDesktop) }] : []),
      ...(desk.trashed.length && siteShown ? [{ label: `Put back ${desk.trashed.length} trashed icon${desk.trashed.length === 1 ? '' : 's'}`, onSelect: () => restoreIcons(desk.trashed) }] : []),
      { separator: true },
      {
        label: 'Open',
        submenu: [
          { label: 'Terminal', onSelect: () => wm.open('terminal') },
          { label: 'Files', onSelect: () => wm.openNew('files') },
          { label: 'Notebook', onSelect: () => wm.open('notebook') },
          ...(cvMode() ? [{ label: 'Activity', onSelect: () => wm.open('recents') }] : []),
          { label: 'About this system', onSelect: () => wm.open('about', { t: String(Date.now()) }) },
        ],
      },
    ]
  }

  return (
    <div
      ref={surface}
      className={`desk ${phoneGrid ? 'is-grid' : ''}`}
      tabIndex={-1}
      onPointerDown={onSurfacePointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => onPointerUp()}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => {
        if (e.target !== surface.current) return
        setSelected(new Set())
        openContextMenu(e, desktopMenu({ x: e.clientX, y: e.clientY }))
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
            data-drop={icon.sf?.dir ? icon.path : undefined}
            style={{ left: p.x, top: p.y, transform, zIndex: pile ? 3 + pile.length - k : undefined }}
            tabIndex={0}
            role="button"
            aria-label={label(icon)}
            aria-selected={isSel}
            onPointerDown={(e) => onIconPointerDown(e, icon)}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onDoubleClick={() => !phoneGrid && open(icon)}
            onClick={() => phoneGrid && !renaming && open(icon)}
            onFocus={() => !selected.has(icon.id) && !drag.current && setSelected(new Set([icon.id]))}
            onContextMenu={(e) => {
              closeContextMenu()
              if (!selected.has(icon.id)) setSelected(new Set([icon.id]))
              openContextMenu(e, iconMenu(icon))
            }}
          >
            {/* A launcher that opens an app (X-MvL-App) wears that app's icon, unless it has an emoji of its own. */}
            {icon.launcher?.app && !icon.launcher.glyph && isLauncherApp(icon.launcher.app) ? (
              <span className="desk-glyph">
                <AppIcon app={icon.launcher.app as AppId} size={44} tone />
              </span>
            ) : icon.video ? (
              <VideoThumb path={icon.path} version={icon.video.version} size={icon.video.size} className="desk-video" imgClassName="desk-thumb" fallback={<span className="desk-glyph">{icon.glyph}</span>} />
            ) : icon.image && !broken.has(icon.id) ? (
              <img className={`desk-img ${icon.kind === 'link' && !icon.launcher?.image ? 'is-favicon' : ''}`} src={icon.image} alt="" draggable={false} onError={() => setBroken((b) => new Set(b).add(icon.id))} />
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
                  if (v && v !== label(icon) && icon.launcher) updateLauncher(icon.launcher.id, { label: v })
                  else if (v && v !== label(icon) && icon.sf) {
                    // A Seafile file is renamed there; its place on the desktop goes with it.
                    const sf = icon.sf
                    renameItem(icon.path, v, sf.dir)
                      .then((made) => {
                        const id = `sf:${made.split('/').pop()}`
                        updateDesktop((s) => ({ ...s, positions: { ...s.positions, [id]: s.positions[icon.id] ?? positions[icon.id] } }))
                      })
                      .catch(failed('Could not rename it'))
                  } else if (v && v !== label(icon)) updateDesktop((s) => ({ ...s, names: { ...s.names, [icon.id]: v } }))
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
