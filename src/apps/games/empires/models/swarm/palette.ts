import type { Palette } from '../kit.ts'

// The Swarm's colours, from its reference sheet: pale organic chitin plates over dark purple chitin
// and darker tissue, violet glowing cores and weapon light, acid-green secondary glows and engine
// sacs, outlined in purple-black. The roles, as the Swarm uses them:
//   hull    pale chitin armour plates (#B8AAB7)
//   hull2   desaturated lavender plates and shells (#8E819A)
//   accent  violet bands and inlays (#B34CDA) on plates and mounts
//   metal   dark purple chitin, the structure under the plates (#41334F)
//   dark    dark internal tissue and recesses (#282033, #1B1524)
//   glass   the bright violet of eyes and weapon emission (#D263F0)
//   glow    violet biological glow, cores and lights (#B34CDA)
//   aid     acid-green secondary glow (#A5E55F): vents, sacs, healers
// Two roles mark a job rather than a side, as every faction's do: `aid` is also the green of repair
// craft, `trim` the gold of a station's own defense wing.

/** Three cel tones (lit, base, shadow) for every colour role, and the outline, smoke and debris. */
export const PALETTE: Palette = {
  hull: ['#ddd2dc', '#b8aab7', '#81738a'],
  hull2: ['#aa9db6', '#8e819a', '#5f5470'],
  accent: ['#d98af2', '#b34cda', '#76299a'],
  metal: ['#5b4a6c', '#41334f', '#2c2238'],
  dark: ['#372b45', '#282033', '#1b1524'],
  glass: ['#f4d4ff', '#d263f0', '#8a32b0'],
  glow: ['#f2d6ff', '#b34cda', '#7a2c9c'],
  char: ['#3c3038', '#282027', '#171216'],
  ember: ['#e6ffb0', '#97ed74', '#4f9a2e'],
  aid: ['#e2fbb6', '#a5e55f', '#5c962c'],
  trim: ['#f3e3a4', '#d0b264', '#866d34'],
  outline: '#211929',
  engine: '#97ed74',
  smoke: 'rgba(52,40,60,1)',
  debris: '#b8aab7',
}
