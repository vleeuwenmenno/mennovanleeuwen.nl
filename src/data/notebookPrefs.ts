import { synced } from '../os/synced'

// How the Notebook opens a note: in Preview, in Edit, or in whichever it was last left in.
// `last` is the view picked by hand most recently, used when `open` is 'last'. Follows the account.

export type NotebookOpen = 'preview' | 'edit' | 'last'
export type NotebookView = 'preview' | 'edit'
export type NotebookPrefs = { open: NotebookOpen; last: NotebookView }

export const NOTEBOOK_OPEN: [NotebookOpen, string][] = [
  ['preview', 'Preview'],
  ['edit', 'Edit'],
  ['last', 'Last used'],
]

const DEFAULTS: NotebookPrefs = { open: 'preview', last: 'preview' }

const store = synced<NotebookPrefs>('notebook', DEFAULTS, {
  normalize: (v) => {
    const o = (v && typeof v === 'object' ? v : {}) as Partial<NotebookPrefs>
    return { open: o.open === 'edit' || o.open === 'last' ? o.open : 'preview', last: o.last === 'edit' ? 'edit' : 'preview' }
  },
})

export const useNotebookPrefs = store.use
export const setNotebookOpen = (open: NotebookOpen) => store.set({ ...store.get(), open })
export const rememberNotebookView = (last: NotebookView) => {
  if (store.get().last !== last) store.set({ ...store.get(), last })
}
/** The view an existing note opens in. */
export const openingView = (): NotebookView => {
  const p = store.get()
  return p.open === 'last' ? p.last : p.open
}
