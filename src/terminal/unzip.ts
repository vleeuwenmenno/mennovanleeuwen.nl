import { extract, type Clash } from '../data/extract'
import { listDir, parseSf, sfPath } from '../data/seafile'
import { readEntry, readZip, type ZipEntry, type ZipIndex } from '../data/zip'
import { lookup, sfOf } from './fs'
import { CmdError, type Ctx } from './types'
import { resolvePath } from './vfs'

// unzip, as Info-ZIP's UnZip 6.00 has it: -l and -v list, -z shows the comment, -p prints files,
// and plain unzip unpacks (all, or the files named, minus -x ones) into the folder you are in or
// -d's. Archives in Seafile only; the unpacking itself happens on the server (data/extract.ts),
// which reads just the files' own bytes. Existing files are asked about one by one, as unzip does,
// unless -o (overwrite) or -n (never).

type Command = { desc: string; usage?: string; man?: string; run: (ctx: Ctx) => string | void | Promise<string | void> }

const c = (color: string, s: string) => `{c:${color}}${s}{/}`

const HELP = `UnZip 6.00 of 20 April 2009, by Debian. Original by Info-ZIP.

Usage: unzip [-Z] [-opts[modifiers]] file[.zip] [list] [-x xlist] [-d exdir]
  Default action is to extract files in list, except those in xlist, to exdir;
  file[.zip] may be a wildcard.  -Z => ZipInfo mode ("unzip -Z" for usage).

  -p  extract files to pipe, no messages     -l  list files (short format)
  -f  freshen existing files, create none    -t  test compressed archive data
  -u  update files, create if necessary      -z  display archive comment only
  -v  list verbosely/show version info       -T  timestamp archive to latest
  -x  exclude files that follow (in xlist)   -d  extract files into exdir
modifiers:
  -n  never overwrite existing files         -q  quiet mode (-qq => quieter)
  -o  overwrite files WITHOUT prompting      -a  auto-convert any text files
  -j  junk paths (do not make directories)   -aa treat ALL files as text
  -C  match filenames case-insensitively     -L  make (some) names lowercase
See "unzip -hh" or unzip.txt for more help.  Examples:
  unzip data1 -x joe   => extract all files except joe from zipfile data1.zip
  unzip -p foo | more  => send contents of foo.zip via pipe into program more
  unzip -fo foo ReadMe => quietly replace existing ReadMe if archive file newer`

const MAN = `${c('bold', 'NAME')}
       unzip - list, test and extract compressed files in a ZIP archive

${c('bold', 'SYNOPSIS')}
       unzip [-lvzpqnoC] file[.zip] [file(s) ...] [-x xfile(s) ...] [-d exdir]

${c('bold', 'DESCRIPTION')}
       unzip lists or extracts files from a ZIP archive in your Seafile libraries (through the
       mounts in /etc/fstab: ~ and /mnt/seafile). Extracting happens on the server, which reads
       only the bytes of the files it unpacks, never the whole archive. Stored and deflated files
       unpack; other methods and password-protected files are skipped with a message.

${c('bold', 'OPTIONS')}
       -l     list archive files (short format)
       -v     list archive files (verbose format: method, compressed size, CRC-32)
       -z     display only the archive comment
       -p     extract files to the screen or a pipe (deflated and stored files up to 32 MB)
       -d exdir
              extract into exdir instead of the current folder (made if it is missing)
       -x xfile(s)
              leave out files that match these patterns
       -n     never overwrite existing files
       -o     overwrite existing files without asking (Seafile keeps the old version)
       -q     quiet; -qq quieter
       -C     match file name patterns case-insensitively

       Patterns use * ? and [...], and * matches across slashes. Without -o or -n, each file
       already there is asked about: [y]es, [n]o, [A]ll, [N]one, or [r]ename (Seafile then adds
       " (1)" to the new one).

${c('bold', 'EXAMPLES')}
       unzip -l mods.zip                    what is in it
       unzip mods.zip                       everything, into this folder
       unzip mods.zip '*.jar' -d ~/mods     only the .jar files, into ~/mods
       unzip -p project.zip README.md | head

${c('bold', 'SEE ALSO')}
       Files and the Archive app (Extract…), which do the same.`

