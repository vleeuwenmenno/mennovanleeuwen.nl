import { freeName, imageFileName } from '../data/agentImageFiles'
import type { GeneratedImage } from '../data/agentImages'
import { statBrowser, useBrowserFiles } from '../data/browserfs'
import { whereIs } from '../data/mounts'
import { getLibraries, libraryName, parseSf, useLibraries, type Listing } from '../data/seafile'
import { uploadFiles } from '../data/uploads'
import { getAccount, useAccount } from '../os/account'
import { choose } from '../os/Dialogs'
import { pickFolder, writableBrowserFolder } from '../os/FolderPicker'
import { notify } from '../os/notify'

// Save to Files for a generated image: the PNG itself, into a Seafile folder or one kept in this
// browser, through the same picker and upload path as Mail's "Save to Files" (os/FolderPicker,
// data/uploads). The bytes come from the image's own private address in this browser's session,
// so only the signed-in owner can read them, and they go only to that account's own Seafile or
// browser store. A name that is taken gets a number: nothing that is there is replaced.

export type SaveDestination = 'Seafile' | 'this browser'

/** Where Save to Files saves by default: Seafile when it is linked (and has a library you can write), else this browser; null when neither can be written. */
export function saveDestination(): SaveDestination | null {
  const libs = getLibraries()
  if (getAccount().seafile && (!libs || libs.some((l) => l.permission === 'rw'))) return 'Seafile'
  return writableBrowserFolder() ? 'this browser' : null
}
/** The same, kept current as the account, its libraries and the browser's store change. */
export function useSaveDestination(): SaveDestination | null {
  useAccount()
  useLibraries()
  useBrowserFiles()
  return saveDestination()
}
export const saveLabel = (to: SaveDestination) => `Save to Files (${to})…`

/** The names already in a folder: Seafile's listing, or this browser's store. */
async function takenIn(folder: string): Promise<(name: string) => boolean> {
  const at = parseSf(folder)
  if (!at) {
    const where = whereIs(folder)
    const base = where.kind === 'browser' ? where.path : '/'
    return (name) => !!statBrowser(base === '/' ? `/${name}` : `${base}/${name}`)
  }
  const res = await fetch(`/api/seafile/dir?repo=${encodeURIComponent(at.repo)}&p=${encodeURIComponent(at.p)}`, { credentials: 'same-origin' })
  if (res.status === 423) throw new Error(`${libraryName(at.repo)} is encrypted and locked: open it in Files and give its password first.`)
  if (res.status === 409) throw new Error('Seafile is not linked any more: link it again in Settings → Integrations.')
  // Anything else: the upload says what went wrong, and Seafile itself never replaces a file here.
  const names = res.ok ? new Set(((await res.json()) as Listing).entries.filter((e) => !e.dir).map((e) => e.name)) : new Set<string>()
  return (name) => names.has(name)
}

const folderName = (folder: string) => {
  const at = parseSf(folder)
  return at ? (at.p === '/' ? libraryName(at.repo) : at.p.split('/').pop()!) : folder === writableBrowserFolder() ? 'this browser' : folder.split('/').pop() || folder
}

/** Asks for a folder, then saves the picture there; every failure says what it was. */
export async function saveImageToFiles(image: GeneratedImage) {
  const name = imageFileName(image)
  const folder = await pickFolder({ title: `Save ${name} to`, local: true })
  if (!folder) return
  try {
    const res = await fetch(image.url, { credentials: 'same-origin' })
    if (res.status === 404) throw new Error('The picture is gone: it was deleted with its thread.')
    if (!res.ok) throw new Error(`The picture could not be read (the server answered ${res.status}).`)
    const blob = await res.blob()
    const taken = await takenIn(folder)
    const free = freeName(name, taken)
    if (free !== name) {
      const pick = await choose({
        title: `“${name}” is already in ${folderName(folder)}`,
        body: `Save this picture as “${free}” instead? The file that is there stays as it is.`,
        buttons: [
          { id: 'cancel', label: 'Cancel' },
          { id: 'save', label: `Save as “${free}”`, primary: true },
        ],
      })
      if (pick !== 'save') return
    }
    await uploadFiles([{ file: new File([blob], free, { type: blob.type || 'image/png' }), rel: '' }], folder)
  } catch (e) {
    notify({ title: 'Could not save to Files', body: (e as Error).message, transient: true })
  }
}
