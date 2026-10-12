// A stand-in for a Seafile server (Seahub's API and its file server), in memory, for checks and
// for trying Files, the desktop and launchers against Seafile without a real account. It speaks
// the part of the API that server/seafile.ts uses: libraries, folders, files, links to download,
// upload and update (answered with CORS headers, like Seafile's file server, since the browser
// talks to it directly), rename, delete into a trash, move and copy (a name that is taken gets
// " (1)", as Seafile does; between libraries as a background task), history and share links.
//
//   node scripts/mock-seafile.ts [port]     (default 8840)
//
// Link it as an admin in Settings → Integrations → Seafile (any username and password; the
// address is a private one, which only admins may use), or write the link into the database the
// way scripts/launchers-check.ts does. `import { startMockSeafile }` starts one in a script.

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'

type Node = { dir: boolean; data: Buffer; mtime: number }
export type MockRepo = { id: string; name: string; files: Map<string, Node>; trash: { path: string; node: Node; deleted: number }[] }

export const MY_LIBRARY = 'aaaaaaaa-0000-4000-8000-000000000001'
export const PHOTOS = 'bbbbbbbb-0000-4000-8000-000000000002'

const now = () => Math.floor(Date.now() / 1000)
const parentOf = (p: string) => p.replace(/\/[^/]*$/, '') || '/'
const nameOf = (p: string) => p.split('/').pop() || ''
const join = (dir: string, name: string) => (dir === '/' ? `/${name}` : `${dir}/${name}`)

function repo(id: string, name: string, folders: string[] = []): MockRepo {
  const files = new Map<string, Node>([['/', { dir: true, data: Buffer.alloc(0), mtime: now() }]])
  for (const f of folders) files.set(f, { dir: true, data: Buffer.alloc(0), mtime: now() })
  return { id, name, files, trash: [] }
}

/** A name not taken in the folder: "a.txt", then "a (1).txt", as Seafile numbers them. */
function seafileName(r: MockRepo, dir: string, name: string): string {
  if (!r.files.has(join(dir, name))) return name
  const dot = name.lastIndexOf('.')
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
  for (let n = 1; ; n++) if (!r.files.has(join(dir, `${stem} (${n})${ext}`))) return `${stem} (${n})${ext}`
}

const subtree = (r: MockRepo, p: string) => [...r.files.keys()].filter((k) => k === p || k.startsWith(`${p}/`))

