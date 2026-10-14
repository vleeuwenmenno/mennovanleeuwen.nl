import type { Palette } from '../kit.ts'

// The droid navy's colours: weathered sand and bone with rust-brown and dull blue-grey plating over
// dark gunmetal, red and amber sensor eyes (its `glass`) and blue-white engines. Shadows lean cool,
// the way the cartoon shades them. Two roles mark a job rather than a side: `aid` is the green of
// repair craft, `trim` the gold of a station's own defense wing.

/** Three cel tones (lit, base, shadow) for every colour role, and the outline, smoke and debris. */
export const PALETTE: Palette = {
  hull: ['#efe4c9', '#cfc09d', '#8f826a'],
  hull2: ['#aab3ba', '#7f8a93', '#535d68'],
  accent: ['#cf7d4f', '#9e5434', '#5f3221'],
  metal: ['#7d7f84', '#57595f', '#37393e'],
  dark: ['#47484d', '#2e2f34', '#1c1d21'],
  glass: ['#ffd88f', '#ff5a2e', '#8c2414'],
  glow: ['#f2f9ff', '#a8dcff', '#5a96cc'],
  char: ['#4a3d34', '#2e2520', '#1a1411'],
  ember: ['#ffe29a', '#ff8a3a', '#c4401a'],
  aid: ['#d6f7a8', '#86cc54', '#41702a'],
  trim: ['#ffe7a0', '#d8a444', '#8a5e22'],
  outline: '#16130f',
  engine: '#a8dcff',
  smoke: 'rgba(60,56,52,1)',
  debris: '#cfc09d',
}
