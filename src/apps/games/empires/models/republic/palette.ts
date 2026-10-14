import type { Palette } from '../kit.ts'

// The Republic's colours: off-white warships with deep red bands, grey machinery and blue engine
// light. Shadows lean cool, the way the cartoon shades them. Two roles mark a job rather than a side:
// `aid` is the green of repair craft, `trim` the gold of a station's own defense wing.

/** Three cel tones (lit, base, shadow) for every colour role, and the outline, smoke and debris. */
export const PALETTE: Palette = {
  hull: ['#f7f3ea', '#e0dacd', '#a4a3ad'],
  hull2: ['#ebe5d8', '#cdc6b8', '#8e8c94'],
  accent: ['#e5483e', '#b7222b', '#6e1a24'],
  metal: ['#9599a2', '#6e727c', '#464a54'],
  dark: ['#50545e', '#373a42', '#22242b'],
  glass: ['#9fd8ff', '#3a6f9e', '#1c3550'],
  glow: ['#d8f3ff', '#6ad0ff', '#2a86d6'],
  char: ['#4a3d34', '#2e2520', '#1a1411'],
  ember: ['#ffe29a', '#ff8a3a', '#c4401a'],
  aid: ['#b4f5a8', '#4cc25e', '#23703c'],
  trim: ['#ffe68e', '#f0b636', '#9c6a1e'],
  outline: '#15171d',
  engine: '#6ad0ff',
  smoke: 'rgba(52,52,60,1)',
  debris: '#d8d2c8',
}
