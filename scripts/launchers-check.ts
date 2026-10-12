// Checks launchers as .desktop files and drag and drop's file moves, headless:
//
//   1. The desktop entry format (src/data/desktopEntry.ts): files with comments, localised keys,
//      other groups and keys MvL OS does not know come back byte for byte, a change touches only
//      its own line, escapes round-trip, and broken files are refused with the line that is wrong.
//      Then launchers from and to that text (src/data/launcherFiles.ts): links, app launchers,
//      icons, and addresses that are not http(s) refused.
//   2. Moving the old launcher list into files (migrateLaunchers): into a home kept in a browser
//      (two "devices", each with a store of its own) and into Seafile shared by two devices, run
//      at the same moment and again later. Every launcher lands once, keeps its id, and one
//      deleted since does not come back.
//   3. Without Seafile, the launcher folders' files are the synced launcher list
//      (src/data/launcherStore.ts): two devices, syncing through the real server's /api/state, see
//      the same files after one adds, renames, moves (between the folders, out of them and back
//      in) and deletes.
//   4. Moving and copying with names that meet (src/data/transferPlan.ts): replace, keep both,
//      skip, cancel, a copy next to itself, undo, within the browser's store, within Seafile, and
//      between the two.
//
// Seafile is scripts/mock-seafile.ts behind the real server (server/index.ts on a free port with
// a scratch DATA_DIR, a signed-in admin and the stand-in linked), reached through the same
// /api/seafile routes the Files app uses. The browser's store is a stand-in with browserfs.ts's
// rules (a name that is taken is refused, folders must exist). No real accounts.
//
//   node scripts/launchers-check.ts
//
// Exits 1 on any failure.

import { randomBytes } from 'node:crypto'
import { Server, check, finish } from './empires-harness.ts'
import { MY_LIBRARY, PHOTOS, putFile, startMockSeafile } from './mock-seafile.ts'
import { DesktopEntryError, formatDesktopFile, getLocalized, getValue, parseDesktopFile, setValue, escapeValue, unescapeValue } from '../src/data/desktopEntry.ts'
import { MIGRATED, idInText, launcherFileName, launcherFromText, launcherText, migrateLaunchers, readLaunchers, type Launcher, type LauncherPort } from '../src/data/launcherFiles.ts'
import { transferInto, undoMove, type Clash, type TransferPort } from '../src/data/transferPlan.ts'
import { virtualLaunchers, type StoredLauncher } from '../src/data/launcherStore.ts'

const throwsAt = (text: string, line: RegExp) => {
  try {
    parseDesktopFile(text)
    return false
  } catch (e) {
    return e instanceof DesktopEntryError && line.test(e.message)
  }
}

// --- 1. the format ------------------------------------------------------------------------------

const SAMPLE = [
  '# Made by hand',
  '',
  '[Desktop Entry]',
  'Version=1.5',
  'Type=Link',
  'Name=Docs',
  'Name[nl]=Documentatie',
  'Name[de_DE]=Dokumente',
  'Comment=Read the docs\\nor else',
  'URL = https://example.com/docs',
  'Icon=📚',
  'Keywords=docs;help\\;faq;',
  'X-Unknown-Thing=keep me',
  '# trailing comment in the group',
  '',
  '[Desktop Action private]',
  'Name=Private window',
  'Exec=firefox --private-window',
  '',
].join('\n')

