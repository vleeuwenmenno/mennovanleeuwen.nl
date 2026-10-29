import { Worker } from 'node:worker_threads'
import type { User } from './auth.ts'
import { guardedFetch } from './egress.ts'
import { HttpError } from './http.ts'
import { fileLink, listDir, mkdir, removeItems, rename, seafile, transfer } from './seafile.ts'
import { commandWords, parse } from '../src/terminal/msh/parse.ts'
import { STEERING } from '../src/data/steering.ts'

// A thread's work folder: a Seafile folder the agent works in, like a coding agent's checkout.
// The file tools here are Claude Code's (read, write, edit, list, glob, grep), with every path
// kept inside the folder. They run on the server, so a turn goes on when the terminal closes.
// The terminal tool's command lines are read here too, to tell the ones that only look from the
// ones that change something.

export type Workdir = { repo: string; path: string; label: string }
/**
 * How a thread's tool calls are allowed (server/agents.ts decide): `default` asks for each change
 * and for web addresses the agent built itself; `auto` is the same, except that such addresses are
 * checked automatically first; `acceptEdits` also lets file edits in the work folder through;
 * `plan` only reads; `bypass` runs everything except the lasting changes (calendar writes and the
 * files that steer the agent).
 */
export type Permission = 'default' | 'auto' | 'acceptEdits' | 'plan' | 'bypass'
export const PERMISSIONS: readonly Permission[] = ['default', 'auto', 'acceptEdits', 'plan', 'bypass']

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
    "Run a command line in msh, the MvL OS shell (a POSIX-like shell: pipes, redirects, if/for/while/case, functions, $(…), heredocs), the same interpreter as the user's terminal. Every call starts a fresh shell in the work folder (or `cwd`, a folder inside it): files you write stay, variables, functions, aliases and `cd` do not carry over to the next call. It answers JSON: exit_code, stdout and stderr apart, duration_ms, truncated (characters dropped from each stream) and terminated (null, or timeout, cancelled, steps, output or memory when the run was cut short). The commands are MvL OS's own (ls, cat, grep, find, head, jq, curl, …), not a Linux box: there is no git, python, node or package manager, and only the options a command's usage names exist; call terminal_capabilities for the exact list. Files can be read and written only inside the work folder; deleting, the network and the files that steer you (AGENTS.md, CLAUDE.md, .agents/, .claude/) need the user's approval of a command that names them. Read-only commands run straight away; a script you wrote runs with `msh script.sh` (check it first with `msh -n script.sh`); anything that changes something may wait for the user.",
    {
      command: str('The command line'),
      description: str('What it does, in a few words, for the user'),
      cwd: str('A folder inside the work folder to run in (default: the work folder itself)'),
      timeout_seconds: { type: 'number', description: 'Stop the run after this many seconds (default 60, at most 180)' },
    },
    ['command'],
  )
}

