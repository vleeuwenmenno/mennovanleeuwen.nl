/** External reads never replace local edits, or a buffer saved/reopened since the read started. */
export type XedBuffer = { text: string; saved: string; loading?: boolean; error?: string; external?: string | null; deleted?: boolean }
export function reconcileBuffer(start: XedBuffer, current: XedBuffer | undefined, disk: string | null): XedBuffer | undefined {
  if (!current || current.loading || current.saved !== start.saved) return current
  if (disk === null) return { ...current, external: null, deleted: true }
  if (disk === current.saved) {
    if (current.external === undefined && !current.deleted) return current
    const { external: _, deleted: __, ...rest } = current
    return rest
  }
  if (current !== start || current.text !== current.saved) return { ...current, external: disk, deleted: false }
  return { text: disk, saved: disk }
}