const parsed = parseDesktopFile(SAMPLE)
check('a file with comments, localised and unknown keys comes back byte for byte', formatDesktopFile(parsed) === SAMPLE)
check('CRLF and a BOM are read', getValue(parseDesktopFile(`﻿[Desktop Entry]\r\nType=Link\r\nName=X\r\n`), 'Name') === 'X')
check('spaces around = are ignored', getValue(parsed, 'URL') === 'https://example.com/docs')
check('escapes are read (\\n)', getValue(parsed, 'Comment') === 'Read the docs\nor else')
check('Name[nl] for nl-NL', getLocalized(parsed, 'Name', ['nl-NL']) === 'Documentatie')
check('Name[de_DE] for de-DE', getLocalized(parsed, 'Name', ['de-DE']) === 'Dokumente')
check('plain Name for a language it does not have', getLocalized(parsed, 'Name', ['fr-FR', 'en']) === 'Docs')
check('keys of other groups are their own', getValue(parsed, 'Name', 'Desktop Action private') === 'Private window')
{
  const renamed = formatDesktopFile(setValue(parsed, 'Name', 'Manual'))
  const diff = SAMPLE.split('\n').filter((l, i) => renamed.split('\n')[i] !== l)
  check('setting Name changes that one line only', diff.length === 1 && diff[0] === 'Name=Docs' && renamed.includes('Name=Manual'))
  const dropped = formatDesktopFile(setValue(parsed, 'Name', 'Manual', { dropLocalized: true }))
  check('a rename can drop the localised names', !dropped.includes('Name[nl]') && !dropped.includes('Name[de_DE]') && dropped.includes('X-Unknown-Thing=keep me') && dropped.includes('Name=Private window'))
  const added = formatDesktopFile(setValue(parsed, 'X-MvL-Id', 'abc'))
  check('a new key goes after the group’s last key, before its comment', added.includes('X-Unknown-Thing=keep me\nX-MvL-Id=abc\n# trailing comment'))
  const removed = formatDesktopFile(setValue(parsed, 'Icon', null))
  check('null removes a key', !removed.includes('Icon=') && removed.split('\n').length === SAMPLE.split('\n').length - 1)
}
for (const v of [' leading space', 'back\\slash', 'two\nlines', 'tab\there', 'plain 📚 text']) check(`escape round-trip: ${JSON.stringify(v)}`, unescapeValue(escapeValue(v)) === v && getValue(setValue(parsed, 'Comment', v), 'Comment') === v)
check('refused: no [Desktop Entry]', throwsAt('Type=Link\n', /before any \[group\]/))
check('refused: another group first', throwsAt('[Other]\nA=1\n[Desktop Entry]\nType=Link\n', /line 1: the first group/))
check('refused: a key twice', throwsAt('[Desktop Entry]\nName=a\nName=b\n', /line 3: Name comes twice/))
check('refused: a group twice', throwsAt('[Desktop Entry]\nName=a\n[Desktop Entry]\n', /line 3: \[Desktop Entry\] comes twice/))
check('refused: a line that is none of the three', throwsAt('[Desktop Entry]\nthis is not a key\n', /line 2: not a key=value/))
check('refused: an empty file', throwsAt('', /no \[Desktop Entry\]/))
check('a key twice in different locales is fine', !throwsAt('[Desktop Entry]\nName=a\nName[nl]=b\n', /./))

const at = '/home/x/Desktop/Docs.desktop'
const doc = launcherFromText(SAMPLE, at, { desktop: true, languages: ['nl'] })
check('a Link file is a launcher, in the reader’s language', doc?.label === 'Documentatie' && doc.url === 'https://example.com/docs' && doc.glyph === '📚' && doc.file === at)
check('refused as a launcher: javascript: addresses', launcherFromText('[Desktop Entry]\nType=Link\nName=x\nURL=javascript:alert(1)\n', at) === null)
check('refused as a launcher: a program to run', launcherFromText('[Desktop Entry]\nType=Application\nName=x\nExec=rm -rf /\n', at) === null)
check('refused as a launcher: Hidden=true', launcherFromText('[Desktop Entry]\nType=Link\nName=x\nURL=https://a.b\nHidden=true\n', at) === null)
check('refused as a launcher: a broken file', launcherFromText('[Desktop Entry]\nName=x\nName=y\nType=Link\nURL=https://a.b\n', at) === null)
{
  const app = launcherFromText('[Desktop Entry]\nType=Application\nName=Work\nExec=open files\nX-MvL-App=files\nX-MvL-Props=path=/home/x/Work;view=grid;\n', at, { isApp: (a) => a === 'files' })
  check('an app launcher (X-MvL-App) with its props', app?.app === 'files' && app.props?.path === '/home/x/Work' && app.props?.view === 'grid')
  check('an app this build does not have is not a launcher', launcherFromText('[Desktop Entry]\nType=Application\nName=W\nX-MvL-App=nope\n', at, { isApp: (a) => a === 'files' }) === null)
}
check('Icon: an image address', launcherFromText('[Desktop Entry]\nType=Link\nName=x\nURL=https://a.b\nIcon=https://a.b/i.png\n', at)?.image === 'https://a.b/i.png')
check('Icon: a theme icon name is left for the favicon', (() => {
  const l = launcherFromText('[Desktop Entry]\nType=Link\nName=x\nURL=https://a.b\nIcon=firefox\n', at)
  return !!l && !l.glyph && !l.image
})())
check('no Name: the file name', launcherFromText('[Desktop Entry]\nType=Link\nURL=https://a.b\n', '/x/My Site.desktop')?.label === 'My Site')
check('no X-MvL-Id: an id from the path, the same every time', launcherFromText('[Desktop Entry]\nType=Link\nURL=https://a.b\n', '/x/a.desktop')?.id === launcherFromText('[Desktop Entry]\nType=Link\nURL=https://b.c\n', '/x/a.desktop')?.id)
{
  const written = launcherText({ id: 'abc12345', label: 'GitHub', url: 'https://github.com/', glyph: '🐙' })
  check('a new launcher file', written === '[Desktop Entry]\nType=Link\nName=GitHub\nURL=https://github.com/\nIcon=🐙\nX-MvL-Id=abc12345\n')
  const back = launcherFromText(written, '/d/GitHub.desktop')
  check('…reads back as the same launcher', back?.id === 'abc12345' && back.label === 'GitHub' && back.url === 'https://github.com/' && back.glyph === '🐙')
  const edited = launcherText({ ...back!, label: 'Docs', url: 'https://docs.example/' }, SAMPLE)
  check('editing a hand-made file keeps its comments, other keys, groups and (same name) its translations', edited.includes('# Made by hand') && edited.includes('X-Unknown-Thing=keep me') && edited.includes('[Desktop Action private]') && edited.includes('Keywords=docs;help\\;faq;') && edited.includes('Name[nl]=Documentatie') && getValue(parseDesktopFile(edited), 'URL') === 'https://docs.example/')
  const renamed = launcherText({ ...back!, label: 'Manual', url: 'https://docs.example/' }, SAMPLE)
  check('a new name replaces the translations too', !renamed.includes('Name[nl]') && getLocalized(parseDesktopFile(renamed), 'Name', ['nl']) === 'Manual' && renamed.includes('# Made by hand'))
}
check('file names: made safe', launcherFileName('a/b: c?', new Set()) === 'a b c.desktop' && launcherFileName('..hidden', new Set()) === 'hidden.desktop' && launcherFileName('', new Set()) === 'Launcher.desktop')
check('file names: numbered when taken', launcherFileName('GitHub', new Set(['GitHub.desktop', 'GitHub 2.desktop'])) === 'GitHub 3.desktop')

