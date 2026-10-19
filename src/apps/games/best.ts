import { bestGladiatorLevel } from './gladiator/saves'
import { highScores } from './shared'

// What a game's card and its place in the library say about the best you have done at it. Kept
// apart from Games.tsx, which pulls in every game, so the library and the arcade at /play can show
// it without that.

/** The best score at a game, as it should read, or null when it has none yet. */
export function readBest(id: string): string | null {
  try {
    const all = highScores.get()
    if (id === 'minesweeper') return all['minesweeper-easy'] !== undefined ? `${all['minesweeper-easy']}s` : null
    if (id === 'minecraft') return 'touch grass'
    if (id === 'empires') return all.empires !== undefined ? `${all.empires} ${all.empires === 1 ? 'victory' : 'victories'}` : null
    if (id === 'pool') return all.pool !== undefined ? `${all.pool} ${all.pool === 1 ? 'win' : 'wins'}` : null
    if (id === 'gladiator') {
      const top = bestGladiatorLevel()
      return top ? `level ${top}` : null
    }
    const score = all[id]
    return score === undefined ? null : String(score)
  } catch {
    return null
  }
}
