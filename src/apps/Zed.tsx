import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { useWM, type WinState } from '../os/wm'
import { fileKind, HOME, KIND_LABEL, kindOfName, lookup as siteLookup, prettyPath, type DirNode, type Node } from '../terminal/vfs'
import { lookup, makeDir, MAX_TEXT, prepare, removePath, touchFile, transfer, walk } from '../terminal/fs'
import { cachedDir, deleteNote, DRAG_FILES, dropOp, getClipboard, getDragged, getLibrary, isInside, isSf, libraryName, openSeafile, parseSf, readText, seafileWebUrl, setClipboard, setDragged, SF, sfPath, shareLink, transferItems, useClipboard, useDir, writeText } from '../data/seafile'
import { mounts, posixOf, useMounts, whereIs } from '../data/mounts'
import { droppedFiles, hasOsFiles, uploadFiles } from '../data/uploads'
import { openContextMenu, type MenuItem } from '../os/ContextMenu'
import { openLink } from '../data/links'
import { ask } from '../os/Dialogs'

// A small Zed: a project panel on the left, tabs, and an editor with line numbers, a current-line
// highlight and Markdown highlighting, plus a Markdown preview, find (Ctrl+F), project search
// (Ctrl+Shift+F) and file finder (Ctrl+P). Markdown opened from elsewhere starts in the preview.
// The project panel sees the filesystem the way the terminal does, through /etc/fstab, so a
// Seafile library on ~ or under /mnt/seafile is there to browse and edit: Ctrl+S saves back to
// Seafile. The site's own files are read-only, except /tmp. Right-clicking the panel creates,
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

/** Where a file really is: its Seafile path (null for the site's own files), and whether it is read-only. */
function locate(path: string): { sf: string | null; ro: boolean } {
  if (isSf(path)) return { sf: path, ro: getLibrary(parseSf(path)!.repo)?.permission === 'r' }
  const w = whereIs(path)
  if (w.kind === 'sf') return w.sf === SF ? { sf: null, ro: true } : { sf: w.sf, ro: w.ro }
  if (w.kind === 'missing') return { sf: null, ro: true }
  return { sf: null, ro: !/^\/tmp\/[^/]+$/.test(path) }
}

