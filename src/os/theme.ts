import { useSyncExternalStore } from 'react'
import { THEMES, type Palette } from './omarchyThemes'

// Theme engine. The site wears an Omarchy theme: Flexoki Light by day and Tokyo Night by night
// (Menno's own setup), switched by the OS light/dark preference in 'auto' mode. Any installed
// Omarchy palette can be picked, and an accent override sits on top of the theme's own accent.

export type Mode = 'auto' | 'light' | 'dark'
type Settings = { mode: Mode; light: string; dark: string; accent: string | null }

const DEFAULTS: Settings = { mode: 'auto', light: 'flexoki-light', dark: 'tokyo-night', accent: null }
const KEY = 'mvlos.theme.v1'

/** Accent overrides offered in menus and by `theme accent <name>`. */
export const ACCENTS: Record<string, string> = {
  amber: '#f6c453',
  blue: '#7aa2f7',
  green: '#9ece6a',
  pink: '#ff7eb6',
  red: '#f7768e',
  purple: '#bb9af7',
}

export const LIGHT_THEMES = Object.keys(THEMES).filter((t) => THEMES[t].mode === 'light')
export const DARK_THEMES = Object.keys(THEMES).filter((t) => THEMES[t].mode === 'dark')

const prettyName = (id: string) => id.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ')
export const themeLabel = prettyName

function load(): Settings {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    return {
      mode: ['auto', 'light', 'dark'].includes(s.mode) ? s.mode : DEFAULTS.mode,
      light: THEMES[s.light]?.mode === 'light' ? s.light : DEFAULTS.light,
      dark: THEMES[s.dark]?.mode === 'dark' ? s.dark : DEFAULTS.dark,
      accent: s.accent && ACCENTS[s.accent] ? s.accent : null,
    }
  } catch {
    return DEFAULTS
  }
}

let settings = load()
let systemDark = typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches
const listeners = new Set<() => void>()

export const resolvedThemeName = () => (settings.mode === 'dark' || (settings.mode === 'auto' && systemDark) ? settings.dark : settings.light)

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings))
  } catch {
    /* applied, not persisted */
  }
}

/** Relative luminance, to pick readable text on top of the accent. */
function luminance(hex: string) {
  const n = parseInt(hex.replace('#', '').slice(0, 6), 16)
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2]
}

const mix = (color: string, pct: number) => `color-mix(in srgb, ${color} ${pct}%, transparent)`

function apply() {
  const p: Palette = THEMES[resolvedThemeName()]
  const accent = settings.accent ? ACCENTS[settings.accent] : p.accent
  const root = document.documentElement
  const vars: Record<string, string> = {
    '--bg': p.background,
    '--bg-dark': p.darkBackground,
    '--bg-darker': p.darkerBackground,
    '--bg-light': p.lighterBackground,
    '--fg': p.foreground,
    '--fg-bright': p.brightForeground,
    '--fg-light': p.lightForeground,
    '--selection': p.selection,
    '--accent': accent,
    '--on-accent': luminance(accent) > 0.4 ? '#111111' : '#ffffff',
    '--red': p.red,
    '--yellow': p.yellow,
    '--orange': p.orange,
    '--green': p.green,
    '--cyan': p.cyan,
    '--blue': p.blue,
    '--magenta': p.magenta,
    // Names the stylesheet has used from the start.
    '--text': p.foreground,
    '--muted': p.darkForeground,
    '--panel': p.background,
    '--panel-solid': p.background,
    '--panel-2': mix(p.foreground, 4),
    '--line': mix(p.foreground, 12),
    '--line-strong': mix(p.foreground, 26),
    '--inactive-border': p.mode === 'light' ? 'rgba(89, 89, 89, 0.45)' : 'rgba(89, 89, 89, 0.67)',
  }
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v)
  root.dataset.mode = p.mode
  root.style.colorScheme = p.mode
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', p.background)
  listeners.forEach((l) => l())
}

export function initTheme() {
  apply()
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    systemDark = e.matches
    if (settings.mode === 'auto') apply()
  })
}

export function setMode(mode: Mode) {
  settings = { ...settings, mode }
  save()
  apply()
}

/** Flips between the light and dark theme (leaving 'auto'). */
export function toggleMode() {
  setMode(THEMES[resolvedThemeName()].mode === 'light' ? 'dark' : 'light')
}

/** Uses an Omarchy theme for its mode and switches to that mode. */
export function setTheme(id: string): boolean {
  const p = THEMES[id]
  if (!p) return false
  settings = { ...settings, [p.mode]: id, mode: settings.mode === 'auto' && (p.mode === 'dark') === systemDark ? 'auto' : p.mode }
  save()
  apply()
  return true
}

/** Accent override; 'theme' (or null) returns to the theme's own accent. */
export function setAccent(name: string | null): boolean {
  if (name && name !== 'theme' && !ACCENTS[name]) return false
  settings = { ...settings, accent: name && name !== 'theme' ? name : null }
  save()
  apply()
  return true
}

export function useTheme() {
  useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => settings.mode + resolvedThemeName() + settings.accent,
  )
  const name = resolvedThemeName()
  return { ...settings, name, palette: THEMES[name], label: prettyName(name) }
}

export const themeSettings = () => ({ ...settings, name: resolvedThemeName() })
