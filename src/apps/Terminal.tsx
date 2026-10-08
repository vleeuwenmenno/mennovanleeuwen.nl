import { Fragment, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { profile } from '../data/profile'
import { setAccent } from '../os/theme'
import { useWM, type WinState } from '../os/wm'
import { complete, fastfetch, runLine } from '../terminal/commands'
import { SlTrain } from '../terminal/SlTrain'
import { HOME, prettyPath } from '../terminal/vfs'

type Entry = { id: number; kind: 'cmd'; cwd: string; text: string } | { id: number; kind: 'out'; text: string }

const MARKUP = /\{(c|link|anim):([^}]*)\}([\s\S]*?)\{\/\}/g

/** Renders the `{c:color}…{/}` / `{link:url}…{/}` markup produced by commands. */
function Markup({ text, onAnimationEnd }: { text: string; onAnimationEnd?: () => void }) {
  const parts: ReactNode[] = []
  let last = 0
  for (const m of text.matchAll(MARKUP)) {
    if (m.index! > last) parts.push(text.slice(last, m.index))
    const [, kind, arg, inner] = m
    parts.push(
      kind === 'anim' ? (
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
const QUICK = ['help', 'projects', 'recent 8', 'cat cv.md', 'ls -l', 'contribs', 'fastfetch', 'fortune | cowsay']
const HISTORY_KEY = 'mvlos.history'

function loadHistory(): string[] {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]')
  } catch {
    return []
  }
}

export function Terminal({ win }: { win: WinState }) {
  const wm = useWM()
  const [entries, setEntries] = useState<Entry[]>(() => [
    { id: nextId++, kind: 'out', text: fastfetch({ windows: wm.windows }) },
    {
      id: nextId++,
      kind: 'out',
      text: `\nWelcome to {c:accent}MvL OS{/}. Type {c:green}help{/} to see what works, or try {c:green}projects{/}, {c:green}recent{/}, {c:green}cat cv.md{/}.\n`,
    },
  ])
  const [cwd, setCwd] = useState(HOME)
  const [value, setValue] = useState('')
  const [running, setRunning] = useState(false)
  // An animation (sl) holds the prompt until it finishes, like the real one.
  const [animating, setAnimating] = useState(false)
  const busy = running || animating
  const history = useRef<string[]>(loadHistory())
  const histIdx = useRef<number | null>(null)
  const env = useRef<Record<string, string>>({ USER: profile.handle, HOME, SHELL: '/bin/msh', TERM: 'xterm-mvlos', EDITOR: 'nvim', LANG: 'en_US.UTF-8' })
  const inputRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const windowsRef = useRef(wm.windows)
  windowsRef.current = wm.windows

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [entries, busy])

  // Focus the prompt whenever this window comes to the front (not on touch, where it pops the keyboard).
  useEffect(() => {
    if (wm.focusedPid === win.pid && !matchMedia('(pointer: coarse)').matches) inputRef.current?.focus({ preventScroll: true })
  }, [wm.focusedPid, win.pid])

  // Other apps can ask the terminal to run something (e.g. "Open in terminal" buttons).
  useEffect(() => {
    if (win.props.run) submit(win.props.run)
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

    let cleared = false
    setRunning(true)
    const results = await runLine(trimmed, {
      cwd,
      setCwd,
      env: env.current,
      history: history.current,
      windows: windowsRef.current,
      openApp: wm.open,
      closeWindow: wm.close,
      clear: () => {
        cleared = true
      },
      exit: () => setTimeout(() => wm.close(win.pid), 120),
      setAccent,
    })
    setRunning(false)
    if (results.some((r) => r.output.includes('{anim:'))) setAnimating(true)
    setEntries((e) => {
      const base = cleared ? [] : e
      return [...base, ...results.filter((r) => r.output).map((r) => ({ id: nextId++, kind: 'out' as const, text: r.output }))]
    })
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
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
      setEntries((x) => [...x, { id: nextId++, kind: 'cmd', cwd, text: value + '^C' }])
      setValue('')
    } else if (e.ctrlKey && e.key.toLowerCase() === 'u') {
      e.preventDefault()
      setValue('')
    }
  }

  return (
    <div
      className="terminal"
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
      {busy && (
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
