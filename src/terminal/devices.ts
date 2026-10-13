import { bytesToText } from './bytes'
import { CmdError } from './types'

// What the nodes in /dev are (vfs.ts builds them). Character devices are streams: on Linux they
// never end, here a read gives at most DEV_READ_CAP bytes (64 KiB), fresh every time, so nothing
// hangs and cat does not flood the screen. Block devices are the disk and the Seafile libraries:
// they refuse to be read or written, as they do for a normal user.

export type DevInfo = {
  kind: 'char' | 'block'
  major: number
  minor: number
  /** A Seafile library's id, for /dev/seafile/<slug> */
  repo?: string
}

/** The most a read of a character device returns: the longest getRandomValues takes at once. */
export const DEV_READ_CAP = 64 * 1024

export const randomText = () => {
  const bytes = new Uint8Array(DEV_READ_CAP)
  crypto.getRandomValues(bytes)
  return bytesToText(bytes)
}
export const zeroText = () => '\0'.repeat(DEV_READ_CAP)

/** The mode column of ls -l: `crw-rw-rw-` for the usual character devices, `brw-rw----` for disks. */
export const modeString = (dev: DevInfo) => (dev.kind === 'char' ? 'crw-rw-rw-' : 'brw-rw----')

/** How `file` and `stat` name the type. */
export const deviceType = (dev: DevInfo) => (dev.kind === 'char' ? 'character special file' : 'block special file')

/** The error for reading a device, or null when it can be read (the character devices). */
export function readError(cmd: string, path: string, dev: DevInfo | undefined, root: boolean): CmdError | null {
  if (dev?.kind !== 'block') return null
  if (!root) return new CmdError(`${cmd}: ${path}: Permission denied`)
  // Even root gets nothing: the disk is a stand-in, there are no sectors behind it.
  const why = dev.repo ? 'Operation not supported' : 'No such device or address'
  return new CmdError(`${cmd}: ${path}: ${why}\n{c:muted}${dev.repo ? 'a library is a Seafile service, not a disk: try ls /mnt/seafile' : 'this disk is a stand-in: there are no sectors behind it'}{/}`)
}

/** The error for writing a device, or null when the write is fine (it is swallowed). */
export function writeError(who: string, path: string, dev: DevInfo | undefined, root: boolean): CmdError | null {
  if (dev?.kind !== 'block') return null
  return new CmdError(`${who}: ${path}: ${root ? 'Read-only file system' : 'Permission denied'}`)
}
