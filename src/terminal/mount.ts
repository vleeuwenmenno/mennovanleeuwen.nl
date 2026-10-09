import { deviceNames, fstabEntries, fstabErrors, isBind, isSeafileType, mountAll, mountEntry, mountFromFstab, mounts, repoOfSource, unmount, whereIs, type FstabEntry, type Mount } from '../data/mounts'
import { getLibraries, getUnlocks, loadLibraries, lock, parseSf, SF, unlock } from '../data/seafile'
import { getAccount } from '../os/account'
import { lookup } from './fs'
import { CmdError, type Ctx } from './types'
import { resolvePath } from './vfs'

// util-linux's view of the mount table: mount, umount, findmnt and lsblk, and fscrypt for the
// encrypted libraries. Mounting and unmounting need root (sudo) unless the fstab line says `user`,
// as on any Linux; what changes shows up in Files at once.

type Command = { desc: string; usage?: string; man?: string; run: (ctx: Ctx) => string | void | Promise<string | void> }

const c = (color: string, s: string) => `{c:${color}}${s}{/}`
const UTIL_LINUX = 'util-linux 2.40.2'

/** How a mount's source reads in mount and findmnt: libraries by their /dev/seafile name. */
function sourceName(m: FstabEntry): string {
  if (!isSeafileType(m) || m.source === 'seafile') return m.source
  const repo = repoOfSource(m.source)
  const slug = repo ? deviceNames().get(repo) : null
  return slug ? `/dev/seafile/${slug}` : m.source
}

/** The options a mount really has: Seafile mounts are FUSE ones, read-only libraries ro. */
function liveOptions(m: Mount): string {
  if (!isSeafileType(m) && !isBind(m)) return m.options.filter((o) => o !== 'defaults').join(',') || 'rw,relatime'
  const w = whereIs(m.target)
  const ro = m.options.includes('ro') || (m.source !== 'seafile' && w.kind === 'sf' && w.ro)
  return `${ro ? 'ro' : 'rw'},nosuid,nodev,relatime,user_id=1000,group_id=1000`
}

/** A bind mount shows the filesystem underneath, with the folder it starts from. */
function underlying(m: Mount): { source: string; type: string } {
  if (!isBind(m)) return { source: sourceName(m), type: isSeafileType(m) ? 'fuse.seafile' : m.type }
  const below = [...mounts()].reverse().find((x) => !isBind(x) && (m.source === x.target || m.source.startsWith(x.target === '/' ? '/' : `${x.target}/`)))
  if (!below) return { source: m.source, type: 'none' }
  const sub = m.source.slice(below.target === '/' ? 0 : below.target.length)
  return { source: `${sourceName(below)}[${sub || '/'}]`, type: isSeafileType(below) ? 'fuse.seafile' : below.type }
}

const mayMount = (ctx: Ctx, e?: FstabEntry) => ctx.root || !!e?.options.some((o) => o === 'user' || o === 'users')

const fstabWarnings = () => fstabErrors().map((n) => c('yellow', `mount: /etc/fstab: parse error at line ${n} -- ignored`))

const MOUNT_HELP = `
Usage:
 mount [-lhV]
 mount -a [options]
 mount [options] [--source] <source> | [--target] <directory>
 mount [options] <source> <directory>
 mount <operation> <mountpoint> [<target>]

Mount a filesystem.

Options:
 -a, --all               mount all filesystems mentioned in fstab
 -l, --show-labels       show also filesystem labels
 -o, --options <list>    comma-separated list of mount options
 -t, --types <list>      limit the set of filesystem types
 -v, --verbose           say what is being done

Operations:
 -B, --bind              mount a subtree somewhere else (same as -o bind)

 -h, --help              display this help
 -V, --version           display version

For more details see mount(8).`

