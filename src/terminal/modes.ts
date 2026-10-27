import { HANDLE } from '../os/identity'
import { localPref } from '../os/localPref'
import { HOME, type Node } from './vfs'

// File permissions in the terminal: one place that says what a path's mode is, so `ls -l`, `find`
// (-perm, -executable, %M), Tab completion and running a file can never disagree, and the one
// place that decides what a mode allows.
//
// The filesystem has no real mode bits. Every node gets a *default* mode from where it lives:
//
//   folders        755 (555 when read-only)         /tmp itself 1777
//   /bin programs  555
//   files          644 (444 when read-only: the site's files, /etc, read-only libraries)
//   *.game files   the same with x added: 755 / 555 (they run without a chmod)
//   /dev nodes     666 (char) or 660 (block)
//
// `chmod` sets an *explicit* mode, kept where the file is kept (see fs.ts `setMode`):
//
//   /tmp           on the file's node in memory, which is as long-lived as the file itself
//   browser files  in the file's own IndexedDB record (data/browserfs.ts), so it travels with a
//                  rename and goes when the file is deleted
//   Seafile        the server has no modes, so a table per account in this browser (sfModes below),
//                  keyed by the Seafile path; terminal mv and rm move and drop its entries
//
// Execution always looks at the mode: a script without an x bit gives `Permission denied` (exit 126).
// Reading and writing are only refused where the mode was set explicitly: the synthetic defaults
// (site files are 444, yet `cat` works; browser files can be written) never refuse anything that
// works today. Setuid and setgid are only shown (s/S in ls -l): nothing here is run as someone
// else, so they grant nothing. The owner's bits apply to files the user owns (home, /tmp, Seafile, the browser's
// files), the "other" bits to the root-owned rest; groups are not told apart. Root (sudo) bypasses
// all checks.

export type Access = 'r' | 'w' | 'x'

const BIT: Record<Access, number> = { r: 4, w: 2, x: 1 }

const isUnderTmp = (abs: string) => abs.startsWith('/tmp/')

/**
 * Who owns a path, for `ls -l`, find (%u, -user, -uid) and the permission checks: the user's handle
 * for their home, /tmp, the site's copy of home (/srv/site), Seafile and the browser's files, root
 * for everything else. `node` may be left out for a path that has none: then the path alone says.
 */
export const ownerOf = (abs: string, node?: Node | null): string =>
  node?.sf || node?.browser || abs === HOME || abs.startsWith(`${HOME}/`) || isUnderTmp(abs) || abs.startsWith('/srv/site/') ? HANDLE : 'root'

/** Whether the signed-in user owns a path. */
export const userOwns = (abs: string, node: Node) => ownerOf(abs, node) !== 'root'

/** Where files can be written: /tmp, Seafile (unless read-only), the browser's store. */
const writable = (abs: string, node: Node) => isUnderTmp(abs) || (!!node.sf && !node.ro) || !!node.browser || node.ro === false

/** The mode a node has when nobody has run chmod on it. */
export function defaultMode(abs: string, node: Node): number {
  if (node.type === 'file' && node.dev) return node.dev.kind === 'char' ? 0o666 : 0o660
  if (abs === '/tmp') return 0o1777
  const rw = writable(abs, node)
  if (node.type === 'dir') return rw ? 0o755 : 0o555
  if (node.exec) return 0o555
  const runs = node.name.endsWith('.game')
  return rw ? (runs ? 0o755 : 0o644) : runs ? 0o555 : 0o444
}

/** A node's mode: what chmod set, or the default. */
export const modeOf = (abs: string, node: Node): number => node.mode ?? defaultMode(abs, node)

/**
 * Whether the user may read, write or run a node. Reads and writes are only refused where chmod
 * set the mode; running always needs an x bit. Root may do anything.
 */
export function allows(abs: string, node: Node, access: Access, root = false): boolean {
  if (root) return true
  if (access !== 'x' && node.mode === undefined) return true
  return (modeOf(abs, node) & (BIT[access] << (userOwns(abs, node) ? 6 : 0))) !== 0
}

/** A file the user can run (find -executable also says yes to a folder: it can be entered). */
export const canRun = (abs: string, node: Node, root = false) => node.type === 'file' && allows(abs, node, 'x', root)

// --- showing ---------------------------------------------------------------------------------------

/** `rwxr-xr-x` from a mode, with setuid, setgid and the sticky bit as `s`/`S` and `t`/`T`, as ls shows them. */
export function rwx(mode: number): string {
  return [6, 3, 0]
    .map((shift, i) => {
      const special = [0o4000, 0o2000, 0o1000][i]
      const x = mode & (1 << shift)
      const last = special === 0o1000 ? (x ? 't' : 'T') : x ? 's' : 'S'
      return `${mode & (4 << shift) ? 'r' : '-'}${mode & (2 << shift) ? 'w' : '-'}${mode & special ? last : x ? 'x' : '-'}`
    })
    .join('')
}

