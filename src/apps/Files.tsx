import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { restoreIcons, useDesktop } from '../os/desktopStore'
import { DESKTOP_ICONS } from '../os/Desktop'
import { openContextMenu, type MenuItem } from '../os/ContextMenu'
import { openLink } from '../data/links'
import { useWM, type AppId, type WinState } from '../os/wm'
import { formatSize, HOME, KIND_LABEL, lookup, prettyPath, resolvePath, stat, walk, type FileKind, type Node } from '../terminal/vfs'

// A file manager in the style of Omafile (the Omarchy file manager Menno contributes to), browsing
// the same in-memory filesystem the terminal uses. Only /tmp is writable.

type View = 'list' | 'grid' | 'compact' | 'gallery'
type Sort = 'az' | 'za' | 'newest' | 'oldest' | 'largest' | 'smallest' | 'type'
type Prefs = { view: View; zoom: number; sort: Sort; hidden: boolean; sidebar: boolean; bookmarks: string[] }

const PREFS_KEY = 'mvlos.files.v1'
const DEFAULT_PREFS: Prefs = { view: 'grid', zoom: 100, sort: 'az', hidden: false, sidebar: true, bookmarks: [`${HOME}/projects`, `${HOME}/games`, `${HOME}/contributions`] }
const RECENT = 'recent://'
const TRASH = 'trash://'

function loadPrefs(): Prefs {
  try {
    return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') }
  } catch {
    return DEFAULT_PREFS
  }
}

// Files opened from any Files window during this visit, newest first.
const recent: string[] = []
const remember = (path: string) => {
  const i = recent.indexOf(path)
  if (i >= 0) recent.splice(i, 1)
  recent.unshift(path)
  recent.length = Math.min(recent.length, 30)
}

const JOKE_TRASH = ['kubernetes-for-my-blog.yaml', 'salt-states-v1/', 'electron-spotify-config.json', 'TODO-final-FINAL-v3.md', 'works-on-my-machine.iso']

type Item = { path: string; name: string; node: Node | null; kind: FileKind; size: number; mtime: number; trash?: 'desktop' | 'joke'; desktopId?: string }

const SPECIAL_EMBLEMS: Record<string, string> = {
  [HOME]: 'home',
  [`${HOME}/Desktop`]: 'desktop',
  [`${HOME}/Documents`]: 'documents',
  [`${HOME}/Downloads`]: 'downloads',
  [`${HOME}/Music`]: 'music',
  [`${HOME}/Pictures`]: 'pictures',
  [`${HOME}/Videos`]: 'videos',
  [`${HOME}/games`]: 'games',
  [`${HOME}/projects`]: 'code',
  [`${HOME}/contributions`]: 'code',
}

// --- icons ------------------------------------------------------------------------------------

const EMBLEM_PATHS: Record<string, ReactNode> = {
  home: <path d="M24 26.5l8-6.5 8 6.5V35h-5v-5h-6v5h-5z" />,
  desktop: <path d="M24 23h16v10H24zM29 36h6" />,
  documents: <path d="M27 21h8l3 3v12H27zM30 28h6M30 31h6" />,
  downloads: <path d="M32 21v11M27.5 27.5L32 32l4.5-4.5M26 36h12" />,
  music: <path d="M29 34.5a2.5 2.5 0 1 1-2.5-2.5H29V22l9-2v12.5a2.5 2.5 0 1 1-2.5-2.5H38" />,
  pictures: <path d="M24 22h16v14H24zM24 33l5-5 4 4 2-2 5 5" />,
  videos: <path d="M24 23h16v12H24zM30 26v6l5-3z" />,
  games: <path d="M26 25h12a4 4 0 0 1 4 4 3 3 0 0 1-5.5 1.7L35 29h-6l-1.5 1.7A3 3 0 0 1 22 29a4 4 0 0 1 4-4zM27 27v3M25.5 28.5h3" />,
  code: <path d="M28 24l-5 5 5 5M36 24l5 5-5 5" />,
}

function FolderIcon({ size, emblem }: { size: number; emblem?: string }) {
  return (
    <svg viewBox="0 0 64 56" width={size} height={size * 0.875} className="fm-folder" aria-hidden>
      <path d="M4 10a4 4 0 0 1 4-4h14l6 6h28a4 4 0 0 1 4 4v4H4z" fill="var(--accent)" opacity="0.7" />
      <rect x="4" y="14" width="56" height="38" rx="4" fill="var(--accent)" />
      {emblem && (
        <g fill="none" stroke="var(--on-accent)" strokeOpacity="0.6" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" transform="translate(0 2)">
          {EMBLEM_PATHS[emblem]}
        </g>
      )}
    </svg>
  )
}

const KIND_COLOR: Partial<Record<FileKind, string>> = { markdown: 'var(--blue)', text: 'var(--muted)', link: 'var(--cyan)', game: 'var(--green)', audio: 'var(--magenta)', video: 'var(--red)', disc: 'var(--orange)', archive: 'var(--yellow)', package: 'var(--green)' }

