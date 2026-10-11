import { useEffect, useMemo, useState } from 'react'
import type { AppId } from '../os/wm'
import { lookup } from '../terminal/fs'
import { fileKind, kindOfName, stat, type FileKind } from '../terminal/vfs'
import { readBrowserBlob, statBrowser, useBrowserFiles } from './browserfs'
import { isSf, parseSf, sfPath, useDir, useFileLink } from './seafile'

// Pictures, video and audio for Preview and Player, from the site's own filesystem, the files
// kept in this browser (blob: addresses) or Seafile: which app opens what, the file's address,
// and the files next to it (for previous and next).

/** The app that opens a kind of file by default, when it is not Zed or the Viewer. */
export const MEDIA_APP: Partial<Record<FileKind, AppId>> = { image: 'preview', video: 'player', audio: 'amp', pdf: 'pdf' }

/** The stand-ins for big files in the site's filesystem say why they will not play. */
export const UNPLAYABLE: Partial<Record<FileKind, string>> = {
  audio: 'This is a FLAC from a filesystem that only exists in your browser. Omasoloist plays the real ones.',
  video: 'The codec for imaginary video has not been invented yet.',
  disc: 'Write it to a USB stick and boot a real machine. This one is a web page.',
  archive: 'Unpacking a pretend archive gives you a pretend folder. Saved you the trouble.',
  package: 'AppImages run on Linux, not inside a CV. Get Boltwarden from boltwarden.org.',
}

export type Media = {
  name: string
  kind: FileKind
  /** Where the browser loads it from; null while it is being looked up, or when it cannot be */
  url: string | null
  size: number | null
  mtime: number | null
  error: string | null
  /** Why a stand-in file in the site's filesystem has nothing to play */
  unplayable: string | null
}

export const nameOf = (path: string) => decodeURIComponent(path.split('/').pop() ?? '')
export const folderOf = (path: string) => {
  const at = parseSf(path)
  if (at) return sfPath(at.repo, at.p.split('/').slice(0, -1).join('/') || '/')
  return path.split('/').slice(0, -1).join('/') || '/'
}

/**
 * A blob: address for a file kept in this browser (data/browserfs.ts), made when it is asked for
 * and let go when the window closes; null while it loads, or for any other file.
 */
export function useBrowserUrl(path: string | null): { url: string | null; error: string | null } {
  const version = useBrowserFiles()
  const node = path && !isSf(path) ? lookup(path) : null
  const store = node?.type === 'file' ? node.browser : undefined
  const mtime = store ? statBrowser(store)?.mtime : undefined
  const [state, setState] = useState<{ key: string; url: string | null; error: string | null }>({ key: '', url: null, error: null })
  const key = store ? `${store}@${mtime}` : ''
  useEffect(() => {
    if (!store) return
    let url: string | null = null
    let live = true
    readBrowserBlob(store).then(
      (blob) => {
        url = URL.createObjectURL(blob)
        if (live) setState({ key, url, error: null })
        else URL.revokeObjectURL(url)
      },
      (e: Error) => live && setState({ key, url: null, error: e.message }),
    )
    return () => {
      live = false
      if (url) URL.revokeObjectURL(url)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, version])
  return state.key === key ? { url: state.url, error: state.error } : { url: null, error: null }
}

/** A file to show or play: its address, size and date, wherever it lives. */
export function useMedia(path: string): Media {
  const sf = isSf(path)
  const link = useFileLink(sf ? path : null)
  const dir = useDir(sf ? folderOf(path) : null)
  const stored = useBrowserUrl(path)
  return useMemo<Media>(() => {
    const name = nameOf(path)
    if (sf) {
      const entry = dir.listing?.entries.find((e) => e.name === name)
      return { name, kind: kindOfName(name), url: link.url, size: entry?.size ?? null, mtime: entry?.mtime ?? null, error: link.error, unplayable: null }
    }
    const node = lookup(path)
    if (!node || node.type !== 'file') return { name, kind: 'file', url: null, size: null, mtime: null, error: path ? 'That file is not there (any more).' : 'Nothing to show.', unplayable: null }
    const kind = fileKind(node)
    const info = stat(path, node)
    // Kept in this browser: the real bytes, whatever they are.
    if (node.browser) return { name, kind, url: stored.url, size: info.size, mtime: info.mtime, error: stored.error, unplayable: null }
    const url = kind === 'image' ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(node.content())}` : null
    return { name, kind, url, size: info.size, mtime: info.mtime, error: null, unplayable: url ? null : (UNPLAYABLE[kind] ?? 'Nothing to play here.') }
  }, [path, sf, link.url, link.error, dir.listing, stored.url, stored.error])
}

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })

/** The files of these kinds in the same folder, in name order: previous and next. */
export function useSiblings(path: string, kinds: FileKind[]): string[] {
  const folder = folderOf(path)
  const sf = isSf(path)
  const dir = useDir(sf ? folder : null)
  return useMemo(() => {
    if (sf) {
      return (dir.listing?.entries ?? [])
        .filter((e) => !e.dir && !e.name.startsWith('.') && kinds.includes(kindOfName(e.name)))
        .map((e) => e.name)
        .sort(byName)
        .map((n) => `${folder}/${n}`)
    }
    const node = lookup(folder)
    if (node?.type !== 'dir') return [path]
    return [...node.children.values()]
      .filter((c) => c.type === 'file' && kinds.includes(fileKind(c)))
      .map((c) => c.name)
      .sort(byName)
      .map((n) => `${folder === '/' ? '' : folder}/${n}`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder, sf, dir.listing, kinds.join()])
}

/** A small picture of an image: Seafile's thumbnail, or the image itself from the site's filesystem (see useBrowserUrl for the browser's). */
export function thumbOf(path: string, size = 256): string | null {
  const at = parseSf(path)
  if (at) return `/api/seafile/thumb?repo=${encodeURIComponent(at.repo)}&p=${encodeURIComponent(at.p)}&size=${size}`
  const node = lookup(path)
  return node?.type === 'file' && !node.browser && fileKind(node) === 'image' ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(node.content())}` : null
}

export const formatTime = (s: number) => {
  if (!isFinite(s) || s < 0) s = 0
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`
}