async function mount(ctx: Ctx): Promise<string> {
  const args = ctx.args.slice()
  if (args.includes('-h') || args.includes('--help')) return MOUNT_HELP
  if (args.includes('-V') || args.includes('--version')) return `mount from ${UTIL_LINUX} (libmount 2.40.2: btrfs, verity, namespaces, idmapping, fd-based-mount, statx, assert, debug)`
  if (getAccount().seafile && !getLibraries()) await loadLibraries()
  let types: string[] | null = null
  let options: string[] = []
  let bind = false
  let all = false
  let verbose = false
  const rest: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '-t' || a === '--types') types = (args[++i] ?? '').split(',')
    else if (a === '-o' || a === '--options') options = (args[++i] ?? '').split(',')
    else if (a === '-B' || a === '--bind') bind = true
    else if (a === '-a' || a === '--all') all = true
    else if (a === '-v' || a === '--verbose') verbose = true
    else if (a === '-l' || a === '--show-labels') continue
    else if (/^-[a-zA-Z]+$/.test(a)) {
      for (const ch of a.slice(1)) if (ch === 'a') all = true
      else if (ch === 'v') verbose = true
      else if (ch === 'B') bind = true
      else if (ch !== 'l') throw new CmdError(`mount: invalid option -- '${ch}'\nTry 'mount --help' for more information.`)
    } else rest.push(a)
  }
  if (options.includes('bind') || options.includes('rbind')) bind = true
  const warn = fstabWarnings()

  // No arguments: the mount table.
  if (!rest.length && !all) {
    const lines = mounts()
      .map((m) => ({ m, u: underlying(m) }))
      .filter(({ u }) => !types || types.some((t) => u.type === t || u.type === `fuse.${t}`))
      .map(({ m, u }) => `${u.source} on ${m.target} type ${u.type} (${liveOptions(m)})`)
    return [...warn, ...lines].join('\n')
  }
  if (all) {
    if (!ctx.root) throw new CmdError('mount: only root can use "--all" option')
    const out = mountAll().flatMap((r) => (r.error ? [c('red', r.error)] : verbose ? [`${r.target.padEnd(24)}: ${r.already ? 'already mounted' : 'successfully mounted'}`] : []))
    return [...warn, ...out].join('\n')
  }
  // One argument: a line of fstab, by mount point or source.
  if (rest.length === 1) {
    const what = rest[0].startsWith('/') || rest[0].includes('=') ? rest[0] : resolvePath(ctx.cwd, rest[0])
    const e = fstabEntries().find((x) => x.target === what || x.source === rest[0])
    if (e && !mayMount(ctx, e)) throw new CmdError(`mount: ${e.target}: must be superuser to use mount.\n       dmesg(1) may have more information after failed mount system call.`)
    const error = mountFromFstab(e?.target ?? what)
    if (error) throw new CmdError(error)
    return [...warn, ...(verbose ? [`mount: ${e?.source ?? what} mounted on ${e?.target ?? what}.`] : [])].join('\n')
  }
  // Two: a source on a folder, by hand.
  const [source, dirArg] = rest
  const dir = resolvePath(ctx.cwd, dirArg)
  if (!ctx.root) throw new CmdError('mount: only root can do that')
  const point = lookup(dir)
  if (!point) throw new CmdError(`mount: ${dir}: mount point does not exist.`)
  if (point.type !== 'dir') throw new CmdError(`mount: ${dir}: mount point is not a directory.`)
  const entry: FstabEntry = bind
    ? { source: resolvePath(ctx.cwd, source), target: dir, type: 'none', options: ['bind', ...options.filter((o) => o !== 'bind')], dump: '0', pass: '0' }
    : { source, target: dir, type: types?.[0] === 'fuse.seafile' ? 'seafile' : (types?.[0] ?? 'seafile'), options: options.length ? options : ['defaults'], dump: '0', pass: '0' }
  if (!bind && entry.type !== 'seafile') throw new CmdError(`mount: ${dir}: unknown filesystem type '${entry.type}'.`)
  if (bind && !lookup(entry.source)) throw new CmdError(`mount: ${dir}: special device ${source} does not exist.`)
  const error = mountEntry(entry)
  if (error) throw new CmdError(error)
  return verbose ? `mount: ${source} mounted on ${dir}.` : ''
}

