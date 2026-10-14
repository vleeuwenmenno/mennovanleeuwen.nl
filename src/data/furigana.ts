import { synced } from '../os/synced'

// Furigana, the small readings above kanji, written {漢字|かんじ} in Markdown (src/data/markdown).
// This is the OS-wide choice of how they show: always, only while the pointer is over them (or
// they have focus, or are tapped), or not at all. The choice sits as a data attribute on the root
// element, which styles.css reads; the terminal's agents view reads it directly. Kept in this
// browser; synced when signed in, like the other settings.

export type FuriganaMode = 'always' | 'hover' | 'off'

export const FURIGANA_MODES: [FuriganaMode, string, string][] = [
  ['always', 'Always', 'Readings sit above the characters all the time.'],
  ['hover', 'On hover', 'Readings show when the pointer is over a word, or when you tap it.'],
  ['off', 'Off', 'Only the characters show, without readings.'],
]

const store = synced<FuriganaMode>('furigana', 'always', {
  normalize: (v) => (v === 'hover' || v === 'off' ? v : 'always'),
})

export const useFurigana = store.use
export const furiganaMode = store.get
export const setFurigana = (mode: FuriganaMode) => store.set(mode)

/** Puts the choice on the root element and keeps it there as it changes. Called once at startup. */
export function initFurigana() {
  const apply = () => {
    document.documentElement.dataset.furigana = store.get()
  }
  apply()
  store.subscribe(apply)
}
