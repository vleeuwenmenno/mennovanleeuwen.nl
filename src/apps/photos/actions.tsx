import { addToAlbum, countOf, downloadZip, immichFiles, immichTrashDays, MAX_DRAG_DOWNLOADS, MAX_ZIP, movePhotos, originalUrl, rescan, restorePhotos, setFavourites, thumbUrl, trashPhotos, type Album, type Item, type SourceId } from '../../data/photos'
import { deleteNote, download as downloadSeafile, getLibrary, parseSf, sfPath, shareLink } from '../../data/seafile'
import type { MenuItem } from '../../os/ContextMenu'
import { ask, tell } from '../../os/Dialogs'
import type { DragItem } from '../../os/dnd'
import { pickFolder } from '../../os/FolderPicker'
import { notify } from '../../os/notify'
import type { AppId, WinState } from '../../os/wm'
import { ZOOMS } from './Grid'
import type { Timeline } from './useTimeline'

// What can be done with photos: the menus (a photo's, the selection's, the empty grid's), and
// the actions behind them and behind the selection bar, the lightbox and the keys. Everything
// works on ids, so a selection of photos that scrolled out of the page (or never loaded into
// it) is handled the same as the ones on screen.

/** A message at the bottom of the app, with an Undo when what it says can be taken back. */
export type Toast = { text: string; undo?: () => Promise<void> }

export type Ctx = {
  source: SourceId
  timeline: Timeline
  /** Every loaded photo by id */
  byId: Map<string, Item>
  /** Immich's address, for its links */
  immichUrl: string | null
  /** Immich's albums, for "Add to album" (null: not asked yet) */
  albums: Album[] | null
  wm: { openNew: (app: AppId, props?: WinState['props']) => void }
  zoom: number
  setZoom: (z: number) => void
  /** Opens one in the lightbox (with its details, for Info) */
  open: (id: string, info?: boolean) => void
  selectAll: () => void
  clear: () => void
  hasSelection: boolean
  toast: (t: Toast | null) => void
  /** Photos that left the timeline (trashed, or moved out of the chosen folders) */
  removed: (ids: string[]) => void
  /** Asks the server for the timeline again (months whose count changed load again) */
  refresh: () => void
}

const SIZES = ['Smallest', 'Small', 'Medium', 'Large', 'Largest']
const nameOf = (path: string) => path.split('/').pop() ?? path
const itemsOf = (ctx: Ctx, ids: string[]) => ids.map((id) => ctx.byId.get(id)).filter((i): i is Item => !!i)
const fail = (title: string) => (e: Error) => void tell({ title, body: e.message })

/** Seafile libraries the account may only read: nothing in them can be trashed or moved. */
function readOnly(items: Item[]): string | null {
  for (const i of items) {
    const at = i.path ? parseSf(i.path) : null
    const lib = at ? getLibrary(at.repo) : null
    if (lib?.permission === 'r') return lib.name
  }
  return null
}

// --- The actions ---------------------------------------------------------------------------------------

export async function favourite(ctx: Ctx, ids: string[]) {
  const items = itemsOf(ctx, ids)
  if (!items.length) return
  // All favourites already: the menu says Unfavourite, and this takes them away.
  const on = !items.every((i) => i.fav)
  const was = new Map(items.map((i) => [i.id, i.fav]))
  ctx.timeline.patch(ids, { fav: on })
  try {
    await setFavourites(ctx.source, ids, on)
  } catch (e) {
    for (const [id, fav] of was) ctx.timeline.patch(id, { fav })
    ctx.toast({ text: `Could not change the favourites: ${(e as Error).message}` })
  }
}

export async function download(ctx: Ctx, ids: string[]) {
  const items = itemsOf(ctx, ids)
  if (items.length === 1) {
    const item = items[0]
    if (item.path) return void downloadSeafile(item.path).catch(fail('Could not download it'))
    const a = document.createElement('a')
    a.href = originalUrl(ctx.source, item.id, true)
    a.download = ''
    a.click()
    return
  }
  if (ids.length > MAX_ZIP) return void tell({ title: 'Too many for one download', body: `One ZIP holds up to ${MAX_ZIP.toLocaleString()} photos; ${ids.length.toLocaleString()} are selected. Download them in parts.` })
  try {
    await downloadZip(ctx.source, ids)
    ctx.toast({ text: `Downloading ${countOf(items, ids.length)} as a ZIP: it is made as it downloads` })
  } catch (e) {
    fail('Could not make the ZIP')(e as Error)
  }
}

