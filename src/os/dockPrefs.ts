// Whether the dock hides itself until the pointer reaches the bottom edge. On by default.

const AUTOHIDE_KEY = 'mvlos.dock.autohide'
export const dockAutohide = {
  get: () => {
    try {
      return localStorage.getItem(AUTOHIDE_KEY) !== 'off'
    } catch {
      return true
    }
  },
  set: (on: boolean) => {
    try {
      localStorage.setItem(AUTOHIDE_KEY, on ? 'on' : 'off')
    } catch {
      /* not persisted */
    }
    window.dispatchEvent(new Event('mvlos:dock'))
  },
}