export async function startMockSeafile(port = 0, host = '127.0.0.1'): Promise<{ base: string; repos: Map<string, MockRepo>; server: Server; close: () => Promise<void> }> {
  const repos = new Map<string, MockRepo>([
    [MY_LIBRARY, repo(MY_LIBRARY, 'My Library', ['/Desktop', '/Documents', '/Downloads', '/Music', '/Pictures', '/Videos'])],
    [PHOTOS, repo(PHOTOS, 'Photos', ['/2024'])],
  ])
  const tasks = new Map<string, number>()
  let base = ''

  const json = (res: ServerResponse, status: number, body: unknown) => void res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
  const fail = (res: ServerResponse, status: number, msg: string) => json(res, status, { error_msg: msg })
  const body = (req: IncomingMessage) =>
    new Promise<Buffer>((resolve) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => resolve(Buffer.concat(chunks)))
    })
  const formOf = async (req: IncomingMessage) => new URLSearchParams((await body(req)).toString())
  const jsonOf = async <T>(req: IncomingMessage) => JSON.parse((await body(req)).toString() || '{}') as T
  /** A multipart body, read with the platform's own parser. */
  const multipart = async (req: IncomingMessage) => new Request('http://x', { method: 'POST', headers: req.headers as Record<string, string>, body: await body(req) }).formData()

  function transfer(op: 'move' | 'copy', from: MockRepo, fromDir: string, names: string[], to: MockRepo, toDir: string) {
    for (const n of names) {
      const src = join(fromDir, n)
      if (!from.files.has(src)) continue
      const name = seafileName(to, toDir, n)
      const dst = join(toDir, name)
      for (const k of subtree(from, src)) {
        const node = from.files.get(k)!
        to.files.set(dst + k.slice(src.length), { ...node, mtime: op === 'copy' ? now() : node.mtime })
      }
      if (op === 'move') for (const k of subtree(from, src)) if (!(from === to && (k === dst || k.startsWith(`${dst}/`)))) from.files.delete(k)
    }
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const path = url.pathname
    const p = url.searchParams.get('p') ?? '/'
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
    if (req.method === 'OPTIONS') return void res.writeHead(204).end()
    let m: RegExpExecArray | null

    // --- signing in -------------------------------------------------------------------------------
    if (path === '/api2/auth-token/') return json(res, 200, { token: 'mock-token' })
    if (path === '/api2/account-info/') return json(res, 200, { name: 'Mock', email: 'mock@example.com' })
    if (path === '/api2/account/info/') return json(res, 200, { usage: [...repos.values()].reduce((n, r) => n + [...r.files.values()].reduce((a, f) => a + f.data.length, 0), 0), total: -2 })
    if (path === '/api2/server-info/') return json(res, 200, { version: '12.0.0-mock' })
    if (path === '/api2/logout-device/') return json(res, 200, {})

    // --- libraries --------------------------------------------------------------------------------
    if (path === '/api/v2.1/repos/' && req.method === 'GET')
      return json(res, 200, { repos: [...repos.values()].map((r) => ({ repo_id: r.id, repo_name: r.name, type: 'mine', owner_email: 'mock@example.com', owner_name: 'Mock', encrypted: false, permission: 'rw', size: 0, last_modified: new Date().toISOString() })) })
    if ((m = /^\/api\/v2\.1\/repos\/([0-9a-f-]{36})\/$/.exec(path))) return repos.has(m[1]) ? json(res, 200, { repo_id: m[1], encrypted: false }) : fail(res, 404, 'Library not found')

    // --- folders and files ------------------------------------------------------------------------
    if ((m = /^\/api\/v2\.1\/repos\/([0-9a-f-]{36})\/dir\/$/.exec(path))) {
      const r = repos.get(m[1])
      if (!r) return fail(res, 404, 'Library not found')
      if (req.method === 'GET') {
        const node = r.files.get(p)
        if (!node?.dir) return fail(res, 404, 'Folder not found')
        const dirent_list = [...r.files.entries()]
          .filter(([k]) => k !== '/' && parentOf(k) === p)
          .map(([k, n]) => ({ type: n.dir ? 'dir' : 'file', name: nameOf(k), id: `${k.length}${n.mtime}`, size: n.data.length, mtime: n.mtime }))
        return json(res, 200, { user_perm: 'rw', dirent_list })
      }
      const form = await formOf(req)
      if (form.get('operation') === 'mkdir') {
        if (!r.files.get(parentOf(p))?.dir) return fail(res, 404, 'Folder not found')
        const name = seafileName(r, parentOf(p), nameOf(p))
        r.files.set(join(parentOf(p), name), { dir: true, data: Buffer.alloc(0), mtime: now() })
        return json(res, 200, { obj_name: name, parent_dir: parentOf(p) })
      }
      if (form.get('operation') === 'rename') return rename(r, p, form.get('newname') ?? '', res)
      return fail(res, 400, 'Bad operation')
    }
    if ((m = /^\/api\/v2\.1\/repos\/([0-9a-f-]{36})\/file\/$/.exec(path)) && req.method === 'POST') {
      const r = repos.get(m[1])!
      const form = await formOf(req)
      if (form.get('operation') === 'create') {
        if (!r.files.get(parentOf(p))?.dir) return fail(res, 404, 'Folder not found')
        const name = seafileName(r, parentOf(p), nameOf(p))
        r.files.set(join(parentOf(p), name), { dir: false, data: Buffer.alloc(0), mtime: now() })
        return json(res, 200, { obj_name: name, parent_dir: parentOf(p) })
      }
      if (form.get('operation') === 'rename') return rename(r, p, form.get('newname') ?? '', res)
      return fail(res, 400, 'Bad operation')
    }
    if ((m = /^\/api\/v2\.1\/repos\/([0-9a-f-]{36})\/file\/detail\/$/.exec(path))) {
      const f = repos.get(m[1])?.files.get(p)
      return f ? json(res, 200, { name: nameOf(p), size: f.data.length, mtime: f.mtime }) : fail(res, 404, 'File not found')
    }
    if (path === '/api/v2.1/repos/batch-delete-item/' && req.method === 'DELETE') {
      const b = await jsonOf<{ repo_id: string; parent_dir: string; dirents: string[] }>(req)
      const r = repos.get(b.repo_id)!
      for (const n of b.dirents) {
        const at = join(b.parent_dir, n)
        for (const k of subtree(r, at)) {
          r.trash.push({ path: k, node: r.files.get(k)!, deleted: now() })
          r.files.delete(k)
        }
      }
      return json(res, 200, { success: true })
    }
    if ((m = /^\/api\/v2\.1\/repos\/(sync|async)-batch-(move|copy)-item\/$/.exec(path))) {
      const b = await jsonOf<{ src_repo_id: string; src_parent_dir: string; src_dirents: string[]; dst_repo_id: string; dst_parent_dir: string }>(req)
      const from = repos.get(b.src_repo_id)
      const to = repos.get(b.dst_repo_id)
      if (!from || !to || !to.files.get(b.dst_parent_dir)?.dir) return fail(res, 404, 'Folder not found')
      transfer(m[2] as 'move' | 'copy', from, b.src_parent_dir, b.src_dirents, to, b.dst_parent_dir)
      if (m[1] === 'sync') return json(res, 200, { success: true })
      const id = `task-${tasks.size + 1}`
      tasks.set(id, Date.now())
      return json(res, 200, { task_id: id })
    }
    if (path === '/api/v2.1/query-copy-move-progress/') return json(res, 200, { done: true, failed: false, canceled: false })

    // --- links on the file server -----------------------------------------------------------------
    if ((m = /^\/api2\/repos\/([0-9a-f-]{36})\/(file|upload-link|update-link)\/$/.exec(path))) {
      const kind = m[2] === 'file' ? 'files' : m[2] === 'upload-link' ? 'upload-api' : 'update-api'
      if (kind === 'files' && !repos.get(m[1])?.files.has(p)) return fail(res, 404, 'File not found')
      return json(res, 200, `${base}/seafhttp/${kind}/${m[1]}${kind === 'files' ? p.split('/').map(encodeURIComponent).join('/') : ''}`)
    }
    if ((m = /^\/seafhttp\/files\/([0-9a-f-]{36})(\/.*)$/.exec(path))) {
      const f = repos.get(m[1])?.files.get(decodeURIComponent(m[2]))
      if (!f || f.dir) return void res.writeHead(404).end('not found')
      return void res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': f.data.length }).end(f.data)
    }
    if ((m = /^\/seafhttp\/(upload|update)-api\/([0-9a-f-]{36})$/.exec(path)) && req.method === 'POST') {
      const r = repos.get(m[2])!
      const form = await multipart(req)
      const file = form.get('file') as File | null
      if (!file) return void res.writeHead(400).end('no file')
      const data = Buffer.from(await file.arrayBuffer())
      if (m[1] === 'update') {
        const target = String(form.get('target_file'))
        if (!r.files.has(target)) return void res.writeHead(404).end('not found')
        r.files.set(target, { dir: false, data, mtime: now() })
        return json(res, 200, [{ name: nameOf(target) }])
      }
      let dir = String(form.get('parent_dir') ?? '/')
      const rel = form.get('relative_path')
      for (const part of rel ? String(rel).split('/').filter(Boolean) : []) {
        dir = join(dir, part)
        if (!r.files.has(dir)) r.files.set(dir, { dir: true, data: Buffer.alloc(0), mtime: now() })
      }
      if (!r.files.get(dir)?.dir) return void res.writeHead(404).end('no such folder')
      const name = form.get('replace') === '1' ? file.name : seafileName(r, dir, file.name)
      r.files.set(join(dir, name), { dir: false, data, mtime: now() })
      return json(res, 200, [{ name, size: data.length }])
    }
    if (/^\/api2\/repos\/[0-9a-f-]{36}\/thumbnail\/$/.test(path)) return void res.writeHead(404).end()

    // --- history and trash ------------------------------------------------------------------------
    if (/^\/api2\/repos\/[0-9a-f-]{36}\/history-limit\/$/.test(path)) return json(res, 200, { keep_days: 30 })
    if ((m = /^\/api\/v2\.1\/repos\/([0-9a-f-]{36})\/trash\/$/.exec(path)) && req.method === 'GET') {
      const r = repos.get(m[1])!
      const top = r.trash.filter((t) => !r.trash.some((o) => o !== t && t.path.startsWith(`${o.path}/`)))
      return json(res, 200, { data: top.map((t) => ({ obj_name: nameOf(t.path), parent_dir: `${parentOf(t.path)}/`.replace('//', '/'), is_dir: t.node.dir, size: t.node.data.length, deleted_time: new Date(t.deleted * 1000).toISOString(), commit_id: 'c0' })), more: false, scan_stat: null })
    }
    if (path === '/api/v2.1/share-links/') return json(res, req.method === 'GET' ? 200 : 200, req.method === 'GET' ? [] : { link: `${base}/f/mock/` })
    res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error_msg: `mock: no ${req.method} ${path}` }))
  })

  function rename(r: MockRepo, p: string, newname: string, res: ServerResponse) {
    if (!r.files.has(p)) return fail(res, 404, 'Not found')
    const name = newname === nameOf(p) ? newname : seafileName(r, parentOf(p), newname)
    const to = join(parentOf(p), name)
    for (const k of subtree(r, p)) {
      r.files.set(to + k.slice(p.length), r.files.get(k)!)
      r.files.delete(k)
    }
    return json(res, 200, { obj_name: name })
  }

  await new Promise<void>((resolve) => server.listen(port, host, resolve))
  base = `http://${host}:${(server.address() as { port: number }).port}`
  return { base, repos, server, close: () => new Promise((r) => server.close(() => r())) }
}

/** Puts a text file in a library (making its folders). */
export function putFile(r: MockRepo, path: string, text: string | Buffer) {
  let dir = '/'
  for (const part of parentOf(path).split('/').filter(Boolean)) {
    dir = join(dir, part)
    if (!r.files.has(dir)) r.files.set(dir, { dir: true, data: Buffer.alloc(0), mtime: now() })
  }
  r.files.set(path, { dir: false, data: Buffer.isBuffer(text) ? text : Buffer.from(text), mtime: now() })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] ?? 8840)
  const mock = await startMockSeafile(port)
  console.log(`mock Seafile on ${mock.base} (libraries: My Library ${MY_LIBRARY}, Photos ${PHOTOS})`)
}