const UMOUNT_HELP = `
Usage:
 umount [-hV]
 umount <source> | <directory>

Unmount filesystems.

Options:
 -l, --lazy              detach the filesystem now, clean up things later
 -v, --verbose           say what is being done

 -h, --help              display this help
 -V, --version           display version

For more details see umount(8).`

function umount(ctx: Ctx): string {
  const args = ctx.args
  if (args.includes('-h') || args.includes('--help')) return UMOUNT_HELP
  if (args.includes('-V') || args.includes('--version')) return `umount from ${UTIL_LINUX} (libmount 2.40.2: btrfs, verity, namespaces, idmapping, fd-based-mount, statx, assert, debug)`
  const lazy = args.some((a) => a === '-l' || a === '--lazy')
  const verbose = args.some((a) => a === '-v' || a === '--verbose')
  const targets = args.filter((a) => !a.startsWith('-'))
  if (!targets.length) throw new CmdError("umount: bad usage\nTry 'umount --help' for more information.")
  const out: string[] = []
  for (const t of targets) {
    const abs = t.startsWith('/') || t.includes('=') ? t.replace(/(.)\/+$/, '$1') : resolvePath(ctx.cwd, t)
    const m = [...mounts()].reverse().find((x) => x.target === abs || x.source === t)
    if (m && !ctx.root && !m.options.some((o) => o === 'user' || o === 'users')) throw new CmdError(`umount: ${m.target}: must be superuser to unmount.`)
    const error = unmount(abs === t ? t : abs, lazy ? undefined : ctx.cwd)
    if (error) throw new CmdError(error)
    if (verbose) out.push(`umount: ${m?.target ?? abs} unmounted`)
  }
  return out.join('\n')
}

/** findmnt: the mounts as a tree (or fstab's lines with -s). */
function findmnt(ctx: Ctx): string {
  const args = ctx.args
  if (args.includes('-h') || args.includes('--help'))
    return `
Usage:
 findmnt [options]
 findmnt [options] <device> | <mountpoint>

Find a (mounted) filesystem.

Options:
 -s, --fstab            search in static table of filesystems
 -l, --list             use list format output
 -t, --types <list>     limit the set of filesystems by FS types

 -h, --help             display this help
 -V, --version          display version

For more details see findmnt(8).`
  const fstab = args.includes('-s') || args.includes('--fstab')
  const list = args.includes('-l') || args.includes('--list')
  const ti = args.findIndex((a) => a === '-t' || a === '--types')
  const types = ti >= 0 ? (args[ti + 1] ?? '').split(',') : null
  const what = args.filter((a, i) => !a.startsWith('-') && i !== ti + 1)[0]
  type Row = { target: string; source: string; type: string; options: string }
  let rows: Row[] = (fstab ? fstabEntries() : mounts()).map((m) => {
    const u = fstab ? { source: m.source, type: m.type } : underlying(m)
    return { target: m.target, source: u.source, type: u.type, options: fstab ? m.options.join(',') : liveOptions(m) }
  })
  if (types) rows = rows.filter((r) => types.some((t) => r.type === t || r.type === `fuse.${t}`))
  if (what) {
    const abs = what.startsWith('/') ? what.replace(/(.)\/+$/, '$1') : resolvePath(ctx.cwd, what)
    rows = rows.filter((r) => r.target === abs || r.source === what)
    if (!rows.length) throw new CmdError('', true)
  }
  // The tree: each mount under the nearest mount above it.
  const depth = (r: Row) => rows.filter((o) => o !== r && (o.target === '/' ? r.target !== '/' : r.target.startsWith(`${o.target}/`))).length
  const ordered = list || what || fstab ? rows : [...rows].sort((a, b) => (a.target === '/' ? -1 : b.target === '/' ? 1 : a.target.localeCompare(b.target)))
  const depths = ordered.map(depth)
  /** Whether row i is the last of its siblings: no row of its depth before the next shallower one. */
  const last = (i: number) => {
    for (let j = i + 1; j < ordered.length; j++) {
      if (depths[j] < depths[i]) return true
      if (depths[j] === depths[i]) return false
    }
    return true
  }
  const label = (r: Row, i: number) => {
    if (list || what || fstab) return r.target
    const d = depths[i]
    if (!d) return r.target
    // Each ancestor level draws │ while that ancestor still has siblings below it.
    let lead = ''
    for (let k = 1; k < d; k++) {
      let a = i
      while (a >= 0 && depths[a] !== k) a--
      lead += a >= 0 && !last(a) ? '│ ' : '  '
    }
    return `${lead}${last(i) ? '└─' : '├─'}${r.target}`
  }
  const labels = ordered.map(label)
  const w = [Math.max(6, ...labels.map((l) => l.length)), Math.max(6, ...ordered.map((r) => r.source.length)), Math.max(6, ...ordered.map((r) => r.type.length))]
  return [`${'TARGET'.padEnd(w[0])} ${'SOURCE'.padEnd(w[1])} ${'FSTYPE'.padEnd(w[2])} OPTIONS`, ...ordered.map((r, i) => `${labels[i].padEnd(w[0])} ${r.source.padEnd(w[1])} ${r.type.padEnd(w[2])} ${r.options}`)].join('\n')
}