/** Moves photos to the source's own trash, after asking, with an Undo. */
export async function trash(ctx: Ctx, ids: string[]) {
  const items = itemsOf(ctx, ids)
  if (!ids.length) return
  const what = countOf(items, ids.length)
  const one = ids.length === 1
  const ro = ctx.source === 'seafile' ? readOnly(items) : null
  if (ro) return void tell({ title: 'Read-only', body: `${ro} is read-only for you, so its photos cannot be moved to the trash.` })
  let title = `Move ${what} to the trash?`
  let body: string
  let final = false
  if (ctx.source === 'seafile') {
    const note = await deleteNote(items.flatMap((i) => (i.path ? [i.path] : [])))
    final = note.final
    if (final) title = `Delete ${what} for good?`
    body = note.body
  } else {
    const days = await immichTrashDays().catch(() => null)
    body = `${one ? 'It goes' : 'They go'} to Immich's trash, where you can restore ${one ? 'it' : 'them'}${days ? ` for ${days} days` : ''} (in Immich: Trash).`
  }
  if (!(await ask({ title, body, confirm: final ? 'Delete' : 'Move to trash', danger: true }))) return
  let result: Awaited<ReturnType<typeof trashPhotos>>
  try {
    result = await trashPhotos(ctx.source, ids)
  } catch (e) {
    return fail(one ? 'Could not move it to the trash' : 'Could not move them to the trash')(e as Error)
  }
  ctx.removed(result.trashed)
  const gone = countOf(items.filter((i) => result.trashed.includes(i.id)), result.trashed.length)
  const done = `${final ? 'Deleted' : 'Moved'} ${gone.replace(/^this /, '1 ')}${final ? '' : ' to the trash'}`
  if (result.error) void tell({ title: `${done}, then it stopped`, body: result.error })
  ctx.toast({
    text: done,
    undo: final
      ? undefined
      : async () => {
          try {
            const back = await restorePhotos(ctx.source, result.undo)
            ctx.refresh()
            ctx.toast({ text: back.failed.length ? `Restored ${back.restored}; ${back.failed.length} could not be (${back.failed.slice(0, 3).join(', ')}): look in the trash` : `Restored ${back.restored === 1 ? 'it' : `all ${back.restored}`}` })
          } catch (e) {
            fail('Could not undo it')(e as Error)
          }
        },
  })
}

async function moveTo(ctx: Ctx, ids: string[]) {
  const items = itemsOf(ctx, ids)
  const ro = readOnly(items)
  if (ro) return void tell({ title: 'Read-only', body: `${ro} is read-only for you, so its photos cannot be moved.` })
  const first = items[0]?.path
  const into = await pickFolder({ title: `Move ${countOf(items, ids.length)} to…`, start: first ? first.split('/').slice(0, -1).join('/') : null })
  const at = into ? parseSf(into) : null
  if (!at) return
  try {
    const r = await movePhotos(ids, { repo: at.repo, path: at.p })
    if (r.kept) {
      for (const i of items) if (i.path) ctx.timeline.patch(i.id, { path: sfPath(at.repo, `${at.p === '/' ? '' : at.p}/${nameOf(i.path)}`) })
      // An album (a folder) may have lost them: the months whose count changed load again.
      ctx.refresh()
    } else ctx.removed(ids)
    ctx.toast({ text: `Moved ${r.moved === 1 ? 'it' : r.moved} to ${nameOf(at.p) || 'the library'}${r.kept ? '' : ', which is not one of the folders Photos shows'}` })
  } catch (e) {
    fail('Could not move them')(e as Error)
  }
}

async function intoAlbum(ctx: Ctx, album: Album, ids: string[]) {
  try {
    const r = await addToAlbum(album.id, ids)
    ctx.toast({ text: `Added ${r.added} to ${album.name}${r.already ? ` (${r.already} already in it)` : ''}${r.failed ? `; ${r.failed} could not be added` : ''}` })
  } catch (e) {
    fail('Could not add them to the album')(e as Error)
  }
}

function copyLink(ctx: Ctx, item: Item) {
  if (item.path)
    return void shareLink(item.path)
      .then(({ url, made }) => navigator.clipboard?.writeText(url).then(() => ctx.toast({ text: made ? 'Made a share link and copied it' : 'Copied its share link' })))
      .catch(fail('Could not make a share link'))
  if (ctx.immichUrl) void navigator.clipboard?.writeText(`${ctx.immichUrl}/photos/${item.id}`).then(() => ctx.toast({ text: 'Copied its link in Immich' }))
}

// --- The menus -----------------------------------------------------------------------------------------

