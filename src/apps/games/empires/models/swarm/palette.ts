import type { Palette } from '../kit.ts'

// The Swarm's colours: for now the ones the Confederacy's first designs had (its concept): bone-tan
// shells with violet accents, glass and engine light. Two roles mark a job rather than a side: `aid`
// is the green of repair craft, `trim` the gold of a station's own defense wing.

/** Three cel tones (lit, base, shadow) for every colour role, and the outline, smoke and debris. */
export const PALETTE: Palette = {
  hull: ['#f6e7c6', '#d9c095', '#9a8263'],
  hull2: ['#e5cfa6', '#bea57a', '#7c684d'],
  accent: ['#c9a0ff', '#8c55d6', '#4c2c7c'],
  metal: ['#86766a', '#5e5248', '#3a322c'],
  dark: ['#4e4038', '#332822', '#1e1814'],
  glass: ['#f0d6ff', '#a070ff', '#4e3290'],
  glow: ['#f4e2ff', '#c890ff', '#8a50d0'],
  char: ['#4a3d34', '#2e2520', '#1a1411'],
  ember: ['#ffe29a', '#ff8a3a', '#c4401a'],
  aid: ['#d6f7a8', '#86cc54', '#41702a'],
  trim: ['#ffe7a0', '#d8a444', '#8a5e22'],
  outline: '#1b130d',
  engine: '#c890ff',
  smoke: 'rgba(58,52,48,1)',
  debris: '#c8b48c',
}