const size = (b: number) => {
  const units = ['B', 'K', 'M', 'G', 'T']
  let v = b
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return i === 0 ? `${v}B` : `${v.toFixed(1)}${units[i]}`
}

/** lsblk: the disk and its partitions, and a block device per Seafile library. */
function lsblk(ctx: Ctx): string {
  const fs = ctx.args.some((a) => a === '-f' || a === '--fs')
  const mounted = mounts()
  const pointsOf = (match: (m: Mount) => boolean) => mounted.filter((m) => !isBind(m) && match(m)).map((m) => m.target)
  type Dev = { name: string; majmin: string; size: string; ro: string; type: string; fstype: string; label: string; uuid: string; points: string[] }
  const devs: Dev[] = [
    { name: 'nvme0n1', majmin: '259:0', size: '476.9G', ro: '0', type: 'disk', fstype: '', label: '', uuid: '', points: [] },
    { name: '├─nvme0n1p1', majmin: '259:1', size: '1G', ro: '0', type: 'part', fstype: 'vfat', label: '', uuid: '7A2C-1F04', points: [] },
    { name: '└─nvme0n1p2', majmin: '259:2', size: '475.9G', ro: '1', type: 'part', fstype: 'ext4', label: 'mvlos', uuid: '1996-09-19-cafe-0000-0000-000000000000', points: pointsOf((m) => m.source === '/dev/nvme0n1p2') },
  ]
  const names = deviceNames()
  ;(getLibraries() ?? []).forEach((l, i) => {
    const slug = names.get(l.id)!
    const points = [...pointsOf((m) => isSeafileType(m) && m.source !== 'seafile' && repoOfSource(m.source) === l.id), ...mounted.filter((m) => isSeafileType(m) && m.source === 'seafile').map((m) => `${m.target}/${l.name}`)]
    devs.push({ name: `seafile/${slug}`, majmin: `252:${i}`, size: size(l.size), ro: l.permission === 'r' ? '1' : '0', type: l.encrypted ? 'crypt' : 'disk', fstype: 'seafile', label: l.name, uuid: l.id, points })
  })
  if (fs) {
    const w = [Math.max(4, ...devs.map((d) => d.name.length)), 7, Math.max(5, ...devs.map((d) => d.label.length)), Math.max(4, ...devs.map((d) => d.uuid.length))]
    return [`${'NAME'.padEnd(w[0])} ${'FSTYPE'.padEnd(w[1])} ${'LABEL'.padEnd(w[2])} ${'UUID'.padEnd(w[3])} MOUNTPOINTS`, ...devs.flatMap((d) => [`${d.name.padEnd(w[0])} ${d.fstype.padEnd(w[1])} ${d.label.padEnd(w[2])} ${d.uuid.padEnd(w[3])} ${d.points[0] ?? ''}`, ...d.points.slice(1).map((p) => `${''.padEnd(w[0] + w[1] + w[2] + w[3] + 4)}${p}`)])].join('\n')
  }
  const w = Math.max(4, ...devs.map((d) => d.name.length))
  const head = `${'NAME'.padEnd(w)} MAJ:MIN RM   SIZE RO TYPE  MOUNTPOINTS`
  return [head, ...devs.flatMap((d) => [`${d.name.padEnd(w)} ${d.majmin.padStart(7)}  0 ${d.size.padStart(6)}  ${d.ro} ${d.type.padEnd(5)} ${d.points[0] ?? ''}`, ...d.points.slice(1).map((p) => `${''.padEnd(w + 29)}${p}`)])].join('\n')
}

