import type { User } from './auth.ts'
import { guardedFetch } from './egress.ts'
import { HttpError } from './http.ts'
import { fileLink, listDir, mkdir, removeItems, rename, seafile, transfer } from './seafile.ts'
import { commandWords, parse } from '../src/terminal/msh/parse.ts'

// A thread's work folder: a Seafile folder the agent works in, like a coding agent's checkout.
// The file tools here are Claude Code's (read, write, edit, list, glob, grep), with every path
// kept inside the folder. They run on the server, so a turn goes on when the terminal closes.
// The terminal tool's command lines are read here too, to tell the ones that only look from the
// ones that change something.

export type Workdir = { repo: string; path: string; label: string }
export type Permission = 'default' | 'acceptEdits' | 'plan'
export const PERMISSIONS: readonly Permission[] = ['default', 'acceptEdits', 'plan']

/** A work folder from a request: a library id, a path in it, and how the terminal showed it. */
export function workdirOf(v: unknown): Workdir | null {
  if (v === null || v === undefined) return null
  const w = v as Partial<Workdir>
  if (typeof w.repo !== 'string' || !/^[0-9a-f-]{36}$/i.test(w.repo)) throw new HttpError(400, 'Bad work folder library')
  if (typeof w.path !== 'string' || !w.path.startsWith('/') || w.path.split('/').includes('..') || w.path.length > 1000) throw new HttpError(400, 'Bad work folder path')
  const path = w.path.replace(/(.)\/+$/, '$1')
  const label = typeof w.label === 'string' && w.label.trim() ? w.label.trim().slice(0, 300) : path
  return { repo: w.repo, path, label }
}

/** The tools that change files: these wait for the user, unless the mode allows edits. */
export const FILE_WRITES = new Set(['write_file', 'edit_file', 'multi_edit', 'make_dir', 'move_path'])
/** Deleting always asks, whatever the mode. */
export const FILE_DELETE = 'delete_path'
export const FILE_TOOLS = ['read_file', 'write_file', 'edit_file', 'multi_edit', 'list_dir', 'glob', 'grep', 'make_dir', 'move_path', 'delete_path'] as const

type ToolDef = { type: 'function'; function: { name: string; description: string; parameters: { type: 'object'; properties: Record<string, unknown>; required?: string[] } } }
const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []): ToolDef => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } })
const str = (description: string) => ({ type: 'string', description })

export function workdirTools(): ToolDef[] {
  const path = str('Path relative to the work folder (a/b.md); the folder itself is "."')
  return [
    tool('read_file', 'Read a text file in the work folder. Lines come numbered (number, tab, text). Long files: read a part with offset and limit.', { path, offset: { type: 'integer', description: 'First line to read, from 1' }, limit: { type: 'integer', description: 'How many lines (default 2000)' } }, ['path']),
    tool('write_file', 'Write a whole file in the work folder, new or replacing what is there. For changes to an existing file, prefer edit_file.', { path, content: str('The whole file content') }, ['path', 'content']),
    tool(
      'edit_file',
      'Replace text in a file: old_string must appear exactly once (give enough surrounding lines to make it unique), or set replace_all. Keep indentation exactly as the file has it; read the file first.',
      { path, old_string: str('The exact text to replace'), new_string: str('What to put instead'), replace_all: { type: 'boolean', description: 'Replace every occurrence (default false)' } },
      ['path', 'old_string', 'new_string'],
    ),
    tool(
      'multi_edit',
      'Several edit_file changes to one file, applied in order; all of them or none.',
      { path, edits: { type: 'array', items: { type: 'object', properties: { old_string: str('Text to replace'), new_string: str('Replacement'), replace_all: { type: 'boolean' } }, required: ['old_string', 'new_string'] } } },
      ['path', 'edits'],
    ),
    tool('list_dir', 'List a folder in the work folder: names (folders end in /) and sizes.', { path }),
    tool('glob', 'Find files by name pattern in the work folder, like **/*.ts or docs/*.md (newest first).', { pattern: str('The pattern; ** crosses folders, {a,b} picks one'), path: str('Folder to search in (default: the whole work folder)') }, ['pattern']),
    tool(
      'grep',
      'Search file contents in the work folder with a regular expression (JavaScript syntax). Answers path:line:text, or just the files.',
      {
        pattern: str('The regular expression'),
        path: str('Folder or file to search (default: the whole work folder)'),
        glob: str('Only files matching this pattern, like *.md'),
        ignore_case: { type: 'boolean' },
        context: { type: 'integer', description: 'Lines of context around each match (default 0)' },
        files_only: { type: 'boolean', description: 'Just the names of the files that match' },
      },
      ['pattern'],
    ),
    tool('make_dir', 'Make a folder (and its parents) in the work folder.', { path }, ['path']),
    tool('move_path', 'Move or rename a file or folder inside the work folder.', { from: str('What to move'), to: str('Its new path (an existing folder: into it)') }, ['from', 'to']),
    tool('delete_path', "Delete a file or folder in the work folder (it goes to the library's trash; the user is always asked).", { path }, ['path']),
  ]
}

