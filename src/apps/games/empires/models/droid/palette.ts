import type { Palette } from '../kit.ts'

// The Confederacy's colours (refs/confederacy.yaml): industrial steel plates (#737C86, lit to the
// brushed #A9AFB5) over gunmetal (#3B414A) and dark charcoal frames (#252B34), recessed panels in
// near-black steel (#161D27), burnt-orange military markings and capacitors (#F07732), technical
// teal windows and sensors (#19A6B1, its `glass`), cyan engines (#4BE1EE, its `glow`) and orange
// plasma (#FF8D39, its `trim`: the Spectre pickets' bands and weapon glows). Near-black outlines.
// `aid` marks a repair craft's work lights, a green-teal.

/** Three cel tones (lit, base, shadow) for every colour role, and the outline, smoke and debris. */
export const PALETTE: Palette = {
  hull: ['#a9afb5', '#737c86', '#4c545e'],
  hull2: ['#59626d', '#3b414a', '#2a2f37'],
  accent: ['#ff9b5a', '#f07732', '#ad4f1c'],
  metal: ['#3a414c', '#252b34', '#191e25'],
  dark: ['#232b36', '#161d27', '#0e131a'],
  glass: ['#8af0f6', '#19a6b1', '#0f6870'],
  glow: ['#dcfdff', '#4be1ee', '#2399a6'],
  char: ['#463d36', '#2b2521', '#171311'],
  ember: ['#ffe2a6', '#ff8d39', '#c4501a'],
  aid: ['#a8f5d4', '#33c493', '#1d6e55'],
  trim: ['#ffc183', '#ff8d39', '#bd5a1c'],
  outline: '#15191f',
  engine: '#4be1ee',
  smoke: 'rgba(52,56,62,1)',
  debris: '#737c86',
}
