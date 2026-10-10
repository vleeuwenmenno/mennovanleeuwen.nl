import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { useGoSuggestionState, useGolinksTemplate } from '../data/golinks'
import { profile } from '../data/profile'
import { linkAt, linkMenu, openContextMenu, type MenuItem } from '../os/ContextMenu'
import { notify } from '../os/notify'
import { setAccent } from '../os/theme'
import { useWM, type WinState } from '../os/wm'
import { complete, completions, escapeArg, fastfetch, runLine, WORD_RE, type Completion } from '../terminal/commands'
import { prepareFolder } from '../terminal/fs'
import { SlTrain } from '../terminal/SlTrain'
import { HOME, prettyPath, resolvePath } from '../terminal/vfs'

/** The query's letters in `name`, in order and case-insensitively, marked the way fzf does. */
function Matched({ name, query }: { name: string; query: string }) {
  const q = query.toLowerCase()
  let at = 0
  return (
    <>
      {[...name].map((ch, i) => {
        const hit = at < q.length && ch.toLowerCase() === q[at]
        if (hit) at++
        return hit ? (
          <b key={i} className="t-pick-hit">
            {ch}
          </b>
        ) : (
          ch
        )
      })}
    </>
  )
}

type Entry = { id: number; kind: 'cmd'; cwd: string; text: string } | { id: number; kind: 'out'; text: string; alt?: boolean }

const MARKUP = /\{(c|link|anim|fg):([^}]*)\}([\s\S]*?)\{\/\}/g
const COLORS = new Set(['green', 'red', 'yellow', 'blue', 'cyan', 'magenta', 'muted', 'accent', 'bold', 'inverse', 'heat1', 'heat2', 'heat3', 'heat4'])

/**
 * Renders the `{c:color}…{/}` / `{fg:#rrggbb}…{/}` / `{link:url}…{/}` markup produced by commands.
 * Output can contain text from the network (curl), so every argument is checked: only known
 * colours, hex colours, http(s) links and the one animation.
 */
function Markup({ text, onAnimationEnd }: { text: string; onAnimationEnd?: () => void }) {
  const parts: ReactNode[] = []
  let last = 0
  for (const m of text.matchAll(MARKUP)) {
    if (m.index! > last) parts.push(text.slice(last, m.index))
    const [, kind, arg, inner] = m
    const valid = kind === 'c' ? COLORS.has(arg) : kind === 'fg' ? /^#[0-9a-f]{6}$/i.test(arg) : kind === 'link' ? /^https?:\/\//.test(arg) : arg === 'sl'
    if (!valid) continue
    parts.push(
      kind === 'fg' ? (
        <span key={m.index} style={{ color: arg }}>
          {inner}
        </span>
      ) : kind === 'anim' ? (
        <SlTrain key={m.index} onDone={onAnimationEnd} />
      ) : kind === 'link' ? (
        <a key={m.index} href={arg} target="_blank" rel="noopener noreferrer">
          {inner}
        </a>
      ) : (
        <span key={m.index} className={`t-${arg}`}>
          {inner}
        </span>
      ),
    )
    last = m.index! + m[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return <>{parts}</>
}

function Prompt({ cwd }: { cwd: string }) {
  return (
    <span className="prompt">
      <span className="t-green">{profile.handle}</span>
      <span className="t-muted">@</span>
      <span className="t-accent">mvlos</span> <span className="t-blue">{prettyPath(cwd)}</span>
      <span className="t-muted"> ❯ </span>
    </span>
  )
}

let nextId = 1

// Text size, shared by every terminal window and kept across visits, like a terminal's config.
const FONT_KEY = 'mvlos.terminal.fontSize'
const FONT_DEFAULT = 13
const FONT_MIN = 9
const FONT_MAX = 28
const FONT_PRESETS = [11, 12, 13, 14, 16, 18, 20, 24]
const fontListeners = new Set<() => void>()
let fontSize = (() => {
  try {
    const v = Number(localStorage.getItem(FONT_KEY))
    return v >= FONT_MIN && v <= FONT_MAX ? v : FONT_DEFAULT
  } catch {
    return FONT_DEFAULT
  }
})()

function setFontSize(size: number) {
  fontSize = Math.min(FONT_MAX, Math.max(FONT_MIN, size))
  try {
    localStorage.setItem(FONT_KEY, String(fontSize))
  } catch {
    /* not persisted */
  }
  fontListeners.forEach((l) => l())
}

const useFontSize = () =>
  useSyncExternalStore(
    (l) => {
      fontListeners.add(l)
      return () => fontListeners.delete(l)
    },
    () => fontSize,
  )

// Phones have no Tab key and typing is slow, so touch devices get one-tap commands.
const QUICK = ['help', 'projects', 'recent 8', 'cat cv.md', 'ping boltwarden.org', 'sl', 'fastfetch', 'fortune | cowsay']
const HISTORY_KEY = 'mvlos.history'

function loadHistory(): string[] {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]')
  } catch {
    return []
  }
}

