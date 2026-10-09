import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { restoreIcons, useDesktop } from '../os/desktopStore'
import { DESKTOP_ICONS } from '../os/Desktop'
import { openContextMenu, type MenuItem } from '../os/ContextMenu'
import { openLink } from '../data/links'
import { useWM, type AppId, type WinState } from '../os/wm'
import { formatSize, HOME, KIND_LABEL, kindOfName, lookup, prettyPath, resolvePath, stat, walk, type FileKind, type Node } from '../terminal/vfs'
import { createFile, deleteItems, download as sfDownload, DRAG_FILES, dropOp, getClipboard, getDragged, getLibrary, isInside, openSeafile, renameItem, setClipboard, setDragged, transferItems, useClipboard, isSf, libraryName, lock, mkdir, parseSf, refreshDirs, SF, sfPath, unlock, useDir, useLibraries, useSeafileHome, useSeafilePrefs, setSeafilePrefs, useUnlocks, type Library } from '../data/seafile'
import { SeafileTrash } from './SeafileTrash'
import { ask } from '../os/Dialogs'
import { useAccount } from '../os/account'
import { MEDIA_APP, thumbOf } from '../data/media'
import { droppedFiles, hasOsFiles, pickAndUpload, uploadFiles } from '../data/uploads'
import { addBookmark, useSidebar } from '../data/filesSidebar'
import { FilesSidebar, type SideSection } from './FilesSidebar'

// A file manager in the style of Omafile (the Omarchy file manager Menno contributes to), browsing
// the same in-memory filesystem the terminal uses (only /tmp is writable there) and, for the
// signed-in owner, Seafile: every library under Libraries, and the primary one as home when that
// is switched on in Settings (seafile://<library>/<path>, see src/data/seafile.ts).

type View = 'list' | 'grid' | 'compact' | 'gallery'
type Sort = 'az' | 'za' | 'newest' | 'oldest' | 'largest' | 'smallest' | 'type'
type Prefs = { view: View; zoom: number; sort: Sort; hidden: boolean; sidebar: boolean }

const PREFS_KEY = 'mvlos.files.v1'
const DEFAULT_PREFS: Prefs = { view: 'grid', zoom: 100, sort: 'az', hidden: false, sidebar: true }
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
const recent: Item[] = []
const remember = (item: Item) => {
  const i = recent.findIndex((r) => r.path === item.path)
  if (i >= 0) recent.splice(i, 1)
  recent.unshift(item)
  recent.length = Math.min(recent.length, 30)
}

const JOKE_TRASH = ['kubernetes-for-my-blog.yaml', 'salt-states-v1/', 'electron-spotify-config.json', 'TODO-final-FINAL-v3.md', 'works-on-my-machine.iso']

type Item = {
  path: string
  name: string
  node: Node | null
  kind: FileKind
  size: number
  mtime: number
  trash?: 'desktop' | 'joke'
  desktopId?: string
  /** A file or folder in Seafile (node is null), or a library at the top of Seafile */
  sf?: { repo: string; p: string; library?: Library }
}

const PLACE_FOLDERS = ['Desktop', 'Documents', 'Downloads', 'Music', 'Pictures', 'Videos'] as const

/** The folder above, for Seafile paths too (a library's parent is the list of libraries). */
function parentOf(path: string): string {
  const at = parseSf(path)
  if (at) return path === SF ? SF : at.p === '/' ? SF : sfPath(at.repo, at.p.split('/').slice(0, -1).join('/') || '/')
  return path.split('/').slice(0, -1).join('/') || '/'
}

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
  lock: <path d="M27 28h10v8H27zM29 28v-3a3 3 0 0 1 6 0v3" />,
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

const KIND_COLOR: Partial<Record<FileKind, string>> = { markdown: 'var(--blue)', text: 'var(--muted)', link: 'var(--cyan)', game: 'var(--green)', audio: 'var(--magenta)', video: 'var(--red)', disc: 'var(--orange)', archive: 'var(--yellow)', package: 'var(--green)', pdf: 'var(--red)', document: 'var(--blue)' }

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

