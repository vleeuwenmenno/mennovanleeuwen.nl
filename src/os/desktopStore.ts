import { synced } from './synced'

// Desktop icon state shared by the Desktop and Files' Trash view: where each icon sits, what it is
// called, and which icons are in the trash. Remembered per browser, so a visitor's tidy (or messy)
// desktop survives a reload, and synced to the server for the signed-in user.

/** A cell counts columns from the right. `page` is the phone home screen (absent on older saves: the one tall home, cut into pages by rows). */
export type IconPos = { col: number; row: number; page?: number }
export type DesktopState = {
  positions: Record<string, IconPos>
  mobilePositions?: Record<string, IconPos>
  /** How many phone home screens exist (empty ones included); at least as many as hold something. */
  mobilePages?: number
  names: Record<string, string>
  trashed: string[]
}

const empty: DesktopState = { positions: {}, names: {}, trashed: [] }

const store = synced<DesktopState>('desktop', empty, { legacyKey: 'mvlos.desktop.v1', normalize: (v) => ({ ...empty, ...(v as Partial<DesktopState>) }) })

export const updateDesktop = (fn: (s: DesktopState) => DesktopState) => store.set(fn)
export const useDesktop = store.use

export const trashIcons = (ids: string[]) => updateDesktop((s) => ({ ...s, trashed: [...new Set([...s.trashed, ...ids])] }))
export const restoreIcons = (ids: string[]) => updateDesktop((s) => ({ ...s, trashed: s.trashed.filter((t) => !ids.includes(t)) }))
export const resetLayout = (mobile = false) => updateDesktop((s) => ({ ...s, [mobile ? 'mobilePositions' : 'positions']: {} }))