// --- stand-ins for the two filesystems ----------------------------------------------------------------

/** The browser's store (browserfs.ts): folders must exist, a name that is taken is refused. */
function browserStore() {
  const nodes = new Map<string, { dir: boolean; text: string }>([['/', { dir: true, text: '' }]])
  const parent = (p: string) => p.replace(/\/[^/]*$/, '') || '/'
  const children = (d: string) => [...nodes.keys()].filter((k) => k !== '/' && parent(k) === d)
  const sub = (p: string) => [...nodes.keys()].filter((k) => k === p || k.startsWith(`${p}/`))
  const port: LauncherPort & TransferPort & { nodes: typeof nodes } = {
    nodes,
    async list(d) {
      return nodes.get(d)?.dir ? children(d).map((k) => ({ name: k.split('/').pop()!, dir: nodes.get(k)!.dir })) : null
    },
    async read(p) {
      const n = nodes.get(p)
      if (!n || n.dir) throw new Error(`${p}: no such file`)
      return n.text
    },
    async write(p, text) {
      if (!nodes.get(parent(p))?.dir) throw new Error(`${parent(p)}: no such folder`)
      nodes.set(p, { dir: false, text })
    },
    async mkdirp(d) {
      if (nodes.has(d)) return
      await port.mkdirp(parent(d))
      nodes.set(d, { dir: true, text: '' })
    },
    async names(d) {
      return new Set(children(d).map((k) => k.split('/').pop()!))
    },
    async transfer(op, paths, into) {
      for (const p of paths) await port.transferAs(op, p, `${into === '/' ? '' : into}/${p.split('/').pop()}`)
    },
    async transferAs(op, from, to) {
      if (nodes.has(to)) throw new Error(`${to.split('/').pop()} already exists there`)
      if (!nodes.get(parent(to))?.dir) throw new Error('no such folder')
      for (const k of sub(from)) nodes.set(to + k.slice(from.length), { ...nodes.get(k)! })
      if (op === 'move') for (const k of sub(from)) nodes.delete(k)
    },
    async remove(paths) {
      for (const p of paths) for (const k of sub(p)) nodes.delete(k)
    },
  }
  return port
}

// --- the real server with the stand-in for Seafile ------------------------------------------------