// --- fscrypt --------------------------------------------------------------------------------------

/** The encrypted library a path is in, if any. */
function encryptedAt(ctx: Ctx, arg: string) {
  const abs = resolvePath(ctx.cwd, arg)
  const w = whereIs(abs)
  if (w.kind !== 'sf' || w.sf === SF) return { abs, lib: null }
  const lib = getLibraries()?.find((l) => l.id === parseSf(w.sf)!.repo) ?? null
  return { abs, lib: lib?.encrypted ? lib : null }
}

/** Reads a passphrase without echoing it; null when Ctrl+C or Esc. */
function readSecret(ctx: Ctx, prompt: string): Promise<string | null> {
  ctx.print(prompt)
  return new Promise((resolve) => {
    let typed = ''
    const done = (v: string | null) => {
      ctx.onKey(null)
      resolve(v)
    }
    ctx.signal.addEventListener('abort', () => done(null), { once: true })
    ctx.onKey((k) => {
      if (k === 'Enter') done(typed)
      else if (k === 'Escape') done(null)
      else if (k === 'Backspace') typed = typed.slice(0, -1)
      else if (k.length === 1) typed += k
      return true
    })
  })
}

async function fscrypt(ctx: Ctx): Promise<string> {
  const [sub, target] = ctx.args
  if (!sub || sub === '--help' || sub === 'help')
    return `fscrypt - manage linux filesystem encryption

Usage:
	fscrypt command [arguments] [command options]

Commands:
	status - get the status of the system or a path
	unlock - unlock an encrypted directory
	lock   - lock an encrypted directory

Here, the encrypted directories are your encrypted Seafile libraries; the passphrase
is the library's password. Files and the terminal share the unlocking.`
  if (!getAccount().seafile) throw new CmdError('fscrypt: no Seafile account: link one in Settings → Integrations → Seafile')
  if (!getLibraries()) await loadLibraries()
  const unlocks = getUnlocks()
  if (sub === 'status') {
    if (target) {
      const { abs, lib } = encryptedAt(ctx, target)
      if (!lib) throw new CmdError(`fscrypt status: file or directory "${abs}" is not encrypted`)
      const open = (unlocks[lib.id] ?? 0) > Date.now()
      return [
        `"${abs}" is encrypted with fscrypt.`,
        '',
        `Policy:   ${lib.id.replace(/-/g, '').slice(0, 32)}`,
        'Options:  padding:32 contents:AES_256_XTS filenames:AES_256_CTS policy_version:2',
        `Unlocked: ${open ? `Yes (until ${new Date(unlocks[lib.id]).toLocaleTimeString('en-GB')})` : 'No'}`,
        '',
        'Protectors:',
        'PROTECTOR         LINKED  DESCRIPTION',
        `${lib.id.replace(/-/g, '').slice(0, 16)}  No      custom protector "${lib.name}"`,
      ].join('\n')
    }
    const enc = (getLibraries() ?? []).filter((l) => l.encrypted)
    if (!enc.length) return 'No encrypted libraries.'
    return ['ENCRYPTED LIBRARY'.padEnd(28) + 'UNLOCKED', ...enc.map((l) => `${l.name.padEnd(28)}${(unlocks[l.id] ?? 0) > Date.now() ? `Yes, until ${new Date(unlocks[l.id]).toLocaleTimeString('en-GB')}` : 'No'}`)].join('\n')
  }
  if (sub === 'unlock' || sub === 'lock') {
    if (!target) throw new CmdError(`fscrypt ${sub}: missing required argument (DIRECTORY)`)
    const { abs, lib } = encryptedAt(ctx, target)
    if (!lib) throw new CmdError(`fscrypt ${sub}: file or directory "${abs}" is not encrypted`)
    const open = (unlocks[lib.id] ?? 0) > Date.now()
    if (sub === 'lock') {
      if (!open) throw new CmdError(`fscrypt lock: directory "${abs}" is already locked`)
      await lock(lib.id)
      return ''
    }
    if (open) throw new CmdError(`fscrypt unlock: directory "${abs}" is already unlocked`)
    const secret = await readSecret(ctx, `Enter custom passphrase for protector "${lib.name}": `)
    if (secret === null) throw new CmdError('^C')
    try {
      await unlock(lib.id, secret)
    } catch {
      throw new CmdError('fscrypt unlock: incorrect key provided')
    }
    return ''
  }
  throw new CmdError(`fscrypt: unknown command "${sub}"\n\nUse "fscrypt --help" for usage.`)
}

