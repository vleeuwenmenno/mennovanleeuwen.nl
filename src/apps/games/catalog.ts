// The library's game list, without the game code, so the terminal filesystem and the desktop can
// list games without pulling every game into their module graph.

/** `size` is the game's window, when the library's own size doesn't suit it. `genre` is what the
 *  library files it under. */
export type GameInfo = { id: string; name: string; blurb: string; glyph: string; color: string; genre: string; size?: [number, number] }

export const GAME_CATALOG: GameInfo[] = [
  { id: 'tetris', name: 'Tetris', blurb: 'Seven shapes, ten columns, no mercy', glyph: '🧩', genre: 'Puzzle', color: '#bb9af7' },
  { id: 'pacman', name: 'Pac-Man', blurb: 'Pellets, power-ups and four ghosts', glyph: '🟡', genre: 'Arcade', color: '#f6c453' },
  { id: 'minecraft', name: 'Minecraft', blurb: 'The full game. In a browser tab. Definitely.', glyph: '⛏️', genre: 'Prank', color: '#5d9b3a' },
  { id: 'snake', name: 'Snake', blurb: 'Eat, grow, do not bite yourself', glyph: '🐍', genre: 'Arcade', color: '#9ece6a' },
  { id: 'minesweeper', name: 'Minesweeper', blurb: 'The reason office PCs had a mouse', glyph: '💣', genre: 'Puzzle', color: '#7aa2f7' },
  { id: 'pool', name: 'Pool', blurb: 'Eight-ball with real spin, throw and cushions', glyph: '🎱', genre: 'Sports', color: '#1a8a4e', size: [960, 680] },
  { id: 'gladiator', name: 'Gladiator', blurb: 'Swords, sandals and a roaring crowd', glyph: '⚔️', genre: 'Action', color: '#c0803a', size: [1000, 700] },
  { id: 'empires', name: 'Empires At War', blurb: 'Space RTS: Republic fleets against droid swarms', glyph: '🚀', genre: 'Strategy', color: '#e0453c', size: [1280, 820] },
  { id: 'breakout', name: 'Breakout', blurb: 'Bounce the ball, break the wall', glyph: '🧱', genre: 'Arcade', color: '#f7768e' },
]

export const gameInfo = (id: string | undefined) => (id ? GAME_CATALOG.find((g) => g.id === id) : undefined)
