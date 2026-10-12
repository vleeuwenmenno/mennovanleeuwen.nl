import { isArchive } from '../data/archive'
import { posixOf } from '../data/mounts'
import { isSf, openSeafile } from '../data/seafile'
import { getAccount } from './account'
import { kindOfName } from '../terminal/vfs'
import type { DragItem } from './dnd'
import type { AppId, WinState } from './wm'

// Which apps open which dragged files: dropping a file on an app's dock icon opens it there, and
// dropping one on the window of an app that shows files (Preview, Player, Omamp, PDF, Zed, the
// Viewer, Archive) shows it in that window. Launchers open whatever they point at.

type FileItem = Extract<DragItem, { kind: 'file' }>

/** Whether `app` can open this file or folder. */
export function opensFile(app: AppId, item: FileItem): boolean {
  if (item.launcher) return false
  const kind = kindOfName(item.name, item.dir)
  if (item.dir) return app === 'files' || app === 'terminal'
  switch (app) {
    case 'preview':
      return kind === 'image'
    case 'player':
      return kind === 'video' || kind === 'audio'
    case 'amp':
      return kind === 'audio'
    case 'pdf':
      return kind === 'pdf'
    case 'zed':
      return ['text', 'markdown', 'link', 'file'].includes(kind)
    case 'viewer':
      return true
    case 'archive':
      return isArchive(item.name)
    case 'office':
    case 'newdoc':
    case 'newsheet':
    case 'newslides':
      return kind === 'document' && isSf(item.path) && !!getAccount().seafile?.office
    case 'files':
      return true
    default:
      return false
  }
}

/** The file items of a drag that `app` opens (empty when it takes none of them). */
export const filesFor = (app: AppId, items: DragItem[]) => items.filter((i): i is FileItem => i.kind === 'file' && opensFile(app, i))

type Opener = { open: (app: AppId, props?: WinState['props']) => void; openNew: (app: AppId, props?: WinState['props']) => void }
const HOW: Partial<Record<AppId, 'zed' | 'viewer' | 'preview' | 'player' | 'amp' | 'pdf' | 'office' | 'archive'>> = { zed: 'zed', viewer: 'viewer', preview: 'preview', player: 'player', amp: 'amp', pdf: 'pdf', archive: 'archive', office: 'office', newdoc: 'office', newsheet: 'office', newslides: 'office' }
const shq = (s: string) => (/^[\w@%+=:,./~-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)

/** Opens a dragged file or folder with `app` (from its dock icon): a new window, as Files would open it. */
export function openWith(wm: Opener, app: AppId, item: FileItem) {
  const folder = item.dir ? item.path : item.path.replace(/\/[^/]*$/, '')
  if (app === 'files') return wm.openNew('files', item.dir ? { path: item.path } : { path: folder, select: item.path })
  if (app === 'terminal') {
    const at = isSf(item.path) ? posixOf(item.path) : item.path
    return at ? wm.openNew('terminal', { run: `cd ${shq(at)} && ls`, t: String(Date.now()) }) : undefined
  }
  const how = HOW[app]
  if (!how) return
  if (isSf(item.path)) return void openSeafile(wm, item.path, { how })
  if (app === 'zed') return wm.open('zed', { path: item.path, t: String(Date.now()) })
  wm.openNew(app, { path: item.path, t: String(Date.now()) })
}

/** Apps whose window shows the file dropped on it (the window's path prop). */
export const SHOWS_FILE = new Set<AppId>(['preview', 'player', 'amp', 'pdf', 'zed', 'viewer', 'archive'])