const mock = await startMockSeafile()
const LOGIN = 'launchers-check'
const server = new Server({ GITHUB_CLIENT_ID: 'x', GITHUB_CLIENT_SECRET: 'x', ADMIN_USERS: LOGIN })
process.env.DATA_DIR = server.data
const { database, encrypt, sha256 } = await import('../server/db.ts')
const sid = randomBytes(24).toString('hex')
const now = Date.now()
database().prepare('INSERT INTO users (id, github_id, login, github_token, created_at, updated_at) VALUES (1, 1, ?, ?, ?, ?)').run(LOGIN, encrypt('none'), now, now)
database().prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, 1, ?, ?)').run(sha256(sid), now, now + 86400_000)
database()
  .prepare('INSERT INTO integrations (user_id, name, secret, created_at) VALUES (1, ?, ?, ?)')
  .run('seafile', encrypt(JSON.stringify({ url: mock.base, username: 'check@example.com', token: 'mock-token', name: 'Check', version: '12.0.0' })), now)
await server.start()

const headers = { Cookie: `mvlos_sid=${sid}`, Origin: server.origin }
async function api<T>(path: string, init: { method?: string; json?: unknown } = {}): Promise<T> {
  const res = await fetch(`${server.origin}${path}`, { method: init.method ?? 'GET', headers: { ...headers, ...(init.json ? { 'Content-Type': 'application/json' } : {}) }, body: init.json ? JSON.stringify(init.json) : undefined })
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new Error(`${path}: ${res.status} ${body?.error ?? ''}`)
  return body as T
}

/**
 * Seafile as the Files app reaches it (src/data/seafile.ts): paths are "sf:<repo>:/folder/name".
 * Each instance is one device, with nothing cached.
 */
function seafileDevice() {
  const split = (p: string) => {
    const m = /^sf:([^:]+):(.*)$/.exec(p)!
    return { repo: m[1], p: m[2] || '/' }
  }
  const sf = (repo: string, p: string) => `sf:${repo}:${p}`
  const parent = (p: string) => p.replace(/\/[^/]*$/, '') || '/'
  const name = (p: string) => p.split('/').pop()!
  const list = async (path: string) => {
    const { repo, p } = split(path)
    try {
      return (await api<{ entries: { name: string; dir: boolean }[] }>(`/api/seafile/dir?repo=${repo}&p=${encodeURIComponent(p)}`)).entries
    } catch {
      return null
    }
  }
  const read = async (path: string) => {
    const { repo, p } = split(path)
    const { url } = await api<{ url: string }>(`/api/seafile/link?repo=${repo}&p=${encodeURIComponent(p)}&op=download`)
    return Buffer.from(await (await fetch(url)).arrayBuffer())
  }
  const upload = async (folder: string, file: string, data: Buffer | string) => {
    const { repo, p } = split(folder)
    const { url } = await api<{ url: string }>(`/api/seafile/link?repo=${repo}&p=${encodeURIComponent(p)}&op=upload`)
    const form = new FormData()
    form.append('parent_dir', p)
    form.append('replace', '1')
    form.append('file', new Blob([data]), file)
    const res = await fetch(`${url}?ret-json=1`, { method: 'POST', body: form })
    if (!res.ok) throw new Error(`upload: ${res.status}`)
  }
  const port: LauncherPort & TransferPort = {
    list,
    read: async (p) => (await read(p)).toString('utf8'),
    write: async (path, text) => upload(sf(split(path).repo, parent(split(path).p)), name(split(path).p), text),
    async mkdirp(path) {
      const { repo, p } = split(path)
      let at = '/'
      for (const part of p.split('/').filter(Boolean)) {
        const next = at === '/' ? `/${part}` : `${at}/${part}`
        if (!(await list(sf(repo, at)))?.some((e) => e.name === part)) await api('/api/seafile/dir', { method: 'POST', json: { repo, path: next } })
        at = next
      }
    },
    async names(path) {
      return new Set(((await list(path)) ?? []).map((e) => e.name))
    },
    async transfer(op, paths, into) {
      const to = split(into)
      for (const path of paths) {
        const from = split(path)
        await api('/api/seafile/transfer', { method: 'POST', json: { op, from: { repo: from.repo, parent: parent(from.p) }, names: [name(from.p)], to: { repo: to.repo, parent: to.p } } })
      }
    },
    // As fileDrop.ts does it: Seafile's own move or copy (it numbers a name that is taken), then a rename.
    async transferAs(op, from, to) {
      const into = sf(split(to).repo, parent(split(to).p))
      const before = await port.names(into)
      await port.transfer(op, [from], into)
      const after = await port.names(into)
      const landed = after.has(name(split(from).p)) && !before.has(name(split(from).p)) ? name(split(from).p) : ([...after].find((n) => !before.has(n)) ?? name(split(from).p))
      if (landed !== name(split(to).p)) {
        const dir = (await list(into))!.find((e) => e.name === landed)!.dir
        await api('/api/seafile/rename', { method: 'POST', json: { repo: split(to).repo, path: `${split(into).p === '/' ? '' : split(into).p}/${landed}`, dir, name: name(split(to).p) } })
      }
    },
    async remove(paths) {
      for (const path of paths) {
        const { repo, p } = split(path)
        await api('/api/seafile/delete', { method: 'POST', json: { repo, parent: parent(p), names: [name(p)] } })
      }
    },
  }
  return { port, read, upload, sf }
}