/** What the terminal can do in this session, as data: asked before guessing at commands or flags. */
export function terminalCapabilitiesTool(): ToolDef {
  return tool(
    'terminal_capabilities',
    "What the terminal tool can actually do in this session, as JSON: the shell and its version and syntax, every command with the options its usage names (no others exist), which commands this call may run, the mounts and where you may read and write (the work folder only), the available integrations, and the execution limits (time, steps, output). Call it before writing a script that depends on a command or an option, instead of assuming Linux flags. With `command`, one command's entry in full (usage and manual).",
    { command: str('One command or builtin, for its usage and manual (default: the overview of everything)') },
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

export async function readText(user: User, repo: string, path: string, signal: AbortSignal): Promise<string> {
  const { url } = await fileLink(user, repo, path, 'download')
  const res = await guardedFetch(user, url, { signal })
  if (res.status === 404) throw new Error(`No file at that path`)
  if (!res.ok) throw new Error(`Seafile answered ${res.status}`)
  const bytes = await readBody(res, 4 * 1024 * 1024, 'That file is too big to read here (over 4 MB)')
  if (bytes.subarray(0, 8000).includes(0)) throw new Error('That is not a text file')
  return bytes.toString('utf8')
}

/** A response body, read only up to `max` bytes (whatever Content-Length says); more is an error. */
export async function readBody(res: Response, max: number, tooBig: string): Promise<Buffer> {
  if (Number(res.headers.get('content-length')) > max) {
    await res.body?.cancel().catch(() => {})
    throw new Error(tooBig)
  }
  if (!res.body) return Buffer.alloc(0)
  const chunks: Uint8Array[] = []
  let size = 0
  const reader = res.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > max) {
      await reader.cancel().catch(() => {})
      throw new Error(tooBig)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

/** Makes a folder and the ones above it that are missing. */
export async function makeDirs(user: User, repo: string, path: string) {
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
  return uploadFile(user, repo, path, content, signal)
}

/** Writes a file through Seafile's file server (its folders made first), replacing what is there. */
export async function uploadFile(user: User, repo: string, path: string, data: string | Uint8Array, signal: AbortSignal) {
  const [dir, name] = split(path)
  const existing = await entryAt(user, repo, path)
  if (existing?.dir) throw new Error('There is a folder with that name')
  if (!existing) await makeDirs(user, repo, dir)
  const { url } = await fileLink(user, repo, dir, 'upload')
  const form = new FormData()
  form.append('parent_dir', dir)
  form.append('replace', existing ? '1' : '0')
  form.append('file', new Blob([typeof data === 'string' ? data : new Uint8Array(data)], { type: typeof data === 'string' ? 'text/plain' : 'application/octet-stream' }), name)
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

/** Brace alternatives expanded: a/{b,c}.md → a/b.md, a/c.md (at most 32). */
function braces(glob: string): string[] {
  const m = /\{([^{}]*)\}/.exec(glob)
  if (!m) return [glob]
  const out = m[1].split(',').flatMap((alt) => braces(glob.slice(0, m.index) + alt + glob.slice(m.index + m[0].length)))
  if (out.length > 32) throw new Error('That pattern has too many {…} choices')
  return out
}

type GlobToken = { k: 'lit'; c: string } | { k: 'any' } | { k: 'star' } | { k: 'globstar' } | { k: 'globdir' } | { k: 'set'; neg: boolean; test: (c: string) => boolean }

function tokens(glob: string): GlobToken[] {
  const out: GlobToken[] = []
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]
    if (ch === '*') {
      let n = 1
      while (glob[i + 1] === '*') (i++, n++)
      if (n >= 2 && glob[i + 1] === '/') {
        i++
        out.push({ k: 'globdir' })
      } else out.push({ k: n >= 2 ? 'globstar' : 'star' })
    } else if (ch === '?') out.push({ k: 'any' })
    else if (ch === '[' && glob.indexOf(']', i + 2) > 0) {
      const end = glob.indexOf(']', i + 2)
      let body = glob.slice(i + 1, end)
      const neg = body[0] === '!' || body[0] === '^'
      if (neg) body = body.slice(1)
      const ranges: [string, string][] = []
      for (let k = 0; k < body.length; k++) {
        if (body[k + 1] === '-' && k + 2 < body.length) (ranges.push([body[k], body[k + 2]]), (k += 2))
        else ranges.push([body[k], body[k]])
      }
      out.push({ k: 'set', neg, test: (c) => ranges.some(([a, b]) => c >= a && c <= b) !== neg })
      i = end
    } else out.push({ k: 'lit', c: ch === '\\' && i + 1 < glob.length ? glob[++i] : ch })
  }
  return out
}

/**
 * Matches a path against a glob (** crosses folders, {a,b} picks one) without regular
 * expressions: a table over pattern and path, so no pattern can make it take long.
 */
export function globMatcher(glob: string): { test: (path: string) => boolean } {
  if (glob.length > 300) throw new Error('That pattern is too long')
  const patterns = braces(glob).map(tokens)
  const one = (t: GlobToken[], str: string) => {
    const s = [...str]
    const n = s.length
    let next = new Array<boolean>(n + 1).fill(false)
    next[n] = true
    for (let i = t.length - 1; i >= 0; i--) {
      const tok = t[i]
      const cur = new Array<boolean>(n + 1).fill(false)
      let later = false // globdir: some '/' at or after j with next[k+1]
      for (let j = n; j >= 0; j--) {
        if (tok.k === 'star') cur[j] = next[j] || (j < n && s[j] !== '/' && cur[j + 1])
        else if (tok.k === 'globstar') cur[j] = next[j] || (j < n && cur[j + 1])
        else if (tok.k === 'globdir') {
          if (j < n && s[j] === '/' && next[j + 1]) later = true
          cur[j] = next[j] || later
        } else if (j < n) cur[j] = next[j + 1] && (tok.k === 'any' ? s[j] !== '/' : tok.k === 'lit' ? s[j] === tok.c : tok.test(s[j]))
      }
      next = cur
    }
    return next[0]
  }
  return { test: (path) => path.length <= 2048 && patterns.some((t) => one(t, path)) }
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
      const re = globMatcher(s('pattern').replace(/^\.\//, ''))
      const rel = (p: string) => p.slice(root === '/' ? 1 : root.length + 1)
      const hits = (await walkFiles(user, repo, root)).filter((f) => re.test(rel(f.path)) || (!s('pattern').includes('/') && re.test(f.path.split('/').pop()!)))
      hits.sort((a, b) => b.mtime - a.mtime)
      if (!hits.length) return 'No files matched'
      return hits.slice(0, 200).map((f) => shown(w, f.path)).join('\n') + (hits.length > 200 ? `\n[${hits.length - 200} more; narrow the pattern]` : '')
    }
    case 'grep': {
      const flags = args.ignore_case === true ? 'i' : ''
      if (s('pattern').length > 1000) throw new Error('That pattern is too long')
      try {
        new RegExp(s('pattern'), flags)
      } catch (e) {
        throw new Error(`Bad regular expression: ${(e as Error).message}`)
      }
      const target = resolveIn(w, s('path') || '.')
      const entry = await entryAt(user, repo, target)
      if (!entry) throw new Error(`Nothing at ${s('path')}`)
      const only = s('glob') ? globMatcher(s('glob')) : null
      const files = entry.dir ? (await walkFiles(user, repo, target)).filter((f) => f.size <= 1024 * 1024 && isText(f.path) && (!only || only.test(f.path.split('/').pop()!) || only.test(shown(w, f.path)))) : [{ path: target, size: entry.size, mtime: entry.mtime }]
      const ctx = Math.min(10, Math.max(0, Math.floor(Number(args.context) || 0)))
      const out: string[] = []
      const matched: string[] = []
      let hits = 0
      let skipped = 0
      const queue = files.slice(0, 400)
      skipped = files.length - queue.length
      // The texts, a few at a time from Seafile (32 MB at most together), then matched in a worker.
      const texts: (readonly [string, string])[] = []
      let bytes = 0
      for (let i = 0; i < queue.length && bytes < 32 * 1024 * 1024; i += 8) {
        const batch = await Promise.all(queue.slice(i, i + 8).map((f) => readText(user, repo, f.path, signal).then((t) => [f.path, t] as const).catch(() => null)))
        for (const item of batch) if (item && bytes < 32 * 1024 * 1024) (texts.push(item), (bytes += item[1].length))
      }
      skipped += queue.length - texts.length
      const found = await matchLines(s('pattern'), flags, texts.map(([, t]) => t), 200)
      {
        for (let f = 0; f < texts.length; f++) {
          if (hits >= 200) break
          const [path, text] = texts[f]
          const lines = text.split('\n')
          const idx = found[f]
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

// A pattern from the model can take exponential time (ReDoS), so lines are matched in a worker
// that is stopped after a few seconds: the server's own thread never runs it.
const MATCHER = `const { parentPort, workerData } = require('node:worker_threads')
const re = new RegExp(workerData.pattern, workerData.flags)
let total = 0
parentPort.postMessage(workerData.texts.map((text) => {
  const idx = []
  const lines = text.split('\\n')
  for (let n = 0; n < lines.length && total < workerData.max; n++) if (re.test(lines[n])) (idx.push(n), total++)
  return idx
}))`

/** For each text, the lines (0-based) that match; fails when the pattern takes too long. */
function matchLines(pattern: string, flags: string, texts: string[], max: number): Promise<number[][]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(MATCHER, { eval: true, workerData: { pattern, flags, texts, max }, resourceLimits: { maxOldGenerationSizeMb: 256 } })
    const timer = setTimeout(() => {
      void worker.terminate()
      reject(new Error('That pattern took too long (over 3 s): make it simpler'))
    }, 3000)
    worker.once('message', (m: number[][]) => {
      clearTimeout(timer)
      void worker.terminate()
      resolve(m)
    })
    worker.once('error', (e: Error) => {
      clearTimeout(timer)
      reject(new Error(`grep failed: ${e.message}`))
    })
  })
}

/** Files that steer the agent itself: writing them always asks, even with edits allowed. */
export { STEERING }

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
  'seq', 'basename', 'dirname', 'test', '[', 'true', 'false', ':', 'cd', 'calc', 'nproc', 'free', 'ps', 'diff', 'read', 'set', 'export', 'local',
  'sleep', 'findmnt', 'lsblk', 'tty', 'history', 'fastfetch', 'fortune', 'cowsay', 'figlet',
])
// Not here on purpose: find and fd (-delete, -exec, fd -x in ways a word check misses), and dig,
// host, nslookup and whois (a lookup can carry data out, past web_fetch's guard).

/** `msh -n file` (also sh, bash): parses and runs nothing, so it only reads. */
function checksSyntax(c: { name: string; args: string[] }): boolean {
  if (!['msh', 'sh', 'bash'].includes(c.name)) return false
  const flags = c.args.filter((a) => a.startsWith('-'))
  return flags.length > 0 && flags.every((a) => /^-[nxe]+$/.test(a)) && flags.some((a) => a.includes('n')) && !c.args.includes('-c')
}

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
    if (c.name && !checksSyntax(c) && (!READ_ONLY.has(c.name) || /[$*?[]/.test(c.name))) return false
    // Words that expand or are quoted could say anything once the shell is done with them.
    if (c.args.some((a) => /[$`'"\\]/.test(a))) return false
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

// --- what a terminal call may do -----------------------------------------------------------------

/**
 * What the terminal runs a call under (src/terminal/policy.ts enforces it where the shell resolves
 * each command, redirect and file write): writes stay inside the work folder, and the rest is only
 * granted by what the user approved.
 */
export type ClientGrant = { mode: string; write: boolean; delete: boolean; network: boolean; steering: boolean }
/**
 * How the call got to run: `readonly` (a line that only looks, in any mode), `edits` (edits accepted:
 * files in the work folder), `bypass`, or `approved` (the user allowed this line, or its commands).
 */
export type TerminalAccess = 'readonly' | 'edits' | 'bypass' | 'approved'

export const DELETE_COMMANDS: ReadonlySet<string> = new Set(['rm', 'rmdir'])
export const NETWORK_COMMANDS: ReadonlySet<string> = new Set(['curl', 'wget', 'ping', 'dig', 'host', 'nslookup', 'whois', 'minecraft', 'pepper'])
/** A command line that names a file steering the agent: such a call always asks, and only then may it write one. */
export const STEERING_IN_LINE = /(AGENTS\.md|CLAUDE\.md|\.agents|\.claude)\b/i

/**
 * The grant for a call. Nothing is implied by anything else: the text of an approved line decides
 * the extras, because the user saw that text. A script the line runs gets what the line names, no more
 * (`msh x.sh` does not give x.sh the right to rm; `rm x` does).
 */
export function terminalGrant(permission: Permission, line: string, access: TerminalAccess): ClientGrant {
  const names = commandNames(line)
  const has = (set: ReadonlySet<string>) => names.some((n) => set.has(n))
  switch (access) {
    case 'readonly':
      return { mode: permission, write: false, delete: false, network: false, steering: false }
    case 'edits':
      return { mode: permission, write: true, delete: false, network: false, steering: false }
    case 'bypass':
      return { mode: permission, write: true, delete: true, network: true, steering: false }
    case 'approved':
      return { mode: permission, write: true, delete: has(DELETE_COMMANDS), network: has(NETWORK_COMMANDS), steering: STEERING_IN_LINE.test(line) }
  }
}
