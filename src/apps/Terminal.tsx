import { Fragment, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { profile } from '../data/profile'
import { setAccent } from '../os/theme'
import { useWM, type WinState } from '../os/wm'
import { complete, fastfetch, runLine } from '../terminal/commands'
import { SlTrain } from '../terminal/SlTrain'
import { HOME, prettyPath } from '../terminal/vfs'

type Entry = { id: number; kind: 'cmd'; cwd: string; text: string } | { id: number; kind: 'out'; text: string }

const MARKUP = /\{(c|link|anim|fg):([^}]*)\}([\s\S]*?)\{\/\}/g
const COLORS = new Set(['green', 'red', 'yellow', 'blue', 'cyan', 'magenta', 'muted', 'accent', 'bold', 'heat1', 'heat2', 'heat3', 'heat4'])

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
  const history = useRef<string[]>(loadHistory())
  const histIdx = useRef<number | null>(null)
  const env = useRef<Record<string, string>>({ USER: profile.handle, HOME, SHELL: '/bin/msh', TERM: 'xterm-mvlos', EDITOR: 'nvim', LANG: 'en_US.UTF-8' })
  const inputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const keyHandler = useRef<((key: string) => boolean) | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const windowsRef = useRef(wm.windows)
  windowsRef.current = wm.windows

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
    // The console grows inside the boot screen, which does the scrolling.
    if (onLogout) scrollRef.current?.scrollIntoView({ block: 'end' })
  }, [entries, busy, onLogout])

  useEffect(() => {
    if (onLogout && !matchMedia('(pointer: coarse)').matches) inputRef.current?.focus({ preventScroll: true })
  }, [onLogout])

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
    const live = (text: string | null) => {
      setDrawing(text !== null)
      if (text === null) {
        const id = liveId
        liveId = null
        if (id !== null) setEntries((e) => e.filter((x) => x.id !== id))
      } else if (liveId === null) {
        const id = (liveId = nextId++)
        setEntries((e) => [...e, { id, kind: 'out', text }])
      } else {
        const id = liveId
        setEntries((e) => e.map((x) => (x.id === id ? { ...x, text } : x)))
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
      onKey: (h) => {
        keyHandler.current = h
      },
      signal: abortRef.current.signal,
    })
    keyHandler.current = null
    setDrawing(false)
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

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (running && keyHandler.current && !e.ctrlKey && !e.metaKey && keyHandler.current(e.key)) {
      e.preventDefault()
      return
    }
    if (e.key === 'Enter') {
      if (!busy) submit(value)
    } else if (e.key === 'Tab') {
      e.preventDefault()
      const { line, options } = complete(value, cwd)
      setValue(line)
      if (options.length) setEntries((x) => [...x, { id: nextId++, kind: 'cmd', cwd, text: value }, { id: nextId++, kind: 'out', text: options.join('  ') }])
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

  return (
    <div
      className={`terminal ${onLogout ? 'is-console' : ''}`}
      ref={scrollRef}
      onMouseUp={() => {
        if (!window.getSelection()?.toString()) inputRef.current?.focus({ preventScroll: true })
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
            <pre className="t-out">
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
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          aria-label="Terminal input"
          enterKeyHint="send"
        />
      </label>
      <div className="t-quick" aria-label="Quick commands">
        {QUICK.map((q) => (
          <button key={q} disabled={busy} onClick={() => submit(q)}>
            {q}
          </button>
        ))}
      </div>
    </div>
  )
}