// --- 2. migration --------------------------------------------------------------------------------------

const legacy: Omit<Launcher, 'file'>[] = [
  { id: 'gh000001', label: 'GitHub', url: 'https://github.com/', glyph: '🐙' },
  { id: 'mail0002', label: 'Mail', url: 'https://mail.example.com/', desktop: false },
  { id: 'news0003', label: 'News: today/tomorrow', url: 'https://news.example.com/' },
  { id: 'dup00004', label: 'GitHub', url: 'https://github.com/settings' },
]
const HOME = '/home/check'
const dirs = { desktop: `${HOME}/Desktop`, apps: `${HOME}/.local/share/applications` }

{
  const a = browserStore()
  const b = browserStore()
  await a.mkdirp(dirs.desktop)
  const first = await migrateLaunchers(a, legacy, dirs)
  const again = await migrateLaunchers(a, legacy, dirs)
  const other = await migrateLaunchers(b, legacy, dirs)
  const files = [...a.nodes.keys()].filter((k) => k.endsWith('.desktop')).sort()
  check('browser home: each launcher written once, on the desktop or in applications', JSON.stringify(files) === JSON.stringify([`${dirs.apps}/Mail.desktop`, `${dirs.desktop}/GitHub 2.desktop`, `${dirs.desktop}/GitHub.desktop`, `${dirs.desktop}/News today tomorrow.desktop`]))
  check('browser home: a second run writes nothing (the marker)', first.written.length === 4 && again.written.length === 0)
  check('browser home: another device’s store gets its own copy', other.written.length === 4 && [...b.nodes.keys()].filter((k) => k.endsWith('.desktop')).length === 4)
  const read = await readLaunchers(a, dirs)
  check('browser home: they read back with their ids, names and places', legacy.every((l) => read.some((r) => r.id === l.id && r.label === l.label && r.url === l.url && r.desktop === (l.desktop !== false))))
  await a.remove([`${dirs.desktop}/GitHub.desktop`])
  const later = await migrateLaunchers(a, [...legacy, { id: 'new00005', label: 'Later', url: 'https://later.example/' }], dirs)
  check('browser home: a deleted launcher stays deleted, one added to the old list later is written', later.written.length === 1 && later.written[0].endsWith('/Later.desktop') && !a.nodes.has(`${dirs.desktop}/GitHub.desktop`))
  check('browser home: the marker lists every id', (await a.read(`${dirs.apps}/${MIGRATED}`)).trim().split('\n').length === 5)
}
{
  // Seafile shared by two devices that migrate at the very same moment, then once more each.
  const one = seafileDevice()
  const two = seafileDevice()
  const sdirs = { desktop: one.sf(MY_LIBRARY, '/Desktop'), apps: one.sf(MY_LIBRARY, '/.local/share/applications') }
  const [ra, rb] = await Promise.all([migrateLaunchers(one.port, legacy, sdirs), migrateLaunchers(two.port, legacy, sdirs)])
  const lib = mock.repos.get(MY_LIBRARY)!
  const files = [...lib.files.keys()].filter((k) => k.endsWith('.desktop')).sort()
  check('Seafile home, two devices at once: still one file per launcher', JSON.stringify(files) === JSON.stringify(['/.local/share/applications/Mail.desktop', '/Desktop/GitHub 2.desktop', '/Desktop/GitHub.desktop', '/Desktop/News today tomorrow.desktop']))
  check('Seafile home: both devices wrote (or skipped) the same files', ra.written.length + ra.skipped.length === 4 && rb.written.length + rb.skipped.length === 4)
  const ids = new Set(files.map((f) => idInText(lib.files.get(f)!.data.toString())))
  check('Seafile home: every file keeps its launcher’s id', legacy.every((l) => ids.has(l.id)))
  const [a2, b2] = [await migrateLaunchers(one.port, legacy, sdirs), await migrateLaunchers(two.port, legacy, sdirs)]
  check('Seafile home: runs after that write nothing', a2.written.length === 0 && b2.written.length === 0)
  await one.port.remove([one.sf(MY_LIBRARY, '/Desktop/News today tomorrow.desktop')])
  check('Seafile home: a launcher deleted on one device is not brought back by the other', (await migrateLaunchers(two.port, legacy, sdirs)).written.length === 0 && !lib.files.has('/Desktop/News today tomorrow.desktop'))
  check('Seafile home: the files read back as launchers', (await readLaunchers(two.port, sdirs)).length === 3)
}

