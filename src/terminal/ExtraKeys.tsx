import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

// The row of extra keys above a phone's keyboard, like Termux's: the keys a touch keyboard lacks
// (Esc, Tab, Ctrl, Alt, arrows) and symbols it hides a page or two away. The terminal feeds every
// key through the same handler as a real keyboard, so the line editor, history, completion and
// full-screen programs (nano, htop, agents) cannot tell the difference.
//
// Ctrl, Alt and Shift are sticky, so they work with one finger: a tap applies to the next key
// only, a double tap locks until tapped again, and holding one applies it to whatever is typed
// meanwhile (on the row or on the keyboard).

export type Mod = 'ctrl' | 'alt' | 'shift'
/** off; once: the next key only; lock: until tapped again; held: while the finger stays on it */
type ModState = 'off' | 'once' | 'lock' | 'held'
export type ModKeys = { ctrl: boolean; alt: boolean; shift: boolean }

const DOUBLE_TAP = 350
const NONE: Record<Mod, ModState> = { ctrl: 'off', alt: 'off', shift: 'off' }

/**
 * The modifiers' state, shared by the row (which sets it) and the terminal (which applies it to
 * the next key from the row or the keyboard). Read through `take`, which also uses up one-shots.
 */
export function useStickyMods() {
  const [state, setState] = useState<Record<Mod, ModState>>(NONE)
  const ref = useRef(state)
  // Per modifier: what it was before the finger landed, when it was last tapped, and whether a key
  // was typed while it was held (then lifting the finger ends it instead of counting as a tap).
  const press = useRef<Record<Mod, { before: ModState; tappedAt: number; used: boolean }>>({
    ctrl: { before: 'off', tappedAt: 0, used: false },
    alt: { before: 'off', tappedAt: 0, used: false },
    shift: { before: 'off', tappedAt: 0, used: false },
  })
  const set = (next: Record<Mod, ModState>) => {
    ref.current = next
    setState(next)
  }
  const mods = {
    state,
    /** Any modifier on, so typed text has to go through the terminal's key handler. */
    armed: () => Object.values(ref.current).some((s) => s !== 'off'),
    /** The modifiers for one key; one-shots are used up by it. */
    take(): ModKeys {
      const now = ref.current
      const keys = { ctrl: now.ctrl !== 'off', alt: now.alt !== 'off', shift: now.shift !== 'off' }
      const next = { ...now }
      for (const m of ['ctrl', 'alt', 'shift'] as const) {
        if (now[m] === 'once') next[m] = 'off'
        if (now[m] === 'held') press.current[m].used = true
      }
      if (next.ctrl !== now.ctrl || next.alt !== now.alt || next.shift !== now.shift) set(next)
      return keys
    },
    down(m: Mod) {
      press.current[m] = { ...press.current[m], before: ref.current[m], used: false }
      set({ ...ref.current, [m]: 'held' })
    },
    up(m: Mod) {
      const p = press.current[m]
      if (ref.current[m] !== 'held') return
      let next: ModState
      if (p.used) next = p.before === 'lock' ? 'lock' : 'off'
      else if (p.before === 'off') next = 'once'
      else if (p.before === 'once') next = performance.now() - p.tappedAt < DOUBLE_TAP ? 'lock' : 'off'
      else next = 'off'
      if (next === 'once') p.tappedAt = performance.now()
      set({ ...ref.current, [m]: next })
    },
    reset: () => set(NONE),
  }
  return mods
}

export type StickyMods = ReturnType<typeof useStickyMods>

type Key = { label: string; key?: string; mod?: Mod; repeat?: boolean; wide?: boolean; title?: string }

// Two rows on one grid, so ↑ sits over ↓ like on a keyboard.
const ROWS: Key[][] = [
  [{ label: 'esc', key: 'Escape' }, { label: '~', key: '~' }, { label: '|', key: '|' }, { label: '/', key: '/' }, { label: '-', key: '-' }, { label: 'home', key: 'Home' }, { label: '↑', key: 'ArrowUp', repeat: true, title: 'Up' }, { label: 'end', key: 'End' }],
  [{ label: 'tab', key: 'Tab' }, { label: 'ctrl', mod: 'ctrl' }, { label: 'alt', mod: 'alt' }, { label: 'shift', mod: 'shift', wide: true }, { label: '←', key: 'ArrowLeft', repeat: true, title: 'Left' }, { label: '↓', key: 'ArrowDown', repeat: true, title: 'Down' }, { label: '→', key: 'ArrowRight', repeat: true, title: 'Right' }],
]

const REPEAT_DELAY = 400
const REPEAT_EVERY = 60

/** The row itself. `onKey` gets the key name, as KeyboardEvent.key would have it. */
export function ExtraKeys({ mods, onKey }: { mods: StickyMods; onKey: (key: string) => void }) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const stop = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }
  useEffect(() => stop, [])

  const down = (k: Key) => (e: ReactPointerEvent<HTMLButtonElement>) => {
    // The prompt keeps the focus, so the keyboard stays up.
    e.preventDefault()
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* the pointer is already gone */
    }
    if (k.mod) return mods.down(k.mod)
    if (!k.key) return
    const key = k.key
    onKey(key)
    // Holding an arrow moves on, like a held key.
    if (k.repeat) {
      const again = () => {
        onKey(key)
        timer.current = setTimeout(again, REPEAT_EVERY)
      }
      timer.current = setTimeout(again, REPEAT_DELAY)
    }
  }
  const up = (k: Key) => () => {
    stop()
    if (k.mod) mods.up(k.mod)
  }

  return (
    <div className="t-keys" role="toolbar" aria-label="Extra keys" data-no-touch-menu onContextMenu={(e) => e.preventDefault()}>
      {ROWS.flat().map((k) => {
        const s = k.mod ? mods.state[k.mod] : 'off'
        return (
          <button
            key={k.label}
            type="button"
            tabIndex={-1}
            className={`t-key ${k.wide ? 'is-wide' : ''} ${s === 'once' || s === 'held' ? 'is-on' : ''} ${s === 'lock' ? 'is-locked' : ''}`}
            aria-label={k.title ?? k.label}
            aria-pressed={k.mod ? s !== 'off' : undefined}
            onPointerDown={down(k)}
            onPointerUp={up(k)}
            onPointerCancel={up(k)}
            onMouseDown={(e) => e.preventDefault()}
          >
            {k.label}
          </button>
        )
      })}
    </div>
  )
}