function Thumb({ item, size, gallery = false, emblem }: { item: Item; size: number; gallery?: boolean; emblem?: string }) {
  const [broken, setBroken] = useState(false)
  // Seafile's pictures come as its thumbnails (not for encrypted libraries: those fall back to the icon).
  const src = useMemo(
    () => (item.kind !== 'image' ? null : item.sf ? (size >= 40 ? thumbOf(item.path, gallery ? 512 : 256) : null) : item.node?.type === 'file' ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(item.node.content())}` : null),
    [item, size >= 40, gallery],
  )
  // An explicit box: SVGs with only a viewBox have no dependable intrinsic size.
  if (src && !broken)
    return <img className={`fm-thumb ${item.sf ? 'is-photo' : ''}`} src={src} alt="" loading="lazy" onError={() => setBroken(true)} style={gallery ? undefined : { width: Math.round(size * 1.35), height: size }} draggable={false} />
  if (item.kind === 'folder') return <FolderIcon size={size} emblem={emblem ?? SPECIAL_EMBLEMS[item.path]} />
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
  const account = useAccount()
  const { libraries } = useLibraries()
  const { home: sfHome, library: homeLibrary } = useSeafileHome()
  const home = sfHome ?? HOME
  const unlocks = useUnlocks()
  // With Seafile linked, the Trash is Seafile's (unless switched off in Settings).
  const sfPrefs = useSeafilePrefs()
  const sfTrash = !!account.seafile && sfPrefs.trash
  const [prefs, setPrefsState] = useState<Prefs>(loadPrefs)
  const { bookmarks } = useSidebar()
  const [path, setPath] = useState(win.props.path ?? home)
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
  const [renaming, setRenaming] = useState<string | null>(null)
  /** The folder a drag would land in right now, highlighted */
  const [dropOn, setDropOn] = useState<string | null>(null)
  const clip = useClipboard()
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
  // Seafile as home is known once the libraries are in: a window that opened at home goes there.
  const opened = useRef(!!win.props.path)
  useEffect(() => {
    if (sfHome && !opened.current && path === HOME) setPath(sfHome)
    if (sfHome) opened.current = true
  }, [sfHome])
  // An unlocked library locks again on time: list it again then, which asks for the password.
  useEffect(() => {
    const next = Math.min(...Object.values(unlocks).filter((u) => u > Date.now()))
    if (!isFinite(next)) return
    const t = setTimeout(() => Object.keys(unlocks).forEach((repo) => unlocks[repo] <= Date.now() + 500 && refreshDirs(sfPath(repo))), next - Date.now() + 200)
    return () => clearTimeout(t)
  }, [unlocks])
  const sfDir = useDir(isSf(path) && path !== SF ? path : null)

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
    const at = parseSf(path)
    if (path === SF)
      list = (libraries ?? []).map((l) => ({ path: sfPath(l.id), name: l.name, node: null, kind: 'folder' as FileKind, size: 0, mtime: l.mtime, sf: { repo: l.id, p: '/', library: l } }))
    else if (at) {
      list = (sfDir.listing?.entries ?? []).map((e) => {
        const p = `${at.p === '/' ? '' : at.p}/${e.name}`
        return { path: sfPath(at.repo, p), name: e.name, node: null, kind: kindOfName(e.name, e.dir), size: e.size, mtime: e.mtime, sf: { repo: at.repo, p } }
      })
      if (search) list = list.filter((i) => i.name.toLowerCase().includes(search.toLowerCase()))
    } else if (path === RECENT) list = recent.map((r) => (r.sf ? r : toItem(r.path))).filter((x): x is Item => !!x)
    else if (path === TRASH && sfTrash) list = []
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
  }, [path, search, prefs.hidden, prefs.sort, tick, desk.trashed, desk.names, libraries, sfDir.listing])

  const writable = path === '/tmp' || path.startsWith('/tmp/')
  const sfWritable = isSf(path) && path !== SF && sfDir.listing?.perm === 'rw'
  /** ~/Documents, Seafile › Photos/2024 or /etc: how a path reads in the path bar and dialogs. */
  const pretty = (p: string) => {
    if (sfHome && (p === sfHome || p.startsWith(sfHome + '/'))) return '~' + p.slice(sfHome.length)
    const at = parseSf(p)
    if (at) return p === SF ? 'Seafile' : `${libraryName(at.repo)}${at.p === '/' ? '' : at.p}`
    return prettyPath(p)
  }

  // --- actions ----------------------------------------------------------------------------------

  const openItem = (item: Item, how: 'default' | 'viewer' | 'zed' | 'terminal' | 'preview' | 'player' | 'pdf' | 'office' | 'archive' = 'default') => {
    if (item.trash) {
      setToast(item.trash === 'desktop' ? 'Put it back first (right-click → Put back).' : 'That file is a cautionary tale. It stays in the trash.')
      return
    }
    if (item.sf) return openSeafileItem(item, how)
    const node = item.node
    if (!node) return
    if (node.type === 'dir') {
      if (how === 'terminal') wm.openNew('terminal', { run: `cd ${prettyPath(item.path)} && ls`, t: String(Date.now()) })
      else navigate(item.path)
      return
    }
    remember(item)
    if (how === 'terminal') return wm.openNew('terminal', { run: `cat ${prettyPath(item.path)}`, t: String(Date.now()) })
    if (how === 'viewer') return wm.openNew('viewer', { path: item.path })
    if (how === 'preview' || how === 'player' || how === 'pdf' || how === 'archive') return wm.openNew(how, { path: item.path })
    if (how === 'zed') return wm.open('zed', { path: item.path, view: 'preview', t: String(Date.now()) })
    if (node.open?.url) return void openLink(node.open.url)
    if (node.open?.app) return wm.open(node.open.app as AppId, { ...node.open.props, t: String(Date.now()) })
    if (item.kind === 'markdown') return openItem(item, 'zed')
    wm.openNew(MEDIA_APP[item.kind] ?? 'viewer', { path: item.path })
  }

  /** Seafile: folders open here, files as everywhere else (see openSeafile). */
  function openSeafileItem(item: Item, how: 'default' | 'viewer' | 'zed' | 'terminal' | 'preview' | 'player' | 'pdf' | 'office' | 'archive') {
    if (item.kind === 'folder') return navigate(item.path)
    remember(item)
    openSeafile(wm, item.path, { how: how === 'terminal' ? 'default' : how }).catch((e: Error) => setToast(e.message))
  }

  const download = (item: Item) => sfDownload(item.path).catch((e: Error) => setToast(e.message))

  // --- changing things in Seafile ------------------------------------------------------------

  /** Whether the account may change things in that Seafile folder (its library's permission). */
  const canWrite = (folder: string) => isSf(folder) && folder !== SF && getLibrary(parseSf(folder)!.repo)?.permission === 'rw'
  const named = (paths: string[]) => (paths.length === 1 ? (paths[0].split('/').pop() ?? '') : `${paths.length} items`)
  /** Runs a change, saying what it is doing and then what it did. */
  const busy = (doing: string, done: string, work: Promise<unknown>) => {
    setToast(doing)
    return work.then(() => setToast(done)).catch((e: Error) => setToast(e.message))
  }
  /** Seafile files and folders among these (not libraries themselves). */
  const sfOnly = (list: Item[]) => list.filter((i) => i.sf && !i.sf.library).map((i) => i.path)

  const newFolder = () => {
    if (!sfWritable) return
    const taken = new Set(items.map((i) => i.name))
    let name = 'New folder'
    for (let n = 2; taken.has(name); n++) name = `New folder ${n}`
    mkdir(`${path}/${name}`)
      .then((made) => {
        setSelected(new Set([made]))
        setRenaming(made)
      })
      .catch((e: Error) => setToast(e.message))
  }

  const newTextFile = () => {
    if (!sfWritable) return
    createFile(`${path}/untitled.txt`)
      .then((made) => {
        setSelected(new Set([made]))
        setRenaming(made)
      })
      .catch((e: Error) => setToast(e.message))
  }

  const commitRename = (item: Item, value: string) => {
    setRenaming(null)
    const name = value.trim()
    if (!name || name === item.name) return
    if (name.includes('/')) return setToast('A name cannot have a / in it')
    renameItem(item.path, name, item.kind === 'folder')
      .then((made) => setSelected(new Set([made])))
      .catch((e: Error) => setToast(e.message))
  }

  const deleteSf = async (paths: string[]) => {
    if (!paths.length) return
    const one = paths.length === 1
    if (!(await ask({ title: `Delete ${named(paths)}?`, body: `${one ? 'It goes' : 'They go'} to the library's trash on Seafile, where you can restore ${one ? 'it' : 'them'} (Files → Trash).`, confirm: 'Delete', danger: true }))) return
    setSelected(new Set())
    busy(`Deleting ${named(paths)}…`, `Deleted ${named(paths)}`, deleteItems(paths))
  }

  const cut = (paths: string[]) => paths.length && (setClipboard({ op: 'move', paths }), setToast(`Cut ${named(paths)}: paste it somewhere with Ctrl+V`))
  const copy = (paths: string[]) => paths.length && (setClipboard({ op: 'copy', paths }), setToast(`Copied ${named(paths)}`))
  const paste = (into = path) => {
    const c = getClipboard()
    if (!c || !canWrite(into)) return
    if (isInside(c.paths, into)) return setToast('A folder cannot go inside itself')
    busy(`${c.op === 'move' ? 'Moving' : 'Copying'} ${named(c.paths)}…`, `${c.op === 'move' ? 'Moved' : 'Copied'} ${named(c.paths)}`, transferItems(c.op, c.paths, into)).then(() => c.op === 'move' && setClipboard(null))
  }

  // Dragging: files and folders go onto folders, a folder's empty space, the sidebar, other
  // Files windows and the desktop. Within a library they move, into another one they copy.
  const dragStart = (e: React.DragEvent, item: Item) => {
    const list = selected.has(item.path) ? selectedItems() : [item]
    const paths = sfOnly(list)
    if (!paths.length || renaming) return e.preventDefault()
    if (!selected.has(item.path)) setSelected(new Set([item.path]))
    e.dataTransfer.setData(DRAG_FILES, JSON.stringify(paths))
    e.dataTransfer.setData('text/plain', paths.map(pretty).join('\n'))
    e.dataTransfer.effectAllowed = 'copyMove'
    setDragged(paths)
  }
  const dragEnd = () => {
    setDragged(null)
    setDropOn(null)
  }
  /** Whether a drag can land in `into`; says so to the browser (and highlights it) when it can. */
  const acceptDrop = (e: React.DragEvent, into: string) => {
    // Files from the computer upload into any Seafile folder you can write to.
    if (!getDragged() && hasOsFiles(e.dataTransfer)) {
      if (!canWrite(into)) return false
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'copy'
      if (dropOn !== into) setDropOn(into)
      return true
    }
    const paths = getDragged()
    if (!paths || !e.dataTransfer.types.includes(DRAG_FILES) || !canWrite(into) || isInside(paths, into)) return false
    const op = dropOp(paths, into, e)
    if (op === 'move' && paths.every((p) => parentOf(p) === into)) return false
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = op
    if (dropOn !== into) setDropOn(into)
    return true
  }
  const dropInto = (e: React.DragEvent, into: string) => {
    if (!getDragged() && hasOsFiles(e.dataTransfer)) {
      if (!acceptDrop(e, into)) return
      setDropOn(null)
      droppedFiles(e.dataTransfer)
        .then((picked) => uploadFiles(picked, into))
        .catch((err: Error) => setToast(err.message))
      return
    }
    const paths = getDragged()
    if (!paths || !acceptDrop(e, into)) return
    const op = dropOp(paths, into, e)
    dragEnd()
    busy(`${op === 'move' ? 'Moving' : 'Copying'} ${named(paths)}…`, `${op === 'move' ? 'Moved' : 'Copied'} ${named(paths)} to ${pretty(into)}`, transferItems(op, paths, into))
  }

  const readOnly = () => setToast(isSf(path) ? `${libraryName(parseSf(path)!.repo)} is read-only for you` : 'Read-only file system. Only /tmp is writable here.')

  const trashItems = (list: Item[]) => {
    if (!list.length) return
    if (list.some((i) => i.sf)) return deleteSf(sfOnly(list))
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

  const bookmark = (p: string) => addBookmark(p)
  const copyPath = (p: string) => navigator.clipboard?.writeText(pretty(p)).then(() => setToast(`Copied ${pretty(p)}`)).catch(() => {})

  const selectedItems = () => items.filter((i) => selected.has(i.path))

  function itemMenu(item: Item): MenuItem[] {
    const many = selected.has(item.path) && selected.size > 1
    if (item.trash === 'desktop')
      return [{ label: 'Put back on desktop', onSelect: () => restoreIcons([item.desktopId!]) }, { label: 'Properties', onSelect: () => setProps(item) }]
    if (item.trash === 'joke') return [{ label: 'Restore', disabled: true }, { label: 'Properties', onSelect: () => setProps(item) }]
    if (many) {
      const sel = selectedItems()
      const sfPaths = sfOnly(sel)
      if (sfPaths.length)
        return [
          { label: `Open ${sel.length} items`, onSelect: () => sel.forEach((i) => openItem(i)) },
          { separator: true },
          { label: `Cut ${sfPaths.length} items`, shortcut: 'Ctrl X', onSelect: () => cut(sfPaths) },
          { label: `Copy ${sfPaths.length} items`, shortcut: 'Ctrl C', onSelect: () => copy(sfPaths) },
          { separator: true },
          { label: `Delete ${sfPaths.length} items`, shortcut: 'Del', danger: true, disabled: !sfWritable, onSelect: () => void deleteSf(sfPaths) },
        ]
      return [
        { label: `Open ${sel.length} items`, onSelect: () => sel.forEach((i) => openItem(i)) },
        { separator: true },
        { label: `Move ${sel.length} items to Trash`, shortcut: 'Del', danger: true, onSelect: () => trashItems(sel) },
      ]
    }
    const isDir = item.kind === 'folder'
    if (item.sf) {
      const library = item.sf.library
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
                  ...(item.kind === 'image' ? [{ label: 'Preview', onSelect: () => openItem(item, 'preview') }] : []),
                  ...(item.kind === 'video' || item.kind === 'audio' ? [{ label: 'Player', onSelect: () => openItem(item, 'player') }] : []),
                  ...(item.kind === 'pdf' ? [{ label: 'PDF', onSelect: () => openItem(item, 'pdf') }] : []),
                  ...(/\.zip$/i.test(item.name) ? [{ label: 'Archive', onSelect: () => openItem(item, 'archive') }] : []),
                  ...((item.kind === 'document' || /\.(csv|txt|rtf)$/i.test(item.name)) && account.seafile?.office ? [{ label: 'Office (OnlyOffice)', onSelect: () => openItem(item, 'office') }] : []),
                ],
              },
              { label: 'Download', onSelect: () => download(item) },
            ]),
        ...(library?.encrypted && unlocks[library.id] > Date.now() ? [{ label: 'Lock now', onSelect: () => void lock(library.id).catch((e: Error) => setToast(e.message)) }] : []),
        { separator: true },
        ...(library
          ? []
          : [
              { label: 'Cut', shortcut: 'Ctrl X', onSelect: () => cut([item.path]) },
              { label: 'Copy', shortcut: 'Ctrl C', onSelect: () => copy([item.path]) },
            ]),
        ...(isDir && clip ? [{ label: `Paste into ${item.name}`, disabled: !canWrite(item.path), onSelect: () => paste(item.path) }] : []),
        ...(isDir && account.seafile?.office && canWrite(item.path) ? [{ label: 'New documents go here', checked: sfPrefs.officeFolder === item.path, onSelect: () => setSeafilePrefs({ officeFolder: item.path }) }] : []),
        ...(library ? [] : [{ label: 'Rename', shortcut: 'F2', disabled: !canWrite(parentOf(item.path)), onSelect: () => setRenaming(item.path) }]),
        { separator: true },
        { label: 'Copy path', onSelect: () => copyPath(item.path) },
        ...(isDir ? [{ label: 'Add to bookmarks', disabled: bookmarks.includes(item.path), onSelect: () => bookmark(item.path) }] : []),
        { label: 'Properties', shortcut: 'Alt ↵', onSelect: () => setProps(item) },
        ...(library ? [] : [{ separator: true } as MenuItem, { label: 'Delete', shortcut: 'Del', danger: true, disabled: !canWrite(parentOf(item.path)), onSelect: () => void deleteSf([item.path]) }]),
      ]
    }
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
                ...(item.kind === 'image' ? [{ label: 'Preview', onSelect: () => openItem(item, 'preview') }] : []),
                ...(item.kind === 'video' || item.kind === 'audio' ? [{ label: 'Player', onSelect: () => openItem(item, 'player') }] : []),
                { label: 'Terminal (cat)', onSelect: () => openItem(item, 'terminal') },
              ],
            },
          ]),
      { label: 'Open in terminal', onSelect: () => openItem(item, 'terminal') },
      { separator: true },
      { label: 'Copy path', onSelect: () => copyPath(item.path) },
      ...(isDir ? [{ label: 'Add to bookmarks', disabled: bookmarks.includes(item.path), onSelect: () => bookmark(item.path) }] : []),
      { label: 'Properties', shortcut: 'Alt ↵', onSelect: () => setProps(item) },
      { separator: true },
      { label: 'Move to Trash', shortcut: 'Del', danger: true, onSelect: () => trashItems([item]) },
    ]
  }

  function backgroundMenu(): MenuItem[] {
    const special = path === RECENT || path === TRASH
    if (isSf(path))
      return [
        { label: 'New folder', disabled: !sfWritable, onSelect: newFolder },
        { label: 'New text file', disabled: !sfWritable, onSelect: newTextFile },
        { label: 'Upload files…', disabled: !sfWritable, onSelect: () => pickAndUpload(path) },
        { label: 'Upload folder…', disabled: !sfWritable, onSelect: () => pickAndUpload(path, true) },
        { label: clip ? `Paste ${named(clip.paths)}` : 'Paste', shortcut: 'Ctrl V', disabled: !clip || !sfWritable, onSelect: () => paste() },
        { label: 'Refresh', shortcut: 'F5', onSelect: () => refreshDirs(path) },
        { label: 'Add to bookmarks', disabled: path === SF || bookmarks.includes(path), onSelect: () => bookmark(path) },
        { separator: true },
        { label: 'Select all', shortcut: 'Ctrl A', onSelect: () => setSelected(new Set(items.map((i) => i.path))) },
        { label: 'Show hidden files', checked: prefs.hidden, shortcut: 'Ctrl H', onSelect: () => setPrefs({ hidden: !prefs.hidden }) },
        { label: 'View', submenu: (['list', 'grid', 'compact', 'gallery'] as View[]).map((v) => ({ label: v[0].toUpperCase() + v.slice(1), checked: prefs.view === v, onSelect: () => setPrefs({ view: v }) })) },
        { label: 'Sort by', submenu: SORTS.map(([k, label]) => ({ label, checked: prefs.sort === k, onSelect: () => setPrefs({ sort: k }) })) },
      ]
    return [
      { label: 'New text file', disabled: !writable, onSelect: newFile },
      { label: 'Open terminal here', disabled: special, onSelect: () => wm.openNew('terminal', { run: `cd ${prettyPath(path)} && ls`, t: String(Date.now()) }) },
      { label: 'Add to bookmarks', disabled: special || bookmarks.includes(path), onSelect: () => bookmark(path) },
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
    if (ctrl && isSf(path) && e.key.toLowerCase() === 'c' && sfOnly(sel).length) copy(sfOnly(sel))
    else if (ctrl && isSf(path) && e.key.toLowerCase() === 'x' && sfOnly(sel).length) cut(sfOnly(sel))
    else if (ctrl && isSf(path) && e.key.toLowerCase() === 'v') paste()
    else if (e.key === 'F2' && sel.length === 1 && sfOnly(sel).length && sfWritable) setRenaming(sel[0].path)
    else if (ctrl && ['1', '2', '3', '4'].includes(e.key)) setPrefs({ view: (['list', 'grid', 'compact', 'gallery'] as View[])[Number(e.key) - 1] })
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
    else if (e.key === 'F5' && isSf(path)) refreshDirs(path)
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
  const atTop = path === '/' || path === RECENT || path === TRASH || path === SF
  const goUp = () => {
    if (!atTop) navigate(parentOf(path))
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
  const trashCount = sfTrash ? null : desk.trashed.length + JOKE_TRASH.length

  const crumbs = useMemo(() => {
    if (path === RECENT) return [{ label: 'Recent', path: RECENT }]
    if (path === TRASH) return [{ label: 'Trash', path: TRASH }]
    const at = parseSf(path)
    if (at) {
      const inSfHome = !!sfHome && (path === sfHome || path.startsWith(sfHome + '/'))
      const out = inSfHome ? [{ label: '~', path: sfHome! }] : [{ label: 'Seafile', path: SF }, ...(path === SF ? [] : [{ label: libraryName(at.repo), path: sfPath(at.repo) }])]
      let acc = ''
      for (const part of at.p.split('/').filter(Boolean)) {
        acc += '/' + part
        out.push({ label: part, path: sfPath(at.repo, acc) })
      }
      return out
    }
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
  }, [path, sfHome, libraries])

  /** Emblems on Seafile's home folders, and on libraries (home, or a padlock). */
  const emblemOf = (item: Item): string | undefined => {
    if (!item.sf) return undefined
    if (item.sf.library) return item.sf.library.encrypted ? 'lock' : sfHome === item.path ? 'home' : undefined
    if (sfHome && item.path === sfHome) return 'home'
    const f = PLACE_FOLDERS.find((name) => item.path === `${sfHome}/${name}`)
    return f ? f.toLowerCase() : undefined
  }

  const openPlace = (target: string) => (target.startsWith('http') ? openLink(target) : navigate(target))

  // The sidebar's sections; FilesSidebar puts them (and their items) in your order and hides what you hid.
  const sections: SideSection[] = [
    {
      id: 'places',
      label: 'Places',
      items: [
        { id: 'home', label: 'Home', target: home, icon: '⌂' },
        { id: 'recent', label: 'Recent', target: RECENT, icon: '↺' },
        { id: 'desktop', label: 'Desktop', target: `${home}/Desktop`, icon: '▭' },
        { id: 'documents', label: 'Documents', target: `${home}/Documents`, icon: '▤' },
        { id: 'downloads', label: 'Downloads', target: `${home}/Downloads`, icon: '⤓' },
        { id: 'music', label: 'Music', target: `${home}/Music`, icon: '♪' },
        { id: 'pictures', label: 'Pictures', target: `${home}/Pictures`, icon: '▣' },
        { id: 'videos', label: 'Videos', target: `${home}/Videos`, icon: '▶' },
        ...(sfHome ? [{ id: 'site', label: 'Site home', target: HOME, icon: '⌂', title: 'The site’s own home folder' }] : []),
        { id: 'filesystem', label: 'Filesystem', target: '/', icon: '▭' },
      ],
    },
    ...(account.seafile
      ? [
          {
            id: 'seafile',
            label: 'Seafile',
            items: [
              { id: 'all', label: 'All libraries', target: SF, icon: '☁' },
              ...(libraries ?? []).map((l) => ({
                id: l.id,
                label: l.name,
                target: sfPath(l.id),
                icon: l.encrypted ? (unlocks[l.id] > Date.now() ? '🔓' : '🔒') : l.id === homeLibrary?.id && sfHome ? '⌂' : '▤',
                title: `${l.name}${l.type !== 'mine' && l.owner ? `, from ${l.owner}` : ''}${l.permission === 'r' ? ' (read-only)' : ''}`,
              })),
            ],
          },
        ]
      : []),
    {
      id: 'bookmarks',
      label: 'Bookmarks',
      items: bookmarks
        .filter((b) => (isSf(b) ? !!account.seafile : lookup(b)))
        .map((b) => ({ id: b, label: isSf(b) && parseSf(b)!.p === '/' ? libraryName(parseSf(b)!.repo) : b.split('/').pop()!.replace(/^./, (ch) => ch.toUpperCase()), target: b, icon: '⚲', bookmark: true, title: pretty(b) })),
    },
    {
      id: 'drives',
      label: 'Drives',
      items: [
        { id: 'nvme0n1', label: 'nvme0n1 (read-only)', target: '/', icon: '⛁' },
        { id: 'tmpfs', label: 'tmpfs', target: '/tmp', icon: '⛁' },
      ],
    },
    {
      id: 'network',
      label: 'Network',
      items: [
        { id: 'git.mvl.sh', label: 'git.mvl.sh', target: 'https://git.mvl.sh/vleeuwenmenno', icon: '⇄' },
        { id: 'github.com', label: 'github.com', target: 'https://github.com/vleeuwenmenno', icon: '⇄' },
      ],
    },
  ]

  return (
    <div className="fm" onKeyDown={onKeyDown}>
      <div className="fm-toolbar">
        <button className="fm-tool" onClick={goBack} disabled={!back.length} title="Back (Alt+←)" aria-label="Back">
          ←
        </button>
        <button className="fm-tool" onClick={goForward} disabled={!fwd.length} title="Forward (Alt+→)" aria-label="Forward">
          →
        </button>
        <button className="fm-tool" onClick={goUp} disabled={atTop} title="Up (Alt+↑)" aria-label="Up">
          ↑
        </button>
        <div className="fm-path" onClick={() => search === null && !editingPath && setEditingPath(true)}>
          {search !== null ? (
            <input
              className="fm-path-input"
              autoFocus
              value={search}
              placeholder={`Search in ${pretty(path)}`}
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
              defaultValue={pretty(path)}
              onFocus={(e) => e.currentTarget.select()}
              onBlur={() => setEditingPath(false)}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Escape') setEditingPath(false)
                if (e.key === 'Enter') {
                  const value = e.currentTarget.value.trim()
                  // ~ is Seafile's home when that is on; seafile://… is taken as it is.
                  if (value.startsWith(SF)) return navigate(value.replace(/\/+$/, '') || SF)
                  if (sfHome && (value === '~' || value.startsWith('~/'))) return navigate(sfHome + value.slice(1).replace(/\/+$/, ''))
                  const target = resolvePath(path.includes('://') ? HOME : path, value)
                  const node = lookup(target)
                  if (node?.type === 'dir') navigate(target)
                  else setToast(`${value}: no such folder`)
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
              ...(isSf(path)
                ? [
                    { label: 'New folder', disabled: !sfWritable, onSelect: newFolder },
                    { label: 'Upload files…', disabled: !sfWritable, onSelect: () => pickAndUpload(path) },
                    { label: 'Upload folder…', disabled: !sfWritable, onSelect: () => pickAndUpload(path, true) },
                  ]
                : [{ label: 'New text file', disabled: !writable, onSelect: newFile }]),
              { label: 'Open terminal here', disabled: path.includes('://'), onSelect: () => wm.openNew('terminal', { run: `cd ${prettyPath(path)} && ls`, t: String(Date.now()) }) },
              { separator: true },
              { label: 'Copy location', disabled: path.includes('://') && !isSf(path), onSelect: () => copyPath(path) },
              { label: 'Add to bookmarks', disabled: (path.includes('://') && !isSf(path)) || path === SF || bookmarks.includes(path), onSelect: () => bookmark(path) },
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
          <FilesSidebar
            sections={sections}
            active={path}
            onOpen={openPlace}
            acceptFiles={acceptDrop}
            dropFiles={dropInto}
            footer={
              <button className={`fm-side-item ${path === TRASH ? 'is-active' : ''}`} onClick={() => navigate(TRASH)}>
                <span className="fm-side-icon">🗑</span>
                <span className="fm-side-label">Trash</span>
                {trashCount !== null && <span className="fm-side-count">{trashCount}</span>}
              </button>
            }
          />
        )}

        <div
          className={`fm-main fm-view-${prefs.view} ${dropOn === path ? 'is-drop' : ''}`}
          data-sf-drop={canWrite(path) ? path : undefined}
          onDragEnter={(e) => acceptDrop(e, path)}
          onDragOver={(e) => acceptDrop(e, path)}
          onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as globalThis.Node | null) && setDropOn(null)}
          onDrop={(e) => dropInto(e, path)}
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
          {isSf(path) && path !== SF && sfDir.status === 423 ? (
            <Unlock repo={parseSf(path)!.repo} />
          ) : isSf(path) && path !== SF && sfDir.error ? (
            <div className="fm-empty fm-sf-state">
              {sfDir.status === 404 && PLACE_FOLDERS.some((f) => path === `${home}/${f}`) ? (
                <>
                  <p>
                    {homeLibrary?.name ?? 'This library'} has no {path.split('/').pop()} folder yet.
                  </p>
                  <button className="btn btn-small btn-primary" onClick={() => mkdir(path).then(() => refreshDirs(path)).catch((e: Error) => setToast(e.message))}>
                    Create it
                  </button>
                </>
              ) : (
                <>
                  <p>{sfDir.status === 404 ? 'That folder is not there (any more).' : sfDir.error}</p>
                  <button className="btn btn-small" onClick={sfDir.reload}>
                    Try again
                  </button>
                </>
              )}
            </div>
          ) : null}
          {path === TRASH && sfTrash && <SeafileTrash onOpenFolder={navigate} toast={setToast} />}
          {items.map((item) => (
            <div
              key={item.path}
              ref={(el) => {
                if (el) tiles.current.set(item.path, el)
                else tiles.current.delete(item.path)
              }}
              className={`fm-item ${selected.has(item.path) ? 'is-selected' : ''} ${item.name.startsWith('.') ? 'is-hidden' : ''} ${dropOn === item.path ? 'is-drop' : ''} ${clip?.op === 'move' && clip.paths.includes(item.path) ? 'is-cut' : ''}`}
              draggable={!!item.sf && !item.sf.library && renaming !== item.path}
              onDragStart={(e) => dragStart(e, item)}
              onDragEnd={dragEnd}
              {...(item.sf && item.kind === 'folder'
                ? {
                    'data-sf-drop': canWrite(item.path) ? item.path : undefined,
                    onDragEnter: (e: React.DragEvent) => acceptDrop(e, item.path),
                    onDragOver: (e: React.DragEvent) => acceptDrop(e, item.path),
                    onDragLeave: (e: React.DragEvent) => !e.currentTarget.contains(e.relatedTarget as globalThis.Node | null) && dropOn === item.path && setDropOn(path),
                    onDrop: (e: React.DragEvent) => dropInto(e, item.path),
                  }
                : {})}
              onClick={(e) => clickItem(e, item)}
              onDoubleClick={() => renaming !== item.path && openItem(item)}
              onContextMenu={(e) => {
                if (!selected.has(item.path)) setSelected(new Set([item.path]))
                openContextMenu(e, itemMenu(item))
              }}
              title={search !== null ? pretty(item.path) : item.name}
            >
              <span className="fm-icon">
                <Thumb item={item} size={iconSize} gallery={prefs.view === 'gallery'} emblem={emblemOf(item)} />
              </span>
              {renaming === item.path ? (
                <input
                  className="fm-rename"
                  defaultValue={item.name}
                  autoFocus
                  spellCheck={false}
                  aria-label={`New name for ${item.name}`}
                  // The name without its extension is selected, as in every file manager.
                  onFocus={(e) => {
                    const dot = item.kind === 'folder' ? -1 : item.name.lastIndexOf('.')
                    e.currentTarget.setSelectionRange(0, dot > 0 ? dot : item.name.length)
                  }}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    e.stopPropagation()
                    if (e.key === 'Enter') e.currentTarget.blur()
                    if (e.key === 'Escape') {
                      e.currentTarget.value = item.name
                      e.currentTarget.blur()
                    }
                  }}
                  onBlur={(e) => commitRename(item, e.currentTarget.value)}
                />
              ) : (
                <span className="fm-name">{prefs.view === 'grid' || prefs.view === 'gallery' ? middleEllipsis(item.name, captionChars) : item.name}</span>
              )}
              {prefs.view === 'list' && (
                <>
                  <span className="fm-col">{item.kind === 'folder' ? (item.sf ? (item.sf.library ? formatSize(item.sf.library.size) : '') : `${item.size} items`) : formatSize(item.size)}</span>
                  <span className="fm-col">{new Date(item.mtime).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                  <span className="fm-col">{KIND_LABEL[item.kind]}</span>
                </>
              )}
              {search !== null && prefs.view !== 'list' && !item.sf && <span className="fm-where">{prettyPath(item.path.split('/').slice(0, -1).join('/') || '/')}</span>}
            </div>
          ))}
          {!items.length && !(isSf(path) && (sfDir.error || sfDir.loading)) && !(path === TRASH && sfTrash) && (
            <p className="fm-empty">{search ? `Nothing matching “${search}” in ${pretty(path)}` : path === RECENT ? 'Files you open show up here.' : path === SF ? (libraries ? 'No libraries.' : 'Loading libraries…') : 'This folder is empty.'}</p>
          )}
          {isSf(path) && sfDir.loading && !sfDir.listing && !items.length && <p className="fm-empty">Loading…</p>}
          {marquee && <div className="fm-marquee" style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }} />}
        </div>
      </div>

      <footer className="fm-status">
        <span>
          {items.length} item{items.length === 1 ? '' : 's'}
          {selectedItems().length > 0 && ` · ${selectedItems().length} selected${selectedSize ? ` (${formatSize(selectedSize)})` : ''}`}
          {writable && ' · writable'}
          {isSf(path) && path !== SF && sfDir.listing && (sfDir.listing.perm === 'rw' ? ` · ${libraryName(parseSf(path)!.repo)}` : ` · ${libraryName(parseSf(path)!.repo)} (read-only)`)}
        </span>
        <span>View size {prefs.zoom}%</span>
      </footer>

      {toast && <div className="fm-toast">{toast}</div>}
      {props && <Properties item={props} close={() => setProps(null)} pretty={pretty} />}
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

