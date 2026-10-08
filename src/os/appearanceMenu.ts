import type { MenuItem } from './ContextMenu'
import { ACCENTS, DARK_THEMES, LIGHT_THEMES, setAccent, setMode, setTheme, themeLabel, themeSettings } from './theme'
import { THEMES } from './omarchyThemes'

/** The Appearance menu shared by the desktop's right-click menu and the top bar theme button. */
export function appearanceMenu(): MenuItem[] {
  const s = themeSettings()
  return [
    { label: 'Auto (follow system)', checked: s.mode === 'auto', onSelect: () => setMode('auto') },
    { label: `Light · ${themeLabel(s.light)}`, checked: s.mode === 'light', onSelect: () => setMode('light') },
    { label: `Dark · ${themeLabel(s.dark)}`, checked: s.mode === 'dark', onSelect: () => setMode('dark') },
    { separator: true },
    { label: 'Light theme', submenu: LIGHT_THEMES.map((t) => ({ label: themeLabel(t), swatch: THEMES[t].background, checked: s.light === t, onSelect: () => setTheme(t) })) },
    { label: 'Dark theme', submenu: DARK_THEMES.map((t) => ({ label: themeLabel(t), swatch: THEMES[t].background, checked: s.dark === t, onSelect: () => setTheme(t) })) },
    {
      label: 'Accent color',
      submenu: [
        { label: 'Theme accent', swatch: THEMES[s.name].accent, checked: !s.accent, onSelect: () => setAccent(null) },
        { separator: true },
        ...Object.entries(ACCENTS).map(([name, color]) => ({ label: name[0].toUpperCase() + name.slice(1), swatch: color, checked: s.accent === name, onSelect: () => setAccent(name) })),
      ],
    },
  ]
}
