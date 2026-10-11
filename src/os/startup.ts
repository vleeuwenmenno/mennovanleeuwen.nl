import { synced } from './synced'

// What the desktop shows when MvL OS opens (a new tab, a reload, the installed app started
// again): the windows from last time, the welcome windows a first visit gets, or nothing. Kept in
// this browser; synced when signed in, like notes.

export type StartWindows = 'last' | 'welcome' | 'empty'
export const START_WINDOWS: [StartWindows, string, string][] = [
  ['last', 'Last windows', 'The windows that were open, where they were'],
  ['welcome', 'Welcome windows', 'The terminal and notes (and the CV, on /cv), as on a first visit'],
  ['empty', 'Empty desktop', 'No windows; open what you need from the dock or Spotlight'],
]

export type StartupPrefs = { windows: StartWindows }

const store = synced<StartupPrefs>(
  'startup',
  { windows: 'last' },
  { normalize: (v) => ({ windows: START_WINDOWS.some(([id]) => id === (v as Partial<StartupPrefs> | null)?.windows) ? (v as StartupPrefs).windows : 'last' }) },
)

export const useStartupPrefs = store.use
export const startupPrefs = store.get
export const setStartupPrefs = (patch: Partial<StartupPrefs>) => store.set((s) => ({ ...s, ...patch }))
