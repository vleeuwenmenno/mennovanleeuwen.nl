import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { useGoSuggestionState, useGolinksTemplate } from '../data/golinks'
import { cvMode } from '../os/cvMode'
import { browserMountPoint, useMounts } from '../data/mounts'
import { HANDLE } from '../os/identity'
import { linkAt, linkMenu, openContextMenu, type MenuItem } from '../os/ContextMenu'
import { notify } from '../os/notify'
import { ask } from '../os/Dialogs'
import { useDropTarget, type Drag } from '../os/dnd'
import { posixPath } from '../data/launchers'
import { whereIs } from '../data/mounts'
import { uploadFiles } from '../data/uploads'
import { setAccent } from '../os/theme'
import { useIsMobile } from '../os/useIsMobile'
import { useMediaQuery } from '../os/useMediaQuery'
import { useWM, type WinState } from '../os/wm'
import { complete, completions, escapeArg, fastfetch, runLine, WORD_RE, type Completion } from '../terminal/commands'
import { ExtraKeys, useStickyMods, type ModKeys } from '../terminal/ExtraKeys'
import { prepareFolder } from '../terminal/fs'
import { quotePaths } from '../terminal/words'
import { useTerminalPrefs } from '../terminal/prefs'
import { SlTrain } from '../terminal/SlTrain'
import { TerminalSettings } from '../terminal/TerminalSettings'
import { HOME, prettyPath, resolvePath } from '../terminal/vfs'
import { markupColor, parseMarkupLines, type MarkupNode } from '../terminal/markup'
import type { Line } from '../terminal/vt/screen'
import { VtSession, type TermPort } from '../terminal/vt/session'
import { VtLines, VtView } from '../terminal/vt/VtView'
import { encodeKey, encodePaste } from '../terminal/vt/keys'
import { CmdError } from '../terminal/types'

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

/** `vt`: what an attached stream (SSH, vtdemo) left on the screen when it detached. */
type Entry = { id: number; kind: 'cmd'; cwd: string; text: string } | { id: number; kind: 'out'; text: string; alt?: boolean } | { id: number; kind: 'vt'; lines: Line[] }

/** One node of the markup tree (src/terminal/markup.ts) as React. */
function renderNode(node: MarkupNode, key: number, onAnimationEnd?: () => void): ReactNode {
  if (typeof node === 'string') return node
  const inner = node.children.map((c, i) => renderNode(c, i, onAnimationEnd))
  switch (node.kind) {
    case 'fg':
      return (
        <span key={key} style={{ color: markupColor(node.arg) }}>
          {inner}
        </span>
      )
    case 'bg':
      return (
        <span key={key} style={{ background: markupColor(node.arg) }}>
          {inner}
        </span>
      )
    case 'anim':
      return <SlTrain key={key} onDone={onAnimationEnd} />
    case 'link':
      return (
        <a key={key} href={node.arg} target="_blank" rel="noopener noreferrer">
          {inner}
        </a>
      )
    default:
      return (
        <span key={key} className={`t-${node.arg}`}>
          {inner}
        </span>
      )
  }
}

/** One line of markup; it only renders again when its text (and the tags open around it) changed. */
const MarkupLineView = memo(
  function MarkupLineView({ nodes, newline, onAnimationEnd }: { k: string; nodes: MarkupNode[]; newline: boolean; onAnimationEnd?: () => void }) {
    return (
      <>
        {nodes.map((n, i) => renderNode(n, i, onAnimationEnd))}
        {newline && '\n'}
      </>
    )
  },
  (a, b) => a.k === b.k && a.newline === b.newline,
)

/**
 * Renders the markup produced by commands (src/terminal/markup.ts): colours, looks, links and
 * the one animation, nested, line by line.
 */
