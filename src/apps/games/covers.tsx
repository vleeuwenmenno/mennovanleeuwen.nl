// Cover art for the games library: one drawing per game, made of plain shapes rather than
// pictures, so it costs no download and takes its colours from the theme and the game's own
// accent (--p). The library draws them behind a game's name, both as a big poster and as the
// thumbnails in the grid, so every drawing fills a 3:4 box and reads at 130px wide.
//
// Each drawing is a handful of paths, not a hundred elements: the library is the Games window's
// first screen, and the desktop's idle budget counts every node in it. Repetition (pellets, stars,
// bricks, tiles, blocks) is one path with many subpaths, built by the helpers at the top.

import { useId, type JSX } from 'react'

/** One path of round dots, `r` in radius, as a run of two arcs each. */
const dots = (points: [number, number][], r: number) =>
  points.map(([x, y]) => `M${x - r} ${y}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`).join('')

/** One path of squares, optionally rounded, from (x, y, width, height) boxes. */
const boxes = (rects: [number, number, number, number][], r = 0) =>
  rects
    .map(([x, y, w, h]) =>
      r > 0
        ? `M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1 ${-r} ${r}h${-(w - 2 * r)}a${r} ${r} 0 0 1 ${-r} ${-r}v${-(h - 2 * r)}a${r} ${r} 0 0 1 ${r} ${-r}z`
        : `M${x} ${y}h${w}v${h}h${-w}z`,
    )
    .join('')

/** The faint grid the games that are played on a board sit on: one patterned rectangle. */
function Grid({ cols, rows, cell, x = 0, y = 0 }: { cols: number; rows: number; cell: number; x?: number; y?: number }) {
  const id = `board-${useId()}`
  return (
    <>
      <defs>
        <pattern id={id} width={cell} height={cell} patternUnits="userSpaceOnUse" x={x} y={y}>
          <path d={`M${cell} 0H0v${cell}`} fill="none" stroke="var(--fg)" strokeWidth="1" opacity="0.09" />
        </pattern>
      </defs>
      <rect x={x} y={y} width={cols * cell} height={rows * cell} fill={`url(#${id})`} />
    </>
  )
}

/** Where a cell of a board is, with a hair of gap between neighbours. */
const cellBox = (cell: number, col: number, row: number, x0: number, y0: number, gap = 2): [number, number, number, number] => [x0 + col * cell + gap / 2, y0 + row * cell + gap / 2, cell - gap, cell - gap]

/** A small, repeatable pseudo-random number, so the stars and specks are always in the same place. */
const speck = (i: number, seed: number) => {
  const v = Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453
  return v - Math.floor(v)
}

// --- Tetris: a well with a stack in it and one piece still falling ---------------------------------

const TETRIS_PILE: [number, number][] = [
  [0, 12], [1, 12], [2, 12], [5, 12], [6, 12], [7, 12], [8, 12], [9, 12],
  [0, 11], [1, 11], [6, 11], [7, 11], [8, 11], [9, 11],
  [0, 10], [7, 10], [8, 10],
  [5, 9], [6, 9], [7, 9],
]
const TETRIS_FALLING: [number, number][] = [[3, 3], [4, 3], [5, 3], [4, 4]]
const TETRIS_TOP = 20
const TETRIS_CELL = 30

const TetrisArt = () => (
  <>
    <Grid cols={10} rows={13} cell={TETRIS_CELL} y={TETRIS_TOP} />
    <path d={boxes(TETRIS_PILE.map(([c, r]) => cellBox(TETRIS_CELL, c, r, 0, TETRIS_TOP)))} fill="var(--p)" opacity="0.75" />
    <path d={boxes(TETRIS_FALLING.map(([c, r]) => cellBox(TETRIS_CELL, c, r, 0, TETRIS_TOP)))} fill="var(--fg-bright)" opacity="0.95" />
    {/* The line the falling piece would complete. */}
    <line x1="0" y1={TETRIS_TOP + 3.5 * TETRIS_CELL} x2="300" y2={TETRIS_TOP + 3.5 * TETRIS_CELL} stroke="var(--p)" strokeWidth="2" strokeDasharray="8 10" opacity="0.5" />
  </>
)