/** Whether files and folders can be made and removed in a folder: /tmp, or Seafile you may write to. */
function canWriteIn(dir: string) {
  if (dir === '/tmp') return true
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

/** The Seafile path to cut, copy or drag for an entry: Seafile files and folders only. */
function clipOf(path: string) {
  const sf = locate(path).sf
  return sf && !isMount(path) ? sf : null
}

const sfParentOf = (sf: string) => {
  const at = parseSf(sf)!
  return sfPath(at.repo, at.p.split('/').slice(0, -1).join('/') || '/')
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
  const [views, setViews] = useState<Record<string, View>>({})
  const [active, setActive] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([root]))
  const [cursor, setCursor] = useState({ line: 0, col: 0 })
  const [status, setStatus] = useState<string | null>(null)
  const [panel, setPanel] = useState(true)
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
    const { sf } = locate(path)
    if (sf) loadSeafile(path, sf)
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

  /** A click in the panel: text in a tab, Seafile pictures, PDFs and the like in their own app. */
  const openFromPanel = (path: string) => {
    const { sf } = locate(path)
    if (sf && !TEXTUAL.has(kindOfName(base(path)))) return void openSeafile(wm, sf).catch((e: Error) => setStatus(e.message))
    const node = lookup(path)
    if (sf && node?.type === 'file' && (node.size ?? 0) > MAX_TEXT) return setStatus(`${base(path)} is too big to edit here`)
    openFile(path)
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

  const save = () => {
    if (!buf || !active) return
    const { sf, ro } = locate(active)
    if (sf) {
      if (buf.loading || buf.error) return
      if (ro) return setStatus(`Not saved: ${libraryName(parseSf(sf)!.repo)} is read-only for you`)
      const path = active
      const text = buf.text
      setStatus(`Saving ${where(path)}…`)
      writeText(sf, text)
        .then(() => {
          setBuffers((bs) => (bs[path] ? { ...bs, [path]: { ...bs[path], saved: text } } : bs))
          setStatus(`Saved ${where(path)} to Seafile`)
        })
        .catch((e: Error) => setStatus(`Not saved: ${e.message}`))
      return
    }
    if (!write(active, buf.text)) return setStatus('Read-only file system. Only /tmp and Seafile are writable.')
    setBuffers((bs) => ({ ...bs, [active]: { ...bs[active], saved: bs[active].text } }))
    setStatus(`Saved ${prettyPath(active)}`)
  }

  // --- project panel: changing files ------------------------------------------------------------

  /** Open tabs (and everything keyed by path) follow a file or folder that moved. */
  const rekey = (from: string, to: string) => {
    const move = (p: string) => (p === from ? to : p.startsWith(`${from}/`) ? to + p.slice(from.length) : p)
    const moveKeys = <T,>(o: Record<string, T>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [move(k), v]))
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
    const note = sf ? await deleteNote([sf]) : { final: true, body: 'It was only ever in memory.' }
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

  /** The Seafile folder the clipboard can be pasted into, or null. */
  const pasteInto = (dir: string) => {
    const c = getClipboard()
    const w = whereIs(dir)
    if (!c || w.kind !== 'sf' || !canWriteIn(dir) || isInside(c.paths, w.sf)) return null
    if (c.op === 'move' && c.paths.every((p) => sfParentOf(p) === w.sf)) return null
    return w.sf
  }

  /** Moves or copies Seafile paths into a folder of the panel; open tabs follow what moved. */
  const carry = async (op: 'move' | 'copy', paths: string[], dir: string, into: string) => {
    const what = paths.length === 1 ? base(paths[0]) : `${paths.length} items`
    const moved = op === 'move' ? paths.map((p) => [posixOf(p), join(dir, base(p))] as const) : []
    setStatus(`${op === 'move' ? 'Moving' : 'Copying'} ${what}…`)
    try {
      await transferItems(op, paths, into)
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
      return w.kind === 'sf' ? w.sf : null
    }
    if (w.kind !== 'sf' || !canWriteIn(dir)) return null
    if (!getDragged() && hasOsFiles(e.dataTransfer)) return ok('copy')
    const paths = getDragged()
    if (!paths || !e.dataTransfer.types.includes(DRAG_FILES) || isInside(paths, w.sf)) return null
    const op = dropOp(paths, w.sf, e)
    if (op === 'move' && paths.every((p) => sfParentOf(p) === w.sf)) return null
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
    const op = dropOp(paths, into, e)
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

  const edit = (value: string) => active && setBuffers((bs) => ({ ...bs, [active]: { ...bs[active], text: value } }))

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

  const onKey = (e: globalThis.KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey
    const key = e.key.toLowerCase()
    const handled = () => {
      e.preventDefault()
      e.stopPropagation()
    }
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
      setPanel((p) => !p)
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

      <div className="zed-body">
        {panel && (
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
                    <div className="zed-gutter" aria-hidden>
                      {lines.map((_, i) => (
                        <div key={i} className={i === cursor.line ? 'is-current' : ''}>
                          {i + 1}
                        </div>
                      ))}
                    </div>
                    <div className="zed-code" style={{ height: lines.length * LINE + PAD * 2 }}>
                      <div className="zed-line-hl" style={{ top: PAD + cursor.line * LINE }} />
                      {find?.query && findMatches.length > 0 && (
                        <pre className="zed-hl zed-marks" aria-hidden>
                          <Marks text={buf.text} at={findMatches} len={find.query.length} current={current} />
                        </pre>
                      )}
                      <pre className="zed-hl" aria-hidden>
                        {kind === 'markdown' ? <Markdown text={buf.text} /> : buf.text}
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
                      />
                    </div>
                  </div>
                )}
                {view !== 'edit' && (
                  <article className="zed-preview">
                    <MarkdownPreview text={buf.text} />
                  </article>
                )}
              </div>
            </>
          ) : (
            <Welcome root={root} onOpen={openFile} onProject={() => setPicker('project')} />
          )}
        </section>
      </div>

      <footer className="zed-status">
        <span className="zed-status-msg">{status ?? (buf && active ? `${where(active)}${buf.text !== buf.saved ? ' •' : ''}` : prettyPath(root))}</span>
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
        <button className="zed-status-btn" onClick={() => wm.openNew('terminal', { run: `cd ${prettyPath(root)}`, t: String(Date.now()) })} title="Open a terminal in this project">
          ⌨
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
      <p className="zed-welcome-title">Zed</p>
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

// --- Markdown preview ----------------------------------------------------------------------------
// Enough CommonMark for these files: headings, paragraphs, nested lists, quotes, fences, rules
// and the inline marks above.

function rich(s: string, key: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  for (const m of s.matchAll(INLINE)) {
    if (m.index > last) out.push(s.slice(last, m.index))
    const k = `${key}-${m.index}`
    const t = m[0]
    if (m[1]) out.push(<code key={k}>{t.slice(1, -1)}</code>)
    else if (m[2]) out.push(<strong key={k}>{rich(t.slice(2, -2), k)}</strong>)
    else if (m[3]) out.push(<em key={k}>{rich(t.slice(1, -1), k)}</em>)
    else if (m[4]) {
      const [, label, href] = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(t)!
      out.push(<a key={k} href={href} target="_blank" rel="noopener noreferrer">{rich(label, k)}</a>)
    } else out.push(<a key={k} href={t} target="_blank" rel="noopener noreferrer">{t}</a>)
    last = m.index + t.length
  }
  if (last < s.length) out.push(s.slice(last))
  return out
}

const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/
const BLOCK_START = /^\s*(#{1,6}\s|>|```|([-*+]|\d+[.)])\s|(---|\*\*\*|___)\s*$)/

type Item = { indent: number; ordered: boolean; text: string }

function list(items: Item[], key: string): ReactNode {
  const out: ReactNode[] = []
  const indent = items[0].indent
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    const kids: Item[] = []
    while (items[i + 1] && items[i + 1].indent > indent) kids.push(items[++i])
    // A task list item: "- [ ] todo" or "- [x] done".
    const task = /^\[( |x|X)\]\s+(.*)$/.exec(item.text)
    out.push(
      <li key={i} className={task ? `md-task ${task[1] !== ' ' ? 'is-done' : ''}` : undefined}>
        {task && <input type="checkbox" checked={task[1] !== ' '} readOnly tabIndex={-1} aria-hidden />}
        {rich(task ? task[2] : item.text, `${key}-${i}`)}
        {kids.length > 0 && list(kids, `${key}-${i}`)}
      </li>,
    )
  }
  return items[0].ordered ? <ol key={key}>{out}</ol> : <ul key={key}>{out}</ul>
}

export function MarkdownPreview({ text }: { text: string }) {
  const lines = text.split('\n')
  const out: ReactNode[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const key = String(i)
    if (!line.trim()) {
      i++
      continue
    }
    if (/^\s*```/.test(line)) {
      const lang = line.trim().slice(3)
      const body: string[] = []
      while (++i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i])
      i++
      out.push(<pre key={key} data-lang={lang || undefined}><code>{body.join('\n')}</code></pre>)
      continue
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      const Tag = `h${h[1].length}` as 'h1'
      out.push(<Tag key={key}>{rich(h[2], key)}</Tag>)
      i++
      continue
    }
    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
      out.push(<hr key={key} />)
      i++
      continue
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''))
      out.push(<blockquote key={key}><MarkdownPreview text={body.join('\n')} /></blockquote>)
      continue
    }
    if (LIST.test(line)) {
      const items: Item[] = []
      while (i < lines.length) {
        const m = LIST.exec(lines[i])
        if (m) items.push({ indent: m[1].length, ordered: /\d/.test(m[2]), text: m[3] })
        else if (lines[i].trim() && /^\s+/.test(lines[i]) && items.length) items[items.length - 1].text += ' ' + lines[i].trim()
        else break
        i++
      }
      out.push(list(items, key))
      continue
    }
    const para: string[] = []
    while (i < lines.length && lines[i].trim() && (!para.length || !BLOCK_START.test(lines[i]))) para.push(lines[i++].trim())
    out.push(<p key={key}>{rich(para.join(' '), key)}</p>)
  }
  return <>{out}</>
}