function Markup({ text, onAnimationEnd }: { text: string; onAnimationEnd?: () => void }) {
  const lines = useMemo(() => parseMarkupLines(text), [text])
  return (
    <>
      {lines.map((l, i) => (
        <MarkupLineView key={i} k={l.key} nodes={l.nodes} newline={i < lines.length - 1} onAnimationEnd={onAnimationEnd} />
      ))}
    </>
  )
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
type KeyLike = Pick<KeyboardEvent<HTMLInputElement>, 'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey' | 'preventDefault' | 'stopPropagation'> & { code?: string }

/** The window title a program set (OSC 0/2) while a stream is attached; else the usual (apps.tsx). */
export const terminalTitle = (w: WinState) => (w.props.vtTitle ? String(w.props.vtTitle) : undefined)

/** A theme colour (set by src/os/theme.ts) for programs that ask for the terminal's colours. */
const themeColor = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()

// An attached stream draws with a tighter line height than msh's output (src/styles.css), so
// box drawing joins up; rows are counted with it.
const VT_LINE_HEIGHT = 1.25

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

  // An attached byte stream (src/terminal/vt/session.ts): while there is one, the window shows
  // its screen and every key goes to it.
  const [session, setSession] = useState<VtSession | null>(null)
  const sessionRef = useRef<VtSession | null>(null)
  const [vtAlt, setVtAlt] = useState(false)
  const cellRef = useRef<{ w: number; h: number } | null>(null)
  // Whether the view follows the output (it stops when scrolled up to read the scrollback).
  const stuckRef = useRef(true)
  const propsRef = useRef(win.props)
  propsRef.current = win.props
  const setVtTitle = (title: string | null) => {
    if (embedded || onLogout) return
    if ((propsRef.current.vtTitle ?? '') === (title ?? '')) return
    wm.setProps(win.pid, { vtTitle: title ?? '' })
  }
  const setVtTitleRef = useRef(setVtTitle)
  setVtTitleRef.current = setVtTitle

  /** Columns and rows for the attached screen, from the measured cell or the font. */
  function vtSize() {
    const el = scrollRef.current
    if (!el) return { cols: 80, rows: 24 }
    const style = getComputedStyle(el)
    let cell = cellRef.current
    if (!cell) {
      const ctx2d = document.createElement('canvas').getContext('2d')!
      ctx2d.font = `${style.fontSize} ${style.fontFamily}`
      cell = { w: ctx2d.measureText('MMMMMMMMMM').width / 10 || 8, h: parseFloat(style.fontSize) * VT_LINE_HEIGHT || 16 }
    }
    const w = el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
    const h = el.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
    return { cols: Math.max(20, Math.floor(w / cell.w)), rows: Math.max(4, Math.floor(h / cell.h)) }
  }

  /** ctx.attachStream: hands this window to a byte stream until it detaches. */
  function attachStream(): TermPort {
    if (sessionRef.current) throw new CmdError('a stream is already attached to this terminal')
    cellRef.current = null
    const s = new VtSession(vtSize(), {
      onEnd: (lines) => {
        sessionRef.current = null
        setSession(null)
        setVtAlt(false)
        setVtTitleRef.current(null)
        if (lines.length) setEntries((e) => [...e, { id: nextId++, kind: 'vt', lines }])
        if (!matchMedia('(pointer: coarse)').matches) requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }))
      },
      onTitle: (t) => setVtTitleRef.current(t || null),
      colors: () => ({ fg: themeColor('--fg'), bg: themeColor('--bg') }),
    })
    sessionRef.current = s
    stuckRef.current = true
    setSession(s)
    setValue('')
    return s
  }

  // The window closing ends the stream.
  useEffect(() => () => sessionRef.current?.detach(), [])

  // A title left over from a stream before a reload goes.
  useEffect(() => {
    if (win.props.vtTitle && !sessionRef.current) setVtTitle(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The attached screen follows the window's size and the text size.
  useEffect(() => {
    if (!session) return
    const fit = () => session.resize(vtSize())
    const ro = new ResizeObserver(fit)
    if (scrollRef.current) ro.observe(scrollRef.current)
    fit()
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, fontPx])
  const onCellSize = useCallback(
    (w: number, h: number) => {
      const was = cellRef.current
      if (was && Math.abs(was.w - w) < 0.01 && Math.abs(was.h - h) < 0.01) return
      cellRef.current = { w, h }
      sessionRef.current?.resize(vtSize())
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )
  /** After the attached screen drew: keep the newest output in view, unless scrolled up. */
  const onVtDrawn = useCallback((alt: boolean) => {
    setVtAlt(alt)
    const el = scrollRef.current
    if (el && (stuckRef.current || alt)) el.scrollTop = el.scrollHeight
  }, [])

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
    // A program's title changes the props too, but is not a new request.
    const prev = handledProps.current
    const keys = (p: WinState['props']) => Object.keys(p).filter((k) => k !== 'vtTitle')
    const titleOnly = !!prev && prev.vtTitle !== win.props.vtTitle && keys(prev).length === keys(win.props).length && keys(prev).every((k) => prev[k] === win.props[k])
    if (titleOnly) handledProps.current = win.props
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
    const signal = abortRef.current.signal
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
      attachStream: () => {
        const port = attachStream()
        // Stop command (the menu) ends it; Ctrl+C goes to the program.
        signal.addEventListener('abort', () => port.detach(), { once: true })
        return port
      },
    })
    // A stream outlives nothing: the command that attached it is done.
    sessionRef.current?.detach()
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
    // An attached stream gets every key as an xterm sends it, except copying a selection (Ctrl+C
    // with text selected, Ctrl+Shift+C) and pasting (Ctrl+V, Ctrl+Shift+V), which the browser does.
    const s = sessionRef.current
    if (s) {
      const k = e.key.toLowerCase()
      if ((e.ctrlKey || e.metaKey) && (k === 'v' || (k === 'c' && (e.shiftKey || window.getSelection()?.toString())))) return
      // Keys that only start composing (IME, dead keys, phone keyboards) arrive as text instead.
      if (['Process', 'Unidentified', 'Dead'].includes(e.key)) return
      const seq = encodeKey(e, s.vt.modes)
      if (seq === null) return
      e.preventDefault()
      e.stopPropagation()
      stuckRef.current = true
      s.send(seq)
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
    const s = sessionRef.current
    if (s) return s.send(encodePaste(text, s.vt.modes.bracketedPaste))
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

  // Files and folders dropped on the terminal paste their paths, quoted, like on a real one. Those
  // from the computer have no path here: they upload into the working folder first, if asked.
  useDropTarget(
    scrollRef,
    {
      accept: (d) => (readOnly ? null : d.os ? 'copy' : d.items.some((i) => i.kind === 'file') ? 'link' : null),
      drop: (d) => void dropPaths(d),
    },
    !onLogout,
  )

  /** What is typed or pasted goes to a program that has the screen (as a bracketed paste), or the input line. */
  function pasteText(text: string) {
    const s = sessionRef.current
    if (s) return s.send(encodePaste(text, s.vt.modes.bracketedPaste))
    if (running && keyHandler.current && rawKeys.current) return void keyHandler.current('Paste', text)
    if (running) return notify({ title: 'A command is running', body: 'Paths go in when it is done.', transient: true })
    const el = inputRef.current
    const start = el?.selectionStart ?? value.length
    const end = el?.selectionEnd ?? value.length
    const before = value.slice(0, start)
    const after = value.slice(end)
    const put = `${before && !/\s$/.test(before) ? ' ' : ''}${text}${/^\s/.test(after) ? '' : ' '}`
    setValue(before + put + after)
    requestAnimationFrame(() => {
      el?.focus({ preventScroll: true })
      el?.setSelectionRange(before.length + put.length, before.length + put.length)
      syncCaret()
    })
  }

  async function dropPaths(d: Drag) {
    const names: string[] = []
    if (d.os) {
      const picked = await d.files()
      if (!picked.length) return
      if (sessionRef.current || running) return notify({ title: 'Nothing to paste', body: 'Files from the computer have no path here. Drop them when the prompt is free.', transient: true })
      const w = whereIs(cwd)
      if (!(w.kind === 'browser' || (w.kind === 'sf' && !w.ro))) {
        notify({ title: `Cannot upload into ${prettyPath(cwd)}`, body: 'Go to a folder in Seafile or in this browser (cd ~) and drop them again.', transient: true })
        return
      }
      const top = [...new Set(picked.map((p) => (p.rel ? p.rel.split('/')[0] : p.file.name)))]
      const one = top.length === 1
      const ok = await ask({
        title: one ? `Upload “${top[0]}”?` : `Upload ${top.length} items?`,
        body: `Files from your computer have no path in the terminal. ${one ? 'It goes' : 'They go'} into ${prettyPath(cwd)}, and the path${one ? ' is' : 's are'} added to the line.`,
        confirm: 'Upload',
      })
      if (!ok) return
      await uploadFiles(picked, w.kind === 'sf' ? w.sf : cwd)
      names.push(...top.map((n) => `${cwd === '/' ? '' : cwd}/${n}`))
    } else {
      const unmounted: string[] = []
      for (const i of d.items) {
        if (i.kind !== 'file') continue
        const path = posixPath(i.path)
        if (path) names.push(path)
        else unmounted.push(i.name)
      }
      if (unmounted.length) notify({ title: `${unmounted.length === 1 ? unmounted[0] : `${unmounted.length} items`} not in the terminal`, body: 'Their library is not mounted. See mount.', transient: true })
    }
    if (names.length) pasteText(quotePaths(names))
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
      { label: 'Clear', shortcut: 'Ctrl L', disabled: alt || readOnly || !!session, onSelect: () => setEntries([]) },
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
      className={`terminal selectable ${onLogout ? 'is-console' : ''} ${alt || (session && vtAlt) ? 'is-alt' : ''} ${takeover ? 'is-takeover' : ''} ${session ? 'is-vt' : ''} ${readOnly ? 'is-readonly' : ''} ${showKeys ? 'has-keys' : ''}`}
      ref={scrollRef}
      onScroll={(e) => {
        if (!sessionRef.current) return
        const el = e.currentTarget
        stuckRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 8
      }}
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
          ) : e.kind === 'vt' ? (
            <VtLines lines={e.lines} />
          ) : (
            <pre className={`t-out ${e.alt ? 't-alt' : ''}`}>
              <Markup text={e.text} onAnimationEnd={() => setAnimating(false)} />
            </pre>
          )}
        </Fragment>
      ))}
      {session && <VtView session={session} focused={caret.focused && !readOnly} onCellSize={onCellSize} onDrawn={onVtDrawn} />}
      {running && !drawing && !session && (
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
              if (sessionRef.current) {
                if (e.target.value) sessionRef.current.send(e.target.value.replace(/\n/g, '\r'))
                setValue('')
                return
              }
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
              const s = sessionRef.current
              if (s) {
                e.preventDefault()
                s.send(encodePaste(e.clipboardData.getData('text/plain'), s.vt.modes.bracketedPaste))
                return
              }
              if (!running || !keyHandler.current || !rawKeys.current) return
              e.preventDefault()
              keyHandler.current('Paste', e.clipboardData.getData('text/plain'))
            }}
            onKeyUp={syncCaret}
            onSelect={syncCaret}
            onFocus={() => {
              syncCaret()
              if (sessionRef.current?.vt.modes.focus) sessionRef.current.send('\x1b[I')
            }}
            onBlur={() => {
              syncCaret()
              if (sessionRef.current?.vt.modes.focus) sessionRef.current.send('\x1b[O')
            }}
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