/** `onLogout` makes this the detached text console reached by pausing the boot, rather than a window. */
export function Terminal({ win, onLogout }: { win: WinState; onLogout?: () => void }) {
  const wm = useWM()
  // Only the terminal that opens at boot greets the visitor; any terminal opened later starts clean.
  const [entries, setEntries] = useState<Entry[]>(() =>
    win.props.motd
      ? [
          { id: nextId++, kind: 'out', text: fastfetch({ windows: wm.windows }) },
          {
            id: nextId++,
            kind: 'out',
            text: `\nWelcome to {c:accent}MvL OS{/}. Type {c:green}help{/} to see what works, or try {c:green}projects{/}, {c:green}recent{/}, {c:green}cat cv.md{/}.\n`,
          },
        ]
      : [],
  )
  const [cwd, setCwd] = useState(HOME)
  const [value, setValue] = useState('')
  const [running, setRunning] = useState(false)
  // A full-screen program (htop, cmatrix, watch) is drawing: no "working…" line under it.
  const [drawing, setDrawing] = useState(false)
  // An animation (sl) holds the prompt until it finishes, like the real one.
  const [animating, setAnimating] = useState(false)
  const busy = running || animating
  // Read-only: the scrollback can still be read, selected and copied, but nothing gets typed or run.
  const [readOnly, setReadOnly] = useState(false)
  const size = useFontSize()

  // Tab opens a picker, like fzf: after `go <alias>` your go links, otherwise the commands, files
  // and folders the word could become (once there is more than one). It narrows as you type; Tab
  // and ↓ (Shift+Tab and ↑, Ctrl+N/P) cycle, → puts the pick on the line, Enter does too (and
  // follows a go link), Esc closes.
  const goWord = /^\s*go\s+(\S*)$/.exec(value)?.[1] ?? null
  const goTemplate = useGolinksTemplate()
  const goMode = goWord !== null && !!goTemplate
  // The picker belongs to the word it opened on: `before` is the line up to it.
  const [picking, setPicking] = useState<{ before: string } | null>(null)
  const [pick, setPick] = useState(0)
  const go = useGoSuggestionState(goTemplate, goWord ?? '', !!picking && goMode)
  const comp = useMemo(() => (picking && !goMode ? completions(value, cwd) : null), [picking, goMode, value, cwd])
  const choices: Completion[] = goMode ? go.list.map((g) => ({ value: g.name, label: g.name, hint: g.target.replace(/^https?:\/\//, '').replace(/\/$/, '') })) : (comp?.items ?? [])
  const typed = goMode ? goWord! : (comp?.word.split('/').pop() ?? '')
  const lastWord = WORD_RE.exec(value)![1]
  useEffect(() => setPick(0), [lastWord])
  // Moving on to another word, or nothing left to pick from, closes it.
  useEffect(() => {
    if (picking && comp && (comp.before !== picking.before || !comp.items.length)) setPicking(null)
  }, [picking, comp])
  useEffect(() => {
    scrollRef.current?.querySelector('.t-pick.is-on')?.scrollIntoView({ block: 'nearest' })
  }, [pick])
  const history = useRef<string[]>(loadHistory())
  const histIdx = useRef<number | null>(null)
  const env = useRef<Record<string, string>>({ USER: profile.handle, HOME, SHELL: '/bin/msh', TERM: 'xterm-mvlos', EDITOR: 'nvim', LANG: 'en_US.UTF-8' })
  const inputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const keyHandler = useRef<((key: string, text?: string) => boolean) | null>(null)
  const rawKeys = useRef(false)
  // A full-screen program on the alternate screen (nano): the rest of the scrollback hides meanwhile.
  const [alt, setAlt] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const windowsRef = useRef(wm.windows)
  windowsRef.current = wm.windows

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
    // The console grows inside the boot screen, which does the scrolling.
    if (onLogout) scrollRef.current?.scrollIntoView({ block: 'end' })
  }, [entries, busy, onLogout, picking, choices.length])

  useEffect(() => {
    if (onLogout && !matchMedia('(pointer: coarse)').matches) inputRef.current?.focus({ preventScroll: true })
  }, [onLogout])

  // The text console owns the whole screen: a click anywhere puts the caret back on the prompt,
  // and typing with nothing focused goes to the prompt instead of the browser (Firefox's find as
  // you type opened its search bar).
  useEffect(() => {
    if (!onLogout) return
    const focusPrompt = () => inputRef.current?.focus({ preventScroll: true })
    const onUp = () => !window.getSelection()?.toString() && focusPrompt()
    const onKey = (e: globalThis.KeyboardEvent) => {
      const active = document.activeElement
      if (active === inputRef.current || active?.matches('input, textarea, [contenteditable="true"]')) return
      if (e.ctrlKey || e.metaKey) return // copying a selection, browser shortcuts
      focusPrompt()
    }
    window.addEventListener('pointerup', onUp)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [onLogout])

  // On the desktop, the same for the terminal in front: typing while nothing editable has focus
  // (after clicking the desktop, or a new tab page that just loaded) goes to its prompt instead
  // of Firefox's find as you type, and the prompt takes focus again when the page gets it back
  // (from the address bar). Only printable keys, and only while this terminal is the front
  // window, so a game in front keeps its keys and the desktop keeps Delete, F2, Enter.
  const front = wm.focusedPid === win.pid
  const frontRef = useRef(front)
  frontRef.current = front
  useEffect(() => {
    if (onLogout || matchMedia('(pointer: coarse)').matches) return
    const idle = () => {
      const active = document.activeElement
      return !active || active === document.body || !active.matches('input, textarea, select, [contenteditable="true"]')
    }
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!frontRef.current || e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey || !idle()) return
      if (document.querySelector('.spotlight, .om-panel, .ctx-menu')) return // an overlay has the keys
      inputRef.current?.focus({ preventScroll: true })
    }
    const onFocus = () => frontRef.current && idle() && inputRef.current?.focus({ preventScroll: true })
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('focus', onFocus)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('focus', onFocus)
    }
  }, [onLogout])

  // A block cursor like Omarchy's terminals (solid when focused, hollow when not), drawn over the
  // input since a native caret can only be a thin line. Monospace, so a character is 1ch.
  const [caret, setCaret] = useState({ at: 0, scroll: 0, range: false, focused: false })
  const syncCaret = () => {
    const el = inputRef.current
    if (!el) return
    const start = el.selectionStart ?? el.value.length
    const end = el.selectionEnd ?? start
    const at = el.selectionDirection === 'backward' ? start : end
    setCaret({ at, scroll: el.scrollLeft, range: start !== end, focused: document.activeElement === el })
  }
  useLayoutEffect(syncCaret, [value])

  // A phone keyboard opening shrinks the visible area: keep the prompt above it.
  useEffect(() => {
    const keep = () => {
      if (document.activeElement !== inputRef.current) return
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
      inputRef.current?.scrollIntoView({ block: 'nearest' })
    }
    window.addEventListener('mvlos:keyboard', keep)
    window.visualViewport?.addEventListener('resize', keep)
    return () => {
      window.removeEventListener('mvlos:keyboard', keep)
      window.visualViewport?.removeEventListener('resize', keep)
    }
  }, [])

  // Focus the prompt whenever this window comes to the front (not on touch, where it pops the keyboard).
  useEffect(() => {
    if (wm.focusedPid !== win.pid || matchMedia('(pointer: coarse)').matches) return
    // Hover focus must not pull the caret out of something else being typed in (Spotlight, a rename).
    const active = document.activeElement
    if (active && active !== document.body && !active.closest('.window')) return
    inputRef.current?.focus({ preventScroll: true })
  }, [wm.focusedPid, win.pid])

  // Other apps can ask the terminal to run something (e.g. "Open in terminal" buttons).
  // Run each request once: React's dev-mode double effects (and re-renders) must not repeat it.
  const handledProps = useRef<WinState['props'] | null>(null)
  useEffect(() => {
    if (!win.props.run || handledProps.current === win.props) return
    handledProps.current = win.props
    submit(win.props.run)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [win.props])

  useEffect(() => {
    if (!animating && wm.focusedPid === win.pid && !matchMedia('(pointer: coarse)').matches) inputRef.current?.focus({ preventScroll: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [animating])

  env.current.PWD = cwd

  async function submit(line: string) {
    const trimmed = line.trim()
    setEntries((e) => [...e, { id: nextId++, kind: 'cmd', cwd, text: line }])
    setValue('')
    histIdx.current = null
    if (!trimmed) return
    if (history.current[history.current.length - 1] !== trimmed) {
      history.current.push(trimmed)
      history.current = history.current.slice(-200)
      try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(history.current))
      } catch {
        /* history just won't persist */
      }
    }

    const print = (text: string) => setEntries((e) => [...e, { id: nextId++, kind: 'out', text }])
    // One redrawable block per command line, for programs that update in place.
    let liveId: number | null = null
    const live = (text: string | null, opts?: { alt?: boolean }) => {
      setDrawing(text !== null)
      setAlt(text !== null && !!opts?.alt)
      if (text === null) {
        const id = liveId
        liveId = null
        if (id !== null) setEntries((e) => e.filter((x) => x.id !== id))
      } else if (liveId === null) {
        const id = (liveId = nextId++)
        setEntries((e) => [...e, { id, kind: 'out', text, alt: opts?.alt }])
      } else {
        const id = liveId
        setEntries((e) => e.map((x) => (x.id === id ? { ...x, text, alt: opts?.alt } : x)))
      }
    }
    abortRef.current = new AbortController()
    setRunning(true)
    const results = await runLine(trimmed, {
      cwd,
      setCwd,
      env: env.current,
      history: history.current,
      windows: windowsRef.current,
      openApp: wm.open,
      openNewApp: wm.openNew,
      closeWindow: wm.close,
      clear: () => setEntries([]),
      exit: () => setTimeout(() => (onLogout ? onLogout() : wm.close(win.pid)), 120),
      console: !!onLogout,
      startx: onLogout
        ? (launch) => {
            if (launch) {
              wm.reset(true)
              wm.openNew(launch.app, launch.props)
            }
            setTimeout(onLogout, 400)
          }
        : undefined,
      setAccent,
      print,
      live,
      size: termSize(),
      onKey: (h, opts) => {
        keyHandler.current = h
        rawKeys.current = !!h && !!opts?.raw
      },
      signal: abortRef.current.signal,
    })
    keyHandler.current = null
    rawKeys.current = false
    setDrawing(false)
    setAlt(false)
    abortRef.current = null
    setRunning(false)
    if (results.some((r) => r.output.includes('{anim:'))) setAnimating(true)
  }

  /** Columns and rows that fit, measured from the font. */
  function termSize() {
    const el = scrollRef.current
    if (!el) return { cols: 80, rows: 24 }
    const style = getComputedStyle(el)
    const ctx2d = document.createElement('canvas').getContext('2d')!
    ctx2d.font = `${style.fontSize} ${style.fontFamily}`
    const charW = ctx2d.measureText('MMMMMMMMMM').width / 10 || 8
    const lineH = parseFloat(style.lineHeight) || 20
    const w = el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
    const h = el.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
    return { cols: Math.max(20, Math.floor(w / charW)), rows: Math.max(8, Math.floor(h / lineH) - 1) }
  }

  /** Puts the pick on the line; `run` also runs it (go links only). */
  function choose(i: number, run: boolean) {
    const chosen = choices[i]
    setPicking(null)
    if (!chosen) return run && submit(value)
    const line = value.slice(0, value.length - WORD_RE.exec(value)![1].length) + (goMode ? chosen.value : escapeArg(chosen.value))
    if (run) submit(line)
    else setValue(chosen.value.endsWith('/') ? line : `${line} `)
    inputRef.current?.focus({ preventScroll: true })
  }

  /** Keys while the picker is open; true when the picker used the key. */
  function onPickerKey(e: KeyboardEvent<HTMLInputElement>) {
    const n = choices.length
    const k = e.key.toLowerCase()
    if ((e.key === 'Tab' && !e.shiftKey) || e.key === 'ArrowDown' || (e.ctrlKey && k === 'n')) setPick((i) => (n ? (i + 1) % n : 0))
    else if (e.key === 'Tab' || e.key === 'ArrowUp' || (e.ctrlKey && k === 'p')) setPick((i) => (n ? (i - 1 + n) % n : 0))
    else if (e.key === 'Escape' || (e.ctrlKey && k === 'c' && !window.getSelection()?.toString())) setPicking(null)
    else if (e.key === 'ArrowRight' || e.key === 'Enter') choose(pick, e.key === 'Enter' && goMode)
    else return false
    e.preventDefault()
    return true
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    // Text size, like Alacritty and Ghostty: Ctrl + / − / 0 while the terminal has the keys.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !onLogout && ['=', '+', '-', '_', '0'].includes(e.key)) {
      e.preventDefault()
      setFontSize(e.key === '0' ? FONT_DEFAULT : fontSize + (e.key === '-' || e.key === '_' ? -1 : 1))
      return
    }
    if (readOnly) {
      // Copying a selection and moving around the line still work; nothing else does.
      if ((e.ctrlKey || e.metaKey) && ['c', 'a'].includes(e.key.toLowerCase())) return
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Shift', 'Control', 'Meta', 'Alt'].includes(e.key)) e.preventDefault()
      return
    }
    // Raw programs (nano) get Ctrl+X as ^X and Alt+U as M-u, ahead of the shell and the desktop.
    if (running && keyHandler.current && rawKeys.current) {
      const k = e.key.length === 1 ? e.key : e.key
      const token = e.ctrlKey && !e.altKey ? (e.key.length === 1 ? `^${k.toUpperCase()}` : `^${k}`) : e.altKey && !e.ctrlKey ? `M-${e.key.length === 1 ? k.toLowerCase() : k}` : k
      if (e.metaKey || ['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return
      if (keyHandler.current(token)) {
        e.preventDefault()
        e.stopPropagation()
      }
      return
    }
    if (running && keyHandler.current && !e.ctrlKey && !e.metaKey && keyHandler.current(e.key)) {
      e.preventDefault()
      return
    }
    if (picking && onPickerKey(e)) return
    if (e.key === 'Enter') {
      if (!busy) submit(value)
    } else if (e.key === 'Tab') {
      e.preventDefault()
      if (busy) return
      if (goMode) {
        // Never a real line, so leaving `go <alias>` closes the go links picker.
        setPicking({ before: '\0go' })
        setPick(0)
        return
      }
      // A folder in Seafile is fetched first, so its names can be offered.
      const word = WORD_RE.exec(value)![1].replace(/\\(.)/g, '$1')
      const at = value
      void prepareFolder(resolvePath(cwd, word.includes('/') ? word.slice(0, word.lastIndexOf('/') + 1) : '.')).then(() => {
        if (inputRef.current?.value !== at) return
        const { line, items } = complete(at, cwd)
        setValue(line)
        if (items.length) {
          setPicking({ before: completions(line, cwd).before })
          setPick(0)
        }
      })
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      const h = history.current
      if (!h.length) return
      histIdx.current = histIdx.current === null ? h.length - 1 : Math.max(0, histIdx.current - 1)
      setValue(h[histIdx.current])
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      const h = history.current
      if (histIdx.current === null) return
      histIdx.current = histIdx.current + 1
      if (histIdx.current >= h.length) {
        histIdx.current = null
        setValue('')
      } else setValue(h[histIdx.current])
    } else if (e.ctrlKey && e.key.toLowerCase() === 'l') {
      e.preventDefault()
      setEntries([])
    } else if (e.ctrlKey && e.key.toLowerCase() === 'c') {
      if (window.getSelection()?.toString()) return
      e.preventDefault()
      if (abortRef.current) {
        abortRef.current.abort()
        return
      }
      setEntries((x) => [...x, { id: nextId++, kind: 'cmd', cwd, text: value + '^C' }])
      setValue('')
    } else if (e.ctrlKey && e.key.toLowerCase() === 'u') {
      e.preventDefault()
      setValue('')
    }
  }

  /** What a copy would take: the selected part of the prompt line, else the selected scrollback. */
  function selectedText() {
    const el = inputRef.current
    if (el && document.activeElement === el && el.selectionStart !== el.selectionEnd) return el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0)
    const sel = window.getSelection()
    return sel && !sel.isCollapsed && scrollRef.current && sel.containsNode(scrollRef.current, true) ? sel.toString() : ''
  }

  async function paste() {
    let text: string
    try {
      text = await navigator.clipboard.readText()
    } catch {
      notify({ title: 'Could not paste', body: 'The browser did not allow reading the clipboard. Ctrl+V still works.' })
      return
    }
    if (!text) return
    if (running && keyHandler.current && rawKeys.current) {
      keyHandler.current('Paste', text)
      return
    }
    // One line, like the browser does when pasting into a single-line field.
    const flat = text.replace(/\s*\r?\n\s*/g, ' ').trimEnd()
    const el = inputRef.current
    const start = el?.selectionStart ?? value.length
    const end = el?.selectionEnd ?? value.length
    setValue(value.slice(0, start) + flat + value.slice(end))
    requestAnimationFrame(() => {
      el?.focus({ preventScroll: true })
      el?.setSelectionRange(start + flat.length, start + flat.length)
      syncCaret()
    })
  }

  /** Selects the whole scrollback, prompt line included. */
  function selectAll() {
    const root = scrollRef.current
    const line = root?.querySelector('.t-input')
    if (!root || !line) return
    inputRef.current?.blur()
    const range = document.createRange()
    range.setStart(root, 0)
    range.setEndAfter(line)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
  }

  function onMenu(e: MouseEvent) {
    // Shift+right-click keeps the browser's menu (openContextMenu lets it through).
    const href = linkAt(e.target)
    const text = selectedText()
    const items: MenuItem[] = [
      ...(href ? [...linkMenu(href), { separator: true as const }] : []),
      { label: 'Copy', shortcut: 'Ctrl C', disabled: !text, onSelect: () => void navigator.clipboard?.writeText(text).catch(() => {}) },
      { label: 'Paste', shortcut: 'Ctrl V', disabled: readOnly || animating, onSelect: () => void paste() },
      { label: 'Select all', onSelect: selectAll },
      { separator: true },
      { label: 'Clear', shortcut: 'Ctrl L', disabled: alt || readOnly, onSelect: () => setEntries([]) },
      ...(running ? [{ label: 'Stop command', shortcut: 'Ctrl C', disabled: readOnly, onSelect: () => abortRef.current?.abort() }] : []),
      { separator: true },
      { label: 'Read-only', checked: readOnly, onSelect: () => setReadOnly((r) => !r) },
      ...(onLogout
        ? []
        : [
            {
              label: 'Text size',
              submenu: [
                { label: 'Larger', shortcut: 'Ctrl +', disabled: size >= FONT_MAX, onSelect: () => setFontSize(size + 1) },
                { label: 'Smaller', shortcut: 'Ctrl −', disabled: size <= FONT_MIN, onSelect: () => setFontSize(size - 1) },
                { label: 'Default', shortcut: 'Ctrl 0', disabled: size === FONT_DEFAULT, onSelect: () => setFontSize(FONT_DEFAULT) },
                { separator: true as const },
                ...FONT_PRESETS.map((px) => ({ label: `${px} px`, checked: size === px, onSelect: () => setFontSize(px) })),
              ],
            },
          ]),
    ]
    openContextMenu(e, items)
  }

  return (
    <div
      className={`terminal ${onLogout ? 'is-console' : ''} ${alt ? 'is-alt' : ''} ${readOnly ? 'is-readonly' : ''}`}
      ref={scrollRef}
      style={onLogout ? undefined : { fontSize: size }}
      onContextMenu={onMenu}
      onMouseUp={(e) => {
        if (e.button === 0 && !window.getSelection()?.toString()) inputRef.current?.focus({ preventScroll: true })
      }}
    >
      {entries.map((e) => (
        <Fragment key={e.id}>
          {e.kind === 'cmd' ? (
            <div className="t-line">
              <Prompt cwd={e.cwd} />
              {e.text}
            </div>
          ) : (
            <pre className={`t-out ${e.alt ? 't-alt' : ''}`}>
              <Markup text={e.text} onAnimationEnd={() => setAnimating(false)} />
            </pre>
          )}
        </Fragment>
      ))}
      {running && !drawing && (
        <div className="t-line t-muted">
          <span className="spinner" /> working…
        </div>
      )}
      <label className={`t-line t-input ${busy ? 'is-busy' : ''}`} hidden={animating}>
        <Prompt cwd={cwd} />
        <span className="t-field">
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onKeyDown}
            readOnly={readOnly}
            onPaste={(e) => {
              if (readOnly) return e.preventDefault()
              if (!running || !keyHandler.current || !rawKeys.current) return
              e.preventDefault()
              keyHandler.current('Paste', e.clipboardData.getData('text/plain'))
            }}
            onKeyUp={syncCaret}
            onSelect={syncCaret}
            onFocus={syncCaret}
            onBlur={syncCaret}
            onScroll={syncCaret}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            aria-label="Terminal input"
            enterKeyHint="send"
          />
          {!caret.range && (
            <span className={`t-cursor ${caret.focused && !readOnly ? 'is-focused' : ''}`} style={{ left: `calc(${caret.at}ch - ${caret.scroll}px)` }} aria-hidden>
              {value[caret.at] ?? ' '}
            </span>
          )}
        </span>
        {readOnly && <span className="t-readonly">read-only</span>}
      </label>
      {picking && (goMode || choices.length > 0) && !busy && (
        <div className="t-picker" role="listbox" aria-label={goMode ? 'Go links' : 'Completions'} style={{ ['--name-w' as string]: `${Math.min(28, Math.max(4, ...choices.map((c) => c.label.length))) + 2}ch` }}>
          <div className="t-pick-list">
            {choices.map((c, i) => (
              <div
                key={c.value}
                role="option"
                aria-selected={i === pick}
                className={`t-pick ${i === pick ? 'is-on' : ''}`}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setPick(i)}
                onClick={() => choose(i, false)}
              >
                <span className="t-pick-mark">{i === pick ? '>' : ' '}</span>
                <span className="t-pick-name">
                  <Matched name={c.label} query={typed} />
                </span>
                <span className="t-pick-target">{c.hint}</span>
              </div>
            ))}
          </div>
          <div className="t-pick-info">
            {goMode && !go.ready ? 'searching…' : `${choices.length || 'no'} ${goMode ? (choices.length === 1 ? 'matching alias' : 'matching aliases') : choices.length === 1 ? 'match' : 'matches'}`} · tab ↑↓ cycle · → insert · enter {goMode ? 'go' : 'insert'} · esc close
          </div>
        </div>
      )}
      <div className="t-quick" aria-label="Quick commands">
        {QUICK.map((q) => (
          <button key={q} disabled={busy || readOnly} onClick={() => submit(q)}>
            {q}
          </button>
        ))}
      </div>
    </div>
  )
}
