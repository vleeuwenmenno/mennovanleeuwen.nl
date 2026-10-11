import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { useGoSuggestionState, useGolinksTemplate } from '../data/golinks'
import { cvMode } from '../os/cvMode'
import { browserMountPoint, useMounts } from '../data/mounts'
import { HANDLE } from '../os/identity'
import { linkAt, linkMenu, openContextMenu, type MenuItem } from '../os/ContextMenu'
import { notify } from '../os/notify'
import { setAccent } from '../os/theme'
import { useIsMobile } from '../os/useIsMobile'
import { useMediaQuery } from '../os/useMediaQuery'
import { useWM, type WinState } from '../os/wm'
import { complete, completions, escapeArg, fastfetch, runLine, WORD_RE, type Completion } from '../terminal/commands'
import { ExtraKeys, useStickyMods, type ModKeys } from '../terminal/ExtraKeys'
import { prepareFolder } from '../terminal/fs'
import { useTerminalPrefs } from '../terminal/prefs'
import { SlTrain } from '../terminal/SlTrain'
import { TerminalSettings } from '../terminal/TerminalSettings'
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
      <span className="t-green">{HANDLE}</span>
      <span className="t-muted">@</span>
      <span className="t-accent">mvlos</span> <span className="t-blue">{prettyPath(cwd)}</span>
      <span className="t-muted"> ❯ </span>
    </span>
  )
}

let nextId = 1

// Zoom for one window only, like a browser tab's: it scales the text size from the settings
// (src/terminal/prefs.ts) and is forgotten when the window closes.
const ZOOM_MIN = 0.5
const ZOOM_MAX = 3
const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3]
const clampZoom = (z: number) => Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)) * 100) / 100
/** The next step up or down from `z`, which may sit between steps after a pinch. */
const stepZoom = (z: number, dir: 1 | -1) => (dir > 0 ? (ZOOM_STEPS.find((s) => s > z + 0.001) ?? ZOOM_MAX) : ([...ZOOM_STEPS].reverse().find((s) => s < z - 0.001) ?? ZOOM_MIN))

// "Terminal settings…" in a terminal window's menu (apps.tsx) opens the sheet in that window.
const settingsOpeners = new Map<number, () => void>()
export const terminalMenu = (w: WinState): MenuItem[] => [{ label: 'Terminal settings…', onSelect: () => settingsOpeners.get(w.pid)?.() }]

/** What the key handling reads from a key press: a real one, or one from the extra keys row. */
type KeyLike = Pick<KeyboardEvent<HTMLInputElement>, 'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey' | 'preventDefault' | 'stopPropagation'>

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
/** Inside another app (Zed's terminal panel): where it starts, and what `exit` does. It never takes
 * the keyboard on its own there, since the app around it has its own fields. */
export type EmbeddedTerminal = { cwd: string; onExit: () => void }

