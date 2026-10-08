// The arcade's game list, without the game code, so the terminal filesystem and the desktop can
// list games without pulling every game into their module graph.

export type GameInfo = { id: string; name: string; blurb: string; glyph: string; color: string }

export const GAME_CATALOG: GameInfo[] = [
  { id: 'tetris', name: 'Tetris', blurb: 'Seven shapes, ten columns, no mercy', glyph: '🧩', color: '#bb9af7' },
  { id: 'pacman', name: 'Pac-Man', blurb: 'Pellets, power-ups and four ghosts', glyph: '🟡', color: '#f6c453' },
  { id: 'minecraft', name: 'Minecraft', blurb: 'The full game. In a browser tab. Definitely.', glyph: '⛏️', color: '#5d9b3a' },
  { id: 'snake', name: 'Snake', blurb: 'Eat, grow, do not bite yourself', glyph: '🐍', color: '#9ece6a' },
  { id: 'minesweeper', name: 'Minesweeper', blurb: 'The reason office PCs had a mouse', glyph: '💣', color: '#7aa2f7' },
  { id: 'pool', name: 'Pool', blurb: 'Eight-ball with real spin, throw and cushions', glyph: '🎱', color: '#1a8a4e' },
  { id: 'breakout', name: 'Breakout', blurb: 'Bounce the ball, break the wall', glyph: '🧱', color: '#f7768e' },
]
