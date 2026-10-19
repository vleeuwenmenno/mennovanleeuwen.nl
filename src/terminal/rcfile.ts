import { synced } from '../os/synced'
import { cvMode } from '../os/cvMode'
import { HOME } from './vfs'

// ~/.mvshrc: the file every terminal runs when it opens (see runRc in msh/interp.ts). Where ~ can
// be written (browser files or Seafile once signed in) it is a normal file there. Where it cannot
// (signed out: home is the site's read-only home), the file is still there as ~/.mvshrc, but its
// text is kept in this browser (localStorage, through synced()), so a visitor can have aliases too.
// Never on the CV page, where home is Menno's read-only one.

export const RC_NAME = '.mvshrc'
export const RC_PATH = `${HOME}/${RC_NAME}`
const MAX_RC = 64 * 1024

/** null: there is no file. An empty file is "". */
const store = synced<string | null>('mvshrc', null, { normalize: (v) => (typeof v === 'string' ? v.slice(0, MAX_RC) : null) })

/** The kept text of ~/.mvshrc while home is read-only; null when there is none (or on the CV page). */
export const keptRc = (): string | null => (cvMode() ? null : store.get())
export const setKeptRc = (text: string | null) => store.set(text === null ? null : text.slice(0, MAX_RC))
export const useKeptRc = store.use
