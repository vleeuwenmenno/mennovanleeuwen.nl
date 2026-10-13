import { synced } from '../os/synced'

// The Terminal's own settings (its window menu → Terminal settings…, or `settings` in it): the
// text size on desktops and on phones, the row of extra keys above a touch keyboard, and when the
// tab strip shows. Shared by every terminal window. Kept in this browser; synced when signed in,
// like notes.

export const FONT_DEFAULT = 13
export const FONT_MIN = 9
export const FONT_MAX = 28

export type TerminalPrefs = {
  /** Text size in px where windows float (wider than the phone breakpoint) */
  fontDesktop: number
  /** Text size in px on phones, where windows fill the screen */
  fontMobile: number
  /** Esc, Tab, Ctrl, Alt, Shift and arrows above the keyboard on touch screens */
  extraKeys: boolean
  /** The tab strip: only with two or more tabs (like Ghostty), or always */
  tabBar: 'auto' | 'always'
}

const DEFAULTS: TerminalPrefs = { fontDesktop: FONT_DEFAULT, fontMobile: FONT_DEFAULT, extraKeys: true, tabBar: 'auto' }

export const clampFont = (px: number) => Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(px)))
const font = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? clampFont(v) : FONT_DEFAULT)

const store = synced<TerminalPrefs>('terminal', DEFAULTS, {
  // There used to be one size for every screen, kept in this browser only: it becomes both.
  legacyKey: 'mvlos.terminal.fontSize',
  normalize: (v) => {
    if (typeof v === 'number') return { ...DEFAULTS, fontDesktop: font(v), fontMobile: font(v) }
    const p = v && typeof v === 'object' ? (v as Partial<TerminalPrefs>) : {}
    return { fontDesktop: font(p.fontDesktop), fontMobile: font(p.fontMobile), extraKeys: p.extraKeys !== false, tabBar: p.tabBar === 'always' ? 'always' : 'auto' }
  },
})

export const useTerminalPrefs = store.use
export const terminalPrefs = store.get
export const setTerminalPrefs = (patch: Partial<TerminalPrefs>) => store.set((p) => ({ ...p, ...patch }))