// --- Pac-Man: pellets, ghosts and Pac-Man himself --------------------------------------------------

const PAC_PELLETS = Array.from({ length: 9 }, (_, r) => Array.from({ length: 7 }, (_, c) => [30 + c * 40, 60 + r * 38] as [number, number])).flat()
const PAC_GHOSTS = [
  { x: 214, y: 300, color: 'var(--red)' },
  { x: 132, y: 322, color: 'var(--cyan)' },
  { x: 250, y: 218, color: 'var(--magenta)' },
]

const PacManArt = () => (
  <>
    <path d={dots(PAC_PELLETS, 3.4)} fill="var(--p)" opacity="0.35" />
    {/* A corner of the maze. */}
    <g fill="none" stroke="var(--p)" strokeWidth="9" strokeLinecap="square" opacity="0.28">
      <path d="M0 22h92v58h-40v52" />
      <path d="M300 120h-70v70h46v88" />
    </g>
    <path d="M172 200A64 64 0 1 0 108 136L108 200Z" fill="var(--p)" />
    <circle cx="132" cy="172" r="7" fill="var(--bg-dark)" opacity="0.85" />
    {PAC_GHOSTS.map(({ x, y, color }) => (
      <g key={color} transform={`translate(${x} ${y})`}>
        <path d="M-22 20V-4a22 22 0 0 1 44 0v24l-11-6-11 6-11-6-11 6Z" fill={color} opacity="0.9" />
        <path d={dots([[-8, -6], [8, -6]], 5.5)} fill="var(--bg-dark)" />
      </g>
    ))}
  </>
)

// --- Minecraft: blocks in the air (and a hole to fall into) ----------------------------------------

const Cube = ({ cx, cy, w = 96, h = 48, depth = 54, tone = 1 }: { cx: number; cy: number; w?: number; h?: number; depth?: number; tone?: number }) => (
  <g>
    <polygon points={`${cx},${cy - h / 2} ${cx + w / 2},${cy} ${cx},${cy + h / 2} ${cx - w / 2},${cy}`} fill="var(--p)" opacity={0.9 * tone} />
    <polygon points={`${cx - w / 2},${cy} ${cx},${cy + h / 2} ${cx},${cy + h / 2 + depth} ${cx - w / 2},${cy + depth}`} fill="var(--p)" opacity={0.5 * tone} />
    <polygon points={`${cx + w / 2},${cy} ${cx},${cy + h / 2} ${cx},${cy + h / 2 + depth} ${cx + w / 2},${cy + depth}`} fill="var(--p)" opacity={0.3 * tone} />
  </g>
)

const MinecraftArt = () => (
  <>
    <Cube cx={150} cy={232} w={180} h={90} depth={96} />
    <Cube cx={150} cy={150} w={126} h={63} depth={0} tone={0.8} />
    <Cube cx={64} cy={132} w={72} h={36} depth={40} tone={0.6} />
    <Cube cx={236} cy={96} w={58} h={29} depth={32} tone={0.7} />
    <path d={boxes([[128, 168, 18, 18], [150, 168, 18, 18], [150, 190, 18, 18]])} fill="var(--p)" opacity="0.8" />
  </>
)

// --- Snake: a body of squares chasing an apple -----------------------------------------------------

const SNAKE_CELL = 30
const SNAKE_TOP = 20
/** A snake that eats its way across the board, one cell at a time. */
const SNAKE_BODY: [number, number][] = [
  [1, 9], [2, 9], [3, 9], [3, 10], [3, 11], [4, 11], [5, 11], [5, 10], [5, 9], [5, 8], [6, 8], [7, 8], [7, 9], [7, 10], [8, 10],
]