const FSTAB_MAN = `${c('bold', 'NAME')}
       fstab - static information about the filesystems

${c('bold', 'SYNOPSIS')}
       /etc/fstab

${c('bold', 'DESCRIPTION')}
       The file fstab contains descriptive information about the filesystems the system can
       mount. Each filesystem is described on a separate line; fields on each line are separated
       by tabs or spaces. Lines starting with '#' are comments. Blank lines are ignored.

       In MvL OS it also decides what Files shows: Home is whatever is mounted on /home/menno, the
       places in its sidebar are the folders under it, and the Seafile section lists what is
       mounted at /mnt/seafile. Edit it with ${c('green', 'sudo nano /etc/fstab')}; Settings →
       Integrations → Seafile edits the same lines.

${c('bold', 'THE FIELDS')}
       1. fs_spec       what to mount: a library as UUID=<library id>, LABEL=<name> or
                        /dev/seafile/<name> (lsblk -f lists them), "seafile" for every library at
                        once (each in a folder named after it), or a folder for a bind mount.
                        Spaces are written \\040.
       2. fs_file       where: an existing folder. On /home/menno it becomes home.
       3. fs_vfstype    seafile for libraries, none for bind mounts.
       4. fs_mntops     defaults, or a comma-separated list: ro (read-only), noauto (not mounted at
                        boot; mount it with mount), user (any user may mount it), bind.
       5. fs_freq       dump; 0.
       6. fs_passno     fsck order; 0.

${c('bold', 'EXAMPLES')}
       seafile                    /mnt/seafile          seafile  defaults  0 0
       UUID=1f2e…                 /home/menno           seafile  defaults  0 0
       LABEL=Photos               /mnt/photos           seafile  ro,noauto 0 0
       /mnt/seafile/Photos/2024   /home/menno/Pictures  none     bind      0 0

${c('bold', 'SEE ALSO')}
       mount(8), umount(8), findmnt(8), lsblk(8), fscrypt(1)`

export const mountCommands: Record<string, Command> = {
  mount: { desc: 'mount a filesystem, or list the mounts', usage: 'mount [-a] [-t type] [-o opts] [--bind] [source] [dir]', run: mount },
  umount: { desc: 'unmount a filesystem', usage: 'umount <dir|source>', run: umount },
  findmnt: { desc: 'show the mounts as a tree', usage: 'findmnt [-s] [-l] [-t type] [dir]', run: findmnt },
  lsblk: { desc: 'list block devices (the disk and your Seafile libraries)', usage: 'lsblk [-f]', run: lsblk },
  fscrypt: { desc: 'unlock and lock encrypted Seafile libraries', usage: 'fscrypt status|unlock|lock [dir]', run: fscrypt },
}

/** Manual pages for things that are not commands (man 5 fstab). */
export const manPages: Record<string, { section: number; text: string }> = { fstab: { section: 5, text: FSTAB_MAN } }
