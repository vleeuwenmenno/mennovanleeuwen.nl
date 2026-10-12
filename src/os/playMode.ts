// mennovanleeuwen.nl/play/<game> is one game on its own: the whole page, without the boot screen,
// desktop, top bar or dock, so a game can be linked to and played like any other web game.
// /play by itself lists the games. Like the CV page (cvMode.ts) it is decided once per page load:
// the path doesn't change after it. The page is src/apps/games/Play.tsx.

const match = typeof location !== 'undefined' ? /^\/play(?:\/([^/]+))?\/?$/.exec(location.pathname) : null

/** Whether this page is a game's direct link (or the list of them) rather than MvL OS. */
export const playMode = (): boolean => match !== null

/** The game the link names (which may not exist), or null for the list at /play. */
export function playGameId(): string | null {
  if (!match?.[1]) return null
  try {
    return decodeURIComponent(match[1])
  } catch {
    return match[1]
  }
}

/** A game's direct link, to share or open without MvL OS. */
export const playUrl = (id: string) => `${location.origin}/play/${encodeURIComponent(id)}`
