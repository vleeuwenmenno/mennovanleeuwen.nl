// The archives Archive opens and the server unpacks: ZIP, and tar, plain or gzipped. Told apart by
// name. Shared with the server.

export type ArchiveFormat = 'zip' | 'tar' | 'tgz'

export function archiveFormat(name: string): ArchiveFormat | null {
  const n = name.toLowerCase()
  if (n.endsWith('.zip')) return 'zip'
  if (n.endsWith('.tar')) return 'tar'
  if (n.endsWith('.tar.gz') || n.endsWith('.tgz')) return 'tgz'
  return null
}

export const isArchive = (name: string) => archiveFormat(name) !== null

/** The name without its archive extension: "mods" for mods.zip or mods.tar.gz. */
export const archiveStem = (name: string) => name.replace(/\.(zip|tar|tgz|tar\.gz)$/i, '')

export const FORMAT_LABEL: Record<ArchiveFormat, string> = { zip: 'ZIP archive', tar: 'Tar archive', tgz: 'Gzipped tar archive' }
