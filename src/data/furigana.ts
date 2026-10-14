import { synced } from '../os/synced'

// Furigana, the small readings above kanji, written {漢字|かんじ} in Markdown (src/data/markdown).
// This is the OS-wide choice of how they show: always, only while the pointer is over them (or
// they have focus, or are tapped), or not at all, and how big they are. Both sit as data
// attributes on the root element, which styles.css reads; the terminal's agents view reads the
// mode directly (it writes readings in brackets, so it has no size). Kept in this
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

/** How big the readings are, next to the characters they sit on (styles.css has the sizes). */
export type FuriganaSize = 'small' | 'medium' | 'large'

export const FURIGANA_SIZES: [FuriganaSize, string][] = [
  ['small', 'Small'],
  ['medium', 'Medium'],
  ['large', 'Large'],
]

const sizeStore = synced<FuriganaSize>('furigana-size', 'medium', {
  normalize: (v) => (v === 'small' || v === 'large' ? v : 'medium'),
})

export const useFuriganaSize = sizeStore.use
export const furiganaSize = sizeStore.get
export const setFuriganaSize = (size: FuriganaSize) => sizeStore.set(size)

/** Puts the choices on the root element and keeps them there as they change. Called once at startup. */
export function initFurigana() {
  const apply = () => {
    document.documentElement.dataset.furigana = store.get()
    document.documentElement.dataset.furiganaSize = sizeStore.get()
  }
  apply()
  store.subscribe(apply)
  sizeStore.subscribe(apply)
}
