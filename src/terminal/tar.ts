import { archiveFormat } from '../data/archive'
import { extract, type Clash } from '../data/extract'
import { parseSf } from '../data/seafile'
import type { ZipEntry, ZipIndex } from '../data/zip'
import { lookup, sfOf } from './fs'
import { CmdError, type Ctx } from './types'
import { pattern } from './unzip'
import { resolvePath } from './vfs'

// tar, as GNU tar 1.35 has it, for tars in Seafile, plain or gzipped (.tar, .tar.gz, .tgz): -t lists
// (-v the long way), -x unpacks into the folder you are in or -C's, -O prints files. Options come
// bundled (tar xzvf a.tgz) or apart (tar -x -f a.tgz -C out). The server reads the archive
// (server/unzip.ts) and does the unpacking; making archives is not available. As GNU tar does, -x
// replaces files that are there, unless -k (keep them).

type Command = { desc: string; usage?: string; man?: string; run: (ctx: Ctx) => string | void | Promise<string | void> }

const c = (color: string, s: string) => `{c:${color}}${s}{/}`

const HELP = `Usage: tar [OPTION...] [FILE]...
GNU 'tar' saves many files together into a single tape or disk archive, and can
restore individual files from the archive.

Examples:
  tar -tvf archive.tar         # List all files in archive.tar verbosely.
  tar -xf archive.tar          # Extract all files from archive.tar.
  tar -xzf archive.tar.gz -C out a/b   # Extract a/b into the folder out.

 Main operation mode:
  -t, --list                 list the contents of an archive
  -x, --extract, --get       extract files from an archive

 Options:
  -C, --directory=DIR        change to directory DIR
  -f, --file=ARCHIVE         use archive file ARCHIVE
  -k, --keep-old-files       don't replace existing files when extracting
      --skip-old-files       the same, without a word about it
      --overwrite            replace existing files when extracting (the default)
  -O, --to-stdout            extract files to standard output
  -v, --verbose              verbosely list files processed
  -z, --gzip                 filter the archive through gzip (seen from the name anyway)
      --wildcards            use wildcards in member names (on when a name has * ? or [)
      --help                 give this help list

Archives in Seafile only (~ or /mnt/seafile): .tar, .tar.gz and .tgz. Creating
archives (-c, -r, -u) is not available here.`

