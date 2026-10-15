import type { Palette } from '../kit.ts'

// The Republic's colours, from its design sheet: warm off-white plating (#E9E6DC) over light cool
// grey panels (#A5A6AF), dark machinery (#555963) and deep graphite recesses (#30343D), Republic red
// markings (#D8343C), medium blue glass (#398FCA) with pale cyan lights (#75C9F5), cyan-blue engine
// light (#55D4FF) and near-black outlines (#1C1E24). Those are the base tones; each role's lit and
// shadow tones are worked from them, shadows leaning cool the way the cartoon shades them. Two roles
// mark a job rather than a side: `aid` is the green of repair craft, `trim` the gold of the station's
// own defense wing.

/** Three cel tones (lit, base, shadow) for every colour role, and the outline, smoke and debris. */
export const PALETTE: Palette = {
  hull: ['#f8f6ef', '#e9e6dc', '#a9a8b0'],
  hull2: ['#c4c5cd', '#a5a6af', '#72737e'],
  accent: ['#ee5654', '#d8343c', '#861d29'],
  metal: ['#767a85', '#555963', '#383b44'],
  dark: ['#454954', '#30343d', '#1d2027'],
  glass: ['#75c9f5', '#398fca', '#1e4c78'],
  glow: ['#d4f5ff', '#55d4ff', '#2a8fd6'],
  char: ['#4a3d34', '#2e2520', '#1a1411'],
  ember: ['#ffe29a', '#ff8a3a', '#c4401a'],
  aid: ['#b4f5a8', '#4cc25e', '#23703c'],
  trim: ['#ffe68e', '#f0b636', '#9c6a1e'],
  outline: '#1c1e24',
  engine: '#55d4ff',
  smoke: 'rgba(52,52,60,1)',
  debris: '#d8d2c8',
}