/** A photo's menu (or the selection's, when it is part of it). `lightbox`: shown there, where Open would do nothing. */
export function photoMenu(ctx: Ctx, ids: string[], opts: { lightbox?: boolean } = {}): MenuItem[] {
  const items = itemsOf(ctx, ids)
  const one = items.length === 1 ? items[0] : null
  const n = ids.length
  const ro = ctx.source === 'seafile' ? readOnly(items) : null
  const allFav = items.length > 0 && items.every((i) => i.fav)
  const menu: MenuItem[] = []
  if (!opts.lightbox) menu.push({ label: one ? 'Open' : `Open the first of ${n}`, shortcut: 'Enter', onSelect: () => ctx.open(ids[0]) })
  menu.push({ label: allFav ? 'Unfavourite' : 'Favourite', shortcut: '.', onSelect: () => void favourite(ctx, ids) })
  menu.push({ label: one ? 'Download' : `Download ${n.toLocaleString()} as a ZIP`, onSelect: () => void download(ctx, ids) })
  menu.push({ separator: true })
  if (one?.path) menu.push({ label: 'Show in Files', onSelect: () => ctx.wm.openNew('files', { path: one.path!.split('/').slice(0, -1).join('/'), select: one.path! }) })
  if (one && ctx.source === 'immich' && ctx.immichUrl) menu.push({ label: 'Open in Immich ↗', onSelect: () => void window.open(`${ctx.immichUrl}/photos/${one.id}`, '_blank', 'noopener') })
  if (one) menu.push({ label: ctx.source === 'seafile' ? 'Copy share link' : 'Copy link', onSelect: () => copyLink(ctx, one) })
  if (ctx.source === 'seafile') menu.push({ label: 'Move to folder…', disabled: !!ro, hint: ro ? `${ro} is read-only` : undefined, onSelect: () => void moveTo(ctx, ids) })
  else {
    const albums = ctx.albums ?? []
    menu.push({ label: 'Add to album', submenu: albums.length ? albums.map((a) => ({ label: a.name, hint: `${a.count.toLocaleString()} ${a.count === 1 ? 'item' : 'items'}`, onSelect: () => void intoAlbum(ctx, a, ids) })) : [{ label: ctx.albums ? 'No albums in Immich yet' : 'Loading…', disabled: true }] })
  }
  if (one && !opts.lightbox) menu.push({ label: 'Info', shortcut: 'I', onSelect: () => ctx.open(one.id, true) })
  menu.push({ separator: true })
  menu.push({ label: 'Move to trash', shortcut: 'Del', danger: true, disabled: !!ro, hint: ro ? `${ro} is read-only` : undefined, onSelect: () => void trash(ctx, ids) })
  return menu
}

/** The menu of the grid's empty space. */
export function gridMenu(ctx: Ctx): MenuItem[] {
  return [
    { label: 'Select all', shortcut: 'Ctrl A', onSelect: ctx.selectAll },
    ...(ctx.hasSelection ? [{ label: 'Clear the selection', shortcut: 'Esc', onSelect: ctx.clear }] : []),
    { separator: true },
    ctx.source === 'seafile'
      ? { label: 'Look for new photos', onSelect: () => void rescan().then(ctx.refresh, fail('Could not look for new photos')) }
      : { label: 'Refresh', onSelect: ctx.refresh },
    { label: 'Grid size', submenu: ZOOMS.map((_, z) => ({ label: SIZES[z], checked: z === ctx.zoom, onSelect: () => ctx.setZoom(z) })) },
  ]
}

// --- Dragging out --------------------------------------------------------------------------------------

/**
 * What a drag of these photos carries (src/os/dnd.ts). Seafile's are files where they are, so
 * Files copies them on Seafile itself and Mail and Agents read them from there. Immich's are no
 * file anywhere here: they travel as files from the computer would, downloaded through the server
 * at the drop (the first MAX_DRAG_DOWNLOADS), so every target that takes those takes them.
 */
export function dragOf(ctx: Ctx, ids: string[]): { items: DragItem[]; files?: () => Promise<{ file: File; rel: string }[]> } {
  const items = itemsOf(ctx, ids)
  if (ctx.source === 'seafile') return { items: items.flatMap((i) => (i.path ? [{ kind: 'file' as const, path: i.path, name: nameOf(i.path), dir: false }] : [])) }
  return {
    items: items.map((i) => ({ kind: 'photo' as const, id: i.id, label: i.video ? 'Video' : 'Photo', image: thumbUrl('immich', i.id, 'small', i.v) })),
    files: async () => {
      if (ids.length > MAX_DRAG_DOWNLOADS) notify({ title: `Only the first ${MAX_DRAG_DOWNLOADS} came along`, body: 'Immich photos are downloaded when they are dropped. Download the rest as a ZIP instead.', transient: true })
      try {
        return (await immichFiles(ids)).map((file) => ({ file, rel: '' }))
      } catch (e) {
        notify({ title: 'Could not fetch the photos from Immich', body: (e as Error).message, transient: true })
        return []
      }
    },
  }
}
