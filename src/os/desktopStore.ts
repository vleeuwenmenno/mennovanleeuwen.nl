import { synced } from './synced'

// Desktop icon state shared by the Desktop and Files' Trash view: where each icon sits, what it is
// called, and which icons are in the trash. Remembered per browser, so a visitor's tidy (or messy)
// desktop survives a reload, and synced to the server for the signed-in owner.

export type IconPos = { col: number; row: number }
export type DesktopState = {
  positions: Record<string, IconPos>
  names: Record<string, string>
  trashed: string[]
}

const empty: DesktopState = { positions: {}, names: {}, trashed: [] }

const store = synced<DesktopState>('desktop', empty, { legacyKey: 'mvlos.desktop.v1', normalize: (v) => ({ ...empty, ...(v as Partial<DesktopState>) }) })

export const updateDesktop = (fn: (s: DesktopState) => DesktopState) => store.set(fn)
export const useDesktop = store.use

export const trashIcons = (ids: string[]) => updateDesktop((s) => ({ ...s, trashed: [...new Set([...s.trashed, ...ids])] }))
export const restoreIcons = (ids: string[]) => updateDesktop((s) => ({ ...s, trashed: s.trashed.filter((t) => !ids.includes(t)) }))
export const resetLayout = () => updateDesktop((s) => ({ ...s, positions: {} }))