const pad = (n: number) => String(n).padStart(2, '0')
const date = (ms: number) => {
  const d = new Date(ms || 0)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const mode = (e: ZipEntry) => {
  const m = e.mode ?? (e.dir ? 0o755 : 0o644)
  const bits = [6, 3, 0].map((s) => ['r', 'w', 'x'].map((ch, i) => ((m >> s) & (4 >> i) ? ch : '-')).join('')).join('')
  return `${e.dir ? 'd' : e.link !== undefined ? 'l' : '-'}${bits}`
}
const shown = (e: ZipEntry) => (e.dir ? `${e.path}/` : e.path)

const api = (path: string, sf: string) => {
  const at = parseSf(sf)!
  return `/api/seafile/${path}?repo=${encodeURIComponent(at.repo)}&p=${encodeURIComponent(at.p)}`
}

async function tar(ctx: Ctx): Promise<string> {
  const args = ctx.args.slice()
  if (!args.length) throw new CmdError("tar: You must specify one of the '-Acdtrux', '--delete' or '--test-label' options\nTry 'tar --help' or 'tar --usage' for more information.")
  if (args.includes('--help') || args.includes('--usage')) return HELP
  if (args.includes('--version')) return 'tar (GNU tar) 1.35\nCopyright (C) 2023 Free Software Foundation, Inc.'
  let op: 't' | 'x' | null = null
  let verbose = false
  let toStdout = false
  let file: string | null = null
  let dir: string | null = null
  let clash: Clash = 'replace'
  const members: string[] = []
  const setOp = (o: 't' | 'x') => {
    if (op && op !== o) throw new CmdError("tar: You may not specify more than one '-Acdtrux', '--delete' or  '--test-label' option\nTry 'tar --help' or 'tar --usage' for more information.")
    op = o
  }
  const short = (ch: string, next: () => string | undefined) => {
    if (ch === 't') setOp('t')
    else if (ch === 'x') setOp('x')
    else if (ch === 'v') verbose = true
    else if (ch === 'z') return
    else if (ch === 'k') clash = 'skip'
    else if (ch === 'O') toStdout = true
    else if (ch === 'f') file = next() ?? null
    else if (ch === 'C') dir = next() ?? null
    else if ('cruA'.includes(ch)) throw new CmdError('tar: creating or changing archives is not available here (only -t and -x)')
    else if ('jJ'.includes(ch)) throw new CmdError(`tar: ${ch === 'j' ? 'bzip2' : 'xz'} archives are not supported here (only .tar, .tar.gz and .tgz)`)
    else throw new CmdError(`tar: invalid option -- '${ch}'\nTry 'tar --help' or 'tar --usage' for more information.`)
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    const next = () => args[++i]
    // The first word may be bundled options without a dash: tar xzvf a.tgz.
    const bundle = i === 0 && !a.startsWith('-') ? a : a.startsWith('-') && !a.startsWith('--') && a.length > 1 ? a.slice(1) : null
    if (bundle !== null) {
      for (let j = 0; j < bundle.length; j++) {
        const ch = bundle[j]
        // An option with a value takes the rest of the word (-fa.tar), or the next word.
        if ((ch === 'f' || ch === 'C') && j < bundle.length - 1 && a.startsWith('-')) {
          short(ch, () => bundle.slice(j + 1))
          break
        }
        short(ch, next)
      }
      continue
    }
    const long = /^--([a-z-]+)(?:=(.*))?$/.exec(a)
    if (long) {
      const [, name, value] = long
      const val = () => value ?? next()
      if (name === 'list') setOp('t')
      else if (name === 'extract' || name === 'get') setOp('x')
      else if (name === 'verbose') verbose = true
      else if (name === 'file') file = val() ?? null
      else if (name === 'directory') dir = val() ?? null
      else if (name === 'keep-old-files' || name === 'skip-old-files') clash = 'skip'
      else if (name === 'overwrite') clash = 'replace'
      else if (name === 'to-stdout') toStdout = true
      else if (name === 'gzip' || name === 'gunzip' || name === 'ungzip' || name === 'wildcards' || name === 'no-wildcards') continue
      else if (['create', 'append', 'update', 'delete', 'concatenate'].includes(name)) throw new CmdError('tar: creating or changing archives is not available here (only -t and -x)')
      else throw new CmdError(`tar: unrecognized option '${a}'\nTry 'tar --help' or 'tar --usage' for more information.`)
      continue
    }
    members.push(a)
  }
  if (!op) throw new CmdError("tar: You must specify one of the '-Acdtrux', '--delete' or '--test-label' options\nTry 'tar --help' or 'tar --usage' for more information.")
  if (!file) throw new CmdError('tar: Refusing to read archive contents from terminal (missing -f option?)\ntar: Error is not recoverable: exiting now')
  const name: string = file

  // The archive: a tar in Seafile.
  const abs = resolvePath(ctx.cwd, name)
  const node = lookup(abs)
  if (!node) throw new CmdError(`tar: ${name}: Cannot open: No such file or directory\ntar: Error is not recoverable: exiting now`)
  if (node.type !== 'file') throw new CmdError(`tar: ${name}: Cannot read: Is a directory\ntar: Error is not recoverable: exiting now`)
  const format = archiveFormat(name)
  if (format !== 'tar' && format !== 'tgz') throw new CmdError(`tar: This does not look like a tar archive${format === 'zip' ? ' (it is a ZIP: try unzip)' : ''}\ntar: Exiting with failure status due to previous errors`)
  if (!node.sf) throw new CmdError(`tar: ${name}: only archives in Seafile can be read here (~ or /mnt/seafile)`)
  const sf = node.sf
  const res = await fetch(api('archive', sf), { credentials: 'same-origin', signal: ctx.signal })
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new CmdError(`tar: ${name}: ${body?.error ?? `the server answered ${res.status}`}\ntar: Error is not recoverable: exiting now`)
  const index = body as ZipIndex

  // Which entries: the members named (a folder takes what is in it; wildcards match too), or all.
  const matchers = members.map((m) => {
    const clean = m.replace(/^\.\//, '').replace(/\/+$/, '')
    const glob = /[*?[]/.test(clean) ? pattern(clean, false) : null
    return (e: ZipEntry) => (glob ? glob.test(e.path) : e.path === clean || e.path.startsWith(`${clean}/`))
  })
  const chosen = matchers.length ? index.entries.filter((e) => matchers.some((m) => m(e))) : index.entries
  const missing = members.filter((_, i) => !index.entries.some(matchers[i])).map((m) => `tar: ${m}: Not found in archive`)
  const failing = missing.length ? ['tar: Exiting with failure status due to previous errors'] : []

  if (op === 't') {
    const owner = Math.max(...chosen.map((e) => (e.owner ?? '').length), 1)
    const size = Math.max(...chosen.map((e) => String(e.size).length), 1)
    const lines = chosen.map((e) =>
      verbose ? `${mode(e)} ${(e.owner ?? '0/0').padEnd(owner)} ${String(e.size).padStart(size)} ${date(e.mtime)} ${shown(e)}${e.link !== undefined ? ` -> ${e.link}` : ''}` : shown(e),
    )
    if (missing.length) throw new CmdError([...lines, ...missing.map((m) => c('red', m)), c('red', failing[0])].join('\n'), true)
    return lines.join('\n')
  }

  if (toStdout) {
    const out: string[] = []
    for (const e of chosen.filter((x) => !x.dir && x.link === undefined)) {
      if (e.size > 32 * 1024 * 1024) {
        out.push(c('red', `tar: ${e.path}: too big to print here`))
        continue
      }
      const r = await fetch(`${api('archive/file', sf)}&entry=${encodeURIComponent(e.path)}`, { credentials: 'same-origin', signal: ctx.signal })
      out.push(r.ok ? await r.text() : c('red', `tar: ${e.path}: ${(await r.json().catch(() => null))?.error ?? `the server answered ${r.status}`}`))
    }
    return [...out, ...missing.map((m) => c('red', m))].join('')
  }

  // Unpacking: into -C's folder or this one, in Seafile and writable.
  const destAbs = resolvePath(ctx.cwd, dir ?? '.')
  const dest = sfOf(destAbs)
  if (!dest || lookup(destAbs)?.type !== 'dir') throw new CmdError(`tar: ${dir ?? '.'}: Cannot open: No such file or directory\ntar: Error is not recoverable: exiting now`)
  if (dest.ro) throw new CmdError(`tar: ${dir ?? '.'}: Cannot open: Read-only file system\ntar: Error is not recoverable: exiting now`)
  if (!chosen.length) throw new CmdError([...missing, failing[0]].filter(Boolean).join('\n'))
  const final = await extract(
    sf,
    dest.sf,
    { entries: matchers.length ? chosen.map((e) => e.path) : undefined, clash, quiet: true },
    (s) => {
      if (!verbose) return
      const lines = s.done.filter((d) => d.how !== 'skipped').map((d) => d.path)
      if (lines.length) ctx.print(lines.join('\n'))
    },
    ctx.signal,
  )
  if (final.state === 'cancelled') throw new CmdError('', true)
  const problems = [...missing, ...final.errors.map((e) => `tar: ${e.path}: ${e.error}`)]
  if (final.state === 'failed') problems.push(`tar: ${final.error}`)
  if (problems.length) throw new CmdError([...problems, 'tar: Exiting with failure status due to previous errors'].map((l) => c('red', l)).join('\n'), true)
  return ''
}

export const tarCommands: Record<string, Command> = {
  tar: { desc: 'list or extract tar archives, plain or gzipped (in Seafile)', usage: 'tar -t|-x [-vzkO] -f archive [-C dir] [member]...', run: tar },
}