const SnakeArt = () => {
  const head = SNAKE_BODY[SNAKE_BODY.length - 1]
  const [hx, hy, hw] = cellBox(SNAKE_CELL, head[0], head[1], 0, SNAKE_TOP)
  return (
    <>
      <Grid cols={10} rows={13} cell={SNAKE_CELL} y={SNAKE_TOP} />
      <path d={boxes(SNAKE_BODY.slice(0, -1).map(([c, r]) => cellBox(SNAKE_CELL, c, r, 0, SNAKE_TOP)), 5)} fill="var(--p)" opacity="0.62" />
      <path d={boxes([[hx, hy, hw, hw]], 5)} fill="var(--p)" />
      <path d={dots([[hx + 9, hy + 10], [hx + 19, hy + 10]], 2.6)} fill="var(--bg-dark)" />
      <circle cx="255" cy="80" r="11" fill="var(--red)" />
      <path d="M255 69c2-8 8-9 12-7-1 6-6 9-12 7Z" fill="var(--green)" opacity="0.55" />
    </>
  )
}

// --- Minesweeper: raised tiles, one of them a mine -------------------------------------------------

const MS_CELL = 44
const MS_X = 14
const MS_Y = 70
const MS_OPEN = new Map<string, string>([
  ['1-1', '1'],
  ['2-1', '2'],
  ['3-1', '1'],
  ['0-2', '1'],
  ['1-2', '3'],
  ['3-2', '2'],
  ['1-3', '1'],
])
const MS_MINE = '2-2'
const MS_TILES = Array.from({ length: 6 }, (_, r) => Array.from({ length: 6 }, (_, c) => [c, r] as [number, number])).flat()

const MinesweeperArt = () => {
  const raised = MS_TILES.filter(([c, r]) => !MS_OPEN.has(`${c}-${r}`) && `${c}-${r}` !== MS_MINE)
  const opened = MS_TILES.filter(([c, r]) => MS_OPEN.has(`${c}-${r}`) || `${c}-${r}` === MS_MINE)
  const [mx, my, mw] = cellBox(MS_CELL, 2, 2, MS_X, MS_Y, 3)
  return (
    <>
      <path d={boxes(raised.map(([c, r]) => cellBox(MS_CELL, c, r, MS_X, MS_Y, 3)))} fill="var(--p)" opacity="0.32" />
      {/* The lit top and left edge of every raised tile, in one stroke. */}
      <path
        d={raised.map(([c, r]) => {
          const [x, y, w, h] = cellBox(MS_CELL, c, r, MS_X, MS_Y, 3)
          return `M${x} ${y + h}v${-h}h${w}`
        }).join('')}
        fill="none"
        stroke="var(--fg-bright)"
        strokeWidth="2"
        opacity="0.2"
      />
      <path d={boxes(opened.map(([c, r]) => cellBox(MS_CELL, c, r, MS_X, MS_Y, 3)))} fill="var(--bg-dark)" opacity="0.45" />
      {[...MS_OPEN].map(([key, number]) => {
        const [c, r] = key.split('-').map(Number)
        const [x, y] = cellBox(MS_CELL, c, r, MS_X, MS_Y, 3)
        return (
          <text key={key} x={x + MS_CELL / 2 - 1.5} y={y + MS_CELL / 2 + 6} textAnchor="middle" fontFamily="var(--mono)" fontSize="22" fontWeight="700" fill="var(--p)" opacity="0.9">
            {number}
          </text>
        )
      })}
      <circle cx={mx + mw / 2 - 1.5} cy={my + mw / 2 - 1.5} r="10" fill="var(--fg-bright)" />
      <g stroke="var(--fg-bright)" strokeWidth="2.4" strokeLinecap="round">
        <line x1={mx + mw / 2 - 1.5} y1={my + 3} x2={mx + mw / 2 - 1.5} y2={my + mw - 3} />
        <line x1={mx + 3} y1={my + mw / 2 - 1.5} x2={mx + mw - 3} y2={my + mw / 2 - 1.5} />
        <line x1={mx + 7} y1={my + 7} x2={mx + mw - 9} y2={my + mw - 9} />
        <line x1={mx + mw - 9} y1={my + 7} x2={mx + 7} y2={my + mw - 9} />
      </g>
    </>
  )
}

