import { Component, lazy, Suspense, useState, type ComponentType, type LazyExoticComponent, type ReactNode } from 'react'
import { reloadIntoLatest } from '../../os/pwa'

/** The game's code didn't arrive: offline before it was saved for offline use, or the network failed. */
class LoadFailed extends Error {}

type GameProps = { win: import('../../os/wm').WinState }

/**
 * A game whose code loads only when it is picked (the big ones: Gladiator, Empires At War). The
 * service worker precaches it, so it normally opens offline too. When the code can't be fetched
 * anyway (no service worker, its cache not filled yet, or cleared), the window says so rather than
 * the error taking the whole page down, and offers a reload. Never a retry in place: Chromium
 * remembers a module that failed to load, and Vite's preloader a stylesheet, so a second import can
 * "succeed" with the game unstyled. A reload starts clean (and picks up a newer release, the likely
 * reason the files were missing).
 */
export function lazyGame(name: string, load: () => Promise<ComponentType<GameProps>>): ComponentType<GameProps> {
  const Lazy: LazyExoticComponent<ComponentType<GameProps>> = lazy(() => load().then((c) => ({ default: c }), (e: unknown) => Promise.reject(new LoadFailed(String((e as Error)?.message ?? e)))))
  function LazyGame(props: GameProps) {
    // After a crash the loaded code is fine: remounting starts the game again in this window only.
    const [attempt, setAttempt] = useState(0)
    return (
      <GameBoundary key={attempt} name={name} onRetry={() => setAttempt((a) => a + 1)}>
        <Suspense fallback={<div className="game"><p className="muted">Loading…</p></div>}>
          <Lazy {...props} />
        </Suspense>
      </GameBoundary>
    )
  }
  LazyGame.displayName = `LazyGame(${name})`
  return LazyGame
}

class GameBoundary extends Component<{ name: string; onRetry: () => void; children: ReactNode }, { error: unknown }> {
  state = { error: null as unknown }
  static getDerivedStateFromError(error: unknown) {
    return { error }
  }
  render() {
    const { error } = this.state
    if (!error) return this.props.children
    const { name, onRetry } = this.props
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false
    if (!(error instanceof LoadFailed))
      return (
        <div className="game" role="alert">
          <p>{name} stopped with an error.</p>
          <p className="muted">Try starting it again.</p>
          <p>
            <button onClick={onRetry}>Try again</button>
          </p>
        </div>
      )
    return (
      <div className="game" role="alert">
        <p>{name} couldn't load.</p>
        <p className="muted">
          {offline
            ? 'You are offline, and this game is not saved on this device yet. Reload once you are back online.'
            : 'Its files could not be downloaded. MvL OS may have been updated since this page was opened: reloading picks up the new version.'}
        </p>
        <p>
          <button onClick={() => void reloadIntoLatest()}>Reload</button>
        </p>
      </div>
    )
  }
}