/** The first character of the listing: d for a folder, c and b for devices, - for a file. */
export const typeChar = (node: Node) => (node.type === 'dir' ? 'd' : node.dev ? (node.dev.kind === 'char' ? 'c' : 'b') : '-')

/** `-rw-r--r--`, as `ls -l` and find's %M show it. */
export const permString = (abs: string, node: Node) => typeChar(node) + rwx(modeOf(abs, node))

// --- parsing ---------------------------------------------------------------------------------------

/**
 * A chmod mode, octal (`755`, `0644`, `1777`) or symbolic (`+x`, `u+w`, `go=r`, `a-rx`, `u=rwx,go=rx`),
 * applied to `current`. `X` adds x only to folders and to files that already run. Null when the text
 * is not a mode. As in chmod, a symbolic mode without who (`+x`) leaves out nothing: umask is 022 but
 * only masks write for group and other.
 */
export function applyMode(spec: string, current: number, isDir: boolean): number | null {
  if (/^[0-7]{1,4}$/.test(spec)) return parseInt(spec, 8)
  if (!spec) return null
  let mode = current & 0o7777
  for (const clause of spec.split(',')) {
    const m = /^([ugoa]*)(?:([+=-])([rwxXst]*)|([+=-])([ugo]))$/.exec(clause)
    if (!m) return null
    const explicit = m[1]
    const who = explicit || 'a'
    const op = (m[2] ?? m[4]) as '+' | '=' | '-'
    let bits = 0
    if (m[5]) bits = (mode >> ({ u: 6, g: 3, o: 0 }[m[5] as 'u' | 'g' | 'o'])) & 7
    else
      for (const p of m[3]) {
        if (p === 'r' || p === 'w' || p === 'x') bits |= BIT[p]
        else if (p === 'X' && (isDir || mode & 0o111)) bits |= 1
      }
    let mask = 0
    if (/[ua]/.test(who)) mask |= bits << 6
    if (/[ga]/.test(who)) mask |= bits << 3
    if (/[oa]/.test(who)) mask |= bits
    // Without who, chmod leaves out what umask (022) would mask.
    if (!explicit) mask &= ~0o022
    const special = m[3] ?? ''
    if (special.includes('t')) mask |= 0o1000
    if (special.includes('s')) mask |= (/[ua]/.test(who) ? 0o4000 : 0) | (/[ga]/.test(who) ? 0o2000 : 0)
    if (op === '+') mode |= mask
    else if (op === '-') mode &= ~mask
    else {
      // `=` replaces the bits of the classes named (or all, without who).
      const classes = (/[ua]/.test(who) ? 0o700 : 0) | (/[ga]/.test(who) ? 0o070 : 0) | (/[oa]/.test(who) ? 0o007 : 0)
      // It clears the special bit of each class named too (a=rw drops setuid, setgid and sticky);
      // a folder keeps its setuid and setgid, as in chmod, unless they are asked for.
      const special = (/[ua]/.test(who) ? 0o4000 : 0) | (/[ga]/.test(who) ? 0o2000 : 0) | (/[oa]/.test(who) ? 0o1000 : 0)
      mode = (mode & ~classes & ~(isDir ? special & 0o1000 : special)) | mask
    }
  }
  return mode
}

// --- Seafile: a table in this browser --------------------------------------------------------------

/** chmod's modes for Seafile paths (the server keeps none), per account, in this browser. */
export const sfModes = localPref<Record<string, number>>(
  'mvlos.terminal.modes',
  (raw) => {
    const v = raw ? (JSON.parse(raw) as unknown) : null
    const out: Record<string, number> = {}
    if (v && typeof v === 'object' && !Array.isArray(v)) for (const [k, m] of Object.entries(v)) if (typeof m === 'number' && Number.isInteger(m)) out[k] = m & 0o7777
    return out
  },
  undefined,
  { account: true },
)

export const sfModeOf = (sf: string): number | undefined => sfModes.get()[sf]

/** Sets (or, with null, clears) the mode of one Seafile path. */
export function setSfMode(sf: string, mode: number | null) {
  sfModes.set((t) => {
    const { [sf]: _, ...rest } = t
    void _
    return mode === null ? rest : { ...rest, [sf]: mode }
  })
}

/** Forgets the modes of a Seafile path and everything under it (it was deleted). */
export function dropSfModes(sf: string) {
  if (!Object.keys(sfModes.get()).some((k) => k === sf || k.startsWith(`${sf}/`))) return
  sfModes.set((t) => Object.fromEntries(Object.entries(t).filter(([k]) => k !== sf && !k.startsWith(`${sf}/`))))
}

/** Carries the modes of a Seafile path (and what is under it) to a new path: `keep` leaves the old ones (a copy). */
export function carrySfModes(from: string, to: string, keep: boolean) {
  const table = sfModes.get()
  const hits = Object.keys(table).filter((k) => k === from || k.startsWith(`${from}/`))
  if (!hits.length) return
  const next = { ...table }
  for (const k of hits) {
    if (!keep) delete next[k]
    next[to + k.slice(from.length)] = table[k]
  }
  sfModes.set(next)
}
