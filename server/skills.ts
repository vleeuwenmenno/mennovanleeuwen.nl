import { gunzipSync } from 'node:zlib'
import type { User } from './auth.ts'
import { guardedFetch } from './egress.ts'
import { HttpError } from './http.ts'
import { listDir, removeItems } from './seafile.ts'
import { readText, uploadFile, type Workdir } from './workdir.ts'
import { readTar } from '../src/data/tar.ts'
import { MSH_REFERENCE } from '../src/data/mshReference.ts'

// Skills for the agents, in the format Claude Code and Codex use: a folder with a SKILL.md (YAML
// front matter with a name and a description, then the instructions) and any files it needs. The
// model sees each skill's name and description, and reads one in full with use_skill when a task
// calls for it. They live where they would on a PC: ~/.agents/skills (the user's, in Seafile, the
// folder the terminal maps there) and .agents/skills or .claude/skills in a work folder. A few come
// built in. `skills add owner/repo` installs from GitHub.

export type SkillSource = 'builtin' | 'user' | 'project'
export type Folder = { repo: string; path: string; label: string }
export type Skill = {
  name: string
  description: string
  source: SkillSource
  /** Where it is in Seafile (null for a built-in one), and how the terminal shows that */
  folder: { repo: string; path: string } | null
  label: string
  /** disable-model-invocation: only the user starts it, with /name */
  userOnly: boolean
  enabled: boolean
}
type Loaded = Omit<Skill, 'enabled'> & { body: string }

const NAME = /^[A-Za-z0-9][\w.-]{0,63}$/

/** SKILL.md's front matter (simple YAML: key: value, quoted or folded) and the text after it. */
export function parseSkill(text: string): { meta: Record<string, string>; body: string } {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(text)
  if (!m) return { meta: {}, body: text }
  const meta: Record<string, string> = {}
  const lines = m[1].split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(lines[i])
    if (!kv) continue
    let value = kv[2].trim()
    if (value === '|' || value === '>' || value === '|-' || value === '>-') {
      const block: string[] = []
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || !lines[i + 1].trim())) block.push(lines[++i].trim())
      value = block.join(value.startsWith('|') ? '\n' : ' ').trim()
    } else if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1).replace(/\\"/g, '"')
    meta[kv[1].toLowerCase()] = value
  }
  return { meta, body: m[2] }
}

const describe = (meta: Record<string, string>, body: string) =>
  (meta.description || body.split('\n').find((l) => l.trim() && !l.startsWith('#')) || '').replace(/\s+/g, ' ').trim().slice(0, 1024)

const BUILTIN: Loaded[] = [
  {
    name: 'msh',
    description: "The MvL OS shell: its syntax (POSIX sh with a few bash extras) and how it differs from bash. Read it before writing scripts or longer command lines for the terminal tool.",
    source: 'builtin',
    folder: null,
    label: '(built in)',
    userOnly: false,
    body: MSH_REFERENCE,
  },
  {
    name: 'skill-creator',
    description: 'How to write a skill for these agents (a folder with a SKILL.md): read it when the user asks to make, change or package a skill.',
    source: 'builtin',
    folder: null,
    label: '(built in)',
    userOnly: false,
    body: `# Writing a skill

A skill is a folder with a SKILL.md file and anything it needs (reference texts, templates, msh
scripts). The agents see every skill's name and description, and read the whole SKILL.md with
use_skill when a task matches the description. So the description decides when it is used: say
what the skill does and when to use it, in one or two sentences.

## Where skills live

- ~/.agents/skills/<name>/ for the user's own skills (in their Seafile)
- <work folder>/.agents/skills/<name>/ (or .claude/skills) for a project's skills
- \`skills new <name>\` in the terminal makes the folder and a SKILL.md to fill in;
  \`skills add owner/repo\` installs skills from GitHub; \`skills ls\` lists them.

## SKILL.md

    ---
    name: release-notes
    description: Write release notes from a list of changes, in the house style. Use when asked for release notes or a changelog.
    ---

    # Release notes

    Steps, rules and examples, in Markdown. Refer to other files in the folder by relative
    path (templates/notes.md); the agent reads them with read_skill_file.

Front matter keys: name (letters, digits, - and _), description, and optionally
disable-model-invocation: true (only the user starts it, by typing /name).

## Scripts

msh scripts (#!/bin/msh, or .sh files) in the skill's folder can be run with the terminal tool.
Python, Node and other interpreters do not exist in MvL OS: write such logic as instructions, or
as msh.

## Writing one for the user

Ask what the skill is for and when it should be used, then write the folder with the file tools
(when the work folder holds it) or the terminal (skills new, then edit). Keep SKILL.md short and
concrete: steps, rules, an example. Put long references in separate files.
`,
  },
]

