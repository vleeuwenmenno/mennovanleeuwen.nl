import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useWM, type WinState } from '../os/wm'
import { fileKind, HOME, KIND_LABEL, kindOfName, lookup, prettyPath, walk, type DirNode, type Node } from '../terminal/vfs'
import { isSf, libraryName, parseSf, readText, writeText } from '../data/seafile'

// A small Zed: a project panel on the left, tabs, and an editor with line numbers, a current-line
// highlight and Markdown highlighting, plus a Markdown preview, find (Ctrl+F), project search
// (Ctrl+Shift+F) and file finder (Ctrl+P). Markdown opened from elsewhere starts in the preview. Every file can be edited, but only /tmp is writable,
// so Ctrl+S saves there and politely refuses everywhere else. Opening another file while Zed is
// open adds a tab to the frontmost window, as the real one does. The project is the home folder
// until another one is picked from the project name in the title bar.

const LINE = 20 // px; the gutter, the highlight layers and the textarea share it
const PAD = 12 // px above the first line
const SEARCH = 'search://' // the project search tab

/** loading: a Seafile file on its way in; error: it could not be read (nothing to save over it). */
type Buffer = { text: string; saved: string; loading?: boolean; error?: string }
type View = 'edit' | 'preview' | 'split'
type Jump = { path: string; line: number; col: number; len: number }

const join = (dir: string, name: string) => `${dir === '/' ? '' : dir}/${name}`
const base = (path: string) => (path === '/' ? '/' : path.split('/').pop()!)
/** Where a file is, for tabs and the status bar: Seafile files by library. */
const where = (path: string) => {
  const at = parseSf(path)
  return at ? `${libraryName(at.repo)}${at.p}` : prettyPath(path)
}
const isMarkdown = (path: string) => /\.md$/i.test(path)

function read(path: string) {
  const node = lookup(path)
  return node?.type === 'file' ? node.content() : ''
}

