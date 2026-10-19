import { useId, useMemo, useState, type MouseEvent, type ReactNode } from 'react'
import { GAME_CATALOG, type GameInfo } from './catalog'
import { readBest } from './best'
import { GameArt } from './covers'
import { gamesFavourites, gamesRecent, toggleFavourite } from './prefs'

// The games library: what the Games app shows when it isn't playing anything, and what /play shows
// as well. One shelf of covers, the game you played last laid out large above it, and a search and
// two filters over both. The same component serves the desktop (a click opens the game's window)
// and the page of its own (each cover is a link to /play/<game>), so the two can't drift apart.

/** Where the grid's games come from: everything, what you played, or what you starred. */
type View = 'all' | 'recent' | 'favourites'

/** How long ago something happened, in the library's own short words. */
function timeAgo(at: number, now = Date.now()) {
  const minutes = Math.round((now - at) / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days} days ago`
  const weeks = Math.round(days / 7)
  if (weeks < 5) return `${weeks} weeks ago`
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

const PlayIcon = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
    <path d="M4.5 2.6 13 8l-8.5 5.4Z" fill="currentColor" />
  </svg>
)

const StarIcon = ({ on }: { on: boolean }) => (
  <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
    <path
      d="M8 1.7l1.9 4 4.4.6-3.2 3.1.8 4.4L8 11.7l-3.9 2.1.8-4.4L1.7 6.3l4.4-.6z"
      fill={on ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinejoin="round"
    />
  </svg>
)

const SearchIcon = () => (
  <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
    <circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.6" />
    <path d="M10.5 10.5 14.4 14.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
)

export type LibraryProps = {
  /** Opens a game: the OS opens its window. The pages at /play give `hrefFor` instead. */
  onOpen?: (id: string) => void
  /** Given when a cover should be a link (the arcade at /play) rather than a button. */
  hrefFor?: (id: string) => string
  /** A right-click (or long press) on a cover. The OS offers the game's direct link here. */
  onMenu?: (e: MouseEvent, id: string) => void
  /** The name in the header: "Library" in the desktop's window, "Arcade" on /play. */
  title?: string
  subtitle?: ReactNode
  /** Something to say under the header, such as a game that isn't there. */
  note?: ReactNode
}

export function Library({ onOpen, hrefFor, onMenu, title = 'Library', subtitle, note }: LibraryProps) {
  const searchId = useId()
  const [query, setQuery] = useState('')
  const [view, setView] = useState<View>('all')
  const recent = gamesRecent.use()
  const favourites = gamesFavourites.use()

  const playedAt = useMemo(() => new Map(recent.list.map((p) => [p.id, p.at])), [recent.list])
  const starred = useMemo(() => new Set(favourites.ids), [favourites.ids])

  // A game is found by its name, what it is and how it is filed.
  const words = query.trim().toLowerCase()
  const found = words ? GAME_CATALOG.filter((g) => `${g.name} ${g.genre} ${g.blurb}`.toLowerCase().includes(words)) : GAME_CATALOG
  const games =
    view === 'favourites'
      ? found.filter((g) => starred.has(g.id))
      : view === 'recent'
        ? found.filter((g) => playedAt.has(g.id)).sort((a, b) => (playedAt.get(b.id) ?? 0) - (playedAt.get(a.id) ?? 0))
        : found

  // The large cover: the game you played last, or Empires At War before you have played anything.
  // Gone while you search or filter, so the list gets the room.
  const last = recent.list[0]
  const hero = !words && view === 'all' ? (GAME_CATALOG.find((g) => g.id === last?.id) ?? GAME_CATALOG.find((g) => g.id === 'empires')) : undefined
  const heroBest = hero ? readBest(hero.id) : null

  // A cover is a button that opens the game's window, or a link to the game's own page; either way
  // the large cover's button opens the same thing.
  const open = (id: string) => (onOpen ? onOpen(id) : hrefFor ? (location.href = hrefFor(id)) : undefined)

  const heading = words ? `${games.length} ${games.length === 1 ? 'game' : 'games'} matching “${query.trim()}”` : view === 'recent' ? 'Recently played' : view === 'favourites' ? 'Favourites' : 'All games'

  const cover = (game: GameInfo) => (
    <>
      <span className="game-art">
        <GameArt id={game.id} glyph={game.glyph} />
      </span>
      <span className="game-art-play">
        <PlayIcon />
        <span>Play</span>
      </span>
    </>
  )

  return (
    <div className="games-library">
      <header className="library-head">
        <div className="library-titles">
          <h2>{title}</h2>
          <p className="library-count">
            {GAME_CATALOG.length} games <span aria-hidden="true">·</span> {favourites.ids.length} starred
          </p>
        </div>
        <label className="library-search" htmlFor={searchId}>
          <SearchIcon />
          <input id={searchId} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search games" autoComplete="off" spellCheck={false} />
        </label>
      </header>
      {subtitle && <p className="library-sub">{subtitle}</p>}
      {note}

      <div className="chips library-views" role="group" aria-label="Which games to show">
        {(
          [
            ['all', 'All'],
            ['recent', 'Played'],
            ['favourites', 'Starred'],
          ] as const
        ).map(([id, label]) => (
          <button key={id} className={`chip ${view === id ? 'is-active' : ''}`} aria-pressed={view === id} onClick={() => setView(id)}>
            {label}
            <span className="muted">{id === 'all' ? GAME_CATALOG.length : id === 'favourites' ? favourites.ids.length : playedAt.size}</span>
          </button>
        ))}
      </div>

      {hero && (
        <section className="game-hero" style={{ ['--p' as string]: hero.color }} aria-labelledby={`${searchId}-hero`}>
          <div className="game-hero-body">
            <p className="game-hero-kicker">{last ? 'Continue playing' : 'Featured'}</p>
            <h3 id={`${searchId}-hero`}>{hero.name}</h3>
            <p className="game-hero-blurb">{hero.blurb}</p>
            <p className="game-hero-meta">
              {hero.genre}
              {heroBest && <> · best {heroBest}</>}
              {last?.id === hero.id && <> · {timeAgo(last.at)}</>}
            </p>
            <div className="game-hero-actions">
              {hrefFor ? (
                <a className="btn btn-primary" href={hrefFor(hero.id)}>
                  <PlayIcon /> {last?.id === hero.id ? 'Continue' : 'Play'}
                </a>
              ) : (
                <button className="btn btn-primary" onClick={() => open(hero.id)}>
                  <PlayIcon /> {last?.id === hero.id ? 'Continue' : 'Play'}
                </button>
              )}
              <button className="btn btn-ghost" aria-pressed={starred.has(hero.id)} onClick={() => toggleFavourite(hero.id)}>
                <StarIcon on={starred.has(hero.id)} /> {starred.has(hero.id) ? 'Starred' : 'Star'}
              </button>
            </div>
          </div>
          {/* The same cover, standing at the right like a poster in a shop window. */}
          <span className="game-hero-art">
            <GameArt id={hero.id} glyph={hero.glyph} />
          </span>
        </section>
      )}

      <div className="library-list-head">
        <h3>{heading}</h3>
        <span className="muted">
          {games.length} of {GAME_CATALOG.length}
        </span>
      </div>

      <div className="game-grid">
        {games.map((game) => (
          <article key={game.id} className="game-tile" style={{ ['--p' as string]: game.color }} onContextMenu={onMenu ? (e) => onMenu(e, game.id) : undefined}>
            {hrefFor ? (
              <a className="game-tile-open" href={hrefFor(game.id)} aria-label={`Play ${game.name}`}>
                {cover(game)}
              </a>
            ) : (
              <button className="game-tile-open" onClick={() => open(game.id)} aria-label={`Play ${game.name}`}>
                {cover(game)}
              </button>
            )}
            <button
              className="game-tile-star"
              aria-pressed={starred.has(game.id)}
              title={starred.has(game.id) ? `Remove ${game.name} from favourites` : `Keep ${game.name} in favourites`}
              aria-label={starred.has(game.id) ? `Remove ${game.name} from favourites` : `Keep ${game.name} in favourites`}
              onClick={() => toggleFavourite(game.id)}
            >
              <StarIcon on={starred.has(game.id)} />
            </button>
            <div className="game-tile-meta">
              <strong>{game.name}</strong>
              <span className="game-tile-sub">
                {game.genre}
                {playedAt.has(game.id) && <> · {timeAgo(playedAt.get(game.id) ?? 0)}</>}
              </span>
            </div>
          </article>
        ))}
      </div>

      {games.length === 0 && (
        <p className="library-empty">
          {words
            ? `No game matches “${query.trim()}”.`
            : view === 'favourites'
              ? 'Nothing starred yet: the star on a cover keeps a game here.'
              : 'Nothing played yet in this browser.'}
        </p>
      )}
    </div>
  )
}