function FileIcon({ size, kind, name }: { size: number; kind: FileKind; name: string }) {
  const ext = name.includes('.') ? name.split('.').pop()!.slice(0, 4).toUpperCase() : 'TXT'
  const color = KIND_COLOR[kind] ?? 'var(--muted)'
  return (
    <svg viewBox="0 0 48 60" width={size * 0.8} height={size} className="fm-file" aria-hidden>
      <path d="M6 2h26l12 12v42a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z" fill="var(--bg-light)" stroke="color-mix(in srgb, var(--fg) 30%, transparent)" strokeWidth="1.5" />
      <path d="M32 2v10a2 2 0 0 0 2 2h10" fill="none" stroke="color-mix(in srgb, var(--fg) 30%, transparent)" strokeWidth="1.5" />
      <rect x="4" y="38" width="40" height="12" fill={color} />
      <text x="24" y="47.5" textAnchor="middle" fontSize="9" fontWeight="700" fontFamily="JetBrains Mono, monospace" fill="#fff">
        {ext}
      </text>
    </svg>
  )
}

function Thumb({ item, size, gallery = false }: { item: Item; size: number; gallery?: boolean }) {
  const src = useMemo(() => (item.node?.type === 'file' && item.kind === 'image' ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(item.node.content())}` : null), [item])
  // An explicit box: SVGs with only a viewBox have no dependable intrinsic size.
  if (src) return <img className="fm-thumb" src={src} alt="" style={gallery ? undefined : { width: Math.round(size * 1.35), height: size }} draggable={false} />
  if (item.kind === 'folder') return <FolderIcon size={size} emblem={SPECIAL_EMBLEMS[item.path]} />
  return <FileIcon size={size} kind={item.kind} name={item.name} />
}

/** "screenshot-202…-22-56.png": keep the start and the end, which are the informative parts. */
function middleEllipsis(name: string, max: number) {
  if (name.length <= max) return name
  const tail = Math.ceil((max - 1) / 2)
  return name.slice(0, max - 1 - tail) + '…' + name.slice(-tail)
}

// --- the app -----------------------------------------------------------------------------------

export function Files({ win }: { win: WinState }) {
  const wm = useWM()
  const desk = useDesktop()
  const [prefs, setPrefsState] = useState<Prefs>(loadPrefs)
  const [path, setPath] = useState(win.props.path ?? HOME)
  const [back, setBack] = useState<string[]>([])
  const [fwd, setFwd] = useState<string[]>([])
  const [selected, setSelected] = useState<Set<string>>(() => new Set(win.props.select ? [win.props.select] : []))
  const [anchor, setAnchor] = useState<string | null>(null)
  const [editingPath, setEditingPath] = useState(false)
  const [search, setSearch] = useState<string | null>(null)
  const [menu, setMenu] = useState<'view' | null>(null)
  const [props, setProps] = useState<Item | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const main = useRef<HTMLDivElement>(null)
  const tiles = useRef(new Map<string, HTMLElement>())

  const setPrefs = (patch: Partial<Prefs>) =>
    setPrefsState((p) => {
      const next = { ...p, ...patch }
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(next))
      } catch {
        /* not persisted */
      }
      return next
    })

  // Re-read the filesystem when the window comes back to the front (the terminal may have written to /tmp).
  useEffect(() => setTick((t) => t + 1), [wm.focusedPid])
  useEffect(() => {
    if (win.props.path) navigate(win.props.path, false)
    if (win.props.select) setSelected(new Set([win.props.select]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [win.props])
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 2600)
    return () => clearTimeout(t)
  }, [toast])

  const navigate = useCallback(
    (to: string, record = true) => {
      if (to === path) return
      if (record) {
        setBack((b) => [...b, path])
        setFwd([])
      }
      setPath(to)
      setSelected(new Set())
      setSearch(null)
      setEditingPath(false)
    },
    [path],
  )

  // --- listing --------------------------------------------------------------------------------

  const items = useMemo<Item[]>(() => {
    void tick
    const toItem = (p: string): Item | null => {
      const node = lookup(p)
      if (!node) return null
      const st = stat(p, node)
      return { path: p, name: node.name, node, kind: st.kind, size: st.size, mtime: st.mtime }
    }
    let list: Item[]
    if (path === RECENT) list = recent.map(toItem).filter((x): x is Item => !!x)
    else if (path === TRASH)
      list = [
        ...DESKTOP_ICONS.filter((i) => desk.trashed.includes(i.id)).map((i) => ({ path: `${TRASH}${i.id}`, name: desk.names[i.id] ?? i.label, node: lookup(resolvePath(HOME, i.path)), kind: i.kind === 'file' ? ('markdown' as FileKind) : ('folder' as FileKind), size: 0, mtime: Date.now(), trash: 'desktop' as const, desktopId: i.id })),
        ...JOKE_TRASH.map((n, idx) => ({ path: `${TRASH}joke-${idx}`, name: n.replace(/\/$/, ''), node: null, kind: n.endsWith('/') ? ('folder' as FileKind) : n.endsWith('.iso') ? ('disc' as FileKind) : n.endsWith('.md') ? ('markdown' as FileKind) : ('text' as FileKind), size: 1024 * (idx + 3) * 17, mtime: Date.now() - (idx + 2) * 864e5 * 30, trash: 'joke' as const })),
      ]
    else if (search) {
      const q = search.toLowerCase()
      list = walk(path)
        .filter((p) => p !== path && p.split('/').pop()!.toLowerCase().includes(q))
        .map(toItem)
        .filter((x): x is Item => !!x)
    } else {
      const node = lookup(path)
      list = node?.type === 'dir' ? [...node.children.keys()].map((n) => toItem(`${path === '/' ? '' : path}/${n}`)).filter((x): x is Item => !!x) : []
    }
    if (!prefs.hidden) list = list.filter((i) => !i.name.startsWith('.'))
    const byName = (a: Item, b: Item) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })
    const cmp: Record<Sort, (a: Item, b: Item) => number> = {
      az: byName,
      za: (a, b) => -byName(a, b),
      newest: (a, b) => b.mtime - a.mtime,
      oldest: (a, b) => a.mtime - b.mtime,
      largest: (a, b) => b.size - a.size,
      smallest: (a, b) => a.size - b.size,
      type: (a, b) => a.kind.localeCompare(b.kind) || byName(a, b),
    }
    // Folders stay on top, as in every file manager.
    return list.sort((a, b) => (a.kind === 'folder' ? 0 : 1) - (b.kind === 'folder' ? 0 : 1) || cmp[prefs.sort](a, b))
  }, [path, search, prefs.hidden, prefs.sort, tick, desk.trashed, desk.names])

  const writable = path === '/tmp' || path.startsWith('/tmp/')

  // --- actions ----------------------------------------------------------------------------------

  const openItem = (item: Item, how: 'default' | 'viewer' | 'zed' | 'terminal' = 'default') => {
    if (item.trash) {
      setToast(item.trash === 'desktop' ? 'Put it back first (right-click → Put back).' : 'That file is a cautionary tale. It stays in the trash.')
      return
    }
    const node = item.node
    if (!node) return
    if (node.type === 'dir') {
      if (how === 'terminal') wm.openNew('terminal', { run: `cd ${prettyPath(item.path)} && ls`, t: String(Date.now()) })
      else navigate(item.path)
      return
    }
    remember(item.path)
    if (how === 'terminal') return wm.openNew('terminal', { run: `cat ${prettyPath(item.path)}`, t: String(Date.now()) })
    if (how === 'viewer') return wm.openNew('viewer', { path: item.path })
    if (how === 'zed') return wm.open('zed', { path: item.path, view: 'preview', t: String(Date.now()) })
    if (node.open?.url) return void openLink(node.open.url)
    if (node.open?.app) return wm.open(node.open.app as AppId, { ...node.open.props, t: String(Date.now()) })
    if (item.kind === 'markdown') return openItem(item, 'zed')
    wm.openNew('viewer', { path: item.path })
  }

  const readOnly = () => setToast('Read-only file system. Only /tmp is writable here.')

  const trashItems = (list: Item[]) => {
    if (!list.length) return
    if (!list.every((i) => i.path.startsWith('/tmp/'))) return readOnly()
    const tmp = lookup('/tmp')
    if (tmp?.type === 'dir') for (const i of list) tmp.children.delete(i.name)
    setSelected(new Set())
    setTick((t) => t + 1)
    setToast(`Deleted ${list.length === 1 ? list[0].name : `${list.length} items`} (it was only ever in memory)`)
  }

  const newFile = () => {
    if (!writable) return readOnly()
    const tmp = lookup('/tmp')
    if (tmp?.type !== 'dir') return
    let name = 'untitled.txt'
    for (let n = 2; tmp.children.has(name); n++) name = `untitled-${n}.txt`
    const created = `Created ${new Date().toLocaleString('en-GB')} in the Files app.\n`
    tmp.children.set(name, { type: 'file', name, content: () => created, mtime: Date.now() })
    setTick((t) => t + 1)
    setSelected(new Set([`/tmp/${name}`]))
  }

  const bookmark = (p: string) => !prefs.bookmarks.includes(p) && setPrefs({ bookmarks: [...prefs.bookmarks, p] })
  const copyPath = (p: string) => navigator.clipboard?.writeText(prettyPath(p)).then(() => setToast(`Copied ${prettyPath(p)}`)).catch(() => {})

  const selectedItems = () => items.filter((i) => selected.has(i.path))

  function itemMenu(item: Item): MenuItem[] {
    const many = selected.has(item.path) && selected.size > 1
    if (item.trash === 'desktop')
      return [{ label: 'Put back on desktop', onSelect: () => restoreIcons([item.desktopId!]) }, { label: 'Properties', onSelect: () => setProps(item) }]
    if (item.trash === 'joke') return [{ label: 'Restore', disabled: true }, { label: 'Properties', onSelect: () => setProps(item) }]
    if (many) {
      const sel = selectedItems()
      return [
        { label: `Open ${sel.length} items`, onSelect: () => sel.forEach((i) => openItem(i)) },
        { separator: true },
        { label: `Move ${sel.length} items to Trash`, shortcut: 'Del', danger: true, onSelect: () => trashItems(sel) },
      ]
    }
    const isDir = item.kind === 'folder'
    return [
      { label: 'Open', shortcut: '↵', onSelect: () => openItem(item) },
      ...(isDir
        ? [{ label: 'Open in new window', onSelect: () => wm.openNew('files', { path: item.path }) }]
        : [
            {
              label: 'Open with',
              submenu: [
                { label: 'Default app', onSelect: () => openItem(item) },
                { label: 'Zed', onSelect: () => openItem(item, 'zed') },
                { label: 'Viewer', onSelect: () => openItem(item, 'viewer') },
                { label: 'Terminal (cat)', onSelect: () => openItem(item, 'terminal') },
              ],
            },
          ]),
      { label: 'Open in terminal', onSelect: () => openItem(item, 'terminal') },
      { separator: true },
      { label: 'Copy path', onSelect: () => copyPath(item.path) },
      ...(isDir ? [{ label: 'Add to bookmarks', disabled: prefs.bookmarks.includes(item.path), onSelect: () => bookmark(item.path) }] : []),
      { label: 'Properties', shortcut: 'Alt ↵', onSelect: () => setProps(item) },
      { separator: true },
      { label: 'Move to Trash', shortcut: 'Del', danger: true, onSelect: () => trashItems([item]) },
    ]
  }

  function backgroundMenu(): MenuItem[] {
    const special = path === RECENT || path === TRASH
    return [
      { label: 'New text file', disabled: !writable, onSelect: newFile },
      { label: 'Open terminal here', disabled: special, onSelect: () => wm.openNew('terminal', { run: `cd ${prettyPath(path)} && ls`, t: String(Date.now()) }) },
      { label: 'Add to bookmarks', disabled: special || prefs.bookmarks.includes(path), onSelect: () => bookmark(path) },
      { separator: true },
      { label: 'Select all', shortcut: 'Ctrl A', onSelect: () => setSelected(new Set(items.map((i) => i.path))) },
      { label: 'Show hidden files', checked: prefs.hidden, shortcut: 'Ctrl H', onSelect: () => setPrefs({ hidden: !prefs.hidden }) },
      { label: 'View', submenu: (['list', 'grid', 'compact', 'gallery'] as View[]).map((v) => ({ label: v[0].toUpperCase() + v.slice(1), checked: prefs.view === v, onSelect: () => setPrefs({ view: v }) })) },
      { label: 'Sort by', submenu: SORTS.map(([k, label]) => ({ label, checked: prefs.sort === k, onSelect: () => setPrefs({ sort: k }) })) },
    ]
  }

  // --- selection & keyboard -------------------------------------------------------------------

  const clickItem = (e: React.MouseEvent, item: Item) => {
    e.stopPropagation()
    if (e.shiftKey && anchor) {
      const a = items.findIndex((i) => i.path === anchor)
      const b = items.findIndex((i) => i.path === item.path)
      const [lo, hi] = a < b ? [a, b] : [b, a]
      setSelected(new Set(items.slice(lo, hi + 1).map((i) => i.path)))
      return
    }
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(selected)
      if (next.has(item.path)) next.delete(item.path)
      else next.add(item.path)
      setSelected(next)
    } else setSelected(new Set([item.path]))
    setAnchor(item.path)
  }

  /** Arrow keys move to the nearest tile in that direction, whatever the layout. */
  const moveSelection = (dir: 'up' | 'down' | 'left' | 'right', extend: boolean) => {
    const current = anchor && tiles.current.get(anchor) ? anchor : items[0]?.path
    if (!current) return
    const from = tiles.current.get(current)?.getBoundingClientRect()
    if (!from) return
    const cx = from.left + from.width / 2
    const cy = from.top + from.height / 2
    let best: string | null = null
    let bestScore = Infinity
    for (const item of items) {
      if (item.path === current) continue
      const r = tiles.current.get(item.path)?.getBoundingClientRect()
      if (!r) continue
      const dx = r.left + r.width / 2 - cx
      const dy = r.top + r.height / 2 - cy
      const ok = { up: dy < -4, down: dy > 4, left: dx < -4 && Math.abs(dy) < from.height / 2, right: dx > 4 && Math.abs(dy) < from.height / 2 }[dir]
      if (!ok) continue
      const score = dir === 'up' || dir === 'down' ? Math.abs(dy) * 1000 + Math.abs(dx) : Math.abs(dx)
      if (score < bestScore) {
        bestScore = score
        best = item.path
      }
    }
    if (!best) return
    setSelected(extend ? new Set([...selected, best]) : new Set([best]))
    setAnchor(best)
    tiles.current.get(best)?.scrollIntoView({ block: 'nearest' })
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('input')) return
    const ctrl = e.ctrlKey || e.metaKey
    const sel = selectedItems()
    if (ctrl && ['1', '2', '3', '4'].includes(e.key)) setPrefs({ view: (['list', 'grid', 'compact', 'gallery'] as View[])[Number(e.key) - 1] })
    else if (ctrl && e.key.toLowerCase() === 'h') setPrefs({ hidden: !prefs.hidden })
    else if (ctrl && e.key.toLowerCase() === 'a') setSelected(new Set(items.map((i) => i.path)))
    else if (ctrl && e.key.toLowerCase() === 'l') setEditingPath(true)
    else if (ctrl && e.key.toLowerCase() === 'f') setSearch('')
    else if (ctrl && (e.key === '=' || e.key === '+')) setPrefs({ zoom: Math.min(200, prefs.zoom + 10) })
    else if (ctrl && e.key === '-') setPrefs({ zoom: Math.max(50, prefs.zoom - 10) })
    else if (e.altKey && e.key === 'ArrowLeft') goBack()
    else if (e.altKey && e.key === 'ArrowRight') goForward()
    else if ((e.altKey && e.key === 'ArrowUp') || e.key === 'Backspace') goUp()
    else if (e.altKey && e.key === 'Enter' && sel[0]) setProps(sel[0])
    else if (e.key === 'Enter' && sel.length) sel.forEach((i) => openItem(i))
    else if (e.key === 'Delete') trashItems(sel)
    else if (e.key === 'Escape') setSelected(new Set())
    else if (e.key.startsWith('Arrow')) moveSelection(e.key.slice(5).toLowerCase() as 'up', e.shiftKey)
    else return
    e.preventDefault()
  }

  const goBack = () => {
    const prev = back[back.length - 1]
    if (prev === undefined) return
    setBack(back.slice(0, -1))
    setFwd([path, ...fwd])
    navigate(prev, false)
  }
  const goForward = () => {
    const next = fwd[0]
    if (next === undefined) return
    setFwd(fwd.slice(1))
    setBack([...back, path])
    navigate(next, false)
  }
  const goUp = () => {
    if (path === '/' || path === RECENT || path === TRASH) return
    navigate(path.split('/').slice(0, -1).join('/') || '/')
  }

  // Rubber-band selection on empty space.
  const onMainPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('.fm-item, .fm-list-head')) return
    const box = main.current!.getBoundingClientRect()
    const start = { x: e.clientX - box.left + main.current!.scrollLeft, y: e.clientY - box.top + main.current!.scrollTop }
    const base = e.ctrlKey || e.metaKey ? new Set(selected) : new Set<string>()
    setSelected(base)
    main.current!.focus({ preventScroll: true })
    const move = (ev: PointerEvent) => {
      const x = ev.clientX - box.left + main.current!.scrollLeft
      const y = ev.clientY - box.top + main.current!.scrollTop
      const rect = { x: Math.min(start.x, x), y: Math.min(start.y, y), w: Math.abs(x - start.x), h: Math.abs(y - start.y) }
      if (rect.w < 4 && rect.h < 4) return
      setMarquee(rect)
      const hit = new Set(base)
      for (const [p, el] of tiles.current) {
        const r = el.getBoundingClientRect()
        const t = { x: r.left - box.left + main.current!.scrollLeft, y: r.top - box.top + main.current!.scrollTop }
        if (t.x < rect.x + rect.w && t.x + r.width > rect.x && t.y < rect.y + rect.h && t.y + r.height > rect.y) hit.add(p)
      }
      setSelected(hit)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setMarquee(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // --- rendering --------------------------------------------------------------------------------

  const z = prefs.zoom / 100
  const iconSize = Math.round((prefs.view === 'gallery' ? 120 : prefs.view === 'compact' ? 22 : prefs.view === 'list' ? 18 : 52) * z)
  const tileWidth = Math.round((prefs.view === 'gallery' ? 210 : 128) * z)
  const captionChars = Math.max(10, Math.floor((tileWidth - 12) / 7.4) * 2)
  const selectedSize = selectedItems().reduce((a, i) => a + (i.kind === 'folder' ? 0 : i.size), 0)
  const trashCount = desk.trashed.length + JOKE_TRASH.length

  const crumbs = useMemo(() => {
    if (path === RECENT) return [{ label: 'Recent', path: RECENT }]
    if (path === TRASH) return [{ label: 'Trash', path: TRASH }]
    const inHome = path === HOME || path.startsWith(HOME + '/')
    const rest = inHome ? path.slice(HOME.length) : path
    const parts = rest.split('/').filter(Boolean)
    const out = [{ label: inHome ? '~' : '/', path: inHome ? HOME : '/' }]
    let acc = inHome ? HOME : ''
    for (const part of parts) {
      acc += '/' + part
      out.push({ label: part, path: acc })
    }
    return out
  }, [path])

  const place = (label: string, target: string, icon: string, extra?: ReactNode) => (
    <button key={target + label} className={`fm-side-item ${path === target ? 'is-active' : ''}`} onClick={() => (target.startsWith('http') ? openLink(target) : navigate(target))}>
      <span className="fm-side-icon">{icon}</span>
      <span className="fm-side-label">{label}</span>
      {extra}
    </button>
  )

  return (
    <div className="fm" onKeyDown={onKeyDown}>
      <div className="fm-toolbar">
        <button className="fm-tool" onClick={goBack} disabled={!back.length} title="Back (Alt+←)" aria-label="Back">
          ←
        </button>
        <button className="fm-tool" onClick={goForward} disabled={!fwd.length} title="Forward (Alt+→)" aria-label="Forward">
          →
        </button>
        <button className="fm-tool" onClick={goUp} disabled={path === '/' || path === RECENT || path === TRASH} title="Up (Alt+↑)" aria-label="Up">
          ↑
        </button>
        <div className="fm-path" onClick={() => search === null && !editingPath && setEditingPath(true)}>
          {search !== null ? (
            <input
              className="fm-path-input"
              autoFocus
              value={search}
              placeholder={`Search in ${prettyPath(path)}`}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setSearch(null)
                  main.current?.focus()
                }
                e.stopPropagation()
              }}
            />
          ) : editingPath ? (
            <input
              className="fm-path-input"
              autoFocus
              defaultValue={prettyPath(path)}
              onFocus={(e) => e.currentTarget.select()}
              onBlur={() => setEditingPath(false)}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Escape') setEditingPath(false)
                if (e.key === 'Enter') {
                  const target = resolvePath(path.includes('://') ? HOME : path, e.currentTarget.value)
                  const node = lookup(target)
                  if (node?.type === 'dir') navigate(target)
                  else setToast(`${e.currentTarget.value}: no such folder`)
                }
              }}
            />
          ) : (
            crumbs.map((c, i) => (
              <span key={c.path} className="fm-crumb-wrap">
                {i > 0 && <span className="fm-crumb-sep">›</span>}
                <button
                  className="fm-crumb"
                  onClick={(e) => {
                    e.stopPropagation()
                    navigate(c.path)
                  }}
                >
                  {c.label}
                </button>
              </span>
            ))
          )}
          <button
            className="fm-path-search"
            onClick={(e) => {
              e.stopPropagation()
              setEditingPath(false)
              setSearch(search === null ? '' : null)
            }}
            title="Search (Ctrl+F)"
            aria-label="Search"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-3.5-3.5" />
            </svg>
          </button>
        </div>
        <div className="fm-menu-wrap">
          <button className={`fm-tool ${menu === 'view' ? 'is-open' : ''}`} onClick={() => setMenu(menu === 'view' ? null : 'view')} title="View options" aria-label="View options">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <rect x="4" y="4" width="16" height="16" />
              <path d="M4 10h16M4 15h16M10 4v16M15 4v16" />
            </svg>
          </button>
          {menu === 'view' && <ViewMenu prefs={prefs} setPrefs={setPrefs} close={() => setMenu(null)} />}
        </div>
        <button className={`fm-tool ${prefs.sidebar ? '' : 'is-off'}`} onClick={() => setPrefs({ sidebar: !prefs.sidebar })} title="Toggle sidebar" aria-label="Toggle sidebar">
          ↔
        </button>
        <button
          className="fm-tool"
          title="Menu"
          aria-label="Menu"
          onClick={(e) =>
            openContextMenu({ clientX: e.currentTarget.getBoundingClientRect().right - 220, clientY: e.currentTarget.getBoundingClientRect().bottom + 4, preventDefault() {}, stopPropagation() {} }, [
              { label: 'New window', onSelect: () => wm.openNew('files', { path }) },
              { label: 'New text file', disabled: !writable, onSelect: newFile },
              { label: 'Open terminal here', disabled: path.includes('://'), onSelect: () => wm.openNew('terminal', { run: `cd ${prettyPath(path)} && ls`, t: String(Date.now()) }) },
              { separator: true },
              { label: 'Copy location', disabled: path.includes('://'), onSelect: () => copyPath(path) },
              { label: 'Add to bookmarks', disabled: path.includes('://') || prefs.bookmarks.includes(path), onSelect: () => bookmark(path) },
              { separator: true },
              { label: 'Keyboard shortcuts', onSelect: () => setToast('Ctrl+1-4 views · Ctrl+H hidden · Ctrl+L path · Ctrl+F search · Alt+arrows navigate · Alt+Enter properties') },
            ])
          }
        >
          ≡
        </button>
      </div>

      <div className="fm-body">
        {prefs.sidebar && (
          <nav className="fm-side">
            <p className="fm-side-head">Places</p>
            {place('Home', HOME, '⌂')}
            {place('Recent', RECENT, '↺')}
            {place('Documents', `${HOME}/Documents`, '▤')}
            {place('Downloads', `${HOME}/Downloads`, '⤓')}
            {place('Music', `${HOME}/Music`, '♪')}
            {place('Pictures', `${HOME}/Pictures`, '▣')}
            {place('Videos', `${HOME}/Videos`, '▶')}
            {place('Filesystem', '/', '▭')}
            <p className="fm-side-head">Bookmarks</p>
            {prefs.bookmarks
              .filter((b) => lookup(b))
              .map((b) =>
                place(
                  b.split('/').pop()!.replace(/^./, (ch) => ch.toUpperCase()),
                  b,
                  '⚲',
                  <span
                    className="fm-side-x"
                    role="button"
                    aria-label="Remove bookmark"
                    onClick={(e) => {
                      e.stopPropagation()
                      setPrefs({ bookmarks: prefs.bookmarks.filter((x) => x !== b) })
                    }}
                  >
                    ×
                  </span>,
                ),
              )}
            <p className="fm-side-head">Drives</p>
            {place('nvme0n1 (read-only)', '/', '⛁')}
            {place('tmpfs', '/tmp', '⛁')}
            <p className="fm-side-head">Network</p>
            {place('git.mvl.sh', 'https://git.mvl.sh/vleeuwenmenno', '⇄')}
            {place('github.com', 'https://github.com/vleeuwenmenno', '⇄')}
            <div className="fm-side-gap" />
            {place('Trash', TRASH, '🗑', <span className="fm-side-count">{trashCount}</span>)}
          </nav>
        )}

        <div
          className={`fm-main fm-view-${prefs.view}`}
          ref={main}
          tabIndex={0}
          onPointerDown={onMainPointerDown}
          onContextMenu={(e) => {
            if ((e.target as HTMLElement).closest('.fm-item')) return
            setSelected(new Set())
            openContextMenu(e, backgroundMenu())
          }}
          style={{ ['--tile' as string]: `${tileWidth}px`, ['--icon' as string]: `${iconSize}px` }}
        >
          {prefs.view === 'list' && (
            <div className="fm-list-head">
              {(
                [
                  ['Name', 'az', 'za'],
                  ['Size', 'largest', 'smallest'],
                  ['Modified', 'newest', 'oldest'],
                  ['Type', 'type', 'type'],
                ] as [string, Sort, Sort][]
              ).map(([label, a, b]) => (
                <button key={label} onClick={() => setPrefs({ sort: prefs.sort === a ? b : a })} className={prefs.sort === a || prefs.sort === b ? 'is-sorted' : ''}>
                  {label}
                  {prefs.sort === a ? ' ↓' : prefs.sort === b && a !== b ? ' ↑' : ''}
                </button>
              ))}
            </div>
          )}
          {items.map((item) => (
            <div
              key={item.path}
              ref={(el) => {
                if (el) tiles.current.set(item.path, el)
                else tiles.current.delete(item.path)
              }}
              className={`fm-item ${selected.has(item.path) ? 'is-selected' : ''} ${item.name.startsWith('.') ? 'is-hidden' : ''}`}
              onClick={(e) => clickItem(e, item)}
              onDoubleClick={() => openItem(item)}
              onContextMenu={(e) => {
                if (!selected.has(item.path)) setSelected(new Set([item.path]))
                openContextMenu(e, itemMenu(item))
              }}
              title={search !== null ? prettyPath(item.path) : item.name}
            >
              <span className="fm-icon">
                <Thumb item={item} size={iconSize} gallery={prefs.view === 'gallery'} />
              </span>
              <span className="fm-name">{prefs.view === 'grid' || prefs.view === 'gallery' ? middleEllipsis(item.name, captionChars) : item.name}</span>
              {prefs.view === 'list' && (
                <>
                  <span className="fm-col">{item.kind === 'folder' ? `${item.size} items` : formatSize(item.size)}</span>
                  <span className="fm-col">{new Date(item.mtime).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                  <span className="fm-col">{KIND_LABEL[item.kind]}</span>
                </>
              )}
              {search !== null && prefs.view !== 'list' && <span className="fm-where">{prettyPath(item.path.split('/').slice(0, -1).join('/') || '/')}</span>}
            </div>
          ))}
          {!items.length && <p className="fm-empty">{search ? `Nothing matching “${search}” below ${prettyPath(path)}` : path === RECENT ? 'Files you open show up here.' : 'This folder is empty.'}</p>}
          {marquee && <div className="fm-marquee" style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }} />}
        </div>
      </div>

      <footer className="fm-status">
        <span>
          {items.length} item{items.length === 1 ? '' : 's'}
          {selected.size > 0 && ` · ${selected.size} selected${selectedSize ? ` (${formatSize(selectedSize)})` : ''}`}
          {writable && ' · writable'}
        </span>
        <span>View size {prefs.zoom}%</span>
      </footer>

      {toast && <div className="fm-toast">{toast}</div>}
      {props && <Properties item={props} close={() => setProps(null)} />}
    </div>
  )
}

const SORTS: [Sort, string][] = [
  ['az', 'A to Z'],
  ['za', 'Z to A'],
  ['newest', 'Last modified'],
  ['oldest', 'First modified'],
  ['largest', 'Largest first'],
  ['smallest', 'Smallest first'],
  ['type', 'Type'],
]

function ViewMenu({ prefs, setPrefs, close }: { prefs: Prefs; setPrefs: (p: Partial<Prefs>) => void; close: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onDown = (e: PointerEvent) => !ref.current?.parentElement?.contains(e.target as Element) && close()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [close])
  const views: [View, string, string, string][] = [
    ['list', 'List', 'Ctrl+1', '☰'],
    ['grid', 'Grid', 'Ctrl+2', '▦'],
    ['compact', 'Compact', 'Ctrl+3', '▥'],
    ['gallery', 'Gallery', 'Ctrl+4', '▣'],
  ]
  return (
    <div className="fm-dropdown" ref={ref}>
      {views.map(([v, label, key, icon]) => (
        <button key={v} className="fm-dd-row" onClick={() => setPrefs({ view: v })}>
          <span className="fm-dd-check">{prefs.view === v ? '✓' : icon}</span>
          <span className="fm-dd-label">{label}</span>
          <span className="fm-dd-key">{key}</span>
        </button>
      ))}
      <div className="fm-dd-sep" />
      <div className="fm-dd-row fm-dd-zoom">
        <span className="fm-dd-check">⌕</span>
        <span className="fm-dd-label">Zoom</span>
        <button onClick={() => setPrefs({ zoom: Math.max(50, prefs.zoom - 10) })} aria-label="Zoom out">
          −
        </button>
        <span className="fm-dd-key">{prefs.zoom}%</span>
        <button onClick={() => setPrefs({ zoom: Math.min(200, prefs.zoom + 10) })} aria-label="Zoom in">
          +
        </button>
      </div>
      <div className="fm-dd-sep" />
      <p className="fm-dd-head">Sort by</p>
      {SORTS.map(([k, label]) => (
        <button key={k} className="fm-dd-row" onClick={() => setPrefs({ sort: k })}>
          <span className="fm-dd-check">{prefs.sort === k ? '✓' : ''}</span>
          <span className="fm-dd-label">{label}</span>
        </button>
      ))}
      <div className="fm-dd-sep" />
      <button className="fm-dd-row" onClick={() => setPrefs({ hidden: !prefs.hidden })}>
        <span className="fm-dd-check">{prefs.hidden ? '✓' : '◌'}</span>
        <span className="fm-dd-label">Show hidden files</span>
        <span className="fm-dd-key">Ctrl+H</span>
      </button>
    </div>
  )
}

function Properties({ item, close }: { item: Item; close: () => void }) {
  const isTmp = item.path.startsWith('/tmp/')
  const rows: [string, string][] = [
    ['Name', item.name],
    ['Location', item.trash ? 'Trash' : prettyPath(item.path.split('/').slice(0, -1).join('/') || '/')],
    ['Type', KIND_LABEL[item.kind]],
    ['Size', item.kind === 'folder' ? `${item.size} items` : `${formatSize(item.size)} (${item.size.toLocaleString('en-GB')} bytes)`],
    ['Modified', new Date(item.mtime).toLocaleString('en-GB')],
    ['Owner', 'menno (1000)'],
    ['Permissions', item.kind === 'folder' ? (isTmp ? 'drwxrwxrwt' : 'dr-xr-xr-x') : isTmp ? '-rw-rw-rw-' : '-r--r--r--'],
  ]
  return (
    <div className="fm-modal" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="fm-dialog" role="dialog" aria-label={`${item.name} properties`} onKeyDown={(e) => e.key === 'Escape' && close()}>
        <header>
          <span className="fm-dialog-icon">{item.kind === 'folder' ? <FolderIcon size={40} /> : <FileIcon size={40} kind={item.kind} name={item.name} />}</span>
          <strong>{item.name}</strong>
        </header>
        <dl>
          {rows.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        <div className="fm-dialog-actions">
          <button className="btn btn-primary" autoFocus onClick={close}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