// --- reading skill folders ------------------------------------------------------------------------

const cache = new Map<string, { at: number; value: Promise<Loaded[]> }>()
const TTL = 60_000
/** Forgets what was read from a folder (after an install or a removal). */
export const forgetFolder = (repo: string, path: string) => cache.delete(`${repo}:${path}`)

/** The skills in one folder of skill folders. */
function folderSkills(user: User, folder: Folder, source: SkillSource): Promise<Loaded[]> {
  const key = `${folder.repo}:${folder.path}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL) return hit.value
  const value = (async () => {
    const listing = await listDir(user, folder.repo, folder.path).catch(() => null)
    const dirs = (listing?.entries ?? []).filter((e) => e.dir && !e.name.startsWith('.')).slice(0, 60)
    const found = await Promise.all(
      dirs.map(async (d): Promise<Loaded | null> => {
        const path = `${folder.path === '/' ? '' : folder.path}/${d.name}`
        const text = await readText(user, folder.repo, `${path}/SKILL.md`, AbortSignal.timeout(15_000)).catch(() => null)
        if (text === null) return null
        const { meta, body } = parseSkill(text.slice(0, 256 * 1024))
        const name = NAME.test(meta.name ?? '') ? meta.name : d.name
        return { name, description: describe(meta, body), source, folder: { repo: folder.repo, path }, label: `${folder.label}/${d.name}`, userOnly: meta['disable-model-invocation'] === 'true', body }
      }),
    )
    return found.filter((x): x is Loaded => !!x)
  })()
  const entry = { at: Date.now(), value }
  cache.set(key, entry)
  value.catch(() => cache.delete(key))
  return value
}

/** Where skills are for a thread: its work folder's, then the user's, then the built-in ones. */
export type SkillPlaces = { user: Folder | null; workdir: Workdir | null; off: string[]; /** Read the folders again now (the skills command, after a change) */ fresh?: boolean }

async function loadAll(user: User, places: SkillPlaces): Promise<Loaded[]> {
  const lists: Loaded[][] = []
  if (places.fresh) {
    if (places.user) forgetFolder(places.user.repo, places.user.path)
    if (places.workdir) for (const sub of ['.agents/skills', '.claude/skills']) forgetFolder(places.workdir.repo, `${places.workdir.path === '/' ? '' : places.workdir.path}/${sub}`)
  }
  if (places.workdir) {
    const base = places.workdir.path === '/' ? '' : places.workdir.path
    for (const sub of ['.agents/skills', '.claude/skills'])
      lists.push(await folderSkills(user, { repo: places.workdir.repo, path: `${base}/${sub}`, label: `${places.workdir.label}/${sub}` }, 'project').catch(() => []))
  }
  if (places.user) lists.push(await folderSkills(user, places.user, 'user').catch(() => []))
  lists.push(BUILTIN)
  // The nearest one wins when two share a name.
  const seen = new Set<string>()
  return lists.flat().filter((s) => !seen.has(s.name) && seen.add(s.name))
}

export async function listSkills(user: User, places: SkillPlaces): Promise<Skill[]> {
  return (await loadAll(user, places)).map(({ body: _b, ...s }) => ({ ...s, enabled: !places.off.includes(s.name) }))
}

/** One skill with its instructions, by name (null when there is none). */
export async function findSkill(user: User, places: SkillPlaces, name: string): Promise<(Skill & { body: string }) | null> {
  const s = (await loadAll(user, places)).find((x) => x.name === name)
  return s ? { ...s, enabled: !places.off.includes(s.name) } : null
}

/** The files in a skill's folder, relative to it (a few levels deep, at most 200). */
export async function skillFiles(user: User, s: { folder: { repo: string; path: string } | null }): Promise<string[]> {
  if (!s.folder) return []
  const out: string[] = []
  const queue: string[] = ['']
  while (queue.length && out.length < 200) {
    const rel = queue.shift()!
    const listing = await listDir(user, s.folder.repo, `${s.folder.path}${rel}`).catch(() => null)
    for (const e of listing?.entries ?? []) {
      const p = `${rel}/${e.name}`
      if (e.dir) {
        if (p.split('/').length < 5) queue.push(p)
      } else out.push(p.slice(1))
    }
  }
  return out.sort()
}

/** A file in a skill's folder; nothing outside it. */
export async function readSkillFile(user: User, s: { folder: { repo: string; path: string } | null; body: string }, path: string): Promise<string> {
  const rel = path.replace(/^\.?\/+/, '')
  if (!s.folder) {
    if (rel === 'SKILL.md') return s.body
    throw new Error('A built-in skill has no other files')
  }
  if (!rel || rel.split('/').includes('..')) throw new Error('That path is outside the skill')
  return readText(user, s.folder.repo, `${s.folder.path}/${rel}`, AbortSignal.timeout(20_000))
}

// --- installing from GitHub -----------------------------------------------------------------------

/** owner/repo, owner/repo/path, owner/repo@ref, or a github.com address (…/tree/ref/path). */
export function parseSource(raw: string): { owner: string; repo: string; ref: string | null; path: string } {
  const s = raw.trim().replace(/^git@github\.com:/, 'https://github.com/').replace(/\.git$/, '')
  let m = /^(?:https?:\/\/)?github\.com\/([\w.-]+)\/([\w.-]+)(?:\/(?:tree|blob)\/([^/]+)(?:\/(.*))?)?\/?$/.exec(s)
  if (m) return { owner: m[1], repo: m[2], ref: m[3] ?? null, path: (m[4] ?? '').replace(/\/?SKILL\.md$/, '').replace(/\/$/, '') }
  m = /^([\w.-]+)\/([\w.-]+)((?:\/[^@\s]+)*)(?:@([\w./-]+))?$/.exec(s)
  if (m) return { owner: m[1], repo: m[2], ref: m[4] ?? null, path: m[3].replace(/^\//, '').replace(/\/?SKILL\.md$/, '') }
  throw new HttpError(400, 'Say which skills: owner/repo, owner/repo/path/to/skill, or a github.com address')
}

const MAX_DOWNLOAD = 25 * 1024 * 1024
const MAX_FILES = 500
const MAX_BYTES = 8 * 1024 * 1024

/** Installs the skills in a GitHub repository (or one folder of it) into a skills folder. */
export async function installSkills(user: User, target: Folder, body: { source?: unknown; skill?: unknown; force?: unknown }): Promise<{ installed: { name: string; files: number; label: string }[]; from: string }> {
  const src = parseSource(String(body.source ?? ''))
  const ref = src.ref ?? 'HEAD'
  const from = `github.com/${src.owner}/${src.repo}${src.path ? `/${src.path}` : ''}${src.ref ? `@${src.ref}` : ''}`
  const res = await guardedFetch(user, `https://codeload.github.com/${src.owner}/${src.repo}/tar.gz/${encodeURIComponent(ref)}`, { signal: AbortSignal.timeout(60_000) })
  if (res.status === 404) throw new HttpError(404, `GitHub has no ${src.owner}/${src.repo}${src.ref ? ` at ${src.ref}` : ''} (or it is private)`)
  if (!res.ok) throw new HttpError(502, `GitHub answered ${res.status}`)
  if (Number(res.headers.get('content-length')) > MAX_DOWNLOAD) throw new HttpError(413, 'That repository is too big to install skills from (over 25 MB)')
  const gz = Buffer.from(await res.arrayBuffer())
  if (gz.length > MAX_DOWNLOAD) throw new HttpError(413, 'That repository is too big to install skills from (over 25 MB)')
  let tar: Buffer
  try {
    tar = gunzipSync(gz, { maxOutputLength: 200 * 1024 * 1024 })
  } catch {
    throw new HttpError(502, 'GitHub sent something that is not a gzipped tar')
  }
  const index = await readTar(async (a, b) => new Uint8Array(tar.subarray(a, b + 1)), tar.length, 50_000)
  // codeload puts everything in one top folder (repo-ref/).
  const strip = (p: string) => p.split('/').slice(1).join('/')
  const files = index.entries.filter((e) => !e.dir && !e.link).map((e) => ({ path: strip(e.path), offset: e.offset, size: e.size })).filter((e) => e.path)
  const want = src.path.replace(/\/$/, '')
  let dirs = files
    .filter((f) => f.path === 'SKILL.md' || f.path.endsWith('/SKILL.md'))
    .map((f) => f.path.slice(0, -'SKILL.md'.length).replace(/\/$/, ''))
    .filter((d) => !want || d === want || d.startsWith(`${want}/`))
  if (typeof body.skill === 'string' && body.skill) dirs = dirs.filter((d) => (d.split('/').pop() || src.repo) === body.skill)
  // A skill folder inside another skill's folder is part of that one.
  dirs = dirs.filter((d) => !dirs.some((o) => o !== d && (o === '' || d.startsWith(`${o}/`))))
  if (!dirs.length) throw new HttpError(404, `No SKILL.md in ${from}${typeof body.skill === 'string' && body.skill ? ` for ${body.skill}` : ''}`)
  if (dirs.length > 50) throw new HttpError(413, `${from} has ${dirs.length} skills: pick some with a path or --skill`)
  const existing = new Set(((await listDir(user, target.repo, target.path).catch(() => null))?.entries ?? []).map((e) => e.name))
  const plan = dirs.map((d) => {
    const inside = files.filter((f) => (d ? f.path.startsWith(`${d}/`) : true))
    const skillMd = inside.find((f) => f.path === (d ? `${d}/SKILL.md` : 'SKILL.md'))!
    const { meta } = parseSkill(tar.subarray(skillMd.offset, skillMd.offset + Math.min(skillMd.size, 64 * 1024)).toString('utf8'))
    const folderName = d.split('/').pop() || src.repo
    const name = NAME.test(meta.name ?? '') ? meta.name : folderName.replace(/[^\w.-]/g, '-')
    if (!NAME.test(name)) throw new HttpError(400, `${folderName} is not a usable skill name`)
    return { name, files: inside.map((f) => ({ rel: d ? f.path.slice(d.length + 1) : f.path, offset: f.offset, size: f.size })) }
  })
  const count = plan.reduce((n, p) => n + p.files.length, 0)
  const bytes = plan.reduce((n, p) => n + p.files.reduce((m, f) => m + f.size, 0), 0)
  if (count > MAX_FILES) throw new HttpError(413, `That is ${count} files; ${MAX_FILES} at most`)
  if (bytes > MAX_BYTES) throw new HttpError(413, 'Those skills are too big together (over 8 MB)')
  const clash = plan.filter((p) => existing.has(p.name)).map((p) => p.name)
  if (clash.length && body.force !== true) throw new HttpError(409, `Installed already: ${clash.join(', ')} (add --force to replace)`)
  const base = target.path === '/' ? '' : target.path
  for (const name of clash) await removeItems(user, { repo: target.repo, parent: target.path, names: [name] })
  for (const p of plan) {
    for (const f of p.files) {
      if (f.rel.split('/').includes('..')) continue
      await uploadFile(user, target.repo, `${base}/${p.name}/${f.rel}`, new Uint8Array(tar.subarray(f.offset, f.offset + f.size)), AbortSignal.timeout(60_000))
    }
  }
  forgetFolder(target.repo, target.path)
  return { installed: plan.map((p) => ({ name: p.name, files: p.files.length, label: `${target.label}/${p.name}` })), from }
}

/** Removes a skill's folder from a skills folder. */
export async function removeSkill(user: User, target: Folder, name: string) {
  const skills = await folderSkills(user, target, 'user')
  const s = skills.find((x) => x.name === name)
  if (!s?.folder) throw new HttpError(404, `No skill called ${name} in ${target.label}`)
  await removeItems(user, { repo: target.repo, parent: target.path, names: [s.folder.path.split('/').pop()!] })
  forgetFolder(target.repo, target.path)
}

/** A skills folder from a request: {repo, path, label}. */
export function folderOf(v: unknown): Folder | null {
  if (!v || typeof v !== 'object') return null
  const f = v as Partial<Folder>
  if (typeof f.repo !== 'string' || !/^[0-9a-f-]{36}$/i.test(f.repo)) return null
  if (typeof f.path !== 'string' || !f.path.startsWith('/') || f.path.split('/').includes('..')) return null
  return { repo: f.repo, path: f.path.replace(/(.)\/+$/, '$1'), label: typeof f.label === 'string' && f.label ? f.label.slice(0, 300) : f.path }
}
