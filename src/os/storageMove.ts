import { browserFilesReady, browserTree, listBrowser, removeBrowser } from '../data/browserfs'
import { transferPaths } from '../data/fileOps'
import { browserMountPoint, subscribeMounts, whereIs } from '../data/mounts'
import { lookup } from '../terminal/fs'
import { HOME, formatSize } from '../terminal/vfs'
import { choose } from './Dialogs'
import { notify } from './notify'
import { accountStorage } from './accountSpace'

// Once Seafile is home, what was made in this browser before is still at /mnt/browser (see
// data/mounts.ts). This offers to copy it into Seafile: the usual folders into their namesakes in
// Seafile, anything else into home. Then it offers to delete the browser's copy. "Not now" is
// remembered on this device (the files stay at /mnt/browser, in Files under This browser).

const SKIPPED = 'mvlos.browser.moveSkipped'
const skipped = () => {
  try {
    return accountStorage.get(SKIPPED) === '1'
  } catch {
    return false
  }
}

let asked = false
let started = false

/** Starts watching; call once the desktop is up. */
export function startStorageMove() {
  if (started) return
  started = true
  const check = () => void offer()
  subscribeMounts(check)
  check()
}

async function offer() {
  const at = browserMountPoint()
  if (asked || skipped() || !at || at === HOME || whereIs(HOME).kind !== 'sf') return
  await browserFilesReady()
  const { files, bytes } = browserTree()
  if (!files || asked) return
  asked = true
  const pick = await choose({
    title: `Copy ${files} ${files === 1 ? 'file' : 'files'} from this browser into Seafile?`,
    body: `Seafile is home now. What you made before (${formatSize(bytes)}) is still kept in this browser, at ${at}. Copy it into your Seafile home, folder for folder? Files with the same name are replaced; Seafile keeps the old version.`,
    buttons: [
      { id: 'later', label: 'Not now' },
      { id: 'copy', label: 'Copy into Seafile', primary: true },
    ],
  })
  if (pick !== 'copy') {
    try {
      accountStorage.set(SKIPPED, '1')
    } catch {
      /* asked again next visit */
    }
    return
  }
  notify({ title: 'Copying your files into Seafile…', transient: true })
  const failed: string[] = []
  for (const e of listBrowser('/')) {
    const name = e.path.slice(1)
    const from = `${at}/${name}`
    try {
      // Documents, Pictures and the like go into Seafile's own; anything else into home.
      if (e.dir && lookup(`${HOME}/${name}`)?.type === 'dir') {
        for (const child of listBrowser(e.path)) await transferPaths('copy', [`${from}/${child.path.split('/').pop()}`], `${HOME}/${name}`)
      } else await transferPaths('copy', [from], HOME)
    } catch (err) {
      failed.push(`${name}: ${(err as Error).message}`)
    }
  }
  if (failed.length) return notify({ title: 'Not everything was copied', body: `${failed.slice(0, 3).join('; ')}. The browser's copy stays at ${at}.`, transient: true })
  const drop = await choose({
    title: 'Copied into Seafile',
    body: `Your files are in Seafile now. Delete the copy kept in this browser (${at})?`,
    buttons: [
      { id: 'keep', label: 'Keep it' },
      { id: 'delete', label: 'Delete it', danger: true },
    ],
  })
  if (drop === 'delete') for (const e of listBrowser('/')) await removeBrowser(e.path).catch(() => {})
}