export function terminalTool(): ToolDef {
  return tool(
    'terminal',
    "Run a command line in the user's MvL OS terminal, in msh (a POSIX-like shell), with the work folder as the working directory. It answers the output and the exit status. The commands are MvL OS's own (ls, cat, grep, find, head, sed-less text tools, curl, jq, …), not a Linux box: there is no git, python, node or package manager. Read-only commands run straight away; anything that changes something waits for the user.",
    { command: str('The command line'), description: str('What it does, in a few words, for the user') },
    ['command'],
  )
}

export function exitPlanTool(): ToolDef {
  return tool('exit_plan_mode', 'Show the user your plan and ask to start. Only in plan mode, once you have looked around and know what to change. The user approves (and picks how edits are allowed) or tells you what to change.', { plan: str('The plan, in Markdown: what you will change and why') }, ['plan'])
}

// --- paths --------------------------------------------------------------------------------------

/** A path the model gave, as a path inside the library; anything outside the work folder fails. */
export function resolveIn(w: Workdir, raw: unknown): string {
  let p = typeof raw === 'string' ? raw.trim() : ''
  // The folder as the terminal shows it (~/Projects/x/a.md) or as Seafile has it.
  for (const prefix of [w.label, w.path]) if (prefix !== '/' && (p === prefix || p.startsWith(`${prefix}/`))) p = p.slice(prefix.length)
  const parts: string[] = []
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      if (!parts.length) throw new Error(`${raw} is outside the work folder`)
      parts.pop()
    } else parts.push(seg)
  }
  return `${w.path === '/' ? '' : w.path}/${parts.join('/')}`.replace(/(.)\/$/, '$1') || '/'
}

/** A library path as the model should see it: relative to the work folder. */
const shown = (w: Workdir, p: string) => (p === w.path ? '.' : p.slice(w.path === '/' ? 1 : w.path.length + 1))
const split = (p: string): [string, string] => {
  const i = p.lastIndexOf('/')
  return [p.slice(0, i) || '/', p.slice(i + 1)]
}

async function entryAt(user: User, repo: string, path: string) {
  if (path === '/') return { name: '', dir: true, size: 0, mtime: 0, id: '' }
  const [dir, name] = split(path)
  const listing = await listDir(user, repo, dir).catch((e) => {
    if (e instanceof HttpError && e.status === 404) return null
    throw e
  })
  return listing?.entries.find((e) => e.name === name) ?? null
}

async function readText(user: User, repo: string, path: string, signal: AbortSignal): Promise<string> {
  const { url } = await fileLink(user, repo, path, 'download')
  const res = await guardedFetch(user, url, { signal })
  if (res.status === 404) throw new Error(`No file at that path`)
  if (!res.ok) throw new Error(`Seafile answered ${res.status}`)
  if (Number(res.headers.get('content-length')) > 4 * 1024 * 1024) throw new Error('That file is too big to read here (over 4 MB)')
  const bytes = Buffer.from(await res.arrayBuffer())
  if (bytes.subarray(0, 8000).includes(0)) throw new Error('That is not a text file')
  return bytes.toString('utf8')
}