/** unzip's wildcards: * ? [...], with * crossing slashes. */
function pattern(p: string, ci: boolean): RegExp {
  let re = ''
  for (let i = 0; i < p.length; i++) {
    const ch = p[i]
    if (ch === '*') re += '.*'
    else if (ch === '?') re += '.'
    else if (ch === '[') {
      const end = p.indexOf(']', i + 1)
      if (end < 0) re += '\\['
      else {
        re += `[${p.slice(i + 1, end).replace(/^!/, '^')}]`
        i = end
      }
    } else if (ch === '\\' && i + 1 < p.length) re += p[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`, ci ? 'i' : '')
}

const pad = (n: number) => String(n).padStart(2, '0')
const date = (ms: number) => {
  const d = new Date(ms || 0)
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const shown = (e: ZipEntry) => (e.dir ? `${e.path}/` : e.path)
const plural = (n: number) => `${n} file${n === 1 ? '' : 's'}`

/** The archive's bytes from..to, through the server (Seafile sends no CORS headers on ranges). */
const rawUrl = (sf: string) => {
  const at = parseSf(sf)!
  return `/api/seafile/raw?repo=${encodeURIComponent(at.repo)}&p=${encodeURIComponent(at.p)}`
}
async function bytes(sf: string, from: number, to: number): Promise<Uint8Array> {
  const res = await fetch(rawUrl(sf), { headers: { Range: `bytes=${from}-${to}` }, credentials: 'same-origin' })
  if (res.status !== 206) throw new Error((await res.json().catch(() => null))?.error ?? `the server answered ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}

/** One file's contents, unpacked here (for -p). */
async function contents(sf: string, e: ZipEntry): Promise<string> {
  if (e.compressed > 32 * 1024 * 1024) throw new Error('too big to print here')
  return new TextDecoder().decode(await readEntry(e, (from, to) => bytes(sf, from, to)))
}

/** One key from the person at the terminal (Ctrl+C gives null). */
function ask(ctx: Ctx, prompt: string, keys: string[]): Promise<string | null> {
  ctx.print(prompt)
  return new Promise((resolve) => {
    const done = (k: string | null) => {
      ctx.onKey(null)
      resolve(k)
    }
    ctx.signal.addEventListener('abort', () => done(null), { once: true })
    ctx.onKey((k) => {
      if (keys.includes(k)) done(k)
      return true
    })
  })
}

async function unzip(ctx: Ctx): Promise<string | void> {
  const args = ctx.args
  if (!args.length || args.includes('-h') || args.includes('--help')) return HELP
  let list = false
  let verbose = false
  let comment = false
  let pipe = false
  let quiet = 0
  let clash: Clash | null = null
  let ci = false
  let exdir: string | null = null
  let file: string | null = null
  const include: string[] = []
  const exclude: string[] = []
  let inX = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '-x') {
      inX = true
      continue
    }
    if (a === '-d') {
      exdir = args[++i] ?? null
      if (exdir === null) throw new CmdError('error:  must specify directory to which to extract with -d option', true)
      inX = false
      continue
    }
    if (a.startsWith('-d') && a.length > 2) {
      exdir = a.slice(2)
      continue
    }
    if (a.startsWith('-') && a.length > 1 && file === null) {
      for (const ch of a.slice(1)) {
        if (ch === 'l') list = true
        else if (ch === 'v') verbose = true
        else if (ch === 'z') comment = true
        else if (ch === 'p') pipe = true
        else if (ch === 'q') quiet++
        else if (ch === 'o') clash = 'replace'
        else if (ch === 'n') clash = 'skip'
        else if (ch === 'C') ci = true
        else if ('tfujTaUXVKMLZ'.includes(ch)) throw new CmdError(`unzip: -${ch} is not available here (try -l, -v, -p, -o, -n, -d, -x)`)
        else throw new CmdError(`unzip:  invalid option -- '${ch}'\n${HELP}`)
      }
      continue
    }
    if (file === null) file = a
    else (inX ? exclude : include).push(a)
  }
  if (file === null) return HELP
  // -v with an archive is the verbose listing.
  if (verbose) list = true

  // The archive: as named, or with .zip or .ZIP added.
  const candidates = [file, `${file}.zip`, `${file}.ZIP`]
  const found = candidates.map((f) => ({ f, abs: resolvePath(ctx.cwd, f) })).find(({ abs }) => lookup(abs)?.type === 'file')
  if (!found) throw new CmdError(`unzip:  cannot find or open ${file}, ${file}.zip or ${file}.ZIP.`)
  const node = lookup(found.abs)!
  if (node.type !== 'file' || !node.sf) throw new CmdError(`unzip:  ${found.f}: only archives in Seafile can be read here (~ or /mnt/seafile)`)
  const sf = node.sf
  let index: ZipIndex
  try {
    index = await readZip(rawUrl(sf), node.size)
  } catch (e) {
    throw new CmdError(`Archive:  ${found.f}\n  End-of-central-directory signature not found.  Either this file is not\n  a zipfile, or it constitutes one disk of a multi-part archive.\n  (${(e as Error).message})`)
  }

  // Which entries: the ones matching the list (all without one), minus -x's.
  const inc = include.map((p) => pattern(p, ci))
  const exc = exclude.map((p) => pattern(p, ci))
  const chosen = index.entries.filter((e) => (!inc.length || inc.some((r) => r.test(shown(e)) || r.test(e.path))) && !exc.some((r) => r.test(shown(e)) || r.test(e.path)))
  const unmatched = include.filter((_, i) => !index.entries.some((e) => inc[i].test(shown(e)) || inc[i].test(e.path)))
  const caution = unmatched.map((p) => `caution: filename not matched:  ${p}`)
  const archiveLine = `Archive:  ${found.f}`

  if (comment) return [archiveLine, index.comment].join('\n')

  if (list) {
    const files = chosen.filter((e) => !e.dir)
    if (verbose) {
      const total = files.reduce((a, e) => a + e.size, 0)
      const packed = files.reduce((a, e) => a + e.compressed, 0)
      const cmpr = (size: number, comp: number) => `${size ? Math.max(0, Math.round((1 - comp / size) * 100)) : 0}%`.padStart(4)
      const method = (e: ZipEntry) => (e.method === 0 ? 'Stored' : e.method === 8 ? 'Defl:N' : `Unk:${String(e.method).padStart(3, '0')}`)
      return [
        archiveLine,
        ' Length   Method    Size  Cmpr    Date    Time   CRC-32   Name',
        '--------  ------  ------- ---- ---------- ----- --------  ----',
        ...chosen.map((e) => `${String(e.size).padStart(8)}  ${method(e)} ${String(e.compressed).padStart(8)} ${cmpr(e.size, e.compressed)} ${date(e.mtime)} ${(e.crc >>> 0).toString(16).padStart(8, '0')}  ${shown(e)}`),
        '--------          -------  ---                            -------',
        `${String(total).padStart(8)}         ${String(packed).padStart(8)} ${cmpr(total, packed)}                            ${plural(files.length)}`,
        ...caution,
      ].join('\n')
    }
    const total = files.reduce((a, e) => a + e.size, 0)
    return [
      archiveLine,
      '  Length      Date    Time    Name',
      '---------  ---------- -----   ----',
      ...chosen.map((e) => `${String(e.size).padStart(9)}  ${date(e.mtime)}   ${shown(e)}`),
      '---------                     -------',
      `${String(total).padStart(9)}                     ${plural(files.length)}`,
      ...caution,
    ].join('\n')
  }

  if (pipe) {
    const out: string[] = []
    for (const e of chosen.filter((x) => !x.dir)) {
      try {
        out.push(await contents(sf, e))
      } catch (err) {
        out.push(c('red', `   skipping: ${e.path}  ${(err as Error).message}`))
      }
    }
    return out.join('')
  }

  // Unpacking: into -d's folder (made if missing) or this one, in Seafile and writable.
  const destAbs = resolvePath(ctx.cwd, exdir ?? '.')
  const dest = sfOf(destAbs) ?? (exdir ? sfOf(destAbs.replace(/\/[^/]+$/, '')) : null)
  if (!dest) throw new CmdError(`checkdir error:  cannot create ${exdir ?? destAbs}\n                 unable to process ${found.f}.`)
  if (dest.ro) throw new CmdError(`checkdir error:  ${exdir ?? destAbs} is read-only\n                 unable to process ${found.f}.`)
  const destSf = sfOf(destAbs)?.sf ?? `${dest.sf}/${destAbs.split('/').pop()}`
  if (!chosen.length) return [archiveLine, ...caution].join('\n')

  // Files already there: asked about one by one, unless -o or -n (after the Archive line, as unzip does).
  if (quiet < 2) ctx.print(archiveLine)
  const decisions: Record<string, Clash> = {}
  if (!clash) {
    const at = parseSf(destSf)!
    const folders = new Map<string, Set<string>>()
    const namesIn = async (dir: string) => {
      if (!folders.has(dir))
        folders.set(
          dir,
          await listDir(sfPath(at.repo, dir))
            .then((l) => new Set(l.entries.filter((e) => !e.dir).map((e) => e.name)))
            .catch(() => new Set<string>()),
        )
      return folders.get(dir)!
    }
    let all: Clash | null = null
    for (const e of chosen.filter((x) => !x.dir)) {
      const parts = e.path.split('/')
      const name = parts.pop()!
      const dir = `${at.p === '/' ? '' : at.p}${parts.length ? `/${parts.join('/')}` : ''}` || '/'
      if (!(await namesIn(dir)).has(name)) continue
      if (all) {
        decisions[e.path] = all
        continue
      }
      const key = await ask(ctx, `replace ${exdir ? `${exdir.replace(/\/$/, '')}/` : ''}${e.path}? [y]es, [n]o, [A]ll, [N]one, [r]ename: `, ['y', 'n', 'A', 'N', 'r'])
      if (key === null) throw new CmdError('', true)
      if (key === 'A') all = 'replace'
      if (key === 'N') all = 'skip'
      decisions[e.path] = key === 'y' || key === 'A' ? 'replace' : key === 'n' || key === 'N' ? 'skip' : 'keep'
    }
  }

  const prefix = exdir ? `${exdir.replace(/\/$/, '')}/` : ''
  const label = { creating: '   creating:', inflating: '  inflating:', extracting: ' extracting:', skipped: '' }
  const final = await extract(
    sf,
    destSf,
    { entries: chosen.map((e) => e.path), clash: clash ?? 'keep', decisions, quiet: true },
    (s) => {
      if (quiet) return
      const lines = s.done.filter((d) => d.how !== 'skipped').map((d) => `${label[d.how]} ${prefix}${d.path}`)
      if (lines.length) ctx.print(lines.join('\n'))
    },
    ctx.signal,
  )
  const problems = [...caution, ...final.errors.map((e) => c('red', `   skipping: ${e.path}  ${e.error}`))]
  if (final.state === 'failed') throw new CmdError([...problems, c('red', `unzip:  ${final.error}`)].join('\n'), true)
  if (final.state === 'cancelled') throw new CmdError('', true)
  if (final.errors.length) throw new CmdError(problems.join('\n'), true)
  return problems.join('\n')
}

export const unzipCommands: Record<string, Command> = {
  unzip: { desc: 'list or extract files from a ZIP archive (in Seafile)', usage: 'unzip [-lvzpqnoC] file[.zip] [list] [-x xlist] [-d exdir]', man: MAN, run: unzip },
}
