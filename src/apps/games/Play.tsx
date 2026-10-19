import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { ContextMenuHost } from '../../os/ContextMenu'
import { Dialogs, tell } from '../../os/Dialogs'
import { Notifications } from '../../os/Notifications'
import { notify } from '../../os/notify'
import { playGameId } from '../../os/playMode'
import { REFUSED } from '../../os/Shell'
import { SoloWindowProvider, type WinState } from '../../os/wm'
import { FullscreenIcon, GAMES, useGameBar } from './Games'
import { Library } from './Library'
import { notePlayed } from './prefs'
import { playSession } from './session'

// A game by its direct link (/play/<game>, src/os/playMode.ts): just the game, filling the page,
// with the game bar from the OS window (name, fullscreen) and a way back to MvL OS. /play lists the
// games; a link to a game that doesn't exist lands there with a note. Saves, settings and high
// scores are the same localStorage keys the OS uses (same origin), so progress carries over both
// ways. The game in progress belongs to the tab instead of a window (session.ts): a reload carries
// on, closing the tab ends it.

type Game = (typeof GAMES)[number]

/** The tab's icon: the game's glyph, drawn as an SVG so any emoji works as a favicon. */
const glyphIcon = (glyph: string) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="88">${glyph}</text></svg>`)}`

/** Sets the page's title and icon for as long as it shows this. */
function usePageIdentity(title: string, icon: string | null) {
  useEffect(() => {
    document.title = title
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
    if (!link || !icon) return
    const was = { href: link.getAttribute('href'), type: link.getAttribute('type') }
    link.setAttribute('href', icon)
    link.setAttribute('type', 'image/svg+xml')
    return () => {
      if (was.href) link.setAttribute('href', was.href)
      if (was.type) link.setAttribute('type', was.type)
    }
  }, [title, icon])
}

/** The browser's own fullscreen: this page is the game, so the game can have the whole monitor. */
function useBrowserFullscreen() {
  const [on, setOn] = useState(() => !!document.fullscreenElement)
  useEffect(() => {
    const sync = () => setOn(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', sync)
    return () => document.removeEventListener('fullscreenchange', sync)
  }, [])
  const toggle = useCallback(() => {
    const done = document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()
    done?.catch(() => {})
  }, [])
  // iPhones only let videos go fullscreen; there the button would do nothing, so it isn't shown.
  return { on, toggle, available: !!document.fullscreenEnabled }
}

/** Back from GitHub's sign-in (Gladiator's "sign in to sync"): /play/<game>?auth=ok|error|off|full|closed|banned. */
const SIGNED_IN: Record<string, { title: string; body?: string }> = {
  ok: { title: 'Signed in', body: 'Saves and high scores now follow you to your other devices.' },
  error: { title: 'Sign-in failed', body: 'GitHub did not complete the sign-in. Try again.' },
  off: { title: 'Sign-in is not set up', body: 'This server has no GitHub OAuth app configured.' },
}
function useSignInResult() {
  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const auth = params.get('auth')
    if (auth === null) return
    const refused = REFUSED[auth]
    // Not cancelled on unmount: React's development mode mounts twice, and the address is clean by the second.
    setTimeout(() => (refused ? void tell(refused(params.get('reason'))) : SIGNED_IN[auth] && notify(SIGNED_IN[auth])), 600)
    history.replaceState(null, '', location.pathname)
  }, [])
}

export function PlayPage() {
  useSignInResult()
  const id = playGameId()
  const game = id ? GAMES.find((g) => g.id === id) : undefined
  return (
    <>
      {game ? <PlayGame game={game} /> : <PlayArcade missing={id} />}
      <ContextMenuHost />
      <Notifications />
      <Dialogs />
    </>
  )
}

function PlayGame({ game }: { game: Game }) {
  usePageIdentity(`${game.name} · MvL OS`, glyphIcon(game.glyph))
  // The game's "window": the whole page, always focused, with the tab's session for what the game
  // keeps across a reload.
  const [session] = useState(() => playSession(game.id))
  useEffect(() => notePlayed(game.id), [game.id])
  const win = useMemo<WinState>(
    () => ({ pid: 1, app: 'games', x: 0, y: 0, w: window.innerWidth, h: window.innerHeight, z: 1, minimized: false, maximized: true, props: { game: game.id, session }, openedAt: Date.now() }),
    [game.id, session],
  )
  const bar = useGameBar()
  const full = useBrowserFullscreen()
  const Game = game.component
  // `is-page-full` as in the OS when a game fills the screen: the safe areas are kept clear and
  // Empires' edge scrolling counts it as fullscreen, which on this page it always is.
  return (
    <SoloWindowProvider win={win}>
      <div className={`games-play is-page-full is-standalone ${bar.shown ? 'is-bar' : ''}`}>
        <div className="games-hot" onPointerEnter={(e) => e.pointerType === 'mouse' && bar.show()} aria-hidden />
        <div className="games-top" onPointerEnter={(e) => e.pointerType === 'mouse' && bar.show()} onPointerLeave={(e) => e.pointerType === 'mouse' && bar.hideSoon()}>
          <span className="games-title">
            {game.glyph} {game.name}
          </span>
          <span className="play-links">
            {full.available && (
              <button className="games-full" onClick={full.toggle} title={full.on ? 'Leave fullscreen (Esc)' : 'Fill the whole screen with the game'} aria-pressed={full.on}>
                <FullscreenIcon on={full.on} />
                <span>{full.on ? 'Exit fullscreen' : 'Fullscreen'}</span>
              </button>
            )}
            <a href="/play" title="All the games">
              Arcade
            </a>
            <a href="/" title="The desktop this game comes from">
              MvL OS
            </a>
          </span>
          <button className="games-handle" onClick={bar.toggle} aria-label={bar.shown ? 'Hide the game bar' : 'Show the game bar'} aria-expanded={bar.shown} />
        </div>
        <Suspense fallback={<div className="game"><p className="muted">Loading…</p></div>}>
          <Game key={session} win={win} />
        </Suspense>
      </div>
    </SoloWindowProvider>
  )
}

function PlayArcade({ missing }: { missing: string | null }) {
  usePageIdentity('Arcade · MvL OS', glyphIcon('🕹️'))
  return (
    <div className="play-arcade">
      <Library
        title="Arcade"
        subtitle={
          <>
            Small games, written for <a href="/">MvL OS</a>. Each one plays on a page of its own; saves and high scores stay in your browser, shared with the desktop.
          </>
        }
        note={
          missing !== null && (
            <p className="play-missing" role="status">
              There is no game called “{missing}”. These are the ones there are.
            </p>
          )
        }
        hrefFor={(id) => `/play/${id}`}
      />
    </div>
  )
}
