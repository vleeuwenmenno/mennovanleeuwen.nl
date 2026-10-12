// Terminal colours. The 16 ANSI colours follow the theme: the renderer draws them with the
// --ansi-0 … --ansi-15 variables (src/styles.css, built from the Omarchy palette's colours), so
// red in `ls --color` or htop is the theme's red. The other 240 of xterm's 256 and truecolour are
// fixed.

export const hex = (r: number, g: number, b: number) => '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, v | 0)).toString(16).padStart(2, '0')).join('')

/** Tokyo Night's ANSI colours, where a fixed value is needed (`{fg:#…}` markup has no variables). */
export const BASIC = ['#15161e', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#a9b1d6']
export const BRIGHT = ['#414868', '#ff899d', '#9fe044', '#faba4a', '#8db0ff', '#c7a9ff', '#a4daff', '#c0caf5']

/** xterm's 256-colour palette as #rrggbb, with Tokyo Night's for the first 16. */
export function color256(n: number): string {
  if (n < 8) return BASIC[n]
  if (n < 16) return BRIGHT[n - 8]
  if (n < 232) {
    const i = n - 16
    const level = (v: number) => (v === 0 ? 0 : 55 + v * 40)
    return hex(level(Math.floor(i / 36)), level(Math.floor(i / 6) % 6), level(i % 6))
  }
  const g = 8 + (n - 232) * 10
  return hex(g, g, g)
}

/**
 * Colours as the emulator keeps them: -1 is the default, 0–255 the palette, and RGB plus the
 * 24-bit value a truecolour one.
 */
export const DEFAULT_COLOR = -1
export const RGB = 0x1000000

/** A colour as CSS: the theme's variable for the first 16, else a fixed value; null for the default. */
export function cssColor(c: number): string | null {
  if (c < 0) return null
  if (c < 16) return `var(--ansi-${c})`
  if (c < 256) return color256(c)
  const v = c - RGB
  return hex((v >> 16) & 255, (v >> 8) & 255, v & 255)
}