// --- 4. moving and copying ------------------------------------------------------------------------

const answer = (c: Clash | null) => async () => c
{
  const b = browserStore()
  await b.mkdirp('/h/A')
  await b.mkdirp('/h/B')
  for (const [p, t] of [
    ['/h/A/a.txt', 'new a'],
    ['/h/A/b.txt', 'new b'],
    ['/h/B/a.txt', 'old a'],
  ])
    await b.write(p, t)
  let asked: string[] = []
  const ask = (c: Clash | null) => async (names: string[]) => ((asked = names), c)
  check('browser: cancel leaves everything', (await transferInto(b, 'move', ['/h/A/a.txt', '/h/A/b.txt'], '/h/B', ask(null))) === null && b.nodes.has('/h/A/a.txt') && (await b.read('/h/B/a.txt')) === 'old a')
  check('…and asked about the one name that meets', JSON.stringify(asked) === '["a.txt"]')
  const skip = await transferInto(b, 'copy', ['/h/A/a.txt', '/h/A/b.txt'], '/h/B', ask('skip'))
  check('browser: skip copies the rest only', skip!.skipped.length === 1 && (await b.read('/h/B/a.txt')) === 'old a' && (await b.read('/h/B/b.txt')) === 'new b')
  await b.remove(['/h/B/b.txt'])
  const keep = await transferInto(b, 'copy', ['/h/A/a.txt'], '/h/B', ask('keep'))
  check('browser: keep both gives the newcomer a number', keep!.moved[0].to === '/h/B/a 2.txt' && (await b.read('/h/B/a 2.txt')) === 'new a' && (await b.read('/h/B/a.txt')) === 'old a')
  const rep = await transferInto(b, 'move', ['/h/A/a.txt'], '/h/B', ask('replace'))
  check('browser: replace puts the new one in its place', rep!.moved[0].to === '/h/B/a.txt' && (await b.read('/h/B/a.txt')) === 'new a' && !b.nodes.has('/h/A/a.txt'))
  const self = await transferInto(b, 'copy', ['/h/B/a.txt'], '/h/B', ask(null))
  check('browser: a copy into its own folder keeps both without asking', self!.moved[0].to === '/h/B/a 3.txt')
  const moved = await transferInto(b, 'move', ['/h/A/b.txt'], '/h/B', answer('keep'))
  check('browser: a plain move', moved!.moved[0].to === '/h/B/b.txt' && !b.nodes.has('/h/A/b.txt'))
  check('browser: undo puts it back', (await undoMove(b, moved!)) === 1 && b.nodes.has('/h/A/b.txt') && !b.nodes.has('/h/B/b.txt'))
  check('browser: moving into the folder it is in does nothing', (await transferInto(b, 'move', ['/h/B/a.txt'], '/h/B', ask(null)))!.moved.length === 0)
}
{
  const dev = seafileDevice()
  const lib = mock.repos.get(MY_LIBRARY)!
  const photos = mock.repos.get(PHOTOS)!
  putFile(lib, '/Documents/report.txt', 'new report')
  putFile(lib, '/Downloads/report.txt', 'old report')
  putFile(lib, '/Documents/Folder/inner.txt', 'inner')
  const D = dev.sf(MY_LIBRARY, '/Documents')
  const W = dev.sf(MY_LIBRARY, '/Downloads')
  const trashBefore = lib.trash.length
  const rep = await transferInto(dev.port, 'copy', [`${D}/report.txt`], W, answer('replace'))
  check('Seafile: replace swaps the content, the old one goes to the trash', rep!.moved[0].to === `${W}/report.txt` && lib.files.get('/Downloads/report.txt')!.data.toString() === 'new report' && lib.trash.length === trashBefore + 1)
  const keep = await transferInto(dev.port, 'copy', [`${D}/report.txt`], W, answer('keep'))
  check('Seafile: keep both is "report 2.txt" (not Seafile’s "report (1).txt")', keep!.moved[0].to === `${W}/report 2.txt` && lib.files.has('/Downloads/report 2.txt') && !lib.files.has('/Downloads/report (1).txt'))
  const folder = await transferInto(dev.port, 'move', [`${D}/Folder`], W, answer(null))
  check('Seafile: a folder moves with what is in it', !!folder && lib.files.get('/Downloads/Folder/inner.txt')?.data.toString() === 'inner' && !lib.files.has('/Documents/Folder'))
  check('Seafile: undo moves it back', (await undoMove(dev.port, folder!)) === 1 && lib.files.has('/Documents/Folder/inner.txt') && !lib.files.has('/Downloads/Folder'))
  const across = await transferInto(dev.port, 'copy', [`${D}/report.txt`], dev.sf(PHOTOS, '/2024'), answer(null))
  check('Seafile: a copy into another library', !!across && photos.files.get('/2024/report.txt')?.data.toString() === 'new report')

  // Between this browser and Seafile: the bytes are carried over (fileOps.ts does it through the
  // terminal's filesystem; here a port that routes by path does the same).
  const b = browserStore()
  await b.mkdirp('/h/Desktop')
  await b.write('/h/Desktop/notes.md', 'from the browser')
  await b.write('/h/Desktop/report.txt', 'browser report')
  const both: TransferPort = {
    names: (d) => (d.startsWith('sf:') ? dev.port.names(d) : b.names(d)),
    async transfer(op, paths, into) {
      for (const p of paths) await both.transferAs(op, p, `${into}/${p.split('/').pop()}`)
    },
    async transferAs(op, from, to) {
      if (from.startsWith('sf:') === to.startsWith('sf:')) return (from.startsWith('sf:') ? dev.port : b).transferAs(op, from, to)
      if (to.startsWith('sf:')) await dev.upload(to.replace(/\/[^/]*$/, ''), to.split('/').pop()!, await b.read(from))
      else await b.write(to, (await dev.read(from)).toString('utf8'))
      if (op === 'move') await (from.startsWith('sf:') ? dev.port : b).remove([from])
    },
    remove: async (paths) => {
      for (const p of paths) await (p.startsWith('sf:') ? dev.port : b).remove([p])
    },
  }
  const desk = dev.sf(MY_LIBRARY, '/Desktop')
  const up = await transferInto(both, 'copy', ['/h/Desktop/notes.md', '/h/Desktop/report.txt'], desk, answer('keep'))
  check('browser to Seafile: copied, nothing taken there', up!.moved.length === 2 && lib.files.get('/Desktop/notes.md')?.data.toString() === 'from the browser' && b.nodes.has('/h/Desktop/notes.md'))
  const again = await transferInto(both, 'copy', ['/h/Desktop/notes.md'], desk, answer('keep'))
  check('browser to Seafile: the second time keeps both', again!.moved[0].to === `${desk}/notes 2.md` && lib.files.has('/Desktop/notes 2.md'))
  const down = await transferInto(both, 'move', [`${desk}/notes 2.md`], '/h/Desktop', answer('replace'))
  check('Seafile to the browser: a move, replacing (when asked)', !!down && down.moved[0].to === '/h/Desktop/notes 2.md' && !lib.files.has('/Desktop/notes 2.md') && (await b.read('/h/Desktop/notes 2.md')) === 'from the browser')
  const back = await transferInto(both, 'copy', [`${desk}/report.txt`].filter(() => lib.files.has('/Desktop/report.txt')), '/h/Desktop', answer('skip'))
  check('Seafile to the browser: skip leaves the browser’s own', !!back && (await b.read('/h/Desktop/report.txt')) === 'browser report')
}

