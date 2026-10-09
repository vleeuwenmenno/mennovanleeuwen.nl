import { createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { User } from './auth.ts'
import { database, decrypt, encrypt, sha256 } from './db.ts'
import { HttpError, publicOrigin } from './http.ts'
import { fileLink, officeServer, seafile, seafileInfo } from './seafile.ts'

// OnlyOffice, the document server Seafile uses, editing Seafile's Office files in a window here.
// This side builds the editor's settings and signs them with the server's JWT secret (as Seahub
// does), pointing it at the file on Seafile's file server and at a callback here. When the
// editor saves (or everyone closes the document), OnlyOffice calls back with where to fetch the
// new version; it goes into Seafile as a new version of the file (its history keeps the old one).
//
// The callback comes from the document server, not a browser: it carries a sealed ticket (which
// user and file) and OnlyOffice's own signature, and both are checked.

/** What OnlyOffice can open, and what it can also edit. */
const TYPES: Record<string, 'word' | 'cell' | 'slide'> = {
  docx: 'word', doc: 'word', odt: 'word', rtf: 'word', txt: 'word', docm: 'word', dotx: 'word', epub: 'word', fodt: 'word',
  xlsx: 'cell', xls: 'cell', ods: 'cell', csv: 'cell', xlsm: 'cell', xltx: 'cell', fods: 'cell',
  pptx: 'slide', ppt: 'slide', odp: 'slide', ppsx: 'slide', pps: 'slide', potx: 'slide', fodp: 'slide',
}
const EDITABLE = new Set(['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'csv', 'docm', 'xlsm', 'txt', 'rtf'])

// --- JWT (HS256), as OnlyOffice expects -------------------------------------------------------

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url')

export function signJwt(payload: object, secret: string): string {
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = b64url(JSON.stringify(payload))
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')
  return `${head}.${body}.${sig}`
}

export function verifyJwt<T>(token: string, secret: string): T {
  const [head, body, sig] = token.split('.')
  if (!head || !body || !sig) throw new HttpError(403, 'Bad token')
  const want = createHmac('sha256', secret).update(`${head}.${body}`).digest()
  const got = Buffer.from(sig, 'base64url')
  if (got.length !== want.length || !timingSafeEqual(got, want)) throw new HttpError(403, 'Bad signature')
  const alg = (JSON.parse(Buffer.from(head, 'base64url').toString()) as { alg?: string }).alg
  if (alg !== 'HS256') throw new HttpError(403, 'Bad algorithm')
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as T & { exp?: number }
  if (payload.exp && payload.exp * 1000 < Date.now()) throw new HttpError(403, 'Token expired')
  return payload
}

// --- the editor's settings ----------------------------------------------------------------------

type Ticket = { u: number; r: string; p: string; e: number }

/** Where a save goes, sealed (encrypted and signed) for the callback URL. */
const seal = (t: Ticket) => encrypt(JSON.stringify(t))
function unseal(sealed: string): Ticket {
  let t: Ticket
  try {
    t = JSON.parse(decrypt(sealed)) as Ticket
  } catch {
    throw new HttpError(403, 'Bad ticket')
  }
  if (t.e < Date.now()) throw new HttpError(403, 'Ticket expired')
  return t
}

export type OfficeConfig = { api: string; config: Record<string, unknown> }

/**
 * The editor for a file in Seafile: the document server's api.js and the signed settings to start
 * it with. Read-only libraries and formats OnlyOffice only shows open in view mode.
 */
export async function officeConfig(req: IncomingMessage, user: User, repo: string | null, path: string | null, opts: { theme?: string | null; mobile?: boolean }): Promise<OfficeConfig> {
  const office = officeServer(user)
  if (!office) throw new HttpError(409, 'OnlyOffice is not set up (Settings → Integrations)')
  const id = String(repo ?? '')
  const p = String(path ?? '')
  const name = p.split('/').pop() ?? ''
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
  const documentType = ext === 'pdf' ? 'pdf' : TYPES[ext]
  if (!documentType) throw new HttpError(415, `OnlyOffice does not open .${ext} files`)

  // The file's id changes with every version: the key is per version, so a reopened file is fresh
  // and two windows on the same version edit together.
  const detail = await seafile<{ id: string; size: number }>(user, `/api2/repos/${encodeURIComponent(id)}/file/detail/?p=${encodeURIComponent(p)}`)
  const libs = await seafile<{ permission?: string }>(user, `/api/v2.1/repos/${encodeURIComponent(id)}/`).catch(() => ({ permission: 'r' }))
  const canEdit = EDITABLE.has(ext) && libs.permission === 'rw'
  const { url } = await fileLink(user, id, p, 'download')
  const key = `${id.slice(0, 8)}-${sha256(`${id}:${p}:${detail.id}`).slice(0, 32)}`
  const origin = process.env.OFFICE_CALLBACK_ORIGIN?.replace(/\/+$/, '') || publicOrigin(req)
  const ticket = seal({ u: user.id, r: id, p, e: Date.now() + 7 * 864e5 })
  const who = seafileInfo(user)

  const config: Record<string, unknown> = {
    type: opts.mobile ? 'mobile' : 'desktop',
    documentType,
    document: {
      fileType: ext,
      key,
      title: name,
      url,
      permissions: { edit: canEdit, download: true, print: true, comment: canEdit, review: canEdit },
    },
    editorConfig: {
      mode: canEdit ? 'edit' : 'view',
      lang: 'en',
      callbackUrl: `${origin}/api/office/callback?t=${encodeURIComponent(ticket)}`,
      user: { id: `mvlos-${user.id}`, name: who?.name || user.name || user.login },
      customization: {
        autosave: true,
        forcesave: true,
        compactHeader: true,
        toolbarNoTabs: false,
        hideRightMenu: false,
        uiTheme: opts.theme === 'light' ? 'theme-light' : 'theme-dark',
        goback: false,
      },
    },
  }
  config.token = signJwt(config, office.secret)
  return { api: `${office.url}/web-apps/apps/api/documents/api.js`, config }
}

// --- saving -----------------------------------------------------------------------------------

type Callback = { key?: string; status?: number; url?: string; users?: string[]; forcesavetype?: number }

/**
 * OnlyOffice's word on a document: 1 being edited, 2 ready to save (everyone closed it), 4 closed
 * without changes, 6 saved while still open (forcesave), 3 and 7 a save that went wrong. Answers
 * { error: 0 } when all is well, which is what OnlyOffice waits for.
 */
export async function officeCallback(req: IncomingMessage, sealed: string | null, body: Callback & { token?: string }): Promise<{ error: number }> {
  if (!sealed) throw new HttpError(403, 'No ticket')
  const ticket = unseal(sealed)
  const row = database().prepare('SELECT id, login, name, avatar, github_token FROM users WHERE id = ?').get(ticket.u) as { id: number; login: string; name: string | null; avatar: string | null; github_token: string } | undefined
  if (!row) throw new HttpError(403, 'No such user')
  const user: User = { id: row.id, login: row.login, name: row.name, avatar: row.avatar, githubToken: '' }
  const office = officeServer(user)
  if (!office) throw new HttpError(409, 'OnlyOffice is not set up')

  // OnlyOffice signs the callback: in the body's token, or the Authorization header.
  const header = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
  let data: Callback
  if (body.token) data = verifyJwt<Callback>(body.token, office.secret)
  else if (header) data = verifyJwt<{ payload: Callback }>(header, office.secret).payload
  else throw new HttpError(403, 'Unsigned callback')

  if (data.status !== 2 && data.status !== 6) {
    if (data.status === 3 || data.status === 7) console.error(`OnlyOffice could not save ${ticket.p} (status ${data.status})`)
    return { error: 0 }
  }
  if (!data.url) return { error: 1 }
  try {
    await saveVersion(user, ticket.r, ticket.p, data.url)
    return { error: 0 }
  } catch (e) {
    console.error(`Saving ${ticket.p} from OnlyOffice failed:`, (e as Error).message)
    return { error: 1 }
  }
}

/** Fetches the edited file from the document server and puts it in Seafile as a new version. */
async function saveVersion(user: User, repo: string, path: string, from: string) {
  const res = await fetch(from, { signal: AbortSignal.timeout(60_000) })
  if (!res.ok) throw new Error(`the document server answered ${res.status}`)
  const blob = await res.blob()
  const dir = path.split('/').slice(0, -1).join('/') || '/'
  const { url: link } = await fileLink(user, repo, dir, 'update')
  const form = new FormData()
  form.append('target_file', path)
  form.append('file', blob, path.split('/').pop())
  const up = await fetch(`${link}?ret-json=1`, { method: 'POST', body: form, signal: AbortSignal.timeout(120_000) })
  if (!up.ok) throw new Error(`Seafile answered ${up.status}: ${(await up.text()).slice(0, 200)}`)
}
