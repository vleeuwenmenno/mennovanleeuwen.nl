// Accent colors the `theme` command can switch between. The choice is remembered per browser.
export const ACCENTS: Record<string, string> = {
  amber: '#f6c453',
  blue: '#7aa2f7',
  green: '#9ece6a',
  pink: '#ff7eb6',
  red: '#f7768e',
  purple: '#bb9af7',
}

const KEY = 'mvlos.accent'

export function setAccent(name: string): boolean {
  const color = ACCENTS[name]
  if (!color) return false
  document.documentElement.style.setProperty('--accent', color)
  try {
    localStorage.setItem(KEY, name)
  } catch {
    /* not persisted, still applied */
  }
  return true
}

export function restoreAccent() {
  try {
    const name = localStorage.getItem(KEY)
    if (name) setAccent(name)
  } catch {
    /* default accent */
  }
}

export function currentAccent(): string {
  try {
    return localStorage.getItem(KEY) ?? 'amber'
  } catch {
    return 'amber'
  }
}
