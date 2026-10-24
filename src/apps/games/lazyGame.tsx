import { Component, lazy, Suspense, useState, type ComponentType, type LazyExoticComponent, type ReactNode } from 'react'
import { reloadIntoLatest } from '../../os/pwa'

/** The game's code didn't arrive: offline before it was saved for offline use, or the network failed. */
class LoadFailed extends Error {}

type GameProps = { win: import('../../os/wm').WinState }

/**
 * A game whose code loads only when it is picked (the big ones: Gladiator, Empires At War). The
 * service worker precaches it, so it normally opens offline too. When the code can't be fetched
 * anyway (no service worker, its cache not filled yet, or cleared), the window says so rather than
 * the error taking the whole page down: offline, it offers to try again; online, the files are most
 * likely gone because a release replaced them while this page was open, so it offers to reload
 * into the new one.
 */
export function lazyGame(name: string, load: () => Promise<ComponentType<GameProps>>): ComponentType<GameProps> {
  const make = () => lazy(() => load().then((c) => ({ default: c }), (e: unknown) => Promise.reject(new LoadFailed(String((e as Error)?.message ?? e)))))
  // React keeps a failed lazy() failed: a retry needs a fresh one. A loaded one is kept for good.
  let Lazy: LazyExoticComponent<ComponentType<GameProps>> = make()
  function LazyGame(props: GameProps) {
    const [attempt, setAttempt] = useState(0)
    const retry = (error: unknown) => {
      // Only a failed load needs a fresh lazy(): after a crash the loaded code is fine, and swapping
      // it would restart the same game in any other window too.
      if (error instanceof LoadFailed) Lazy = make()
      setAttempt((a) => a + 1)
    }
    return (
      <GameBoundary key={attempt} name={name} onRetry={retry}>
        <Suspense fallback={<div className="game"><p className="muted">Loading…</p></div>}>
          <Lazy {...props} />
        </Suspense>
      </GameBoundary>
    )
  }
  LazyGame.displayName = `LazyGame(${name})`
  return LazyGame
}

class GameBoundary extends Component<{ name: string; onRetry: (error: unknown) => void; children: ReactNode }, { error: unknown }> {
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
            <button onClick={() => onRetry(error)}>Try again</button>
          </p>
        </div>
      )
    // Online, a retry in place could fail again (Chromium remembers a module that failed to load),
    // and the likely cause is a release that replaced the game's files: a reload fixes both.
    return (
      <div className="game" role="alert">
        <p>{name} couldn't load.</p>
        <p className="muted">
          {offline
            ? 'You are offline, and this game is not saved on this device yet. It will be once MvL OS has been opened online for a moment.'
            : 'Its files could not be downloaded. MvL OS may have been updated since this page was opened: reloading picks up the new version.'}
        </p>
        <p>{offline ? <button onClick={() => onRetry(error)}>Try again</button> : <button onClick={() => void reloadIntoLatest()}>Reload</button>}</p>
      </div>
    )
  }
}