export function Terminal({ win, onLogout, embedded }: { win: WinState; onLogout?: () => void; embedded?: EmbeddedTerminal }) {
  const wm = useWM()
  // Only the terminal that opens at boot greets the visitor; any terminal opened later starts clean.
  const [entries, setEntries] = useState<Entry[]>(() =>
    win.props.motd
      ? [
          { id: nextId++, kind: 'out', text: fastfetch({ windows: wm.windows }) },
          {
            id: nextId++,
            kind: 'out',
            text: cvMode()
              ? `\nWelcome to {c:accent}MvL OS{/}. Type {c:green}help{/} to see what works, or try {c:green}projects{/}, {c:green}recent{/}, {c:green}cat cv.md{/}.\n`
              : `\nWelcome to {c:accent}MvL OS{/}. Type {c:green}help{/} to see what works, or try {c:green}games{/}, {c:green}ls ~/Pictures{/}, {c:green}cat README.md{/}.\n`,
          },
        ]
      : [],
  )
  // Signed in without Seafile as home: ~ is writable, but only kept in this browser. Said once in
  // the boot terminal, as soon as the account is known.
  const mountsVersion = useMounts()
  const toldBrowser = useRef(false)
  useEffect(() => {
    if (!win.props.motd || toldBrowser.current || browserMountPoint() !== HOME) return
    toldBrowser.current = true
    setEntries((list) => [...list, { id: nextId++, kind: 'out', text: `{c:yellow}~ is kept in this browser only{/}: clearing the site's data deletes it. Link Seafile in Settings → Integrations to keep files for good ({c:green}df -h{/} shows the space).\n` }])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mountsVersion])
  const [cwd, setCwd] = useState(embedded?.cwd ?? HOME)
  const [value, setValue] = useState('')
  const [running, setRunning] = useState(false)
  // A full-screen program (htop, cmatrix, watch) is drawing: no "working…" line under it.
  const [drawing, setDrawing] = useState(false)
  // An animation (sl) holds the prompt until it finishes, like the real one.
  const [animating, setAnimating] = useState(false)
  const busy = running || animating
  // Read-only: the scrollback can still be read, selected and copied, but nothing gets typed or run.
  const [readOnly, setReadOnly] = useState(false)

  // Text size: the setting for this kind of screen (phones have their own), times this window's
  // zoom. The text console keeps the boot screen's.
  const prefs = useTerminalPrefs()
  const mobile = useIsMobile()
  const coarse = useMediaQuery('(pointer: coarse)')
  const [zoom, setZoomState] = useState(1)
  const zoomRef = useRef(zoom)
  const [zoomBadge, setZoomBadge] = useState(false)
  const badgeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => clearTimeout(badgeTimer.current ?? undefined), [])
  const fontPx = onLogout ? null : (mobile ? prefs.fontMobile : prefs.fontDesktop) * zoom
  /** Zooms this window and shows the new size for a moment. */
  function setZoom(z: number) {
    const next = clampZoom(z)
    zoomRef.current = next
    setZoomState(next)
    setZoomBadge(true)
    clearTimeout(badgeTimer.current ?? undefined)
    badgeTimer.current = setTimeout(() => setZoomBadge(false), 1100)
  }
  const zoomBy = (z: number | 'in' | 'out') => setZoom(z === 'in' ? stepZoom(zoomRef.current, 1) : z === 'out' ? stepZoom(zoomRef.current, -1) : z)

  // The settings sheet, from the window menu, the right-click menu or `settings`.
  const [settingsOpen, setSettingsOpen] = useState(false)
  useEffect(() => {
    if (embedded || onLogout) return
    settingsOpeners.set(win.pid, () => setSettingsOpen(true))
    return () => void settingsOpeners.delete(win.pid)
  }, [win.pid, embedded, onLogout])

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
  const env = useRef<Record<string, string>>({ USER: HANDLE, HOME, SHELL: '/bin/msh', TERM: 'xterm-mvlos', EDITOR: 'nvim', LANG: 'en_US.UTF-8' })
  const inputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const keyHandler = useRef<((key: string, text?: string) => boolean) | null>(null)
  const rawKeys = useRef(false)
  const shiftKeys = useRef(false)
  const resizeHandler = useRef<(() => void) | null>(null)
  // While a command runs: measures the size again and tells the program when it changed.
  const sizeCheck = useRef<(() => void) | null>(null)
  // A full-screen program on the alternate screen (nano): the rest of the scrollback hides meanwhile.
  const [alt, setAlt] = useState(false)
  // A program that draws its own prompt in its live block (agents): the shell's stays out of sight.
  const [takeover, setTakeover] = useState(false)
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
  const front = !embedded && wm.focusedPid === win.pid
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
      if (document.querySelector('.spotlight, .om-panel, .ctx-menu, .t-sheet')) return // an overlay has the keys
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

  // A new text size changes how many rows and columns fit without changing the window, which the
  // ResizeObserver would not notice: full-screen programs (nano, htop, agents) redraw to fit.
  useLayoutEffect(() => sizeCheck.current?.(), [fontPx])

  // Ctrl with the scroll wheel (a trackpad pinch sends the same) and a two-finger pinch on a touch
  // screen zoom this window instead of the page.
  useEffect(() => {
    const el = scrollRef.current
    if (!el || onLogout) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY
      setZoom(zoomRef.current * Math.exp(-px * 0.002))
    }
    let pinch: { spread: number; zoom: number } | null = null
    const spread = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY) || 1
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) pinch = { spread: spread(e.touches), zoom: zoomRef.current }
    }
    const onTouchMove = (e: TouchEvent) => {
      if (!pinch || e.touches.length !== 2) return
      e.preventDefault()
      setZoom((pinch.zoom * spread(e.touches)) / pinch.spread)
    }
    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) pinch = null
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: false })
    el.addEventListener('touchend', onTouchEnd)
    el.addEventListener('touchcancel', onTouchEnd)
    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('touchend', onTouchEnd)
      el.removeEventListener('touchcancel', onTouchEnd)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onLogout])

  // Focus the prompt whenever this window comes to the front (not on touch, where it pops the keyboard).
  useEffect(() => {
    if (embedded || wm.focusedPid !== win.pid || matchMedia('(pointer: coarse)').matches) return
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
    if (!embedded && !animating && wm.focusedPid === win.pid && !matchMedia('(pointer: coarse)').matches) inputRef.current?.focus({ preventScroll: true })
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
    const live = (text: string | null, opts?: { alt?: boolean; hideInput?: boolean }) => {
      setDrawing(text !== null)
      setAlt(text !== null && !!opts?.alt)
      setTakeover(text !== null && !!opts?.hideInput)
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
    // The size follows the window while the command runs, for programs that redraw (agents).
    const size = termSize()
    const check = () => {
      const now = termSize()
      if (now.cols === size.cols && now.rows === size.rows) return
      Object.assign(size, now)
      resizeHandler.current?.()
    }
    sizeCheck.current = check
    const watcher = new ResizeObserver(check)
    if (scrollRef.current) watcher.observe(scrollRef.current)
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
      exit: () => setTimeout(() => (onLogout ? onLogout() : embedded ? embedded.onExit() : wm.close(win.pid)), 120),
      console: !!onLogout,
      openSettings: onLogout ? undefined : () => setSettingsOpen(true),
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
      size,
      onResize: (h) => void (resizeHandler.current = h),
      onKey: (h, opts) => {
        keyHandler.current = h
        rawKeys.current = !!h && !!opts?.raw
        shiftKeys.current = !!h && !!opts?.shift
      },
      signal: abortRef.current.signal,
    })
    watcher.disconnect()
    sizeCheck.current = null
    resizeHandler.current = null
    keyHandler.current = null
    rawKeys.current = false
    shiftKeys.current = false
    setDrawing(false)
    setAlt(false)
    setTakeover(false)
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
  function onPickerKey(e: KeyLike) {
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

  function onKeyDown(e: KeyLike) {
    // Zoom, like Alacritty and Ghostty: Ctrl + / − / 0 while the terminal has the keys (and not
    // the browser's zoom of the whole page).
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !onLogout && ['=', '+', '-', '_', '0'].includes(e.key)) {
      e.preventDefault()
      zoomBy(e.key === '0' ? 1 : e.key === '-' || e.key === '_' ? 'out' : 'in')
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
      const shift = shiftKeys.current && e.shiftKey && e.key.length > 1 ? 'S-' : ''
      const token = e.ctrlKey && !e.altKey ? (e.key.length === 1 ? `^${k.toUpperCase()}` : `^${k}`) : e.altKey && !e.ctrlKey ? `M-${e.key.length === 1 ? k.toLowerCase() : k}` : shift + k
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

  // The extra keys row on touch screens (src/terminal/ExtraKeys.tsx), while the prompt has the
  // keyboard. Its Ctrl, Alt and Shift also apply to what is typed on the keyboard.
  const mods = useStickyMods()
  const showKeys = coarse && prefs.extraKeys && caret.focused && !readOnly && !animating && !onLogout
  useEffect(() => {
    if (!showKeys) mods.reset()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showKeys])

  /**
   * One key with modifiers, the way a keyboard would send it: through onKeyDown, then what the
   * browser does with a key nothing used (typing it, moving the caret), which a made-up key
   * press does not get by itself.
   */
  function pressKey(key: string, m: ModKeys) {
    let prevented = false
    const e: KeyLike = {
      key: m.shift && key.length === 1 ? key.toUpperCase() : key,
      ctrlKey: m.ctrl,
      altKey: m.alt,
      shiftKey: m.shift,
      metaKey: false,
      preventDefault: () => void (prevented = true),
      stopPropagation: () => {},
    }
    onKeyDown(e)
    if (!prevented) keyDefault(e)
  }
  const pressRef = useRef(pressKey)
  pressRef.current = pressKey

  /** The browser's own part of a key press on the prompt line. */
  function keyDefault(e: KeyLike) {
    const el = inputRef.current
    if (!el || e.ctrlKey || e.altKey || e.metaKey) return
    if (e.key.length === 1) return typeText(e.key)
    const len = el.value.length
    const start = el.selectionStart ?? len
    const end = el.selectionEnd ?? start
    if (e.key === 'Backspace' || e.key === 'Delete') {
      if (readOnly || (start === end && (e.key === 'Backspace' ? start === 0 : end === len))) return
      const from = start !== end ? start : e.key === 'Backspace' ? start - 1 : start
      const to = start !== end ? end : e.key === 'Backspace' ? start : start + 1
      return replaceText(from, to, '')
    }
    const moves: Record<string, number> = { Home: 0, End: len, ArrowLeft: start !== end ? start : Math.max(0, start - 1), ArrowRight: start !== end ? end : Math.min(len, end + 1) }
    const at = moves[e.key]
    if (at === undefined) return
    el.setSelectionRange(at, at)
    syncCaret()
  }

  /** Text typed at the caret, as if from the keyboard (a raw program gets it as typed text). */
  function typeText(text: string) {
    const el = inputRef.current
    if (!el || readOnly) return
    if (running && keyHandler.current && rawKeys.current) return void keyHandler.current('Text', text)
    replaceText(el.selectionStart ?? el.value.length, el.selectionEnd ?? el.value.length, text)
  }

  function replaceText(from: number, to: number, text: string) {
    const el = inputRef.current
    if (!el) return
    // Straight into the field as well, so a second key in the same moment builds on this one.
    const next = el.value.slice(0, from) + text + el.value.slice(to)
    el.value = next
    el.setSelectionRange(from + text.length, from + text.length)
    setValue(next)
    syncCaret()
  }

  /** A key from the row. */
  const rowKey = (key: string) => pressKey(key, mods.take())

  /** A real key press: with a modifier from the row on, it goes the row's way. */
  function onRealKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (mods.armed() && !e.nativeEvent.isComposing && !['Shift', 'Control', 'Alt', 'Meta', 'Unidentified', 'Process', 'Dead'].includes(e.key)) {
      e.preventDefault()
      const m = mods.take()
      pressKey(e.key, { ctrl: m.ctrl || e.ctrlKey, alt: m.alt || e.altKey, shift: m.shift || e.shiftKey })
      return
    }
    onKeyDown(e)
  }

  // Phone keyboards mostly send text without telling which key (Android's key is "Unidentified"):
  // with a modifier from the row on, that text becomes key presses too, so Ctrl and then c on the
  // keyboard is Ctrl+C.
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    const onBeforeInput = (e: InputEvent) => {
      if (!mods.armed() || e.inputType !== 'insertText' || !e.data) return
      e.preventDefault()
      for (const ch of e.data) pressRef.current(ch, mods.take())
    }
    el.addEventListener('beforeinput', onBeforeInput)
    return () => el.removeEventListener('beforeinput', onBeforeInput)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
              label: 'Zoom',
              submenu: [
                { label: 'Zoom in', shortcut: 'Ctrl +', disabled: zoom >= ZOOM_MAX, onSelect: () => zoomBy('in') },
                { label: 'Zoom out', shortcut: 'Ctrl −', disabled: zoom <= ZOOM_MIN, onSelect: () => zoomBy('out') },
                { label: 'Actual size', shortcut: 'Ctrl 0', disabled: zoom === 1, onSelect: () => zoomBy(1) },
              ],
            },
            { label: 'Terminal settings…', onSelect: () => setSettingsOpen(true) },
          ]),
    ]
    openContextMenu(e, items)
  }

  const screen = (
    <div
      className={`terminal ${onLogout ? 'is-console' : ''} ${alt ? 'is-alt' : ''} ${takeover ? 'is-takeover' : ''} ${readOnly ? 'is-readonly' : ''} ${showKeys ? 'has-keys' : ''}`}
      ref={scrollRef}
      style={fontPx === null ? undefined : { fontSize: fontPx }}
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
            onChange={(e) => {
              // Text the keyboard put in although a modifier from the row is on (some keyboards'
              // input can't be stopped beforehand): taken out again and pressed as keys.
              const next = e.target.value
              if (mods.armed() && next.length > value.length) {
                let head = 0
                while (head < value.length && value[head] === next[head]) head++
                const tail = value.length - head
                if (next.slice(next.length - tail) === value.slice(head)) {
                  const added = next.slice(head, next.length - tail)
                  e.target.value = value
                  e.target.setSelectionRange(head, head)
                  for (const ch of added) pressKey(ch, mods.take())
                  return
                }
              }
              // Text that arrives without key presses (a phone's keyboard, IME, dictation) goes to a raw program as typed.
              if (running && keyHandler.current && rawKeys.current) {
                if (e.target.value) keyHandler.current('Text', e.target.value)
                setValue('')
                return
              }
              setValue(e.target.value)
            }}
            onKeyDown={onRealKeyDown}
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
  if (onLogout) return screen

  const closeSettings = () => {
    setSettingsOpen(false)
    if (!coarse) inputRef.current?.focus({ preventScroll: true })
  }
  return (
    <div className="term-wrap">
      {screen}
      {zoomBadge && (
        <div className="t-zoom-badge" aria-live="polite">
          {Math.round(zoom * 100)}%
        </div>
      )}
      {showKeys && <ExtraKeys mods={mods} onKey={rowKey} />}
      {settingsOpen && (
        <TerminalSettings
          zoom={zoom}
          onZoom={zoomBy}
          onClose={closeSettings}
          onAppearance={() => {
            setSettingsOpen(false)
            wm.open('settings', { section: 'appearance', t: String(Date.now()) })
          }}
          onAllSettings={() => {
            setSettingsOpen(false)
            wm.open('settings', { section: 'terminal', t: String(Date.now()) })
          }}
        />
      )}
    </div>
  )
}
