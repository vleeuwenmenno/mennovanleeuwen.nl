import type { SavedWindow } from '../../os/wm'
import { startupPrefs } from '../../os/startup'

// A game in progress belongs to its window. Each game window gets a session id (props.session,
// saved with the window layout), and whatever a game keeps so a reload can carry on (Empires'
// battle snapshots, the campaign it had open, being in multiplayer) is stored under that id.
// Closing the window throws it all away, so the game opens fresh next time; a reload restores the
// window with the same id, so the game picks up where it was. Real save games (Empires' named
// campaigns, Gladiator's careers), high scores and settings live elsewhere and are kept.

const PREFIX = 'mvlos.gamewin.'
const keyOf = (session: string, name: string) => `${PREFIX}${session}.${name}`
/** Where os/synced.ts keeps the saved window layouts (windows:desktop and windows:mobile). */
const LAYOUTS = 'mvlos.sync.windows:'

export const newSession = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 46656).toString(36)}`

type Where = 'local' | 'tab'
const storage = (where: Where) => (where === 'tab' ? sessionStorage : localStorage)

/** What a game window keeps for itself under `name`, or null (also without a session). */
export function sessionGet<T>(session: string | undefined, name: string, where: Where = 'local'): T | null {
  if (!session) return null
  try {
    return JSON.parse(storage(where).getItem(keyOf(session, name)) ?? 'null') as T | null
  } catch {
    return null
  }
}

/** Keeps `v` for this game window (null forgets it). Without a session nothing is kept. */
export function sessionPut(session: string | undefined, name: string, v: unknown, where: Where = 'local') {
  if (!session) return
  try {
    if (v === null) storage(where).removeItem(keyOf(session, name))
    else storage(where).setItem(keyOf(session, name), JSON.stringify(v))
  } catch {
    // Storage full or blocked: a reload starts this game afresh.
  }
}

/** Keys from before games were tied to their windows: a campaign to reopen, battles to resume. */
const RETIRED = (k: string) => k === 'mvlos.empires.resume' || k.startsWith('mvlos.empires.battle.')

/** Removes what game windows kept, for every session `drop` says to (and the retired keys). */
function sweep(drop: (session: string) => boolean) {
  for (const s of [localStorage, sessionStorage]) {
    try {
      const keys: string[] = []
      for (let i = 0; i < s.length; i++) keys.push(s.key(i) ?? '')
      for (const k of keys) {
        if (RETIRED(k)) s.removeItem(k)
        else if (k.startsWith(PREFIX) && drop(k.slice(PREFIX.length).split('.')[0])) s.removeItem(k)
      }
    } catch {
      // Storage blocked: there is nothing kept to remove either.
    }
  }
}

/** The game window with this session closed: its game is gone. */
export const discardSession = (session: string) => sweep((s) => s === session)

// Game windows mounted right now, by session. React's development mode unmounts and mounts every
// component once on the way in; a window counts as closed only when it stays unmounted.
const mounted = new Map<string, number>()
export function holdSession(session: string) {
  mounted.set(session, (mounted.get(session) ?? 0) + 1)
  return () => {
    const n = (mounted.get(session) ?? 1) - 1
    if (n > 0) mounted.set(session, n)
    else mounted.delete(session)
    setTimeout(() => !mounted.has(session) && discardSession(session), 0)
  }
}

// At startup, what windows that no longer exist kept is removed: windows closed while another tab
// had the layout, closed on another device, or not brought back because the desktop starts with
// the welcome windows or nothing. This runs before the window manager restores anything. Both saved
// layouts count (phones and bigger screens keep their own, see layoutStore in os/wm.tsx), so a
// page loaded in a narrow window doesn't end the games waiting in the wide layout. A layout that
// can't be read stops the sweep: better to keep a little too much than to end a game.
{
  const live = new Set<string>()
  let readable = true
  try {
    if (startupPrefs().windows === 'last') {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i) ?? ''
        if (!k.startsWith(LAYOUTS)) continue
        const saved = (JSON.parse(localStorage.getItem(k) ?? 'null') as { value?: SavedWindow[] | null } | null)?.value ?? []
        for (const w of saved) if (w.app === 'games' && w.props?.session) live.add(w.props.session)
      }
    }
  } catch {
    readable = false
  }
  if (readable) sweep((s) => !live.has(s))
}