/** Makes a folder and the ones above it that are missing. */
async function makeDirs(user: User, repo: string, path: string) {
  const parts = path.split('/').filter(Boolean)
  let at = ''
  for (const part of parts) {
    at += `/${part}`
    const e = await entryAt(user, repo, at)
    if (e && !e.dir) throw new Error(`${at} is a file`)
    if (!e) await mkdir(user, { repo, path: at })
  }
}

async function writeText(user: User, repo: string, path: string, content: string, signal: AbortSignal) {
  if (Buffer.byteLength(content) > 2 * 1024 * 1024) throw new Error('That is more than 2 MB of text')
  const [dir, name] = split(path)
  const existing = await entryAt(user, repo, path)
  if (existing?.dir) throw new Error('There is a folder with that name')
  if (!existing) await makeDirs(user, repo, dir)
  const { url } = await fileLink(user, repo, dir, 'upload')
  const form = new FormData()
  form.append('parent_dir', dir)
  form.append('replace', existing ? '1' : '0')
  form.append('file', new Blob([content], { type: 'text/plain' }), name)
  const res = await guardedFetch(user, `${url}?ret-json=1`, { method: 'POST', body: form, signal })
  if (!res.ok) throw new Error(`Seafile answered ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return { created: !existing }
}

type FileEntry = { path: string; size: number; mtime: number }
const MAX_WALK = 5000

/** Every file under a folder: one recursive listing from Seafile, else folder by folder. */
async function walkFiles(user: User, repo: string, root: string): Promise<FileEntry[]> {
  try {
    const body = await seafile<{ dirent_list?: { type: string; name: string; parent_dir?: string; size?: number; mtime?: number }[] }>(user, `/api/v2.1/repos/${repo}/dir/?p=${encodeURIComponent(root)}&recursive=1&t=f`)
    const list = body.dirent_list ?? []
    if (list.length && list.every((d) => typeof d.parent_dir === 'string'))
      return list.slice(0, MAX_WALK).map((d) => ({ path: `${d.parent_dir!.replace(/\/$/, '')}/${d.name}`, size: d.size ?? 0, mtime: (d.mtime ?? 0) * 1000 }))
    if (!list.length) return []
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) throw new Error('No such folder')
  }
  const out: FileEntry[] = []
  const queue = [root]
  let dirs = 0
  while (queue.length && dirs < 400 && out.length < MAX_WALK) {
    const dir = queue.shift()!
    dirs++
    const { entries } = await listDir(user, repo, dir)
    for (const e of entries) {
      const p = `${dir === '/' ? '' : dir}/${e.name}`
      if (e.dir) queue.push(p)
      else out.push({ path: p, size: e.size, mtime: e.mtime })
    }
  }
  return out
}

/** A glob as a regular expression over a relative path: ** crosses folders, {a,b} picks one. */
export function globRegExp(glob: string, ci = false): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i++
        if (glob[i + 1] === '/') {
          i++
          re += '(?:.*/)?'
        } else re += '.*'
      } else re += '[^/]*'
    } else if (ch === '?') re += '[^/]'
    else if (ch === '{') {
      const end = glob.indexOf('}', i)
      if (end < 0) re += '\\{'
      else {
        re += `(?:${glob
          .slice(i + 1, end)
          .split(',')
          .map((x) => x.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'))
          .join('|')})`
        i = end
      }
    } else if (ch === '[') {
      const end = glob.indexOf(']', i)
      if (end < 0) re += '\\['
      else {
        re += `[${glob.slice(i + 1, end).replace(/^!/, '^')}]`
        i = end
      }
    } else re += ch.replace(/[.+^${}()|\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`, ci ? 'i' : '')
}

const TEXTY = /\.(md|markdown|txt|csv|tsv|json|jsonc|ya?ml|toml|ini|conf|cfg|log|xml|html?|css|scss|less|s?js|mjs|cjs|jsx|tsx?|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|sh|msh|bash|fish|zsh|sql|lua|swift|r|tex|env|svg|vue|svelte|astro|dart|ex|exs|erl|hs|ml|nix|tf|gradle|properties|gitignore|dockerfile|makefile)$/i
const isText = (path: string) => TEXTY.test(path) || /(^|\/)(Makefile|Dockerfile|README|LICENSE|AGENTS|CLAUDE)[^/]*$/.test(path)

/** Runs one file tool. Answers what the model reads back. */
export async function runFileTool(user: User, w: Workdir, name: string, args: Record<string, unknown>, signal: AbortSignal, pageChars: number): Promise<string> {
  const s = (k: string) => (typeof args[k] === 'string' ? (args[k] as string) : '')
  const repo = w.repo
  switch (name) {
    case 'read_file': {
      const p = resolveIn(w, s('path'))
      const text = await readText(user, repo, p, signal)
      const lines = text.split('\n')
      if (text.endsWith('\n')) lines.pop()
      const from = Math.max(1, Math.floor(Number(args.offset) || 1))
      const count = Math.min(5000, Math.max(1, Math.floor(Number(args.limit) || 2000)))
      const part = lines.slice(from - 1, from - 1 + count).map((l, i) => `${String(from + i).padStart(6)}\t${l.length > 2000 ? `${l.slice(0, 2000)}…` : l}`)
      let body = part.join('\n')
      const budget = pageChars * 4
      let note = from - 1 + count < lines.length ? `\n[lines ${from}-${from - 1 + part.length} of ${lines.length}; read on with offset ${from + part.length}]` : ''
      if (body.length > budget) {
        body = body.slice(0, budget).replace(/\n[^\n]*$/, '')
        const shownLines = body.split('\n').length
        note = `\n[lines ${from}-${from - 1 + shownLines} of ${lines.length} (cut to fit); read on with offset ${from + shownLines}]`
      }
      return body ? body + note : lines.length ? `[the file has ${lines.length} lines; offset ${from} is past the end]` : '[the file is empty]'
    }
    case 'write_file': {
      const p = resolveIn(w, s('path'))
      const content = typeof args.content === 'string' ? args.content : ''
      const r = await writeText(user, repo, p, content, signal)
      return JSON.stringify({ [r.created ? 'created' : 'replaced']: shown(w, p), lines: content.split('\n').length, bytes: Buffer.byteLength(content) })
    }
    case 'edit_file':
    case 'multi_edit': {
      const p = resolveIn(w, s('path'))
      const edits = name === 'edit_file' ? [args] : Array.isArray(args.edits) ? (args.edits as Record<string, unknown>[]) : []
      if (!edits.length) throw new Error('No edits given')
      let text = await readText(user, repo, p, signal)
      let total = 0
      edits.forEach((e, k) => {
        const from = typeof e.old_string === 'string' ? e.old_string : ''
        const to = typeof e.new_string === 'string' ? e.new_string : ''
        const which = edits.length > 1 ? `edit ${k + 1}: ` : ''
        if (!from) throw new Error(`${which}old_string is empty (to write a new file, use write_file)`)
        if (from === to) throw new Error(`${which}old_string and new_string are the same`)
        const n = text.split(from).length - 1
        if (!n) throw new Error(`${which}old_string was not found in ${shown(w, p)}. Read the file again and copy the text exactly, with its indentation.`)
        if (n > 1 && e.replace_all !== true) throw new Error(`${which}old_string appears ${n} times in ${shown(w, p)}: add surrounding lines to make it unique, or set replace_all`)
        text = e.replace_all === true ? text.split(from).join(to) : text.replace(from, () => to)
        total += e.replace_all === true ? n : 1
      })
      await writeText(user, repo, p, text, signal)
      return JSON.stringify({ edited: shown(w, p), replacements: total })
    }
    case 'list_dir': {
      const p = resolveIn(w, s('path') || '.')
      const { entries } = await listDir(user, repo, p)
      const sorted = [...entries].sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
      const lines = sorted.slice(0, 500).map((e) => (e.dir ? `${e.name}/` : `${e.name}  (${e.size} bytes)`))
      return `${shown(w, p)}:\n${lines.join('\n') || '(empty)'}${entries.length > 500 ? `\n[${entries.length - 500} more]` : ''}`
    }
    case 'glob': {
      const root = resolveIn(w, s('path') || '.')
      const re = globRegExp(s('pattern').replace(/^\.\//, ''))
      const rel = (p: string) => p.slice(root === '/' ? 1 : root.length + 1)
      const hits = (await walkFiles(user, repo, root)).filter((f) => re.test(rel(f.path)) || (!s('pattern').includes('/') && re.test(f.path.split('/').pop()!)))
      hits.sort((a, b) => b.mtime - a.mtime)
      if (!hits.length) return 'No files matched'
      return hits.slice(0, 200).map((f) => shown(w, f.path)).join('\n') + (hits.length > 200 ? `\n[${hits.length - 200} more; narrow the pattern]` : '')
    }
    case 'grep': {
      let re: RegExp
      try {
        re = new RegExp(s('pattern'), args.ignore_case === true ? 'i' : '')
      } catch (e) {
        throw new Error(`Bad regular expression: ${(e as Error).message}`)
      }
      const target = resolveIn(w, s('path') || '.')
      const entry = await entryAt(user, repo, target)
      if (!entry) throw new Error(`Nothing at ${s('path')}`)
      const only = s('glob') ? globRegExp(s('glob')) : null
      const files = entry.dir ? (await walkFiles(user, repo, target)).filter((f) => f.size <= 1024 * 1024 && isText(f.path) && (!only || only.test(f.path.split('/').pop()!) || only.test(shown(w, f.path)))) : [{ path: target, size: entry.size, mtime: entry.mtime }]
      const ctx = Math.min(10, Math.max(0, Math.floor(Number(args.context) || 0)))
      const out: string[] = []
      const matched: string[] = []
      let hits = 0
      let skipped = 0
      const queue = files.slice(0, 400)
      skipped = files.length - queue.length
      // A few files at a time from Seafile.
      for (let i = 0; i < queue.length && hits < 200; i += 8) {
        const batch = await Promise.all(queue.slice(i, i + 8).map((f) => readText(user, repo, f.path, signal).then((t) => [f.path, t] as const).catch(() => null)))
        for (const item of batch) {
          if (!item || hits >= 200) continue
          const [path, text] = item
          const lines = text.split('\n')
          const idx = lines.flatMap((l, n) => (re.test(l) ? [n] : []))
          if (!idx.length) continue
          matched.push(shown(w, path))
          if (args.files_only === true) continue
          const keep = new Set<number>()
          for (const n of idx) for (let k = Math.max(0, n - ctx); k <= Math.min(lines.length - 1, n + ctx); k++) keep.add(k)
          let prev = -2
          for (const n of [...keep].sort((a, b) => a - b)) {
            if (ctx && prev >= 0 && n > prev + 1) out.push('--')
            out.push(`${shown(w, path)}:${n + 1}${idx.includes(n) ? ':' : '-'}${lines[n].length > 400 ? `${lines[n].slice(0, 400)}…` : lines[n]}`)
            prev = n
          }
          hits += idx.length
        }
      }
      const tail = (hits >= 200 ? '\n[stopped at 200 matches; narrow the search]' : '') + (skipped ? `\n[${skipped} files not searched; give a path or glob]` : '')
      if (args.files_only === true) return matched.length ? matched.join('\n') + tail : 'No matches'
      return out.length ? out.join('\n') + tail : `No matches${tail}`
    }
    case 'make_dir': {
      const p = resolveIn(w, s('path'))
      await makeDirs(user, repo, p)
      return JSON.stringify({ made: shown(w, p) })
    }
    case 'move_path': {
      const from = resolveIn(w, s('from'))
      let to = resolveIn(w, s('to'))
      if (from === w.path) throw new Error('That is the work folder itself')
      const src = await entryAt(user, repo, from)
      if (!src) throw new Error(`Nothing at ${s('from')}`)
      const dest = await entryAt(user, repo, to)
      if (dest?.dir) to = `${to === '/' ? '' : to}/${src.name}`
      else if (dest) throw new Error(`${s('to')} exists already`)
      const [fromDir, fromName] = split(from)
      const [toDir, toName] = split(to)
      if (to.startsWith(`${from}/`)) throw new Error('A folder cannot go inside itself')
      if (fromDir !== toDir) {
        await makeDirs(user, repo, toDir)
        await transfer(user, { op: 'move', from: { repo, parent: fromDir }, names: [fromName], to: { repo, parent: toDir } })
      }
      if (fromName !== toName) await rename(user, { repo, path: `${toDir === '/' ? '' : toDir}/${fromName}`, dir: src.dir, name: toName })
      return JSON.stringify({ moved: shown(w, from), to: shown(w, to) })
    }
    case 'delete_path': {
      const p = resolveIn(w, s('path'))
      if (p === w.path) throw new Error('That is the work folder itself')
      if (!(await entryAt(user, repo, p))) throw new Error(`Nothing at ${s('path')}`)
      const [dir, base] = split(p)
      await removeItems(user, { repo, parent: dir, names: [base] })
      return JSON.stringify({ deleted: shown(w, p), note: "In the library's trash while it keeps history" })
    }
  }
  throw new Error(`There is no tool called ${name}`)
}

/** AGENTS.md (or CLAUDE.md) at the top of the work folder: the project's own instructions. */
export async function projectInstructions(user: User, w: Workdir, signal: AbortSignal): Promise<{ name: string; text: string } | null> {
  const { entries } = await listDir(user, w.repo, w.path).catch(() => ({ entries: [] as { name: string; dir: boolean }[] }))
  const name = ['AGENTS.md', 'CLAUDE.md', 'agents.md'].find((n) => entries.some((e) => e.name === n && !e.dir))
  if (!name) return null
  const text = await readText(user, w.repo, `${w.path === '/' ? '' : w.path}/${name}`, signal).catch(() => null)
  return text === null ? null : { name, text: text.slice(0, 40_000) }
}

// --- the terminal tool's command lines ----------------------------------------------------------

/** Commands that only look: a line made of these alone runs without asking. */
const READ_ONLY = new Set([
  'ls', 'll', 'cat', 'less', 'more', 'bat', 'head', 'tail', 'wc', 'grep', 'egrep', 'sort', 'uniq', 'tree', 'pwd', 'echo', 'printf', 'stat', 'du', 'df', 'file',
  'which', 'type', 'whoami', 'id', 'date', 'cal', 'uname', 'uptime', 'hostname', 'env', 'man', 'help', 'jq', 'sha256sum', 'sha1sum', 'sha512sum', 'md5sum', 'base64',
  'seq', 'basename', 'dirname', 'test', '[', 'true', 'false', ':', 'cd', 'find', 'fd', 'calc', 'nproc', 'free', 'ps', 'diff', 'read', 'set', 'export', 'local',
  'sleep', 'dig', 'host', 'nslookup', 'whois', 'findmnt', 'lsblk', 'tty', 'history', 'fastfetch', 'fortune', 'cowsay', 'figlet',
])
/** Arguments that make a looking command change something. */
const WRITING_ARGS: Record<string, RegExp> = { find: /^-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls)$/, fd: /^(-x|-X|--exec|--exec-batch)$/ }

/** Whether a command line only reads (so it can run without the user allowing it). */
export function readOnlyCommand(line: string): boolean {
  if (/[`]|\$\(/.test(line)) return false
  let tree
  try {
    tree = parse(line)
  } catch {
    return false
  }
  const cmds = commandWords(tree)
  return cmds.every((c) => {
    if (c.name === 'function') return false
    if (c.name && (!READ_ONLY.has(c.name) || /[$*?[]/.test(c.name))) return false
    if (c.name && WRITING_ARGS[c.name] && c.args.some((a) => WRITING_ARGS[c.name].test(a))) return false
    return c.redirs.every((r) => r.op === '<' || r.op === '<<' || r.op === '<<-' || ((r.op === '>&' || r.op === '<&') && /^[0-9-]$/.test(r.target)) || r.target === '/dev/null')
  })
}

/** The command names in a line, for "don't ask again for these". */
export function commandNames(line: string): string[] {
  try {
    return [...new Set(commandWords(parse(line)).map((c) => c.name).filter((n) => n && n !== 'function' && !/[$*?[]/.test(n)))]
  } catch {
    return []
  }
}
