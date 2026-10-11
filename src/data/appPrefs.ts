import { jsonPref } from '../os/localPref'

// The preferences Files, Omamp, PDF and Preview keep in this browser, each under the key it has
// always used. They live here, apart from the apps, so that Settings → Apps can show and change
// them without loading the apps themselves, and so every open window follows a change at once.

// --- Files --------------------------------------------------------------------------------------

export type FilesView = 'list' | 'grid' | 'compact' | 'gallery'
export type FilesSort = 'az' | 'za' | 'newest' | 'oldest' | 'largest' | 'smallest' | 'type'
export type FilesPrefs = { view: FilesView; zoom: number; sort: FilesSort; hidden: boolean; sidebar: boolean }

export const FILES_VIEWS: [FilesView, string][] = [
  ['list', 'List'],
  ['grid', 'Grid'],
  ['compact', 'Compact'],
  ['gallery', 'Gallery'],
]
export const FILES_SORTS: [FilesSort, string][] = [
  ['az', 'A to Z'],
  ['za', 'Z to A'],
  ['newest', 'Last modified'],
  ['oldest', 'First modified'],
  ['largest', 'Largest first'],
  ['smallest', 'Smallest first'],
  ['type', 'Type'],
]
export const FILES_ZOOM_MIN = 50
export const FILES_ZOOM_MAX = 200

export const filesPrefs = jsonPref<FilesPrefs>('mvlos.files.v1', { view: 'grid', zoom: 100, sort: 'az', hidden: false, sidebar: true })

// --- Omamp --------------------------------------------------------------------------------------

export const AMP_PRESETS: Record<string, number[]> = {
  Flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  Rock: [5, 3, -3, -5, -2, 2, 5, 7, 7, 7],
  Pop: [-1, 3, 5, 5, 3, -1, -2, -2, -1, -1],
  Dance: [6, 4, 1, 0, 0, -3, -4, -4, 0, 0],
  Classical: [0, 0, 0, 0, 0, 0, -4, -4, -4, -6],
  'Full bass': [6, 6, 6, 3, 1, -3, -6, -7, -8, -8],
  'Full treble': [-6, -6, -6, -2, 2, 7, 10, 10, 10, 11],
  Vocal: [-2, -3, -3, 1, 4, 4, 3, 1, 0, -2],
  Headphones: [3, 7, 3, -2, -1, 1, 3, 6, 8, 9],
}
export type AmpRepeat = 'off' | 'all' | 'one'
export type AmpVis = 'bars' | 'scope' | 'off'
export type AmpPrefs = { volume: number; balance: number; eq: boolean; preamp: number; bands: number[]; showEq: boolean; showPl: boolean; shuffle: boolean; repeat: AmpRepeat; vis: AmpVis; remaining: boolean }

export const ampPrefs = jsonPref<AmpPrefs>('mvlos.amp', { volume: 0.8, balance: 0, eq: false, preamp: 0, bands: AMP_PRESETS.Flat, showEq: true, showPl: true, shuffle: false, repeat: 'all', vis: 'bars', remaining: false })

/** The preset the equalizer's bands match, if any: anything else is "Custom". */
export const ampPresetOf = (bands: number[]) => Object.keys(AMP_PRESETS).find((k) => AMP_PRESETS[k].every((v, i) => v === bands[i])) ?? null

// --- PDF and Preview ----------------------------------------------------------------------------

export const pdfPrefs = jsonPref('mvlos.pdf', { sidebar: true, night: false })
export const previewPrefs = jsonPref('mvlos.preview', { sidebar: false })
