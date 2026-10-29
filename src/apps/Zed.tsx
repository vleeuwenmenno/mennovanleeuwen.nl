import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { useWM, type WinState } from '../os/wm'
import { fileKind, HOME, KIND_LABEL, kindOfName, lookup as siteLookup, prettyPath, type DirNode, type Node } from '../terminal/vfs'
import { lookup, makeDir, MAX_TEXT, prepare, readFileText, removePath, touchFile, transfer, walk } from '../terminal/fs'
import { browserPathOf, canWriteFolder, deleteNoteFor, dropOpFor, inBrowser, saveText, transferPaths } from '../data/fileOps'
import { browserFilesState, useBrowserFiles } from '../data/browserfs'
import { notify } from '../os/notify'
import { cachedDir, DRAG_FILES, getClipboard, getDragged, getLibrary, isInside, isSf, libraryName, openSeafile, parseSf, readText, seafileWebUrl, setClipboard, setDragged, SF, sfPath, shareLink, useClipboard, useDir, writeText } from '../data/seafile'
import { mounts, posixOf, useMounts, whereIs } from '../data/mounts'
import { droppedFiles, hasOsFiles, uploadFiles } from '../data/uploads'
import { openContextMenu, type MenuItem } from '../os/ContextMenu'
import { openLink } from '../data/links'
import { ask } from '../os/Dialogs'
import { Terminal } from './Terminal'
import { useEdgeSwipe } from '../os/useEdgeSwipe'
import { useMediaQuery } from '../os/useMediaQuery'
import { MarkdownPreview } from '../data/markdown/MarkdownPreview'
import { MshHighlight, isMsh, useXedDebug, XedDebugPanel, XedDebugToolbar } from './XedDebug'
import { breakpointsIn, editorBreakpoints, moveBreakpoints, removeBreakpoints, shiftBreakpoints, subscribeDebug, debugRevision } from '../terminal/msh/debug'
import { analyzeMsh } from '../terminal/msh/analysis'
import { toUi } from '../os/uiScale'

// The Markdown preview moved to its own module; other apps still import it from here.
export { MarkdownPreview }

// A small Zed: a project panel on the left, tabs, and an editor with line numbers, a current-line
// highlight and Markdown highlighting, plus a Markdown preview, find (Ctrl+F), project search
// (Ctrl+Shift+F) and file finder (Ctrl+P). Markdown opened from elsewhere starts in the preview.
// The project panel sees the filesystem the way the terminal does, through /etc/fstab, so a
// Seafile library on ~ or under /mnt/seafile is there to browse and edit: Ctrl+S saves back to
// Seafile. Without Seafile as home, ~ is kept in this browser (data/browserfs.ts): editable, with
// "Browser only" in the status bar. The site's own files are read-only, except /tmp. Right-clicking the panel creates,
// renames, deletes, cuts, copies and pastes, and entries drag onto folders, as in Files (and the
// clipboard and drags are the same ones Files and the desktop use). Opening another file while
// Zed is open adds a tab to the frontmost window, as the real one does. The project is the home
// folder until another one is picked from the project name in the title bar.

const LINE = 20 // px; the gutter, the highlight layers and the textarea share it
const PAD = 12 // px above the first line
const SEARCH = 'search://' // the project search tab

/** loading: a Seafile file on its way in; error: it could not be read (nothing to save over it). */
type Buffer = { text: string; saved: string; loading?: boolean; error?: string }
type View = 'edit' | 'preview' | 'split'
type Jump = { path: string; line: number; col: number; len: number }
/** A name being typed in the project panel: a rename, or a new file or folder in `dir`. */
type Pending = { kind: 'rename'; path: string } | { kind: 'file' | 'folder'; dir: string }