// --- Pool: the rack, the cue ball and the cue -----------------------------------------------------

const POOL_BALLS = (() => {
  const palette = ['var(--yellow)', 'var(--blue)', 'var(--red)', 'var(--magenta)', 'var(--orange)', 'var(--green)', 'var(--cyan)']
  const balls: { x: number; y: number; color: string }[] = []
  let n = 0
  ;[1, 2, 3, 4, 5].forEach((count, row) => {
    for (let i = 0; i < count; i++) {
      // The 8 ball sits in the middle of the third row.
      const isEight = row === 2 && i === 1
      balls.push({ x: 150 + row * 30, y: 250 - (count - 1) * 17 + i * 34, color: isEight ? 'var(--bg-darker)' : palette[n % palette.length] })
      n++
    }
  })
  return balls
})()

/** The rack, colour by colour: one path per colour rather than fifteen circles. */
const POOL_BY_COLOUR = (() => {
  const by = new Map<string, [number, number][]>()
  for (const { x, y, color } of POOL_BALLS) by.set(color, [...(by.get(color) ?? []), [x, y]])
  return by
})()

const PoolArt = () => (
  <>
    <line x1="24" y1="366" x2="92" y2="296" stroke="var(--fg-bright)" strokeWidth="7" strokeLinecap="round" opacity="0.35" />
    <circle cx="112" cy="278" r="17" fill="var(--fg-bright)" />
    <line x1="124" y1="266" x2="146" y2="258" stroke="var(--fg-bright)" strokeWidth="1.5" strokeDasharray="5 7" opacity="0.4" />
    {[...POOL_BY_COLOUR].map(([color, balls]) => (
      <path key={color} d={dots(balls, 15)} fill={color} stroke="var(--bg-darker)" strokeWidth="2" opacity="0.9" />
    ))}
    <circle cx="34" cy="96" r="26" fill="none" stroke="var(--bg-darker)" strokeWidth="7" opacity="0.7" />
  </>
)

// --- Gladiator: the arena, and two swords over it -------------------------------------------------

/** A gladius: blade, guard, grip and pommel, drawn up from its point. */
const Sword = ({ flip }: { flip?: boolean }) => (
  <g transform={`translate(150 176) rotate(${flip ? -38 : 38})`}>
    <rect x="-6" y="-110" width="12" height="112" fill="var(--fg-bright)" opacity={flip ? 0.8 : 0.9} />
    <path d="M-12 0h24l-6 34h-12Z" fill="var(--fg-bright)" opacity={flip ? 0.65 : 0.75} />
    <rect x="-22" y="34" width="44" height="9" fill="var(--p)" />
    <rect x="-5" y="43" width="10" height="30" fill="var(--p)" opacity="0.8" />
    <circle cx="0" cy="78" r="7" fill="var(--p)" />
  </g>
)

const GladiatorArt = () => (
  <>
    <g fill="none" stroke="var(--p)" strokeLinecap="round">
      <ellipse cx="150" cy="300" rx="150" ry="62" strokeWidth="10" opacity="0.5" />
      <ellipse cx="150" cy="300" rx="112" ry="46" strokeWidth="7" opacity="0.35" />
      <ellipse cx="150" cy="300" rx="74" ry="30" strokeWidth="5" opacity="0.25" />
    </g>
    <circle cx="150" cy="176" r="74" fill="var(--p)" opacity="0.18" />
    <Sword />
    <Sword flip />
    <path d={dots([[44, 92], [268, 128], [58, 226], [246, 300], [96, 372]], 2.4)} fill="var(--fg-bright)" opacity="0.55" />
  </>
)

// --- Empires At War: a warship over a planet, with its fighters ------------------------------------