// --- 3. without Seafile: the synced list as files ----------------------------------------------------

{
  // A device: its copy of the list (as synced.ts keeps it), and the browser's store around the
  // two folders the way browserfs.ts routes to the list: a .desktop file elsewhere is a plain file.
  const device = () => {
    let value: StoredLauncher[] = []
    let base = 0
    const plain = new Map<string, string>()
    const v = virtualLaunchers({ get: () => value, set: (fn) => void (value = fn(value)), dirs: () => ({ desktop: '/Desktop', apps: '/.local/share/applications' }), isApp: (a) => a === 'files' })
    return {
      v,
      plain,
      async push() {
        const r = await api<{ updatedAt: number; conflict?: boolean }>('/api/state/launchers', { method: 'PUT', json: { value, base } })
        if (r.conflict) throw new Error('conflict')
        base = r.updatedAt
      },
      async pull() {
        const all = await api<Record<string, { value: StoredLauncher[]; updatedAt: number }>>('/api/state')
        value = all.launchers?.value ?? []
        base = all.launchers?.updatedAt ?? 0
      },
      ls: (dir: string) => v.list(dir).map((e) => e.path.split('/').pop()).sort(),
      // browserfs.ts's transferBrowser, for these two places
      move(from: string, to: string) {
        if (v.has(from)) {
          if (v.isPlace(to) && v.rename('move', from, to)) return
          plain.set(to, v.text(from)!)
          v.remove(from)
        } else if (v.isPlace(to) && v.write(to, plain.get(from)!)) plain.delete(from)
      },
    }
  }
  const a = device()
  const b = device()
  const same = async (what: string) => {
    await a.push()
    await b.pull()
    check(`no Seafile, two devices: ${what}`, JSON.stringify([b.ls('/Desktop'), b.ls('/.local/share/applications')]) === JSON.stringify([a.ls('/Desktop'), a.ls('/.local/share/applications')]) && a.ls('/Desktop').every((n) => b.v.text(`/Desktop/${n}`) === a.v.text(`/Desktop/${n}`)))
  }
  check('no Seafile: a launcher written in ~/Desktop joins the list', a.v.write('/Desktop/Docs.desktop', '# mine\n[Desktop Entry]\nType=Link\nName=Docs\nURL=https://docs.example/\nX-Extra=kept\n'))
  check('no Seafile: a file that is not a launcher stays a plain file', !a.v.write('/Desktop/broken.desktop', 'not a desktop entry') && !a.v.isPlace('/Documents/x.desktop'))
  await same('the one added shows on the other')
  check('…as the same file, comments and unknown keys kept', (b.v.text('/Desktop/Docs.desktop') ?? '').includes('# mine') && (b.v.text('/Desktop/Docs.desktop') ?? '').includes('X-Extra=kept') && /X-MvL-Id=\w+/.test(b.v.text('/Desktop/Docs.desktop') ?? ''))
  const id = /X-MvL-Id=(\w+)/.exec(a.v.text('/Desktop/Docs.desktop')!)![1]
  b.v.write('/Desktop/Docs.desktop', b.v.text('/Desktop/Docs.desktop')!.replace('Name=Docs', 'Name=Manual'))
  await b.push()
  await a.pull()
  check('no Seafile: renamed on the other device (Name=), the file keeps its name and id', (a.v.text('/Desktop/Docs.desktop') ?? '').includes('Name=Manual') && a.v.text('/Desktop/Docs.desktop')!.includes(`X-MvL-Id=${id}`))
  a.move('/Desktop/Docs.desktop', '/.local/share/applications/Docs.desktop')
  await same('moved off the desktop into applications')
  check('…where the other device has it', b.ls('/Desktop').length === 0 && JSON.stringify(b.ls('/.local/share/applications')) === '["Docs.desktop"]')
  a.move('/.local/share/applications/Docs.desktop', '/Documents/Docs.desktop')
  await same('moved out to Documents: it leaves the list')
  check('…and is a plain file of that browser', a.plain.has('/Documents/Docs.desktop') && b.ls('/.local/share/applications').length === 0)
  a.move('/Documents/Docs.desktop', '/Desktop/Docs.desktop')
  await same('moved back in: it joins the list again, with its id')
  check('…on the other device’s desktop', JSON.stringify(b.ls('/Desktop')) === '["Docs.desktop"]' && b.v.text('/Desktop/Docs.desktop')!.includes(`X-MvL-Id=${id}`))
  check('no Seafile: a copy gets an id of its own', a.v.rename('copy', '/Desktop/Docs.desktop', '/Desktop/Docs 2.desktop') && a.v.text('/Desktop/Docs 2.desktop')!.match(/X-MvL-Id=(\w+)/)![1] !== id)
  a.v.remove('/Desktop/Docs 2.desktop')
  a.v.remove('/Desktop/Docs.desktop')
  await same('deleted on one, gone on the other')
  check('…nothing left', b.ls('/Desktop').length === 0 && b.ls('/.local/share/applications').length === 0)
  // The list as it was before files (no name, no text): shown as files made from its fields.
  const old = device()
  await api('/api/state/launchers', { method: 'PUT', json: { value: legacy, base: (await api<Record<string, { updatedAt: number }>>('/api/state')).launchers.updatedAt } })
  await old.pull()
  check('no Seafile: the list from before shows as files', JSON.stringify(old.ls('/Desktop')) === '["GitHub 2.desktop","GitHub.desktop","News today tomorrow.desktop"]' && JSON.stringify(old.ls('/.local/share/applications')) === '["Mail.desktop"]' && old.v.text('/Desktop/GitHub.desktop')!.includes('X-MvL-Id=gh000001'))
}

await server.dispose()
await mock.close()
finish()