const join = (dir: string, name: string) => `${dir === '/' ? '' : dir}/${name}`
const base = (path: string) => (path === '/' ? '/' : path.split('/').pop()!)
const parentOf = (path: string) => path.replace(/\/[^/]*$/, '') || '/'
const inside = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`)
/** Quotes a path for a command line in the terminal. */
const shq = (s: string) => (/^[\w@%+=:,./~-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)
/** Where a file is, for tabs and the status bar: Seafile files without a mount by library. */
const where = (path: string) => {
  const at = parseSf(path)
  return at ? `${libraryName(at.repo)}${at.p}` : prettyPath(path)
}
const isMarkdown = (path: string) => /\.md$/i.test(path)
/** Kinds Zed edits when they are clicked in the panel; pictures, PDFs and such open in their own app. */
const TEXTUAL = new Set(['text', 'markdown', 'link', 'file'])

function read(path: string) {
  const node = lookup(path)
  return node?.type === 'file' ? node.content() : ''
}

/** Writes a file in /tmp, the only writable directory of the site's own. Returns false anywhere else. */
function write(path: string, text: string) {
  const m = /^\/tmp\/([^/]+)$/.exec(path)
  const tmp = siteLookup('/tmp') as DirNode | null
  if (!m || !tmp) return false
  tmp.children.set(m[1], { type: 'file', name: m[1], content: () => text, mtime: Date.now() })
  return true
}

/** Where a file really is: its Seafile path (null for the site's own files), whether it is read-only, and whether it is kept in this browser. */
function locate(path: string): { sf: string | null; ro: boolean; browser?: boolean } {
  if (isSf(path)) return { sf: path, ro: getLibrary(parseSf(path)!.repo)?.permission === 'r' }
  const w = whereIs(path)
  // On the browser mount: writable (the site's own files there are saved as the browser's copy).
  if (w.kind === 'browser') return { sf: null, ro: false, browser: true }
  if (w.kind === 'sf') return w.sf === SF ? { sf: null, ro: true } : { sf: w.sf, ro: w.ro }
  if (w.kind === 'missing') return { sf: null, ro: true }
  return { sf: null, ro: !/^\/tmp\/[^/]+$/.test(path) }
}

/** Whether files and folders can be made and removed in a folder: /tmp, or Seafile you may write to. */
function canWriteIn(dir: string) {
  if (dir === '/tmp' || canWriteFolder(dir)) return true
  const w = whereIs(dir)
  return w.kind === 'sf' && w.sf !== SF && !w.ro && cachedDir(w.sf)?.listing?.perm !== 'r'
}

/** Mount points (a library on ~, /mnt/seafile and the libraries in it) stay where they are. */
function isMount(path: string) {
  if (mounts().some((m) => m.target === path)) return true
  const w = whereIs(path)
  return w.kind === 'sf' && (w.sf === SF || parseSf(w.sf)!.p === '/')
}

const canChange = (path: string) => path !== '/' && !isMount(path) && canWriteIn(parentOf(path))

/** The path to cut, copy or drag for an entry: Seafile files and folders, and what is kept in this browser. */
function clipOf(path: string) {
  if (isMount(path)) return null
  if (inBrowser(path)) return path
  return locate(path).sf
}

/** The folder a clipboard or drag path is in: a Seafile folder, or a folder of the filesystem. */
const sfParentOf = (p: string) => {
  const at = parseSf(p)
  return at ? sfPath(at.repo, at.p.split('/').slice(0, -1).join('/') || '/') : p.replace(/\/[^/]*$/, '') || '/'
}

/** A path handed to Zed from elsewhere: Seafile paths by where they are mounted, and the site's own files where they are now. */
function normalize(path: string) {
  if (isSf(path)) return posixOf(path) ?? path
  if (lookup(path)) return path
  // With Seafile on ~, the desktop's cv.md and README.md are the site's, under /srv/site.
  if (path.startsWith(`${HOME}/`) && whereIs(HOME).kind === 'sf' && siteLookup(path)) return `/srv/site${path.slice(HOME.length)}`
  return path
}

/** Command errors read "touch: cannot touch 'x': Read-only file system"; the last part says it. */
const reason = (e: Error) => (/^[\w-]+: /.test(e.message) ? e.message.split(': ').pop()! : e.message)

/** Files worth searching: text, not the stand-ins for ISOs, music and pictures. */
function searchable(path: string) {
  const node = lookup(path)
  return node?.type === 'file' && ['text', 'markdown', 'link', 'game', 'file'].includes(fileKind(node))
}

function matchesIn(text: string, query: string) {
  if (!query) return []
  const hay = text.toLowerCase()
  const needle = query.toLowerCase()
  const out: number[] = []
  for (let i = hay.indexOf(needle); i !== -1 && out.length < 2000; i = hay.indexOf(needle, i + needle.length)) out.push(i)
  return out
}

export function Zed({ win }: { win: WinState }) {
  const wm = useWM()
  // Follows /etc/fstab and the libraries, so the panel changes when Seafile mounts or unmounts.
  useMounts()
  const [root, setRoot] = useState(() => win.props.root ?? HOME)
  const [tabs, setTabs] = useState<string[]>([])
  const [buffers, setBuffers] = useState<Record<string, Buffer>>({})
  // Tabs opened again at boot may have been read before this browser's files (or the account)
  // loaded: once they are in, read the untouched ones again from where they really are.
  useBrowserFiles()
  const storeReady = browserFilesState() === 'ready'
  useEffect(() => {
    if (!storeReady) return
    for (const t of tabs) {
      const b = buffers[t]
      if (!locate(t).browser || !b || b.loading || b.text !== b.saved) continue
      readFileText(t)
        .then((r) => r && setBuffers((now) => (now[t] && now[t].text === now[t].saved ? { ...now, [t]: { text: r.text, saved: r.text } } : now)))
        // Refused (a mode set with chmod): the tab keeps what it has.
        .catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeReady])
  const [views, setViews] = useState<Record<string, View>>({})
  const [active, setActive] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([root]))
  const [cursor, setCursor] = useState({ line: 0, col: 0 })
  const [status, setStatus] = useState<string | null>(null)
  const [panel, setPanel] = useState(true)
  // On a phone the project panel is a drawer over the editor: the button at the bottom left, or a
  // swipe in from the left edge (and away again).
  const narrow = useMediaQuery('(max-width: 719px)')
  const [drawer, setDrawer] = useState(false)
  const showPanel = narrow ? drawer : panel
  const togglePanel = () => (narrow ? setDrawer((d) => !d) : setPanel((p) => !p))

  // The terminal panel under the editor, as in Zed: terminals in tabs, each starting in the project.
  // Hidden ones keep running (and their scrollback); closing a tab ends it.
  const [terms, setTerms] = useState<number[]>([])
  const [termOn, setTermOn] = useState<number | null>(null)
  const [dock, setDock] = useState(false)
  const [dockH, setDockH] = useState(240)
  const nextTerm = useRef(1)
  const newTerm = () => {
    const id = nextTerm.current++
    setTerms((ts) => [...ts, id])
    setTermOn(id)
    setDock(true)
  }
  const toggleDock = () => (terms.length ? setDock((d) => !d) : newTerm())
  const closeTerm = (id: number) =>
    setTerms((ts) => {
      const left = ts.filter((t) => t !== id)
      setTermOn((on) => (on === id ? (left[left.length - 1] ?? null) : on))
      if (!left.length) setDock(false)
      return left
    })
  /** Dragging the panel's top edge: taller or shorter, leaving the editor some room. */
  const resizeDock = (e: React.PointerEvent) => {
    e.preventDefault()
    const startY = toUi(e.clientY)
    const startH = dockH
    const room = (rootEl.current?.querySelector('.zed-main')?.clientHeight ?? 600) - 120
    const move = (ev: PointerEvent) => setDockH(Math.round(Math.max(100, Math.min(room, startH - (toUi(ev.clientY) - startY)))))
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const termWin = useMemo(() => ({ ...win, props: {} }), [win])
  const [picker, setPicker] = useState<'project' | 'files' | null>(null)
  const [find, setFind] = useState<{ query: string; index: number } | null>(null)
  const [query, setQuery] = useState('') // project search
  const [jump, setJump] = useState<Jump | null>(null)
  // The project panel: the selected entry, a name being typed, and where a drag would land.
  const [sel, setSel] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [dropOn, setDropOn] = useState<string | null>(null)
  const [, setTick] = useState(0) // /tmp changes in place; this draws the panel again
  const clip = useClipboard()
  const text = useRef<HTMLTextAreaElement>(null)
  const editor = useRef<HTMLDivElement>(null)
  const rootEl = useRef<HTMLDivElement>(null)
  useEdgeSwipe(rootEl, { enabled: narrow, open: drawer, onOpen: () => setDrawer(true), onClose: () => setDrawer(false) })
  const findInput = useRef<HTMLInputElement>(null)

  const reveal = (path: string) =>
    setExpanded((o) => {
      const next = new Set(o)
      const parts = path.split('/').filter(Boolean)
      for (let i = 1; i < parts.length; i++) next.add('/' + parts.slice(0, i).join('/'))
      return next
    })

  /** Opens a file in a tab (or focuses its tab); answers the path it is open under. */
  const openFile = (raw: string, at?: Omit<Jump, 'path'>) => {
    const path = normalize(raw)
    setTabs((ts) => (ts.includes(path) ? ts : [...ts, path]))
    const { sf, browser } = locate(path)
    if (sf) loadSeafile(path, sf)
    else if (browser) loadBrowser(path)
    else setBuffers((bs) => (bs[path] ? bs : { ...bs, [path]: { text: read(path), saved: read(path) } }))
    setActive(path)
    setCursor({ line: at?.line ?? 0, col: at?.col ?? 0 })
    if (at) {
      setViews((v) => (v[path] === 'preview' ? { ...v, [path]: 'edit' } : v))
      setJump({ path, ...at })
    }
    if (!isSf(path)) reveal(path)
    return path
  }

  /** A Seafile file comes in from its file server; an open tab keeps what is typed in it. */
  const loadSeafile = (path: string, sf: string) => {
    if (buffers[path] && !buffers[path].error) return
    setBuffers((bs) => ({ ...bs, [path]: { text: '', saved: '', loading: true } }))
    readText(sf)
      .then((t) => setBuffers((now) => ({ ...now, [path]: { text: t, saved: t } })))
      .catch((e: Error) => setBuffers((now) => ({ ...now, [path]: { text: '', saved: '', error: `Could not open it: ${e.message}` } })))
  }

  /** A file kept in this browser: big or binary ones are read from IndexedDB, not from memory. */
  const loadBrowser = (path: string) => {
    if (buffers[path] && !buffers[path].error) return
    setBuffers((bs) => ({ ...bs, [path]: { text: '', saved: '', loading: true } }))
    readFileText(path)
      .then((r) => setBuffers((now) => ({ ...now, [path]: { text: r?.text ?? '', saved: r?.text ?? '' } })))
      .catch((e: Error) => setBuffers((now) => ({ ...now, [path]: { text: '', saved: '', error: `Could not open it: ${e.message}` } })))
  }

  /** A click in the panel: text in a tab, Seafile pictures, PDFs and the like in their own app. */
  const openFromPanel = (path: string) => {
    const { sf } = locate(path)
    if (sf && !TEXTUAL.has(kindOfName(base(path)))) return void openSeafile(wm, sf).catch((e: Error) => setStatus(e.message))
    const node = lookup(path)
    if (sf && node?.type === 'file' && (node.size ?? 0) > MAX_TEXT) return setStatus(`${base(path)} is too big to edit here`)
    openFile(path)
    setDrawer(false)
  }

  const openSearch = () => {
    setTabs((ts) => (ts.includes(SEARCH) ? ts : [...ts, SEARCH]))
    setActive(SEARCH)
  }

  // `open README.md`, Files and Spotlight hand us a path (and a fresh `t` so the same path focuses
  // again). Markdown opened from outside Zed starts in the preview (`view: 'preview'`).
  useEffect(() => {
    if (!win.props.path) return
    const path = openFile(win.props.path)
    if (win.props.view === 'preview' && isMarkdown(path)) setViews((v) => ({ ...v, [path]: 'preview' }))
  }, [win.props.path, win.props.t])

  // A tab closed from outside (its file deleted): the one before it takes over.
  useEffect(() => {
    if (active && !tabs.includes(active)) setActive(tabs[tabs.length - 1] ?? null)
  }, [tabs, active])

  // Focusing the window puts the caret back in the editor, as clicking into Zed does.
  useEffect(() => {
    if (wm.focusedPid !== win.pid || matchMedia('(pointer: coarse)').matches) return
    if (!rootEl.current?.contains(document.activeElement)) (text.current ?? rootEl.current)?.focus({ preventScroll: true })
  }, [wm.focusedPid, win.pid])

  useEffect(() => {
    if (!status) return
    const t = setTimeout(() => setStatus(null), 2600)
    return () => clearTimeout(t)
  }, [status])

  const scrollToLine = (line: number) => {
    const view = editor.current
    if (!view) return
    const top = PAD + line * LINE
    if (top < view.scrollTop) view.scrollTop = top - LINE * 2
    else if (top + LINE * 2 > view.scrollTop + view.clientHeight) view.scrollTop = top + LINE * 3 - view.clientHeight
  }

  // A jump from project search: select the match once its editor has rendered (and a Seafile
  // file has come in).
  const jumpLoading = !!jump && !!buffers[jump.path]?.loading
  useEffect(() => {
    if (!jump || jump.path !== active || !text.current || jumpLoading) return
    const lines = text.current.value.split('\n')
    const start = lines.slice(0, jump.line).reduce((n, l) => n + l.length + 1, 0) + jump.col
    text.current.focus({ preventScroll: true })
    text.current.setSelectionRange(start, start + jump.len)
    scrollToLine(jump.line)
    setJump(null)
  }, [jump, active, jumpLoading])

  const buf = active && active !== SEARCH ? buffers[active] : null
  const view: View = (active && views[active]) || 'edit'
  const markdown = !!active && isMarkdown(active)
  const mshAnalysis = useMemo(() => active && buf && isMsh(active, buf.text) ? analyzeMsh(buf.text, active) : null, [active, buf?.text])

  const findMatches = useMemo(() => (buf && find ? matchesIn(buf.text, find.query) : []), [buf, find?.query])
  const current = findMatches.length ? ((find!.index % findMatches.length) + findMatches.length) % findMatches.length : -1

  const lineOf = (offset: number) => (buf ? buf.text.slice(0, offset).split('\n').length - 1 : 0)

  const stepFind = (by: number) => {
    if (!find || !findMatches.length) return
    const i = (((current + by) % findMatches.length) + findMatches.length) % findMatches.length
    setFind({ ...find, index: i })
    scrollToLine(lineOf(findMatches[i]))
  }

  const closeFind = (select: boolean) => {
    const at = current >= 0 ? findMatches[current] : -1
    setFind(null)
    const el = text.current
    if (!el) return
    el.focus({ preventScroll: true })
    if (select && at >= 0) {
      el.setSelectionRange(at, at + find!.query.length)
      track()
    }
  }

  const openFind = () => {
    if (!buf) return
    if (view === 'preview') setViews((v) => ({ ...v, [active!]: 'edit' }))
    const el = text.current
    const selected = el && el.selectionEnd > el.selectionStart ? el.value.slice(el.selectionStart, el.selectionEnd) : ''
    setFind((f) => ({ query: selected && !selected.includes('\n') ? selected : (f?.query ?? ''), index: 0 }))
    requestAnimationFrame(() => findInput.current?.select())
  }

  const close = async (path: string) => {
    const b = buffers[path]
    if (b && b.text !== b.saved && !(await ask({ title: `Close ${base(path)}?`, body: 'It has changes that are not saved. Closing it loses them.', confirm: 'Close without saving', danger: true }))) return
    const i = tabs.indexOf(path)
    const rest = tabs.filter((x) => x !== path)
    setTabs(rest)
    if (path !== SEARCH) {
      setBuffers(({ [path]: _, ...bs }) => bs)
      setViews(({ [path]: _, ...v }) => v)
    }
    if (active === path) setActive(rest[Math.min(i, rest.length - 1)] ?? null)
  }

  /** Saves the active file; resolves true once it is saved (Run waits for this). */
  const save = async (): Promise<boolean> => {
    if (!buf || !active) return false
    const { sf, ro } = locate(active)
    if (sf) {
      if (buf.loading || buf.error) return false
      if (ro) {
        setStatus(`Not saved: ${libraryName(parseSf(sf)!.repo)} is read-only for you`)
        return false
      }
      const path = active
      const text = buf.text
      setStatus(`Saving ${where(path)}…`)
      return writeText(sf, text)
        .then(() => {
          setBuffers((bs) => (bs[path] ? { ...bs, [path]: { ...bs[path], saved: text } } : bs))
          setStatus(`Saved ${where(path)} to Seafile`)
          return true
        })
        .catch((e: Error) => {
          setStatus(`Not saved: ${e.message}`)
          return false
        })
    }
    if (locate(active).browser) {
      if (buf.loading || buf.error) return false
      const path = active
      const text = buf.text
      return saveText(path, text)
        .then(() => {
          setBuffers((bs) => (bs[path] ? { ...bs, [path]: { ...bs[path], saved: text } } : bs))
          setStatus(`Saved ${prettyPath(path)} in this browser`)
          // Once per device: where it went, and what that means.
          notify({ title: 'Saved in this browser only', body: "Files in ~ are kept in this browser until Seafile is set up: clearing the site's data deletes them.", action: { app: 'settings', props: { section: 'integrations', sub: 'seafile' } }, once: 'browser-files-first-save', transient: true })
          return true
        })
        .catch((e: Error) => {
          setStatus(`Not saved: ${e.message}`)
          return false
        })
    }
    if (!write(active, buf.text)) {
      setStatus('Read-only file system. Only /tmp, ~ and Seafile are writable.')
      return false
    }
    setBuffers((bs) => ({ ...bs, [active]: { ...bs[active], saved: bs[active].text } }))
    setStatus(`Saved ${prettyPath(active)}`)
    return true
  }

  // --- project panel: changing files ------------------------------------------------------------

  /** Open tabs (and everything keyed by path) follow a file or folder that moved. */
  const rekey = (from: string, to: string) => {
    const move = (p: string) => (p === from ? to : p.startsWith(`${from}/`) ? to + p.slice(from.length) : p)
    const moveKeys = <T,>(o: Record<string, T>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [move(k), v]))
    moveBreakpoints(from, to)
    setTabs((ts) => ts.map(move))
    setActive((a) => a && move(a))
    setSel((s) => s && move(s))
    setBuffers(moveKeys)
    setViews(moveKeys)
    setExpanded((o) => new Set([...o].map(move)))
  }

  /** Tabs of something deleted close (the dialog said their changes go too). */
  const forget = (path: string) => {
    const keep = <T,>(o: Record<string, T>) => Object.fromEntries(Object.entries(o).filter(([k]) => !inside(k, path)))
    for (const p of new Set(editorBreakpoints().map((b) => b.path))) if (inside(p, path)) removeBreakpoints(p)
    setTabs((ts) => ts.filter((t) => !inside(t, path)))
    setBuffers(keep)
    setViews(keep)
    setSel((s) => (s && inside(s, path) ? parentOf(path) : s))
  }

  const startNew = (dir: string, kind: 'file' | 'folder') => {
    setExpanded((o) => new Set([...o, dir]))
    setPending({ kind, dir })
  }

  const finishPending = async (typed: string | null) => {
    const p = pending
    setPending(null)
    const name = typed?.trim() ?? ''
    if (!p || !name) return
    if (p.kind === 'rename') return renameTo(p.path, name)
    if (name.includes('/')) return setStatus('A name cannot have a / in it')
    const abs = join(p.dir, name)
    if (lookup(abs)) return setStatus(`${name} already exists`)
    try {
      if (p.kind === 'folder') await makeDir('/', abs, false)
      else await touchFile('/', abs)
      setTick((t) => t + 1)
      setSel(abs)
      if (p.kind === 'file') openFile(abs)
    } catch (e) {
      setStatus(`Could not create ${name}: ${reason(e as Error)}`)
    }
  }

  const renameTo = async (path: string, name: string) => {
    if (name === base(path)) return
    if (name.includes('/')) return setStatus('A name cannot have a / in it')
    const dest = join(parentOf(path), name)
    if (lookup(dest)) return setStatus(`${name} already exists`)
    setStatus(`Renaming ${base(path)}…`)
    try {
      await transfer('move', '/', path, dest, true)
      rekey(path, dest)
      setStatus(`Renamed to ${name}`)
    } catch (e) {
      setStatus(`Could not rename ${base(path)}: ${reason(e as Error)}`)
    }
    setTick((t) => t + 1)
  }

  const remove = async (path: string) => {
    const name = base(path)
    const { sf } = locate(path)
    const unsaved = tabs.some((t) => inside(t, path) && buffers[t] && buffers[t].text !== buffers[t].saved)
    const note = sf ? await deleteNoteFor([sf]) : inBrowser(path) ? await deleteNoteFor([path]) : { final: true, body: 'It was only ever in memory.' }
    const body = unsaved ? `${note.body} Changes not saved in its open tabs are lost too.` : note.body
    if (!(await ask({ title: note.final ? `Delete ${name} for good?` : `Delete ${name}?`, body, confirm: 'Delete', danger: true }))) return
    setStatus(`Deleting ${name}…`)
    try {
      await removePath('/', path, { recursive: true, force: true, dir: false })
      forget(path)
      setStatus(`Deleted ${name}`)
    } catch (e) {
      setStatus(`Could not delete ${name}: ${reason(e as Error)}`)
    }
    setTick((t) => t + 1)
  }

  const cutOrCopy = (op: 'move' | 'copy', path: string) => {
    const sf = clipOf(path)
    if (!sf || (op === 'move' && !canChange(path))) return
    setClipboard({ op, paths: [sf] })
    setStatus(op === 'move' ? `Cut ${base(path)}: paste it into a folder with Ctrl+V` : `Copied ${base(path)}`)
  }

  /** The folder the clipboard can be pasted into (a Seafile path, or a folder kept in this browser), or null. */
  const pasteInto = (dir: string) => {
    const c = getClipboard()
    const w = whereIs(dir)
    const target = w.kind === 'sf' ? w.sf : w.kind === 'browser' ? dir : null
    if (!c || !target || !canWriteIn(dir) || isInside(c.paths, target)) return null
    if (c.op === 'move' && c.paths.every((p) => sfParentOf(p) === target)) return null
    return target
  }

  /** Moves or copies Seafile paths into a folder of the panel; open tabs follow what moved. */
  const carry = async (op: 'move' | 'copy', paths: string[], dir: string, into: string) => {
    const what = paths.length === 1 ? base(paths[0]) : `${paths.length} items`
    const moved = op === 'move' ? paths.map((p) => [isSf(p) ? posixOf(p) : p, join(dir, base(p))] as const) : []
    setStatus(`${op === 'move' ? 'Moving' : 'Copying'} ${what}…`)
    try {
      await transferPaths(op, paths, into)
      for (const [from, to] of moved) if (from) rekey(from, to)
      setStatus(`${op === 'move' ? 'Moved' : 'Copied'} ${what} to ${prettyPath(dir)}`)
      return true
    } catch (e) {
      setStatus((e as Error).message)
      return false
    }
  }

  const paste = async (dir: string) => {
    const c = getClipboard()
    const into = pasteInto(dir)
    if (!c || !into) return
    if ((await carry(c.op, c.paths, dir, into)) && c.op === 'move') setClipboard(null)
  }

  const revealInFiles = (path: string) => {
    const parent = whereIs(parentOf(path))
    wm.openNew('files', { path: parent.kind === 'sf' ? parent.sf : parentOf(path), select: locate(path).sf ?? path })
  }

  const copyText = (value: string) =>
    navigator.clipboard
      ?.writeText(value)
      .then(() => setStatus(`Copied ${value}`))
      .catch(() => {})

  const relative = (path: string) => (path === root ? '.' : inside(path, root) ? path.slice(root === '/' ? 1 : root.length + 1) : path)

  function entryMenu(path: string, isDir: boolean, isRoot = false): MenuItem[] {
    const dir = isDir ? path : parentOf(path)
    const { sf } = locate(path)
    const changeable = !isRoot && canChange(path)
    const clippable = !isRoot && !!clipOf(path)
    const web = sf ? seafileWebUrl(sf) : null
    return [
      { label: 'New File', disabled: !canWriteIn(dir), onSelect: () => startNew(dir, 'file') },
      { label: 'New Folder', disabled: !canWriteIn(dir) || dir === '/tmp', onSelect: () => startNew(dir, 'folder') },
      { separator: true },
      ...(isDir ? [] : [{ label: 'Open', onSelect: () => openFromPanel(path) }]),
      { label: 'Reveal in Files', onSelect: () => revealInFiles(path) },
      { label: 'Open in Terminal', onSelect: () => wm.openNew('terminal', { run: `cd ${shq(prettyPath(dir))}`, t: String(Date.now()) }) },
      ...(sf
        ? [
            {
              label: 'Seafile',
              submenu: [
                { label: 'Copy share link', onSelect: () => void shareLink(sf).then(({ url }) => copyText(url), (e: Error) => setStatus(e.message)) },
                ...(web ? [{ label: 'Open in Seafile ↗', onSelect: () => void openLink(web) }] : []),
              ],
            },
          ]
        : []),
      { separator: true },
      ...(isRoot
        ? []
        : [
            { label: 'Cut', shortcut: 'Ctrl X', disabled: !clippable || !changeable, onSelect: () => cutOrCopy('move', path) },
            { label: 'Copy', shortcut: 'Ctrl C', disabled: !clippable, onSelect: () => cutOrCopy('copy', path) },
          ]),
      { label: 'Paste', shortcut: 'Ctrl V', disabled: !pasteInto(dir), onSelect: () => void paste(dir) },
      { separator: true },
      { label: 'Copy Path', onSelect: () => copyText(path) },
      { label: 'Copy Relative Path', onSelect: () => copyText(relative(path)) },
      ...(isRoot
        ? []
        : [
            { separator: true } as MenuItem,
            { label: 'Rename', shortcut: 'F2', disabled: !changeable, onSelect: () => setPending({ kind: 'rename', path }) },
            { label: 'Delete', shortcut: 'Del', danger: true, disabled: !changeable, onSelect: () => void remove(path) },
          ]),
    ]
  }

  const onPanelKey = (e: KeyboardEvent<HTMLElement>) => {
    if ((e.target as HTMLElement).closest('input') || !sel) return
    const mod = e.ctrlKey || e.metaKey
    const key = e.key.toLowerCase()
    const dir = lookup(sel)?.type === 'dir' ? sel : parentOf(sel)
    if (e.key === 'F2' && canChange(sel)) setPending({ kind: 'rename', path: sel })
    else if ((e.key === 'Delete' || (mod && e.key === 'Backspace')) && canChange(sel)) void remove(sel)
    else if (mod && key === 'c' && !e.altKey) cutOrCopy('copy', sel)
    else if (mod && key === 'x') cutOrCopy('move', sel)
    else if (mod && key === 'v') void paste(dir)
    else return
    e.preventDefault()
    e.stopPropagation()
  }

  // Dragging: Seafile entries onto folders here, into Files and onto the desktop; from there (and
  // from the computer, which uploads) into folders here. Within a library they move, else copy.
  const dragStart = (e: DragEvent, path: string) => {
    const sf = clipOf(path)
    if (!sf || pending) return e.preventDefault()
    e.dataTransfer.setData(DRAG_FILES, JSON.stringify([sf]))
    e.dataTransfer.setData('text/plain', prettyPath(path))
    e.dataTransfer.effectAllowed = 'copyMove'
    setDragged([sf])
    setSel(path)
  }
  const dragEnd = () => {
    setDragged(null)
    setDropOn(null)
  }
  /** Whether a drag can land in `dir`; says so to the browser (and highlights it) when it can. */
  const acceptDrop = (e: DragEvent, dir: string): string | null => {
    e.stopPropagation()
    const w = whereIs(dir)
    const ok = (effect: 'copy' | 'move') => {
      e.preventDefault()
      e.dataTransfer.dropEffect = effect
      if (dropOn !== dir) setDropOn(dir)
      return target
    }
    const target = w.kind === 'sf' ? w.sf : w.kind === 'browser' ? dir : null
    if (!target || !canWriteIn(dir)) return null
    if (!getDragged() && hasOsFiles(e.dataTransfer)) return ok('copy')
    const paths = getDragged()
    if (!paths || !e.dataTransfer.types.includes(DRAG_FILES) || isInside(paths, target)) return null
    const op = dropOpFor(paths, target, e)
    if (op === 'move' && paths.every((p) => sfParentOf(p) === target)) return null
    return ok(op)
  }
  const dropInto = (e: DragEvent, dir: string) => {
    const into = acceptDrop(e, dir)
    setDropOn(null)
    if (!into) return
    if (!getDragged() && hasOsFiles(e.dataTransfer)) {
      droppedFiles(e.dataTransfer)
        .then((picked) => uploadFiles(picked, into))
        .catch((err: Error) => setStatus(err.message))
      return
    }
    const paths = getDragged()!
    const op = dropOpFor(paths, into, e)
    dragEnd()
    void carry(op, paths, dir, into)
  }

  const tree: TreeCtx = {
    open: expanded,
    active,
    sel,
    dropOn,
    cut: clip?.op === 'move' ? clip.paths : [],
    pending,
    onToggle: (p) =>
      setExpanded((o) => {
        const next = new Set(o)
        if (!next.delete(p)) next.add(p)
        return next
      }),
    onOpen: openFromPanel,
    onSelect: setSel,
    onMenu: (e, p, isDir, isRoot) => openContextMenu(e, entryMenu(p, isDir, isRoot)),
    onPendingDone: (name) => void finishPending(name),
    onDragStart: dragStart,
    onDragEnd: dragEnd,
    onDragOver: acceptDrop,
    onDrop: dropInto,
    onLocked: (sf) => wm.openNew('files', { path: sf }),
  }

  const edit = (value: string) => {
    if (!active) return
    if (buf && breakpointsIn(active).size) followEdit(active, buf.text, value)
    setBuffers((bs) => ({ ...bs, [active]: { ...bs[active], text: value } }))
  }

  const track = () => {
    const el = text.current
    if (!el) return
    const before = el.value.slice(0, el.selectionStart)
    const line = before.split('\n').length - 1
    setCursor({ line, col: before.length - before.lastIndexOf('\n') - 1 })
    // The textarea never scrolls itself (it is as tall as the file), so keep the caret in view.
    scrollToLine(line)
  }

  const togglePreview = (split = false) => {
    if (!active || !markdown) return
    setViews((v) => ({ ...v, [active]: (v[active] ?? 'edit') === 'edit' ? (split ? 'split' : 'preview') : 'edit' }))
  }

  // --- the msh debugger ------------------------------------------------------------------------------
  useSyncExternalStore(subscribeDebug, debugRevision)
  const [revealAt, setRevealAt] = useState<{ path: string; line: number } | null>(null)
  /** A pause in some file: its tab comes to the front (opened if needed) and scrolls to the line. The caret stays. */
  const revealSource = (raw: string, line: number) => {
    const path = normalize(raw)
    if (!tabs.includes(path)) openFile(path)
    else setActive(path)
    setViews((v) => (v[path] === 'preview' ? { ...v, [path]: 'edit' } : v))
    setRevealAt({ path, line })
  }
  const revealLoading = !!revealAt && !!buffers[revealAt.path]?.loading
  useEffect(() => {
    const view = editor.current
    if (!revealAt || revealAt.path !== active || !view || revealLoading) return
    const top = PAD + revealAt.line * LINE
    if (top < view.scrollTop + LINE || top + LINE * 2 > view.scrollTop + view.clientHeight) view.scrollTop = Math.max(0, top - view.clientHeight / 2)
    setRevealAt(null)
  }, [revealAt, active, revealLoading])
  const caretOffset = useMemo(() => (buf ? buf.text.split('\n').slice(0, cursor.line).reduce((n, l) => n + l.length + 1, 0) + cursor.col : 0), [buf?.text, cursor.line, cursor.col])
  const dbg = useXedDebug({
    path: active && active !== SEARCH ? active : null,
    text: buf?.text ?? '',
    dirty: !!buf && buf.text !== buf.saved,
    ready: !!buf && !buf.loading && !buf.error,
    root,
    caret: caretOffset,
    save,
    reveal: revealSource,
    say: setStatus,
    lineHeight: LINE,
    pad: PAD,
  })
  const points = active && dbg.msh ? breakpointsIn(active) : null
  const errorLines = new Set(mshAnalysis?.diagnostics.map((d) => d.line) ?? [])

  /** The debugger's keys, as in VS Code. F5 and Shift+F5 are always Xed's here (no page reload with unsaved work); the others only around msh. */
  const debugKey = (e: globalThis.KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey || !/^F(5|6|9|10|11)$/.test(e.key)) return false
    if (e.key === 'F10' && e.shiftKey) return false // the context menu key
    if (e.key !== 'F5' && !dbg.msh && !dbg.session) return false
    e.preventDefault()
    e.stopPropagation()
    if (e.repeat) return true
    if (e.key === 'F5') {
      if (e.shiftKey) dbg.actions.stop()
      else if (!dbg.paused && dbg.runnable && dbg.state !== 'running') setStatus(`F5 runs msh scripts: ${dbg.runnable}`)
      else dbg.actions.run()
    } else if (e.key === 'F6') dbg.actions.pause()
    else if (e.key === 'F9') dbg.actions.toggleBreakpoint(cursor.line)
    else if (e.key === 'F10') dbg.actions.stepOver()
    else if (e.shiftKey) dbg.actions.stepOut()
    else dbg.actions.stepInto()
    return true
  }

  const onKey = (e: globalThis.KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey
    const key = e.key.toLowerCase()
    const handled = () => {
      e.preventDefault()
      e.stopPropagation()
    }
    if (debugKey(e)) return
    if (mod && e.shiftKey && key === 'f') {
      handled()
      openSearch()
    } else if (mod && e.shiftKey && key === 'v') {
      handled()
      togglePreview()
    } else if (mod && key === 'f') {
      handled()
      openFind()
    } else if (mod && key === 's') {
      handled()
      save()
    } else if (mod && key === 'p') {
      handled()
      setPicker('files')
    } else if (mod && key === 'o') {
      handled()
      setPicker('project')
    } else if (mod && key === 'b') {
      handled()
      togglePanel()
    } else if (e.ctrlKey && key === '`') {
      handled()
      toggleDock()
    } else if (e.altKey && key === 'w' && active) {
      handled()
      close(active)
    }
  }

  const onEditorKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape' && find) return closeFind(false)
    if (e.key !== 'Tab' || e.ctrlKey || e.metaKey || e.altKey) return
    e.preventDefault()
    const el = e.currentTarget
    const { selectionStart: s, selectionEnd: end, value } = el
    edit(value.slice(0, s) + '  ' + value.slice(end))
    requestAnimationFrame(() => {
      el.selectionStart = el.selectionEnd = s + 2
      track()
    })
  }

  const lines = buf ? buf.text.split('\n') : []
  const node = buf && active ? lookup(active) : null
  const kind = node ? fileKind(node) : active && isSf(active) ? kindOfName(base(active)) : buf ? (markdown ? 'markdown' : 'text') : null
  const heading = markdown && buf ? lines.slice(0, cursor.line + 1).reverse().find((l) => /^#{1,6}\s/.test(l)) : undefined
  const place = buf && active ? locate(active) : null

  // Shortcuts work whenever this window is focused, also before anything inside it has focus,
  // but leave typing in another app's field (Spotlight, say) alone.
  const keys = useRef(onKey)
  keys.current = onKey
  useEffect(() => {
    if (wm.focusedPid !== win.pid) return
    const listen = (e: globalThis.KeyboardEvent) => {
      const el = document.activeElement
      if (el && !rootEl.current?.contains(el) && el.matches('input, textarea, [contenteditable]')) return
      keys.current(e)
    }
    window.addEventListener('keydown', listen)
    return () => window.removeEventListener('keydown', listen)
  }, [wm.focusedPid, win.pid])

  const closePicker = () => {
    setPicker(null)
    requestAnimationFrame(() => (text.current ?? rootEl.current)?.focus({ preventScroll: true }))
  }

  const pickProject = (dir: string) => {
    setRoot(dir)
    setExpanded(new Set([dir]))
    setSel(null)
    closePicker()
    setStatus(`Opened ${prettyPath(dir)}`)
  }

  return (
    <div className="zed" ref={rootEl} tabIndex={-1}>
      <div className="zed-title">
        <button data-picker-toggle className={`zed-chip zed-project ${picker === 'project' ? 'is-open' : ''}`} onClick={() => setPicker((p) => (p === 'project' ? null : 'project'))} title="Open a project (Ctrl+O)">
          {base(root)}
        </button>
        <span className="zed-chip zed-branch">⎇ main</span>
        <span className="spacer" />
        <button data-picker-toggle className="zed-chip zed-muted" onClick={() => setPicker((p) => (p === 'files' ? null : 'files'))} title="Go to file (Ctrl+P)">
          Go to file…
        </button>
      </div>

      {picker === 'project' && <ProjectPicker root={root} onPick={pickProject} onClose={closePicker} />}
      {picker === 'files' && (
        <FileFinder
          root={root}
          onPick={(p) => {
            closePicker()
            openFile(p)
          }}
          onClose={closePicker}
        />
      )}

      <div className={`zed-body ${narrow && drawer ? 'has-drawer' : ''}`}>
        {narrow && drawer && <div className="zed-scrim" onPointerDown={() => setDrawer(false)} aria-hidden />}
        {showPanel && (
          <nav
            className={`zed-panel ${dropOn === root ? 'is-drop' : ''}`}
            aria-label="Project"
            onKeyDown={onPanelKey}
            onContextMenu={(e) => openContextMenu(e, entryMenu(root, true, true))}
            onDragEnter={(e) => acceptDrop(e, root)}
            onDragOver={(e) => acceptDrop(e, root)}
            onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Element | null) && setDropOn(null)}
            onDrop={(e) => dropInto(e, root)}
          >
            <Tree dir={root} depth={0} ctx={tree} />
          </nav>
        )}

        <section className="zed-main">
          {tabs.length > 0 && (
            <div className="zed-tabs" role="tablist">
              {tabs.map((t) => {
                const dirty = t !== SEARCH && buffers[t] && buffers[t].text !== buffers[t].saved
                return (
                  <div
                    key={t}
                    role="tab"
                    aria-selected={t === active}
                    className={`zed-tab ${t === active ? 'is-active' : ''}`}
                    onClick={() => setActive(t)}
                    onAuxClick={(e) => e.button === 1 && close(t)}
                    title={t === SEARCH ? 'Project search' : where(t)}
                  >
                    {t === SEARCH ? <span className="zed-tab-icon">⌕</span> : <FileDot name={t} />}
                    <span className={views[t] === 'preview' ? 'zed-tab-preview' : ''}>{t === SEARCH ? `Search${query ? `: ${query}` : ''}` : views[t] === 'preview' ? `Preview ${base(t)}` : base(t)}</span>
                    <button
                      className={`zed-tab-x ${dirty ? 'is-dirty' : ''}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        close(t)
                      }}
                      aria-label="Close tab"
                    >
                      <span className="zed-dot">●</span>
                      <span className="zed-x">×</span>
                    </button>
                  </div>
                )
              })}
            </div>
          )}

          {active === SEARCH ? (
            <ProjectSearch root={root} query={query} setQuery={setQuery} onOpen={openFile} />
          ) : buf && active ? (
            <>
              <div className="zed-crumbs">
                <span className="zed-crumb-file">{base(active)}</span>
                {heading && (
                  <>
                    <span className="muted">›</span>
                    <span className="zed-crumb-heading">{heading}</span>
                  </>
                )}
                <span className="spacer" />
                <XedDebugToolbar ctl={dbg} />
                {markdown && (
                  <button
                    className={`zed-icon-btn ${view !== 'edit' ? 'is-on' : ''}`}
                    onClick={(e) => togglePreview(e.altKey)}
                    title={'Preview Markdown (Ctrl+Shift+V)\nAlt-click to open in a split'}
                    aria-label="Preview Markdown"
                  >
                    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
                      <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
                      <circle cx="8" cy="8" r="2" />
                    </svg>
                  </button>
                )}
                <button className={`zed-icon-btn ${find ? 'is-on' : ''}`} onClick={() => (find ? closeFind(false) : openFind())} title="Find in buffer (Ctrl+F)" aria-label="Find">
                  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
                    <circle cx="7" cy="7" r="4.5" />
                    <path d="M10.5 10.5l4 4" />
                  </svg>
                </button>
                <button className="zed-icon-btn" onClick={openSearch} title="Search the project (Ctrl+Shift+F)" aria-label="Search project">
                  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
                    <path d="M2 3.5h5M2 7h3M2 10.5h3" />
                    <circle cx="10" cy="9" r="3" />
                    <path d="M12.2 11.2l2.3 2.3" />
                  </svg>
                </button>
              </div>

              {find && view !== 'preview' && (
                <div className="zed-find">
                  <input
                    ref={findInput}
                    className="zed-find-input"
                    value={find.query}
                    placeholder="Search…"
                    autoFocus
                    spellCheck={false}
                    onChange={(e) => {
                      const q = e.target.value
                      setFind({ query: q, index: 0 })
                      const first = buf.text.toLowerCase().indexOf(q.toLowerCase())
                      if (q && first >= 0) scrollToLine(lineOf(first))
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        stepFind(e.shiftKey ? -1 : 1)
                      } else if (e.key === 'Escape') {
                        e.preventDefault()
                        e.stopPropagation()
                        closeFind(true)
                      }
                    }}
                  />
                  <span className={`zed-find-count ${find.query && !findMatches.length ? 'is-none' : ''}`}>{find.query ? (findMatches.length ? `${current + 1}/${findMatches.length}` : 'No results') : ''}</span>
                  <button className="zed-icon-btn" onClick={() => stepFind(-1)} disabled={!findMatches.length} title="Previous match (Shift+Enter)" aria-label="Previous match">
                    ↑
                  </button>
                  <button className="zed-icon-btn" onClick={() => stepFind(1)} disabled={!findMatches.length} title="Next match (Enter)" aria-label="Next match">
                    ↓
                  </button>
                  <button className="zed-icon-btn" onClick={() => closeFind(false)} title="Close (Esc)" aria-label="Close find">
                    ×
                  </button>
                </div>
              )}

              <div className={`zed-panes is-${view}`}>
                {view !== 'preview' && (
                  <div className="zed-editor" key={active} ref={editor}>
                    {/* msh files: clicking a line's gutter toggles its breakpoint (F9 and the Breakpoints list do it from the keyboard). */}
                    <div
                      className={`zed-gutter ${points ? 'is-debug' : ''}`}
                      aria-hidden
                      onClick={
                        points
                          ? (e) => {
                              const row = (e.target as HTMLElement).closest<HTMLElement>('[data-line]')
                              if (row) dbg.actions.toggleBreakpoint(Number(row.dataset.line))
                            }
                          : undefined
                      }
                    >
                      {lines.map((_, i) => {
                        const bp = points?.get(i + 1)
                        const cls = [
                          i === cursor.line ? 'is-current' : '',
                          bp === undefined ? '' : bp ? 'has-bp' : 'has-bp is-off',
                          bp !== undefined && mshAnalysis?.commands && !mshAnalysis.commands.has(i + 1) ? 'is-dead' : '',
                          dbg.pausedLine === i + 1 ? 'is-paused' : '',
                          errorLines.has(i + 1) ? 'has-error' : '',
                        ]
                          .filter(Boolean)
                          .join(' ')
                        return (
                          <div key={i} data-line={points ? i : undefined} className={cls || undefined}>
                            {i + 1}
                          </div>
                        )
                      })}
                    </div>
                    <div className="zed-code" style={{ height: lines.length * LINE + PAD * 2 }}>
                      <div className="zed-line-hl" style={{ top: PAD + cursor.line * LINE }} />
                      {dbg.pausedLine !== null && <div className={`zed-pause-hl ${dbg.differs ? 'is-stale' : ''}`} style={{ top: PAD + (dbg.pausedLine - 1) * LINE }} title={dbg.differs ? 'Paused here in the running source, which differs from this text' : undefined} />}
                      {find?.query && findMatches.length > 0 && (
                        <pre className="zed-hl zed-marks" aria-hidden>
                          <Marks text={buf.text} at={findMatches} len={find.query.length} current={current} />
                        </pre>
                      )}
                      <pre className="zed-hl" aria-hidden>
                        {mshAnalysis ? <MshHighlight text={buf.text} tokens={mshAnalysis.tokens} /> : kind === 'markdown' ? <Markdown text={buf.text} /> : buf.text}
                        {'\n'}
                      </pre>
                      <textarea
                        ref={text}
                        className="zed-input"
                        value={buf.text}
                        wrap="off"
                        spellCheck={false}
                        autoCapitalize="off"
                        autoComplete="off"
                        aria-label={`Editing ${where(active)}`}
                        readOnly={!!buf.loading || !!buf.error}
                        placeholder={buf.loading ? 'Loading from Seafile…' : buf.error}
                        onChange={(e) => {
                          edit(e.target.value)
                          track()
                        }}
                        onKeyDown={onEditorKey}
                        onKeyUp={track}
                        onClick={track}
                        onSelect={track}
                        onMouseMove={dbg.paused ? dbg.hoverAt : undefined}
                        onMouseLeave={dbg.hoverOut}
                      />
                      {dbg.hoverTip}
                    </div>
                  </div>
                )}
                {view !== 'edit' && (
                  <article className="zed-preview selectable">
                    <MarkdownPreview text={buf.text} />
                  </article>
                )}
              </div>
            </>
          ) : (
            <Welcome root={root} onOpen={openFile} onProject={() => setPicker('project')} />
          )}
          {dbg.open && (dbg.msh || dbg.session) && <XedDebugPanel ctl={dbg} path={active && active !== SEARCH ? active : null} caretLine={cursor.line} diagnostics={mshAnalysis?.diagnostics ?? []} commands={mshAnalysis?.commands ?? null} jump={(path, line, col) => openFile(path, { line, col, len: 0 })} />}
          {terms.length > 0 && (
            <div className="zed-dock" style={{ height: dockH, display: dock ? undefined : 'none' }}>
              <div className="zed-dock-grip" onPointerDown={resizeDock} role="separator" aria-orientation="horizontal" aria-label="Resize the terminal panel" />
              <div className="zed-dock-tabs" role="tablist" aria-label="Terminals">
                {terms.map((id) => (
                  <div key={id} role="tab" aria-selected={id === termOn} className={`zed-tab ${id === termOn ? 'is-active' : ''}`} onClick={() => setTermOn(id)} onAuxClick={(e) => e.button === 1 && closeTerm(id)} title={`Terminal ${id} · ${prettyPath(root)}`}>
                    <span className="zed-tab-icon">❯</span>
                    <span>Terminal {id}</span>
                    <button
                      className="zed-tab-x"
                      onClick={(e) => {
                        e.stopPropagation()
                        closeTerm(id)
                      }}
                      aria-label={`Close terminal ${id}`}
                      title="Close (or type exit)"
                    >
                      ×
                    </button>
                  </div>
                ))}
                <button className="zed-dock-btn" onClick={newTerm} title="New terminal" aria-label="New terminal">
                  +
                </button>
                <span className="spacer" />
                <button className="zed-dock-btn" onClick={() => setDock(false)} title="Hide the terminal panel (Ctrl+`)" aria-label="Hide the terminal panel">
                  ⌄
                </button>
              </div>
              {terms.map((id) => (
                <div key={id} className="zed-dock-term" style={{ display: id === termOn ? undefined : 'none' }}>
                  <Terminal win={termWin} embedded={{ cwd: root, onExit: () => closeTerm(id) }} />
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <footer className="zed-status">
        <button className={`zed-status-btn zed-status-icon ${showPanel ? 'is-on' : ''}`} onClick={togglePanel} title={`${showPanel ? 'Hide' : 'Show'} the project panel (Ctrl+B${narrow ? ', or swipe in from the left' : ''})`} aria-label="Toggle project panel" aria-pressed={showPanel}>
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <rect x="3" y="4" width="18" height="16" />
            <path d="M9 4v16" />
          </svg>
        </button>
        <span className="zed-status-msg">{status ?? (buf && active ? `${where(active)}${buf.text !== buf.saved ? ' •' : ''}` : prettyPath(root))}</span>
        {active && browserPathOf(active) !== null && (
          <span className="zed-status-browser" title="Kept in this browser only: clearing the site's data deletes it. Set up Seafile in Settings → Integrations to keep files for good.">
            Browser only
          </span>
        )}
        <span className="spacer" />
        {buf && active && (
          <>
            <span>
              {cursor.line + 1}:{cursor.col + 1}
            </span>
            <span>{kind === 'markdown' ? 'Markdown' : kind && KIND_LABEL[kind] !== 'Text' ? KIND_LABEL[kind] : 'Plain Text'}</span>
            <span>{place?.ro ? 'read-only' : place?.sf ? 'Seafile' : 'UTF-8'}</span>
          </>
        )}
        {(dbg.msh || dbg.session) && (
          <button
            className={`zed-status-btn zed-status-icon xed-status-debug ${dbg.open ? 'is-on' : ''} ${mshAnalysis?.diagnostics.length ? 'has-problems' : ''}`}
            onClick={() => dbg.setOpen(!dbg.open)}
            title={`${dbg.open ? 'Hide' : 'Show'} the debug panel${mshAnalysis?.diagnostics.length ? ` (${mshAnalysis.diagnostics.length} problem)` : ''}`}
            aria-label="Toggle debug panel"
            aria-pressed={dbg.open}
          >
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden>
              <path d="M5.5 5.5h5v5.5a2.5 2.5 0 0 1-5 0zM6.5 5.5a1.5 1.5 0 0 1 3 0M3 8h2.5M10.5 8H13M3.5 12l2-1M12.5 12l-2-1M3.5 4.5l2 1.5M12.5 4.5l-2 1.5" />
            </svg>
            {mshAnalysis?.diagnostics.length ? <span>{mshAnalysis.diagnostics.length}</span> : null}
          </button>
        )}
        <button className={`zed-status-btn zed-status-icon ${dock ? 'is-on' : ''}`} onClick={toggleDock} title={`${dock ? 'Hide' : 'Show'} the terminal (Ctrl+\`)`} aria-label="Toggle terminal panel" aria-pressed={dock}>
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="3" y="4" width="18" height="16" />
            <path d="M7 9l3 3-3 3M12 15h5" />
          </svg>
        </button>
      </footer>
    </div>
  )
}


// --- Project panel -------------------------------------------------------------------------------

type TreeCtx = {
  open: Set<string>
  active: string | null
  sel: string | null
  dropOn: string | null
  /** Seafile paths cut for pasting, shown faded */
  cut: string[]
  pending: Pending | null
  onToggle: (p: string) => void
  onOpen: (p: string) => void
  onSelect: (p: string) => void
  onMenu: (e: MouseEvent, p: string, isDir: boolean, isRoot?: boolean) => void
  onPendingDone: (name: string | null) => void
  onDragStart: (e: DragEvent, p: string) => void
  onDragEnd: () => void
  onDragOver: (e: DragEvent, dir: string) => void
  onDrop: (e: DragEvent, dir: string) => void
  onLocked: (sf: string) => void
}

const indent = (depth: number) => 8 + depth * 12

/** A folder of the project panel, through the mounts: Seafile folders are listed when opened. */
function Tree({ dir, depth, ctx }: { dir: string; depth: number; ctx: TreeCtx }) {
  useBrowserFiles() // the terminal or Files may change what is kept in this browser
  const open = ctx.open.has(dir)
  const w = whereIs(dir)
  const sf = w.kind === 'sf' && w.sf !== SF ? w.sf : null
  const listing = useDir(open ? sf : null)
  const node = lookup(dir)
  const children = node?.type === 'dir' ? [...node.children.values()].sort((a, b) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || a.name.localeCompare(b.name)) : []
  const self = depth === 0
  const { pending } = ctx
  const adding = pending && pending.kind !== 'rename' && pending.dir === dir ? pending : null
  const note = (text: ReactNode) => (
    <li className="zed-note" style={{ paddingLeft: indent(depth + 1) + 16 }}>
      {text}
    </li>
  )
  const dropHandlers = (target: string) => ({
    onDragEnter: (e: DragEvent) => ctx.onDragOver(e, target),
    onDragOver: (e: DragEvent) => ctx.onDragOver(e, target),
    onDrop: (e: DragEvent) => ctx.onDrop(e, target),
  })
  return (
    <ul className="zed-tree" role={self ? 'tree' : 'group'}>
      {self && (
        <li>
          <button className={`zed-row zed-root ${ctx.dropOn === dir ? 'is-drop' : ''}`} onClick={() => ctx.onToggle(dir)} onContextMenu={(e) => ctx.onMenu(e, dir, true, true)} {...dropHandlers(dir)}>
            <span className="zed-caret">{open ? '▾' : '▸'}</span>
            {base(dir)}
          </button>
        </li>
      )}
      {open && (
        <>
          {adding && (
            <li>
              <NameInput initial="" folder={adding.kind === 'folder'} pad={indent(depth + 1)} onDone={ctx.onPendingDone} />
            </li>
          )}
          {w.kind === 'missing' && note(w.loading ? 'Loading…' : 'Not connected')}
          {sf &&
            !listing.listing &&
            (listing.status === 423 ? (
              note(
                <button className="zed-link" onClick={() => ctx.onLocked(sf)}>
                  Locked: unlock it in Files
                </button>,
              )
            ) : listing.error ? (
              note(listing.error)
            ) : listing.loading ? (
              note('Loading…')
            ) : null)}
          {children.map((c: Node) => {
            const path = join(dir, c.name)
            const isDir = c.type === 'dir'
            const pad = indent(depth + 1)
            if (pending?.kind === 'rename' && pending.path === path)
              return (
                <li key={path}>
                  <NameInput initial={c.name} folder={isDir} pad={pad} onDone={ctx.onPendingDone} />
                </li>
              )
            const cut = !!c.sf && ctx.cut.includes(c.sf)
            const cls = `zed-row ${path === ctx.active ? 'is-active' : ''} ${path === ctx.sel ? 'is-selected' : ''} ${ctx.dropOn === path ? 'is-drop' : ''} ${cut ? 'is-cut' : ''}`
            return (
              <li key={path}>
                <button
                  className={cls}
                  style={{ paddingLeft: pad }}
                  draggable={!!c.sf}
                  onClick={() => {
                    ctx.onSelect(path)
                    if (isDir) ctx.onToggle(path)
                    else ctx.onOpen(path)
                  }}
                  onContextMenu={(e) => {
                    ctx.onSelect(path)
                    ctx.onMenu(e, path, isDir)
                  }}
                  onDragStart={(e) => ctx.onDragStart(e, path)}
                  onDragEnd={ctx.onDragEnd}
                  {...dropHandlers(isDir ? path : dir)}
                >
                  {isDir ? <span className="zed-caret">{ctx.open.has(path) ? '▾' : '▸'}</span> : <FileDot name={c.name} />}
                  {c.name}
                </button>
                {isDir && ctx.open.has(path) && <Tree dir={path} depth={depth + 1} ctx={ctx} />}
              </li>
            )
          })}
        </>
      )}
    </ul>
  )
}

/** The name field of a rename or a new entry: Enter or leaving it commits, Escape cancels. */
function NameInput({ initial, folder, pad, onDone }: { initial: string; folder: boolean; pad: number; onDone: (name: string | null) => void }) {
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    // The name without its extension, as Zed selects it.
    const dot = folder ? -1 : initial.lastIndexOf('.')
    el.setSelectionRange(0, dot > 0 ? dot : initial.length)
  }, [])
  const finish = (name: string | null) => {
    if (done.current) return
    done.current = true
    onDone(name)
  }
  return (
    <div className="zed-row zed-naming" style={{ paddingLeft: pad }}>
      {folder ? <span className="zed-caret">▸</span> : <FileDot name={initial} />}
      <input
        ref={ref}
        className="zed-name-input"
        defaultValue={initial}
        spellCheck={false}
        autoComplete="off"
        aria-label={initial ? `Rename ${initial}` : `New ${folder ? 'folder' : 'file'} name`}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') {
            e.preventDefault()
            finish(e.currentTarget.value)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            finish(null)
          }
        }}
        onBlur={(e) => finish(e.currentTarget.value)}
      />
    </div>
  )
}

const DOT: Record<string, string> = { md: 'var(--blue)', txt: 'var(--muted)', url: 'var(--cyan)', game: 'var(--green)', svg: 'var(--magenta)', conf: 'var(--yellow)' }

function FileDot({ name }: { name: string }) {
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
  return <span className="zed-file-dot" style={{ background: DOT[ext] ?? 'var(--line-strong)' }} />
}

// --- Pickers -------------------------------------------------------------------------------------

type PickItem = { id: string; label: string; detail?: string; section?: string; checked?: boolean; run: () => void }

/** A searchable list with keyboard navigation, for the project picker and the file finder. */
function Palette({ placeholder, items, query, setQuery, onClose, className }: { placeholder: string; items: PickItem[]; query: string; setQuery: (q: string) => void; onClose: () => void; className: string }) {
  const [sel, setSel] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    setSel(0)
  }, [query])
  useEffect(() => {
    const away = (e: PointerEvent) => {
      const t = e.target as HTMLElement
      if (!ref.current?.contains(t) && !t.closest?.('[data-picker-toggle]')) onClose()
    }
    window.addEventListener('pointerdown', away, true)
    return () => window.removeEventListener('pointerdown', away, true)
  }, [onClose])
  useEffect(() => {
    list.current?.querySelector('.is-sel')?.scrollIntoView({ block: 'nearest' })
  }, [sel])
  let section: string | undefined
  return (
    <div className={`zed-palette ${className}`} ref={ref}>
      <input
        className="zed-palette-input"
        autoFocus
        value={query}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            setSel((s) => Math.max(0, Math.min(items.length - 1, s + (e.key === 'ArrowDown' ? 1 : -1))))
          } else if (e.key === 'Enter') {
            e.preventDefault()
            items[sel]?.run()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            onClose()
          }
        }}
      />
      <div className="zed-palette-list" ref={list}>
        {items.length === 0 && <div className="zed-palette-empty">No matches</div>}
        {items.map((it, i) => {
          const head = it.section !== section ? it.section : undefined
          section = it.section
          return (
            <div key={it.id}>
              {head && <div className="zed-palette-section">{head}</div>}
              <button className={`zed-palette-item ${i === sel ? 'is-sel' : ''}`} onPointerEnter={() => setSel(i)} onClick={it.run}>
                <span>{it.label}</span>
                {it.checked && <span className="zed-check">✓</span>}
                {it.detail && <span className="zed-palette-detail">{it.detail}</span>}
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** Folders that make sense as a project: home, each project and contribution, and a few system ones. */
function recentProjects() {
  const kids = (dir: string) => {
    const n = lookup(dir)
    return n?.type === 'dir' ? [...n.children.values()].filter((c) => c.type === 'dir').map((c) => join(dir, c.name)) : []
  }
  // With Seafile on ~, the site's own home is /srv/site; every library is under /mnt/seafile.
  const site = whereIs(HOME).kind === 'sf' ? ['/srv/site'] : []
  return [HOME, ...kids(`${HOME}/projects`), ...kids(`${HOME}/contributions`), `${HOME}/games`, ...site, ...kids('/mnt/seafile'), '/etc', '/tmp', '/'].filter((p) => lookup(p)?.type === 'dir')
}

function ProjectPicker({ root, onPick, onClose }: { root: string; onPick: (dir: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [all, setAll] = useState(false)
  const items = useMemo<PickItem[]>(() => {
    const q = query.trim().toLowerCase()
    const pick = (p: string, section: string): PickItem => ({ id: `${section}:${p}`, label: base(p), detail: prettyPath(p), section, checked: p === root, run: () => onPick(p) })
    if (q || all) {
      const dirs = walk('/').filter((p) => lookup(p)?.type === 'dir')
      return dirs.filter((p) => !q || `${prettyPath(p)}\n${p}`.toLowerCase().includes(q)).slice(0, 60).map((p) => pick(p, 'Folders'))
    }
    return [
      pick(root, 'This Window'),
      ...recentProjects().filter((p) => p !== root).map((p) => pick(p, 'Recent Projects')),
      { id: 'all', label: 'Open Local Folder…', section: ' ', run: () => setAll(true) },
    ]
  }, [query, all, root, onPick])
  return <Palette className="is-project" placeholder="Search projects…" items={items} query={query} setQuery={setQuery} onClose={onClose} />
}

/**
 * Fetches what is in Seafile under a folder, for the file finder (`find`, names) and project
 * search (`grep`, names and text), as far as the terminal's limits go. True once it is in.
 */
function useFetched(root: string, cmd: 'find' | 'grep', on = true) {
  const [done, setDone] = useState<string | null>(null)
  useEffect(() => {
    if (!on) return
    let live = true
    prepare(root, cmd, cmd === 'grep' ? ['-r', root] : [root])
      .catch(() => {})
      .finally(() => live && setDone(`${cmd}:${root}`))
    return () => {
      live = false
    }
  }, [root, cmd, on])
  return done === `${cmd}:${root}`
}

/** Fuzzy match: every character of the query, in order. */
const fuzzy = (hay: string, q: string) => {
  let i = 0
  for (const ch of hay) if (ch === q[i]) i++
  return i === q.length
}

function FileFinder({ root, onPick, onClose }: { root: string; onPick: (p: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const fetched = useFetched(root, 'find')
  const items = useMemo<PickItem[]>(() => {
    const q = query.toLowerCase().replace(/\s+/g, '')
    const files = walk(root).filter((p) => lookup(p)?.type === 'file')
    const rel = (p: string) => (root === '/' ? p.slice(1) : p.slice(root.length + 1))
    return files
      .filter((p) => !q || fuzzy(rel(p).toLowerCase(), q))
      .sort((a, b) => Number(!base(a).toLowerCase().includes(q)) - Number(!base(b).toLowerCase().includes(q)) || rel(a).length - rel(b).length)
      .slice(0, 80)
      .map((p) => ({ id: p, label: base(p), detail: rel(p).split('/').slice(0, -1).join('/'), run: () => onPick(p) }))
  }, [query, root, onPick, fetched])
  return <Palette className="is-files" placeholder="Search files by name…" items={items} query={query} setQuery={setQuery} onClose={onClose} />
}

// --- Project search ------------------------------------------------------------------------------

function ProjectSearch({ root, query, setQuery, onOpen }: { root: string; query: string; setQuery: (q: string) => void; onOpen: (p: string, at: Omit<Jump, 'path'>) => void }) {
  const fetched = useFetched(root, 'grep', query.length >= 2)
  const results = useMemo(() => {
    if (query.length < 2) return []
    const q = query.toLowerCase()
    const out: { path: string; hits: { line: number; col: number; text: string }[] }[] = []
    let total = 0
    for (const path of walk(root)) {
      if (!searchable(path) || total >= 500) continue
      const hits = read(path)
        .split('\n')
        .flatMap((text, line) => {
          const col = text.toLowerCase().indexOf(q)
          return col >= 0 ? [{ line, col, text }] : []
        })
      if (hits.length) {
        out.push({ path, hits })
        total += hits.length
      }
    }
    return out
  }, [query, root, fetched])
  const count = results.reduce((n, r) => n + r.hits.length, 0)
  const rel = (p: string) => (root === '/' ? p.slice(1) : p.slice(root.length + 1))

  return (
    <div className="zed-search">
      <div className="zed-search-bar">
        <input className="zed-find-input" autoFocus value={query} placeholder={`Search ${prettyPath(root)}…`} spellCheck={false} onChange={(e) => setQuery(e.target.value)} />
        <span className="zed-find-count">{query.length < 2 ? '' : count ? `${count} result${count === 1 ? '' : 's'} in ${results.length} file${results.length === 1 ? '' : 's'}${fetched ? '' : '…'}` : fetched ? 'No results' : 'Searching…'}</span>
      </div>
      <div className="zed-search-results">
        {query.length < 2 && <p className="muted zed-search-hint">Search every file in {prettyPath(root)}. Click a result to jump to it.</p>}
        {results.map((r) => (
          <section key={r.path} className="zed-search-file">
            <header>
              <FileDot name={r.path} />
              <span>{base(r.path)}</span>
              <span className="muted">{rel(r.path).split('/').slice(0, -1).join('/')}</span>
            </header>
            {r.hits.map((h) => {
              const lead = Math.max(0, h.col - 40)
              return (
                <button key={h.line} className="zed-search-hit" onClick={() => onOpen(r.path, { line: h.line, col: h.col, len: query.length })}>
                  <span className="zed-search-ln">{h.line + 1}</span>
                  <span className="zed-search-text">
                    {lead ? '…' : ''}
                    {h.text.slice(lead, h.col).trimStart()}
                    <mark>{h.text.slice(h.col, h.col + query.length)}</mark>
                    {h.text.slice(h.col + query.length, h.col + query.length + 120)}
                  </span>
                </button>
              )
            })}
          </section>
        ))}
      </div>
    </div>
  )
}

function Welcome({ root, onOpen, onProject }: { root: string; onOpen: (p: string) => void; onProject: () => void }) {
  const picks = ['README.md', 'cv.md', 'contact.txt'].map((n) => join(root, n)).filter((p) => lookup(p)?.type === 'file')
  return (
    <div className="zed-welcome">
      <svg viewBox="0 0 48 48" width="56" height="56" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden>
        <path d="M13 13h22L13 35h22" />
        <path d="M19 24h10" />
      </svg>
      <p className="zed-welcome-title">Xed</p>
      <p className="muted">Pick a file in the project panel, or:</p>
      <div className="zed-welcome-list">
        {picks.map((p) => (
          <button key={p} className="zed-row" onClick={() => onOpen(p)}>
            <FileDot name={p} />
            {base(p)}
          </button>
        ))}
        <button className="zed-row" onClick={onProject}>
          <span className="zed-caret">▸</span>
          Open another project…
        </button>
      </div>
      <p className="muted zed-keys">Ctrl+P file · Ctrl+F find · Ctrl+Shift+F search project · Ctrl+Shift+V preview · Ctrl+S save</p>
    </div>
  )
}

// --- Highlighting --------------------------------------------------------------------------------
// Line based, like a tree-sitter grammar would colour it: headings, quotes, list markers, fences,
// and inline code, bold, italics and links. Every character stays put so the caret lines up.

/** Breakpoints of `path` follow an edit from `before` to `after`: lines inserted or removed above them move them. */
function followEdit(path: string, before: string, after: string) {
  const max = Math.min(before.length, after.length)
  let p = 0
  while (p < max && before.charCodeAt(p) === after.charCodeAt(p)) p++
  let s = 0
  while (s < max - p && before.charCodeAt(before.length - 1 - s) === after.charCodeAt(after.length - 1 - s)) s++
  const newlines = (t: string, from: number, to: number) => {
    let n = 0
    for (let i = from; i < to; i++) if (t.charCodeAt(i) === 10) n++
    return n
  }
  const removed = newlines(before, p, before.length - s)
  const added = newlines(after, p, after.length - s)
  if (removed === added) return
  // A change that starts mid-line leaves that line where it is; lines after it move.
  const line = newlines(before, 0, p) + 1
  shiftBreakpoints(path, p === 0 || before[p - 1] === '\n' ? line : line + 1, removed, added)
}

function Marks({ text, at, len, current }: { text: string; at: number[]; len: number; current: number }) {
  const out: ReactNode[] = []
  let last = 0
  at.forEach((start, i) => {
    out.push(text.slice(last, start))
    out.push(<mark key={start} className={i === current ? 'is-current' : ''}>{text.slice(start, start + len)}</mark>)
    last = start + len
  })
  out.push(text.slice(last))
  return <>{out}</>
}

function Markdown({ text }: { text: string }) {
  let fenced = false
  const out: ReactNode[] = []
  text.split('\n').forEach((line, i) => {
    if (i) out.push('\n')
    if (/^\s*```/.test(line)) {
      fenced = !fenced
      out.push(<span key={i} className="md-fence">{line}</span>)
      return
    }
    if (fenced) return void out.push(<span key={i} className="md-code">{line}</span>)
    const h = /^(#{1,6}\s)(.*)$/.exec(line)
    if (h) return void out.push(<span key={i} className={`md-h md-h${h[1].length - 1}`}>{h[1]}{inline(h[2], i)}</span>)
    const q = /^(\s*>\s?)(.*)$/.exec(line)
    if (q) return void out.push(<span key={i} className="md-quote"><span className="md-punct">{q[1]}</span>{inline(q[2], i)}</span>)
    const li = /^(\s*)([-*+]|\d+[.)])(\s+)(.*)$/.exec(line)
    if (li) return void out.push(<span key={i}>{li[1]}<span className="md-bullet">{li[2]}</span>{li[3]}{inline(li[4], i)}</span>)
    out.push(<span key={i}>{inline(line, i)}</span>)
  })
  return <>{out}</>
}

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*|__[^_]+__)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(\[[^\]]+\]\([^)]+\))|(https?:\/\/[^\s)]+)/g

function inline(s: string, key: number): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  for (const m of s.matchAll(INLINE)) {
    if (m.index > last) out.push(s.slice(last, m.index))
    const cls = m[1] ? 'md-code' : m[2] ? 'md-bold' : m[3] ? 'md-em' : m[4] ? 'md-link' : 'md-url'
    out.push(<span key={`${key}-${m.index}`} className={cls}>{m[0]}</span>)
    last = m.index + m[0].length
  }
  if (last < s.length) out.push(s.slice(last))
  return out
}