/** The starfield, split in two by size so each size is one path. */
const EMPIRES_STARS: [number, number][][] = [
  Array.from({ length: 22 }, (_, i) => [speck(i, 1) * 300, speck(i, 2) * 400] as [number, number]),
  Array.from({ length: 24 }, (_, i) => [speck(i + 40, 2) * 300, speck(i + 40, 3) * 400] as [number, number]),
]

const EmpiresArt = () => (
  <>
    <path d={dots(EMPIRES_STARS[0], 1.1)} fill="var(--fg-bright)" opacity="0.7" />
    <path d={dots(EMPIRES_STARS[1], 1.8)} fill="var(--fg-bright)" opacity="0.36" />
    <circle cx="86" cy="330" r="96" fill="var(--p)" opacity="0.16" />
    <path d="M-6 424a96 96 0 0 1 192 0Z" fill="var(--p)" opacity="0.2" />
    <path d="M96 208 232 156l44 52-44 52-136-52Z" fill="var(--fg-bright)" opacity="0.9" />
    <path d="M96 208 232 156l-8 34-128 18Z" fill="var(--bg-darker)" opacity="0.28" />
    <path d="M232 156l44 52-44 52 12-52Z" fill="var(--p)" opacity="0.85" />
    <path d="M96 208l-22-6 6 8-6 8 22-6" fill="var(--p)" opacity="0.7" />
    <g stroke="var(--p)" strokeWidth="4" strokeLinecap="round" opacity="0.8">
      <line x1="84" y1="196" x2="44" y2="184" />
      <line x1="84" y1="208" x2="38" y2="208" />
      <line x1="84" y1="220" x2="44" y2="232" />
    </g>
    <path d="M212 316l22-8 10 12-10 12-22-8-8-4Z" fill="var(--red)" opacity="0.85" />
    <path d="M258 356l16-6 8 9-8 9-16-6-6-3Z" fill="var(--red)" opacity="0.6" />
    <path d="M300 84a70 70 0 0 0-70 70" fill="none" stroke="var(--p)" strokeWidth="3" opacity="0.35" />
  </>
)

// --- Breakout: a wall, a paddle and a ball on its way ----------------------------------------------

const BREAKOUT_ROWS = [0.82, 0.7, 0.58, 0.46, 0.34]

const BreakoutArt = () => (
  <>
    {BREAKOUT_ROWS.map((opacity, r) => (
      <path
        key={r}
        d={boxes(Array.from({ length: 7 }, (_, c) => [8 + c * 41, 64 + r * 26, 36, 21] as [number, number, number, number]).filter(([x]) => r !== 2 || x !== 8 + 3 * 41))}
        fill="var(--p)"
        opacity={opacity}
      />
    ))}
    <line x1="196" y1="206" x2="230" y2="266" stroke="var(--fg-bright)" strokeWidth="9" strokeLinecap="round" strokeDasharray="1 14" opacity="0.3" />
    <circle cx="236" cy="278" r="11" fill="var(--fg-bright)" />
    <path d={boxes([[94, 350, 112, 13]])} fill="var(--p)" />
    <path d={boxes([[94, 350, 112, 5]])} fill="var(--fg-bright)" opacity="0.45" />
  </>
)

const ART: Record<string, () => JSX.Element> = {
  tetris: TetrisArt,
  pacman: PacManArt,
  minecraft: MinecraftArt,
  snake: SnakeArt,
  minesweeper: MinesweeperArt,
  pool: PoolArt,
  gladiator: GladiatorArt,
  empires: EmpiresArt,
  breakout: BreakoutArt,
}

/**
 * A game's cover: its drawing, or its emoji for a game that has none yet. Purely decoration, so it
 * is hidden from screen readers; the game's name is always written next to it.
 */
export function GameArt({ id, glyph }: { id: string; glyph?: string }) {
  const Art = ART[id]
  return (
    <svg className="game-art-svg" viewBox="0 0 300 400" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
      {Art ? (
        <Art />
      ) : (
        <text x="150" y="232" textAnchor="middle" fontSize="120">
          {glyph ?? '🎮'}
        </text>
      )}
    </svg>
  )
}
