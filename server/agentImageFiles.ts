import type { User } from './auth.ts'
import type { Prepared } from './agentCalendar.ts'
import { database } from './db.ts'
import { guardedFetch, readCapped } from './egress.ts'
import { HttpError } from './http.ts'
import { fileLink, libraries, listDir, seafileInfo } from './seafile.ts'

const MAX_IMAGE = 20 * 1024 * 1024
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const binding = (user: User) => (database().prepare("SELECT secret FROM integrations WHERE user_id = ? AND name = 'seafile'").get(user.id) as { secret: string } | undefined)?.secret

/** No byte content or upload credentials ever pass through the model. */
function artifact(user: User, id: string, bytes = false) {
  const row = database().prepare(`SELECT i.id, length(i.body) AS size,
    CASE WHEN ? AND length(i.body) <= ? THEN i.body END AS body
    FROM agent_images i JOIN agent_threads t ON t.id = i.thread_id WHERE i.id = ? AND t.user_id = ?`).get(bytes ? 1 : 0, MAX_IMAGE, id, user.id) as { id: string; size: number; body: Uint8Array | null } | undefined
  if (!row) throw new HttpError(404, 'No generated image matches that request in your threads')
  if (row.size > MAX_IMAGE) throw new HttpError(413, 'This generated image exceeds the 20 MiB file transfer limit')
  if (bytes && (!row.body || !Buffer.from(row.body).subarray(0, 8).equals(PNG))) throw new HttpError(409, 'The saved artifact is not a PNG image')
  return row
}

function destination(value: unknown) {
  if (typeof value !== 'string' || value.length > 1000 || !value.startsWith('/') || /[\\\x00-\x1f\x7f]/.test(value) || value.split('/').slice(1).some((p) => !p || p === '.' || p === '..' || Buffer.byteLength(p) > 255)) throw new HttpError(400, 'Supply an absolute file path inside the Seafile library, without empty, . or .. segments or control characters')
  const at = value.lastIndexOf('/'), name = value.slice(at + 1)
  if (!/\.png$/i.test(name)) throw new HttpError(400, 'Use a .png filename for this generated image')
  return { path: value, dir: value.slice(0, at) || '/', name }
}

/** Resolve the destination before approval; freeze the account and library identity until execution. */
export async function prepareImageFileSave(user: User, args: Record<string, unknown>, signal: AbortSignal): Promise<Prepared> {
  if (Object.keys(args).some((k) => !['image_id', 'library', 'path', 'overwrite'].includes(k)) || typeof args.image_id !== 'string' || !/^[0-9a-f-]{36}$/.test(args.image_id) || typeof args.library !== 'string' || !args.library.trim() || args.library.length > 200 || args.overwrite !== undefined && typeof args.overwrite !== 'boolean') throw new HttpError(400, 'Supply an image_id, an exact Seafile library ID or unambiguous name, a file path and optional boolean overwrite; never supply image bytes or URLs')
  const target = destination(args.path), id = args.image_id, overwrite = args.overwrite === true
  const source = artifact(user, id)
  const account = seafileInfo(user), identity = binding(user)
  if (!account || !identity) throw new HttpError(409, 'Link Seafile in Settings → Integrations → Seafile first. Browser-local Files and the host Desktop cannot be written by this server tool; use Save to Files on the image.')
  const limit = AbortSignal.any([signal, AbortSignal.timeout(45_000)])
  limit.throwIfAborted()
  const all = await libraries(user, limit)
  const exact = all.find((l) => l.id === args.library)
  const matches = exact ? [exact] : all.filter((l) => l.name.toLowerCase() === String(args.library).toLowerCase())
  if (matches.length !== 1) throw new HttpError(400, matches.length ? 'That library name is ambiguous; use the exact library ID from seafile_list' : 'No such Seafile library; use seafile_list to choose an installed library')
  const library = matches[0]
  if (library.permission !== 'rw') throw new HttpError(403, 'That Seafile library is read-only')
  const checkDestination = async (during: AbortSignal) => {
    during.throwIfAborted()
    if (binding(user) !== identity) throw new HttpError(409, 'The linked Seafile account changed; request the save again for the new account')
    const folder = await listDir(user, library.id, target.dir, during).catch((e) => {
      if (e instanceof HttpError && e.status === 404) throw new HttpError(404, `Destination folder ${target.dir} does not exist; create it with seafile_mkdir only if the user requested it`)
      throw e
    })
    if (folder.perm !== 'rw') throw new HttpError(403, 'That destination folder is read-only')
    const existing = folder.entries.find((e) => e.name === target.name)
    if (existing?.dir) throw new HttpError(409, 'There is a folder with that filename')
    if (existing?.locked) throw new HttpError(409, 'That destination file is locked')
    if (existing && !overwrite) throw new HttpError(409, 'That file exists already: choose another filename, or set overwrite only if the user requested replacement')
    return !!existing
  }
  await checkDestination(limit)
  return {
    summary: { title: 'Save generated image to Seafile', rows: [['Image', id], ['Seafile', account.url], ['Library', `${library.name} (${library.id})`], ['Path', target.path], ['File', `image/png · ${source.size} bytes`], ['Overwrite', overwrite ? 'Replace this file if it exists' : 'Do not replace existing files']] },
    run: async () => {
      const during = AbortSignal.any([signal, AbortSignal.timeout(45_000)])
      const replaced = await checkDestination(during)
      const { url } = await fileLink(user, library.id, target.dir, 'upload', during)
      during.throwIfAborted()
      if (binding(user) !== identity) throw new HttpError(409, 'The linked Seafile account changed; request the save again for the new account')
      const image = artifact(user, id, true)
      const form = new FormData()
      form.append('parent_dir', target.dir)
      form.append('replace', overwrite ? '1' : '0')
      form.append('file', new Blob([Buffer.from(image.body!)], { type: 'image/png' }), target.name)
      const upload = new URL(url); upload.searchParams.set('ret-json', '1')
      const response = await guardedFetch(user, upload.href, { method: 'POST', body: form, signal: during, redirect: 'error' })
      const raw = (await readCapped(response, 64 * 1024)).toString('utf8')
      if (!response.ok) throw new HttpError(502, `Seafile could not save the image (HTTP ${response.status}${response.status === 507 || /quota|space/i.test(raw) ? '; storage quota or space exhausted' : ''}). The generated artifact is unchanged; check the destination before retrying.`)
      let saved: { name?: unknown; size?: unknown; id?: unknown } | undefined
      try { const result = JSON.parse(raw); saved = Array.isArray(result) ? result[0] : undefined } catch { /* Report an uncertain remote write, never invent a success. */ }
      if (!saved || typeof saved.name !== 'string' || !saved.name || saved.size !== image.size || /[\/\\\x00-\x1f\x7f]/.test(saved.name) || saved.name === '.' || saved.name === '..' || Buffer.byteLength(saved.name) > 255) throw new HttpError(502, 'Seafile did not confirm the saved filename and size. The upload may have completed; check the destination before retrying.')
      const path = `${target.dir === '/' ? '' : target.dir}/${saved.name}`
      return JSON.stringify({ saved: true, image_id: id, library: { id: library.id, name: library.name }, path, name: saved.name, bytes: image.size, mime: 'image/png', replaced, url: `/api/seafile/stream?repo=${encodeURIComponent(library.id)}&p=${encodeURIComponent(path)}`, files_path: `seafile://${library.id}${path}`, ...(saved.name !== target.name ? { warning: `Seafile saved as ${saved.name} because the requested name became occupied. No automatic retry or deletion was made.` } : {}) })
    },
  }
}