function Properties({ item, close, pretty }: { item: Item; close: () => void; pretty: (p: string) => string }) {
  const isTmp = item.path.startsWith('/tmp/')
  const library = item.sf && (item.sf.library ?? getLibrary(item.sf.repo))
  const rows: [string, string][] = item.sf
    ? [
        ['Name', item.name],
        ['Location', item.sf.library ? 'Seafile' : pretty(parentOf(item.path))],
        ['Type', item.sf.library ? `Library${library?.encrypted ? ', encrypted' : ''}` : KIND_LABEL[item.kind]],
        ...(item.kind !== 'folder' ? [['Size', `${formatSize(item.size)} (${item.size.toLocaleString('en-GB')} bytes)`] as [string, string]] : item.sf.library ? [['Size', formatSize(item.sf.library.size)] as [string, string]] : []),
        ['Modified', item.mtime ? new Date(item.mtime).toLocaleString('en-GB') : '—'],
        ...(library ? [['Library', `${library.name}${library.owner && library.type !== 'mine' ? ` (${library.owner})` : ''}`] as [string, string], ['Access', library.permission === 'rw' ? 'Read and write' : 'Read-only'] as [string, string]] : []),
      ]
    : [
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


/** An encrypted library: its password, once, for as long as Settings says (Seafile never sees it stored). */
function Unlock({ repo }: { repo: string }) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    unlock(repo, password)
      .catch((err: Error) => setError(err.message))
      .finally(() => setBusy(false))
  }
  return (
    <form className="fm-unlock" onSubmit={submit} onPointerDown={(e) => e.stopPropagation()}>
      <FolderIcon size={64} emblem="lock" />
      <p>
        <strong>{libraryName(repo)}</strong> is encrypted.
      </p>
      <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Library password" autoFocus autoComplete="off" required onKeyDown={(e) => e.stopPropagation()} />
      <button className="btn btn-primary" disabled={busy}>
        {busy ? 'Unlocking…' : 'Unlock'}
      </button>
      {error && <p className="t-red">{error}</p>}
      <p className="muted">The password goes to Seafile and is not kept anywhere. It is asked again after the time set in Settings → Integrations.</p>
    </form>
  )
}