/** Writes a file in /tmp, the only writable directory. Returns false anywhere else. */
function write(path: string, text: string) {
  const m = /^\/tmp\/([^/]+)$/.exec(path)
  const tmp = lookup('/tmp') as DirNode | null
  if (!m || !tmp) return false
  tmp.children.set(m[1], { type: 'file', name: m[1], content: () => text, mtime: Date.now() })
  return true
}

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

  const openFile = (path: string, at?: Omit<Jump, 'path'>) => {
    setTabs((ts) => (ts.includes(path) ? ts : [...ts, path]))
    if (isSf(path)) loadSeafile(path)
    else setBuffers((bs) => (bs[path] ? bs : { ...bs, [path]: { text: read(path), saved: read(path) } }))
    setActive(path)
    setCursor({ line: at?.line ?? 0, col: at?.col ?? 0 })
    if (at) {
      setViews((v) => (v[path] === 'preview' ? { ...v, [path]: 'edit' } : v))
      setJump({ path, ...at })
    }
    if (!isSf(path)) reveal(path)
  }

  /** A Seafile file comes in from its file server; an open tab keeps what is typed in it. */
  const loadSeafile = (path: string) => {
    if (buffers[path] && !buffers[path].error) return
    setBuffers((bs) => ({ ...bs, [path]: { text: '', saved: '', loading: true } }))
    readText(path)
      .then((t) => setBuffers((now) => ({ ...now, [path]: { text: t, saved: t } })))
      .catch((e: Error) => setBuffers((now) => ({ ...now, [path]: { text: '', saved: '', error: `Could not open it: ${e.message}` } })))
  }

  const openSearch = () => {
    setTabs((ts) => (ts.includes(SEARCH) ? ts : [...ts, SEARCH]))
    setActive(SEARCH)
  }

  // `open README.md`, Files and Spotlight hand us a path (and a fresh `t` so the same path focuses
  // again). Markdown opened from outside Zed starts in the preview (`view: 'preview'`).
  useEffect(() => {
    const path = win.props.path
    if (!path) return
    openFile(path)
    if (win.props.view === 'preview' && isMarkdown(path)) setViews((v) => ({ ...v, [path]: 'preview' }))
  }, [win.props.path, win.props.t])

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

  // A jump from project search: select the match once its editor has rendered.
  useEffect(() => {
    if (!jump || jump.path !== active || !text.current) return
    const lines = text.current.value.split('\n')
    const start = lines.slice(0, jump.line).reduce((n, l) => n + l.length + 1, 0) + jump.col
    text.current.focus({ preventScroll: true })
    text.current.setSelectionRange(start, start + jump.len)
    scrollToLine(jump.line)
    setJump(null)
  }, [jump, active])

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

  const close = (path: string) => {
    const b = buffers[path]
    if (b && b.text !== b.saved && !confirm(`${base(path)} has unsaved changes. Close anyway?`)) return
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
    if (isSf(active)) {
      if (buf.loading || buf.error) return
      const path = active
      const text = buf.text
      setStatus(`Saving ${where(path)}…`)
      writeText(path, text)
        .then(() => {
          setBuffers((bs) => (bs[path] ? { ...bs, [path]: { ...bs[path], saved: text } } : bs))
          setStatus(`Saved ${where(path)} to Seafile`)
        })
        .catch((e: Error) => setStatus(`Not saved: ${e.message}`))
      return
    }
    if (!write(active, buf.text)) return setStatus('Read-only file system. Only /tmp is writable.')
    setBuffers((bs) => ({ ...bs, [active]: { ...bs[active], saved: bs[active].text } }))
    setStatus(`Saved ${prettyPath(active)}`)
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
          <nav className="zed-panel" aria-label="Project">
            <Tree
              dir={root}
              depth={0}
              open={expanded}
              active={active}
              onToggle={(p) =>
                setExpanded((o) => {
                  const next = new Set(o)
                  if (!next.delete(p)) next.add(p)
                  return next
                })
              }
              onOpen={(p) => openFile(p)}
            />
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
            <span>{active.startsWith('/tmp/') ? 'UTF-8' : isSf(active) ? 'Seafile' : 'read-only'}</span>
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

function Tree({ dir, depth, open, active, onToggle, onOpen }: { dir: string; depth: number; open: Set<string>; active: string | null; onToggle: (p: string) => void; onOpen: (p: string) => void }) {
  const node = lookup(dir)
  const children = useMemo(() => {
    if (node?.type !== 'dir') return []
    return [...node.children.values()].sort((a, b) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || a.name.localeCompare(b.name))
  }, [node, open])
  const self = depth === 0
  return (
    <ul className="zed-tree" role={self ? 'tree' : 'group'}>
      {self && (
        <li>
          <button className="zed-row zed-root" onClick={() => onToggle(dir)}>
            <span className="zed-caret">{open.has(dir) ? '▾' : '▸'}</span>
            {base(dir)}
          </button>
        </li>
      )}
      {open.has(dir) &&
        children.map((c: Node) => {
          const path = join(dir, c.name)
          const pad = { paddingLeft: 8 + (depth + 1) * 12 }
          if (c.type === 'dir')
            return (
              <li key={path}>
                <button className="zed-row" style={pad} onClick={() => onToggle(path)}>
                  <span className="zed-caret">{open.has(path) ? '▾' : '▸'}</span>
                  {c.name}
                </button>
                {open.has(path) && <Tree dir={path} depth={depth + 1} open={open} active={active} onToggle={onToggle} onOpen={onOpen} />}
              </li>
            )
          return (
            <li key={path}>
              <button className={`zed-row ${path === active ? 'is-active' : ''}`} style={pad} onClick={() => onOpen(path)}>
                <FileDot name={c.name} />
                {c.name}
              </button>
            </li>
          )
        })}
    </ul>
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
  return [HOME, ...kids(`${HOME}/projects`), ...kids(`${HOME}/contributions`), `${HOME}/games`, '/etc', '/tmp', '/'].filter((p) => lookup(p)?.type === 'dir')
}

function ProjectPicker({ root, onPick, onClose }: { root: string; onPick: (dir: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [all, setAll] = useState(false)
  const items = useMemo<PickItem[]>(() => {
    const q = query.trim().toLowerCase()
    const pick = (p: string, section: string): PickItem => ({ id: `${section}:${p}`, label: base(p), detail: prettyPath(p), section, checked: p === root, run: () => onPick(p) })
    if (q || all) {
      const dirs = walk('/').filter((p) => lookup(p)?.type === 'dir')
      return dirs.filter((p) => !q || prettyPath(p).toLowerCase().includes(q)).slice(0, 60).map((p) => pick(p, 'Folders'))
    }
    return [
      pick(root, 'This Window'),
      ...recentProjects().filter((p) => p !== root).map((p) => pick(p, 'Recent Projects')),
      { id: 'all', label: 'Open Local Folder…', section: ' ', run: () => setAll(true) },
    ]
  }, [query, all, root, onPick])
  return <Palette className="is-project" placeholder="Search projects…" items={items} query={query} setQuery={setQuery} onClose={onClose} />
}

/** Fuzzy match: every character of the query, in order. */
const fuzzy = (hay: string, q: string) => {
  let i = 0
  for (const ch of hay) if (ch === q[i]) i++
  return i === q.length
}

function FileFinder({ root, onPick, onClose }: { root: string; onPick: (p: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const items = useMemo<PickItem[]>(() => {
    const q = query.toLowerCase().replace(/\s+/g, '')
    const files = walk(root).filter((p) => lookup(p)?.type === 'file')
    const rel = (p: string) => (root === '/' ? p.slice(1) : p.slice(root.length + 1))
    return files
      .filter((p) => !q || fuzzy(rel(p).toLowerCase(), q))
      .sort((a, b) => Number(!base(a).toLowerCase().includes(q)) - Number(!base(b).toLowerCase().includes(q)) || rel(a).length - rel(b).length)
      .slice(0, 80)
      .map((p) => ({ id: p, label: base(p), detail: rel(p).split('/').slice(0, -1).join('/'), run: () => onPick(p) }))
  }, [query, root, onPick])
  return <Palette className="is-files" placeholder="Search files by name…" items={items} query={query} setQuery={setQuery} onClose={onClose} />
}

// --- Project search ------------------------------------------------------------------------------

function ProjectSearch({ root, query, setQuery, onOpen }: { root: string; query: string; setQuery: (q: string) => void; onOpen: (p: string, at: Omit<Jump, 'path'>) => void }) {
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
  }, [query, root])
  const count = results.reduce((n, r) => n + r.hits.length, 0)
  const rel = (p: string) => (root === '/' ? p.slice(1) : p.slice(root.length + 1))

  return (
    <div className="zed-search">
      <div className="zed-search-bar">
        <input className="zed-find-input" autoFocus value={query} placeholder={`Search ${prettyPath(root)}…`} spellCheck={false} onChange={(e) => setQuery(e.target.value)} />
        <span className="zed-find-count">{query.length < 2 ? '' : count ? `${count} result${count === 1 ? '' : 's'} in ${results.length} file${results.length === 1 ? '' : 's'}` : 'No results'}</span>
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
      <p className="muted zed-keys">Ctrl+P file · Ctrl+F find · Ctrl+Shift+F search project · Ctrl+Shift+V preview · Ctrl+S save (in /tmp)</p>
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
