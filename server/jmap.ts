import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { loadsRemote, readRemoteSettings, type RemoteSettings } from '../src/data/mailRemote.ts'
import { allows, normalizePrefs } from '../src/data/notifySources.ts'
import { TASK_HEADER, type ArrivedMail } from '../src/data/agentTaskMail.ts'
import { accounts, isAdmin, requireUser, type User } from './auth.ts'
import { database, decrypt, encrypt, sha256, onUserGone } from './db.ts'
import { guardedFetch, readCapped, rethrowEgress } from './egress.ts'
import { bodyRead, HttpError, json, readJson, SECURITY, UNTRUSTED } from './http.ts'
import { parseInvite, type Invite } from './imip.ts'
import { sanitizeHtml } from './mailhtml.ts'
import { serveSenderIcon } from './mailicons.ts'
import { claimOnce, notify, registerWatcher, tellPages } from './notifier.ts'
import { readState } from './state.ts'
import { bindPrivateAccess, requirePrivateRequest, privateSessionBinding, privateSignal, runPrivateRequest, withProviderGuard, withoutPrivateRequest } from './privateRequest.ts'
import type { SessionBinding } from './liveSessions.ts'

// Mail over JMAP (RFC 8620, RFC 8621): Fastmail, Stalwart and other servers that speak it. An
// account is a JMAP session URL (found from a host through /.well-known/jmap; Fastmail's is the
// default) and an API token, stored encrypted. The token never reaches the browser: the Mail app
// (src/apps/mail) asks this server's small per-user API under /api/mail, and every JMAP call goes
// from here, through server/egress.ts, batched with back-references where one answer feeds the next.
//
// - Mailboxes, identities, threads (Email/query with collapseThreads), whole conversations
//   (Thread/get + Email/get) with their HTML made safe here (server/mailhtml.ts) and calendar
//   invitations read (server/imip.ts).
// - Changes: flags, moves (archive, trash, junk), permanent deletes only from Trash, drafts
//   (Email/set in Drafts, replaced on every save) and sending (EmailSubmission/set with
//   onSuccessUpdateEmail: out of Drafts into Sent).
// - Blobs: attachments uploaded and downloaded through here; inline (cid:) pictures put into the
//   HTML as data: URIs, or (big ones) through short-lived sealed links that need no session cookie.
// - Push: per linked account, while useful (mail notifications on, or Mail used lately), a JMAP
//   EventSource, or polling when the server has none or it keeps failing. New mail in the Inbox
//   comes as a notification (server/notifier.ts, web push included) and open Mail windows update.
//
// IMAP and SMTP are not supported (yet).

export const FASTMAIL_SESSION = 'https://api.fastmail.com/jmap/session'
const CORE = 'urn:ietf:params:jmap:core'
const MAIL = 'urn:ietf:params:jmap:mail'
const SUBMISSION = 'urn:ietf:params:jmap:submission'
/** Accounts one user may link. */
const MAX_ACCOUNTS = 5
/** A JMAP Id: 1 to 255 characters of the URL-safe base64 alphabet. Checked before any goes into a URL or a call. */
const ID = /^[A-Za-z0-9_-]{1,255}$/
const EMAIL = /^[^\s@<>(),;:"\\]+@[^\s@<>(),;:"\\]+$/
const TIMEOUT = 20_000

export type MailAccountInfo = { id: number; label: string; username: string; url: string }
type Linked = MailAccountInfo & { user: User; token: string; key: string }
type Row = { link_id: string; id: number; user_id: number; label: string; session_url: string; username: string; token: string; push_state: string | null }

// ---------------------------------------------------------------------------------------------
// Accounts

let ready = false
function table() {
  if (ready) return database()
  database().exec(`CREATE TABLE IF NOT EXISTS jmap_accounts (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    session_url TEXT NOT NULL,
    username TEXT NOT NULL,
    token TEXT NOT NULL,
    push_state TEXT,
    created_at INTEGER NOT NULL
  )`)
  const columns = database().prepare('PRAGMA table_info(jmap_accounts)').all() as { name: string }[]
  if (!columns.some((c) => c.name === 'link_id')) database().exec("ALTER TABLE jmap_accounts ADD COLUMN link_id TEXT NOT NULL DEFAULT ''")
  database().exec("UPDATE jmap_accounts SET link_id = lower(hex(randomblob(32))) WHERE link_id = ''")
  ready = true
  return database()
}

export function listMail(user: User): MailAccountInfo[] {
  const rows = table().prepare('SELECT id, label, session_url, username FROM jmap_accounts WHERE user_id = ? ORDER BY id').all(user.id) as unknown as Row[]
  return rows.map((r) => ({ id: r.id, label: r.label, username: r.username, url: r.session_url }))
}

function linked(user: User, id: unknown): Linked {
  const row = table().prepare('SELECT * FROM jmap_accounts WHERE user_id = ? AND id = ?').get(user.id, Number(id)) as unknown as Row | undefined
  if (!row) throw new HttpError(404, 'No such mail account')
  // Rows from older callers receive their identity once, before any provider await.
  if (!row.link_id) {
    row.link_id = randomBytes(32).toString('hex')
    table().prepare("UPDATE jmap_accounts SET link_id = ? WHERE id = ? AND user_id = ? AND link_id = ''").run(row.link_id, row.id, user.id)
  }
  return { key: rowKey(row), id: row.id, label: row.label, username: row.username, url: row.session_url, user, token: decrypt(row.token) }
}

// A DB row number is reusable. Each link has a durable random identity, with owner and the
// sealed credential/provider record in its key. Replacement never inherits a cache or push line.
const rowKey = (r: Row) => `${r.user_id}:${r.id}:${r.link_id}:${sha256(JSON.stringify([r.session_url, r.username, r.token]))}`
const invalidators = new Map<string, Set<() => void>>()
function onMailChanged(key: string, end: () => void) {
  const listeners = invalidators.get(key) ?? new Set<() => void>()
  invalidators.set(key, listeners.add(end))
  return () => { listeners.delete(end); if (!listeners.size) invalidators.delete(key) }
}
function checkMailLink(acc: Linked) {
  const row = table().prepare('SELECT * FROM jmap_accounts WHERE user_id = ? AND id = ?').get(acc.user.id, acc.id) as Row | undefined
  if (!row || rowKey(row) !== acc.key || !userById(acc.user.id)) throw new HttpError(409, 'The mail account changed: try again')
}
function assertMail(acc: Linked) { requirePrivateRequest(acc.user); checkMailLink(acc) }
function bindMailRequest(acc: Linked) {
  bindPrivateAccess(() => checkMailLink(acc), (end) => onMailChanged(acc.key, end), `mail:${acc.key}`)
}
/** All account operations carry prepared link authority, including agent tools and pollers. */
function mailOperation<A extends unknown[], T>(work: (acc: Linked, ...args: A) => Promise<T>) {
  return (acc: Linked, ...args: A): Promise<T> => withProviderGuard(() => checkMailLink(acc), async () => {
    bindMailRequest(acc)
    assertMail(acc)
    const result = await work(acc, ...args)
    assertMail(acc)
    return result
  })
}

/** Retains provider cancellation until the body ends, including attachment and SSE streams. */
async function mailFetch(acc: Linked, url: string, init: RequestInit): Promise<Response> {
  const gone = new AbortController()
  const stop = onMailChanged(acc.key, () => gone.abort(new HttpError(409, 'The mail account changed: try again')))
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  const signal = privateSignal(AbortSignal.any([gone.signal, ...(init.signal ? [init.signal] : [])]))!
  const cancel = () => { void reader?.cancel(signal.reason).catch(() => {}); stop() }
  signal.addEventListener('abort', cancel, { once: true })
  const done = () => { stop(); signal.removeEventListener('abort', cancel) }
  try {
    return await withProviderGuard(() => checkMailLink(acc), async () => {
      assertMail(acc)
      const response = await guardedFetch(acc.user, url, { ...init, signal })
      assertMail(acc)
      if (!response.body) { done(); return response }
      reader = response.body.getReader()
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            signal.throwIfAborted(); assertMail(acc)
            const next = await reader!.read()
            signal.throwIfAborted(); assertMail(acc)
            if (next.done) { done(); controller.close() }
            else controller.enqueue(next.value)
          } catch (error) { gone.abort(error); done(); controller.error(error) }
        },
        async cancel(reason) { gone.abort(reason); done(); await reader!.cancel(reason).catch(() => {}) },
      }, { highWaterMark: 0 })
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
    })
  } catch (error) { gone.abort(error); done(); throw error }
}

/** A session URL from what was typed: a host means its /.well-known/jmap. */
function sessionUrl(input: string | undefined): string {
  let raw = (input ?? '').trim() || FASTMAIL_SESSION
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new HttpError(400, 'That is not a URL')
  }
  if (url.username || url.password) throw new HttpError(400, 'Leave credentials out of the URL')
  if (url.pathname === '/' && !url.search) url.pathname = '/.well-known/jmap'
  return url.href
}

/** Checks the token against the session (proving it works and has mail), then stores it. */
export async function addMail(user: User, body: { url?: string; token?: string; label?: string }): Promise<MailAccountInfo> {
  const token = body.token?.trim()
  if (!token) throw new HttpError(400, 'An API token is required')
  if (token.length > 4096 || /\s/.test(token)) throw new HttpError(400, 'That does not look like an API token')
  const start = sessionUrl(body.url)
  // Fastmail tokens all start with fmu1-: anything else is the wrong string (a saved password
  // autofilled, an app password), and Fastmail only answers that with a bare 401.
  if (/(^|\.)fastmail\.com$/.test(new URL(start).hostname) && !token.startsWith('fmu1-')) throw new HttpError(400, "That isn't a Fastmail API token: they start with fmu1-. Make one at Settings → Privacy & Security → Manage API tokens.")
  const links = () => JSON.stringify((table().prepare('SELECT * FROM jmap_accounts WHERE user_id = ? ORDER BY id').all(user.id) as Row[]).map(rowKey))
  const before = links()
  const check = () => {
    if (!userById(user.id) || links() !== before) throw new HttpError(409, 'The mail accounts changed: try again')
  }
  const { session, url } = await withProviderGuard(check, () => readSession(user, start, token))
  requirePrivateRequest(user)
  check()
  const label = (body.label?.trim() || (/fastmail/.test(url) ? 'Fastmail' : new URL(url).host)).slice(0, 40)
  const db = table()
  const existing = db.prepare('SELECT id FROM jmap_accounts WHERE user_id = ? AND session_url = ? AND username = ?').get(user.id, url, session.username) as { id: number } | undefined
  if (existing) {
    // The same account again (a new token): keep it, with its place in the list.
    const old = linked(user, existing.id)
    db.prepare('UPDATE jmap_accounts SET label = ?, token = ?, link_id = ?, push_state = NULL WHERE id = ? AND user_id = ?').run(label, encrypt(token), randomBytes(32).toString('hex'), existing.id, user.id)
    forget(old.key)
    return { id: existing.id, label, username: session.username, url }
  }
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM jmap_accounts WHERE user_id = ?').get(user.id) as { n: number }
  if (n >= MAX_ACCOUNTS) throw new HttpError(400, `At most ${MAX_ACCOUNTS} mail accounts`)
  const r = db.prepare('INSERT INTO jmap_accounts (user_id, label, session_url, username, token, created_at, link_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(user.id, label, url, session.username, encrypt(token), Date.now(), randomBytes(32).toString('hex'))
  return { id: Number(r.lastInsertRowid), label, username: session.username, url }
}

export function removeMail(user: User, id: number) {
  requirePrivateRequest(user)
  const old = listMail(user).some((a) => a.id === id) ? linked(user, id) : null
  table().prepare('DELETE FROM jmap_accounts WHERE user_id = ? AND id = ?').run(user.id, id)
  if (old) forget(old.key)
}

/** Drops what is kept in memory about an account (its session, mailboxes, push line). */
function forget(id: string) {
  for (const end of invalidators.get(id) ?? []) end()
  invalidators.delete(id)
  sessions.delete(id)
  metas.delete(id)
  people.delete(id)
  stopLive(id)
}

onUserGone((userId) => {
  for (const id of new Set([...sessions.keys(), ...metas.keys(), ...people.keys(), ...live.keys(), ...invalidators.keys()])) if (id.startsWith(`${userId}:`)) forget(id)
  lastUse.delete(userId)
})

// ---------------------------------------------------------------------------------------------
// Sessions and calls

type Session = {
  apiUrl: string
  downloadUrl: string
  uploadUrl: string
  eventSourceUrl: string | null
  accountId: string
  username: string
  maxSizeUpload: number
  maxObjectsInSet: number
  submission: boolean
  state: string
  at: number
}
const sessions = new Map<string, Session>()
const SESSION_TTL = 30 * 60_000

const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'User-Agent': 'mvlos' })
const hostOf = (url: string) => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** The server's own reason for a refusal, from the first line of its text body (or the message of a JSON one), as plain text; empty when it gave none. */
async function reasonOf(res: Response): Promise<string> {
  const raw = await readCapped(res, 4096).then((b) => b.toString('utf8')).catch(() => '')
  let line = raw.split('\n').find((l) => l.trim()) ?? ''
  if (line.trimStart().startsWith('{')) {
    try {
      const j = JSON.parse(raw) as Record<string, unknown>
      line = [j.detail, j.description, j.message, j.error, j.title].find((v): v is string => typeof v === 'string') ?? ''
    } catch {
      line = ''
    }
  }
  // Markup is an error page, not a reason.
  if (/^\s*</.test(line)) return ''
  // eslint-disable-next-line no-control-regex
  line = line.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  return line.length > 120 ? `${line.slice(0, 119)}…` : line
}

/** Reads a session, following redirects (/.well-known/jmap points elsewhere) with the token kept, over https only. */
async function readSession(user: User, start: string, token: string, acc?: Linked): Promise<{ session: Session; url: string }> {
  const fetchSession = (url: string, init: RequestInit) => acc ? mailFetch(acc, url, init) : guardedFetch(user, url, init)
  let at = start
  for (let hop = 0; hop < 4; hop++) {
    const res = await fetchSession(at, { headers: { ...bearer(token), Accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT) }).catch((e) => (rethrowEgress(e), null))
    if (!res) throw new HttpError(502, `${hostOf(at)} did not answer`)
    const location = res.headers.get('location')
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel().catch(() => {})
      const next = new URL(location, at)
      if (new URL(at).protocol === 'https:' && next.protocol !== 'https:') throw new HttpError(400, `${hostOf(at)} sent the session to an insecure address`)
      at = next.href
      continue
    }
    if (res.status === 401 || res.status === 403) {
      const why = await reasonOf(res)
      throw new HttpError(400, `${hostOf(at)} refused the token${why ? `: ${why}` : ''}`)
    }
    if (!res.ok) throw new HttpError(400, `${hostOf(at)} answered ${res.status}: is that a JMAP server?`)
    let body: Record<string, unknown>
    try {
      body = JSON.parse((await readCapped(res, 1024 * 1024)).toString('utf8'))
    } catch {
      throw new HttpError(400, `${hostOf(at)} did not answer with a JMAP session`)
    }
    return { session: toSession(body, at), url: start === at ? start : at }
  }
  throw new HttpError(400, `${hostOf(start)} redirected too often`)
}

function toSession(j: Record<string, unknown>, base: string): Session {
  const caps = (j.capabilities ?? {}) as Record<string, Record<string, unknown>>
  const primary = (j.primaryAccounts ?? {}) as Record<string, string>
  const accountId = primary[MAIL]
  const abs = (v: unknown) => (typeof v === 'string' && v ? new URL(v, base).href : null)
  const apiUrl = abs(j.apiUrl)
  const downloadUrl = typeof j.downloadUrl === 'string' ? j.downloadUrl : null
  const uploadUrl = typeof j.uploadUrl === 'string' ? j.uploadUrl : null
  if (!caps[CORE] || !apiUrl || !downloadUrl || !uploadUrl) throw new HttpError(400, 'That is not a JMAP session')
  if (!caps[MAIL] || !accountId || !ID.test(accountId)) throw new HttpError(400, 'That account has no mail (does the token have Mail access?)')
  const core = caps[CORE]
  const accountCaps = (((j.accounts ?? {}) as Record<string, { accountCapabilities?: Record<string, unknown> }>)[accountId]?.accountCapabilities ?? {}) as Record<string, unknown>
  return {
    apiUrl,
    downloadUrl: template(downloadUrl, base),
    uploadUrl: template(uploadUrl, base),
    eventSourceUrl: typeof j.eventSourceUrl === 'string' && j.eventSourceUrl ? template(j.eventSourceUrl, base) : null,
    accountId,
    username: typeof j.username === 'string' && j.username ? j.username.slice(0, 200) : accountId,
    maxSizeUpload: Math.min(Number(core.maxSizeUpload) || 50_000_000, 50_000_000),
    maxObjectsInSet: Math.max(1, Math.min(Number(core.maxObjectsInSet) || 500, 500)),
    submission: !!caps[SUBMISSION] && (SUBMISSION in accountCaps || !!primary[SUBMISSION]),
    state: typeof j.state === 'string' ? j.state : '',
    at: Date.now(),
  }
}

/** A URL template (RFC 6570 level 1) resolved against the session's URL, its {variables} kept. */
const template = (v: string, base: string) => new URL(v.replace(/[{}]/g, (c) => (c === '{' ? '%7B' : '%7D')), base).href.replace(/%7B(\w+)%7D/gi, '{$1}')

/** A URL template filled in, each value escaped. */
const fill = (template: string, values: Record<string, string>) => template.replace(/\{(\w+)\}/g, (all, k: string) => (k in values ? encodeURIComponent(values[k]) : all))

async function sessionInner(acc: Linked, fresh = false): Promise<Session> {
  const known = sessions.get(acc.key)
  if (known && !fresh && Date.now() - known.at < SESSION_TTL) return known
  const { session: s } = await readSession(acc.user, acc.url, acc.token, acc).catch((e: HttpError) => {
    throw new HttpError(e.status === 400 ? 502 : e.status, `${acc.label}: ${e.message}`)
  })
  assertMail(acc)
  sessions.set(acc.key, s)
  return s
}

type Call = [string, Record<string, unknown>, string]
type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

/** The answers to one request, by call id; a method error throws, with the server's words. */
class Answers {
  private list: [string, Json, string][]
  constructor(list: [string, Json, string][]) {
    this.list = list
  }
  all(id: string): [string, Json][] {
    return this.list.filter((r) => r[2] === id).map((r) => [r[0], r[1]])
  }
  error(id: string): Json | null {
    return this.all(id).find(([name]) => name === 'error')?.[1] ?? null
  }
  get(id: string, name?: string): Json {
    const err = this.error(id)
    if (err) throw new HttpError(err.type === 'notFound' ? 404 : 502, `The mail server refused ${name ?? 'that'}: ${err.description ?? err.type ?? 'error'}`)
    const found = this.all(id).find(([n]) => !name || n === name)
    if (!found) throw new HttpError(502, `The mail server did not answer ${name ?? id}`)
    return found[1]
  }
}

/** One JMAP request: the calls in order, later ones free to refer back to earlier answers. */
async function jmapInner(acc: Linked, calls: Call[]): Promise<Answers> {
  const s = await session(acc)
  const using = [CORE, MAIL, ...(calls.some(([m]) => m.startsWith('EmailSubmission/') || m.startsWith('Identity/')) ? [SUBMISSION] : [])]
  const res = await mailFetch(acc, s.apiUrl, {
    method: 'POST',
    headers: { ...bearer(acc.token), 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ using, methodCalls: calls.map(([m, args, id]) => [m, { accountId: s.accountId, ...args }, id]) }),
    signal: AbortSignal.timeout(TIMEOUT),
  }).catch((e) => (rethrowEgress(e), null))
  if (!res) throw new HttpError(502, `${acc.label} did not answer`)
  if (res.status === 401 || res.status === 403) {
    sessions.delete(acc.key)
    const why = await reasonOf(res)
    throw new HttpError(502, `${acc.label} refused the token${why ? ` (${why})` : ''}: link it again in Settings → Integrations → Mail`)
  }
  const text = (await readCapped(res, 64 * 1024 * 1024)).toString('utf8')
  let body: Json
  try {
    body = JSON.parse(text)
  } catch {
    throw new HttpError(502, `${acc.label} answered ${res.status}`)
  }
  if (!res.ok) throw new HttpError(502, `${acc.label} answered ${res.status}: ${body.detail ?? body.type ?? ''}`.trim())
  // The session changed (new mailboxes' URLs, another account): read it again next time.
  if (body.sessionState && s.state && body.sessionState !== s.state) sessions.delete(acc.key)
  return new Answers(Array.isArray(body.methodResponses) ? body.methodResponses : [])
}

// ---------------------------------------------------------------------------------------------
// Mailboxes and identities

export type Mailbox = { id: string; name: string; parentId: string | null; role: string | null; sortOrder: number; total: number; unread: number; totalThreads: number; unreadThreads: number }
export type Identity = { id: string; name: string; email: string; replyTo: Address[] | null; bcc: Address[] | null; textSignature: string }
type Address = { name: string | null; email: string }
type Meta = { at: number; mailboxes: Mailbox[]; identities: Identity[]; role: (r: string) => string | null }
const metas = new Map<string, Meta>()

const MAILBOX_PROPS = ['id', 'name', 'parentId', 'role', 'sortOrder', 'totalEmails', 'unreadEmails', 'totalThreads', 'unreadThreads']

async function metaInner(acc: Linked, fresh = false): Promise<Meta> {
  const known = metas.get(acc.key)
  if (known && !fresh && Date.now() - known.at < 60_000) return known
  const s = await session(acc)
  const r = await jmap(acc, [['Mailbox/get', { ids: null, properties: MAILBOX_PROPS }, 'm'], ...(s.submission ? ([['Identity/get', { ids: null }, 'i']] as Call[]) : [])])
  const mailboxes: Mailbox[] = (r.get('m', 'Mailbox/get').list as Json[]).map((m) => ({
    id: String(m.id),
    name: String(m.name ?? ''),
    parentId: m.parentId ?? null,
    role: m.role ?? null,
    sortOrder: Number(m.sortOrder) || 0,
    total: Number(m.totalEmails) || 0,
    unread: Number(m.unreadEmails) || 0,
    totalThreads: Number(m.totalThreads) || 0,
    unreadThreads: Number(m.unreadThreads) || 0,
  }))
  const identities: Identity[] = s.submission && !r.error('i') ? (r.get('i', 'Identity/get').list as Json[]).map((i) => ({ id: String(i.id), name: String(i.name ?? ''), email: String(i.email ?? ''), replyTo: i.replyTo ?? null, bcc: i.bcc ?? null, textSignature: String(i.textSignature ?? '') })) : []
  const m: Meta = { at: Date.now(), mailboxes, identities, role: (role) => mailboxes.find((b) => b.role === role)?.id ?? null }
  assertMail(acc)
  metas.set(acc.key, m)
  return m
}

// ---------------------------------------------------------------------------------------------
// Threads and messages

export type ThreadRow = {
  id: string
  threadId: string
  mailboxIds: string[]
  from: Address[]
  to: Address[]
  subject: string
  preview: string
  receivedAt: string
  seen: boolean
  flagged: boolean
  answered: boolean
  draft: boolean
  hasAttachment: boolean
  /** Messages in the conversation. */
  count: number
}

const ROW_PROPS = ['id', 'threadId', 'mailboxIds', 'keywords', 'from', 'to', 'subject', 'preview', 'receivedAt', 'hasAttachment']
const addresses = (v: unknown): Address[] => (Array.isArray(v) ? v.filter((a) => a && typeof a.email === 'string').map((a) => ({ name: typeof a.name === 'string' && a.name ? a.name : null, email: a.email })) : [])

function toRow(e: Json, count: number): ThreadRow {
  const k = e.keywords ?? {}
  return {
    id: e.id,
    threadId: e.threadId,
    mailboxIds: Object.keys(e.mailboxIds ?? {}),
    from: addresses(e.from),
    to: addresses(e.to),
    subject: String(e.subject ?? ''),
    preview: String(e.preview ?? ''),
    receivedAt: String(e.receivedAt ?? ''),
    seen: !!k.$seen,
    flagged: !!k.$flagged,
    answered: !!k.$answered,
    draft: !!k.$draft,
    hasAttachment: !!e.hasAttachment,
    count,
  }
}

/**
 * A search as typed, into a JMAP filter: free words search everything, and from:, to:, cc:,
 * subject:, has:attachment, is:unread, is:flagged, after:YYYY-MM-DD and before:YYYY-MM-DD narrow it.
 * "Quoted words" stay together.
 */
export function parseSearch(q: string): Json | null {
  const filter: Json = {}
  const words: string[] = []
  for (const m of q.matchAll(/(\w+):(?:"([^"]*)"|(\S+))|"([^"]*)"|(\S+)/g)) {
    const [, key, quotedValue, value, quoted, word] = m
    const v = (quotedValue ?? value ?? '').slice(0, 200)
    const k = key?.toLowerCase()
    if (k === 'from' || k === 'to' || k === 'cc' || k === 'bcc' || k === 'subject' || k === 'body') filter[k] = v
    else if (k === 'has' && /^attach/i.test(v)) filter.hasAttachment = true
    else if (k === 'is' && v === 'unread') filter.notKeyword = '$seen'
    else if (k === 'is' && (v === 'flagged' || v === 'starred')) filter.hasKeyword = '$flagged'
    else if ((k === 'after' || k === 'before') && /^\d{4}-\d{2}-\d{2}$/.test(v)) filter[k] = new Date(`${v}T00:00:00Z`).toISOString().replace('.000', '')
    else words.push((quoted ?? word ?? m[0]).slice(0, 200))
  }
  if (words.length) filter.text = words.join(' ')
  return Object.keys(filter).length ? filter : null
}

/** A page of conversations: a mailbox's, or a search across every mailbox but Trash and Junk. */
async function listThreadsInner(acc: Linked, opts: { mailbox?: string | null; q?: string | null; position?: number; limit?: number }) {
  const m = await meta(acc)
  const search = opts.q ? parseSearch(opts.q) : null
  let filter: Json | null
  if (search) {
    const away = [m.role('trash'), m.role('junk')].filter((x): x is string => !!x)
    filter = { ...search, ...(opts.mailbox && ID.test(opts.mailbox) ? { inMailbox: opts.mailbox } : away.length ? { inMailboxOtherThan: away } : {}) }
  } else {
    if (!opts.mailbox || !ID.test(opts.mailbox)) throw new HttpError(400, 'Which mailbox?')
    filter = { inMailbox: opts.mailbox }
  }
  const position = Math.max(0, Math.min(Number(opts.position) || 0, 1_000_000))
  const limit = Math.max(1, Math.min(Number(opts.limit) || 50, 200))
  const r = await jmap(acc, [
    ['Email/query', { filter, sort: [{ property: 'receivedAt', isAscending: false }], collapseThreads: true, position, limit, calculateTotal: true }, 'q'],
    ['Email/get', { '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: ROW_PROPS }, 'g'],
    ['Thread/get', { '#ids': { resultOf: 'g', name: 'Email/get', path: '/list/*/threadId' } }, 't'],
  ])
  const q = r.get('q', 'Email/query')
  const emails = new Map((r.get('g', 'Email/get').list as Json[]).map((e) => [e.id, e]))
  const sizes = new Map((r.get('t', 'Thread/get').list as Json[]).map((t) => [t.id, (t.emailIds ?? []).length]))
  const rows = (q.ids as string[]).map((id) => emails.get(id)).filter(Boolean).map((e) => toRow(e!, sizes.get(e!.threadId) ?? 1))
  return { rows, total: typeof q.total === 'number' ? q.total : null, position: q.position ?? position }
}

export type Attachment = { blobId: string; name: string; type: string; size: number; cid: string | null }
export type Message = ThreadRow & {
  cc: Address[]
  bcc: Address[]
  replyTo: Address[]
  sentAt: string | null
  messageId: string[]
  inReplyTo: string[]
  references: string[]
  /** Safe HTML, for the sandboxed frame. */
  html: string | null
  /** Plain text, when the message has no HTML. */
  text: string | null
  blocked: number
  trackers: number
  /** Whether remote images were let in. */
  images: boolean
  truncated: boolean
  attachments: Attachment[]
  invite: Invite | null
}

const MESSAGE_PROPS = [...ROW_PROPS, 'cc', 'bcc', 'replyTo', 'sentAt', 'messageId', 'inReplyTo', 'references', 'textBody', 'htmlBody', 'attachments', 'bodyValues']
const BODY_ARGS = { fetchTextBodyValues: true, fetchHTMLBodyValues: true, maxBodyValueBytes: 1_000_000 }
const escapeText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * The remote-content settings (Settings → Apps → Mail, synced state "mail"): whether remote
 * images and styles load without being asked, for everyone or for the senders on the allow list.
 * Read here so that remote content stays blocked until the settings or a "Load images" say so.
 */
function remoteSettings(user: User): RemoteSettings {
  return readRemoteSettings(readState(user).mail?.value)
}

/** Inline pictures up to this size each, and this much in all per message, go into its HTML as data: URIs. */
const INLINE_EACH = 1_500_000
const INLINE_TOTAL = 6_000_000

/** A sealed, short-lived link to one of a message's inline parts: the message frame loads it without cookies. */
function inlineLink(acc: Linked, part: { blobId: string; type: string }): string {
  const sealed = encrypt(JSON.stringify({ k: acc.key, session: privateSessionBinding(), u: acc.user.id, a: acc.id, b: part.blobId, t: part.type, e: Date.now() + 12 * 3600_000 }))
  return `/api/mail/inline/${Buffer.from(sealed).toString('base64url')}`
}

async function renderInner(acc: Linked, e: Json, images: boolean): Promise<Message> {
  const values = (e.bodyValues ?? {}) as Record<string, { value?: string; isTruncated?: boolean }>
  const parts = (list: unknown): Json[] => (Array.isArray(list) ? list : [])
  const htmlParts = parts(e.htmlBody)
  const textParts = parts(e.textBody)
  const files = parts(e.attachments)
  const valid = (p: Json) => typeof p.blobId === 'string' && ID.test(p.blobId)
  // Inline parts by Content-ID, for cid: images.
  const byCid = new Map<string, Json>()
  for (const p of [...files, ...htmlParts]) if (p.cid && valid(p)) byCid.set(String(p.cid).replace(/^<|>$/g, ''), p)
  let html: string | null = null
  let text: string | null = null
  let blocked = 0
  let trackers = 0
  let usedCids: string[] = []
  const truncated = Object.values(values).some((v) => v.isTruncated)
  if (htmlParts.some((p) => p.type === 'text/html')) {
    // The parts in order: HTML as it is, text as text, pictures in between where they were.
    const source = htmlParts
      .map((p) => {
        if (p.type === 'text/html') return values[p.partId]?.value ?? ''
        if (String(p.type).startsWith('text/')) return `<div style="white-space: pre-wrap">${escapeText(values[p.partId]?.value ?? '')}</div>`
        if (String(p.type).startsWith('image/') && valid(p)) return `<img src="cid:${p.cid ? encodeURIComponent(String(p.cid).replace(/^<|>$/g, '')) : `blob.${p.blobId}`}" alt="">`
        return ''
      })
      .join('\n')
    // The pictures the HTML shows: small ones go into it as data: URIs (the sandboxed frame then
    // loads nothing for them at all), bigger ones through a sealed link.
    const partOf = (id: string) => (id.startsWith('blob.') ? htmlParts.find((x) => x.blobId === id.slice(5)) : byCid.get(id))
    const wanted = new Set<Json>()
    for (const m of source.matchAll(/cid:([^"'\s>)]+)/gi)) {
      let id = m[1]
      try {
        id = decodeURIComponent(id)
      } catch {
        /* as written */
      }
      const p = partOf(id.replace(/^<|>$/g, ''))
      if (p && SHOWABLE.test(String(p.type))) wanted.add(p)
    }
    const embedded = new Map<string, string>()
    let room = INLINE_TOTAL
    await Promise.all(
      [...wanted].map(async (p) => {
        const size = Number(p.size) || 0
        if (size > INLINE_EACH || size > room) return
        room -= size
        const bytes = await readCapped(await fetchBlob(acc, p.blobId, 'image', p.type), INLINE_EACH).catch(() => null)
        if (bytes) embedded.set(p.blobId, `data:${String(p.type).toLowerCase()};base64,${bytes.toString('base64')}`)
      }),
    )
    const cid = (id: string) => {
      const p = partOf(id)
      if (!p || !SHOWABLE.test(String(p.type))) return null
      return embedded.get(p.blobId) ?? inlineLink(acc, { blobId: p.blobId, type: p.type })
    }
    const s = sanitizeHtml(source, { images, cid })
    html = s.html
    blocked = s.blocked
    trackers = s.trackers
    usedCids = s.cids
  } else {
    text = textParts
      .filter((p) => String(p.type).startsWith('text/'))
      .map((p) => values[p.partId]?.value ?? '')
      .join('\n')
  }
  const used = new Set(usedCids)
  const attachments: Attachment[] = files
    .filter(valid)
    .filter((p) => !(p.cid && used.has(String(p.cid).replace(/^<|>$/g, ''))))
    .map((p) => ({ blobId: p.blobId, name: String(p.name ?? '') || (String(p.type).startsWith('text/calendar') ? 'invite.ics' : 'attachment'), type: String(p.type ?? 'application/octet-stream'), size: Number(p.size) || 0, cid: p.cid ? String(p.cid) : null }))
  // A calendar invitation: the first text/calendar part or .ics file, read for its card.
  let invite: Invite | null = null
  const ics = [...files, ...textParts, ...htmlParts].find((p) => valid(p) && (/^text\/calendar\b/i.test(String(p.type)) || /\.ics$/i.test(String(p.name ?? ''))))
  if (ics) {
    const value = values[ics.partId]?.value
    const body = value ?? (await blobText(acc, ics.blobId, 256 * 1024).catch(() => null))
    invite = body ? parseInvite(body) : null
  }
  // The invitation's own text/calendar part (no file name) is the card; a named .ics stays a file.
  if (invite) attachments.splice(0, attachments.length, ...attachments.filter((a) => !(a.name === 'invite.ics' && /^text\/calendar\b/i.test(a.type) && !files.find((p) => p.blobId === a.blobId)?.name)))
  return {
    ...toRow(e, 0),
    cc: addresses(e.cc),
    bcc: addresses(e.bcc),
    replyTo: addresses(e.replyTo),
    sentAt: e.sentAt ?? null,
    messageId: Array.isArray(e.messageId) ? e.messageId : [],
    inReplyTo: Array.isArray(e.inReplyTo) ? e.inReplyTo : [],
    references: Array.isArray(e.references) ? e.references : [],
    html,
    text,
    blocked,
    trackers,
    images,
    truncated,
    attachments,
    invite,
  }
}

/** A conversation, oldest first. `images`: message ids to show with remote images (Load images). */
async function getThreadInner(acc: Linked, threadId: string, images: string[]): Promise<{ id: string; messages: Message[] }> {
  if (!ID.test(threadId)) throw new HttpError(400, 'Bad thread')
  const r = await jmap(acc, [
    ['Thread/get', { ids: [threadId] }, 't'],
    ['Email/get', { '#ids': { resultOf: 't', name: 'Thread/get', path: '/list/*/emailIds' }, properties: MESSAGE_PROPS, ...BODY_ARGS }, 'g'],
  ])
  const thread = (r.get('t', 'Thread/get').list as Json[])[0]
  if (!thread) throw new HttpError(404, 'That conversation is gone')
  const settings = remoteSettings(acc.user)
  const emails = new Map((r.get('g', 'Email/get').list as Json[]).map((e) => [e.id, e]))
  const list = (thread.emailIds as string[]).map((id) => emails.get(id)).filter((e): e is Json => !!e)
  const messages = await Promise.all(list.map((e) => render(acc, e, images.includes(e.id) || loadsRemote(settings, addresses(e.from).map((a) => a.email)))))
  return { id: threadId, messages }
}

/** One message again (with remote images, after Load images). */
async function getMessageInner(acc: Linked, emailId: string, images: boolean): Promise<Message> {
  if (!ID.test(emailId)) throw new HttpError(400, 'Bad message')
  const r = await jmap(acc, [['Email/get', { ids: [emailId], properties: MESSAGE_PROPS, ...BODY_ARGS }, 'g']])
  const e = (r.get('g', 'Email/get').list as Json[])[0]
  if (!e) throw new HttpError(404, 'That message is gone')
  return render(acc, e, images || loadsRemote(remoteSettings(acc.user), addresses(e.from).map((a) => a.email)))
}

// ---------------------------------------------------------------------------------------------
// Changes

type Op = 'seen' | 'unseen' | 'flag' | 'unflag' | 'move' | 'archive' | 'trash' | 'junk' | 'notjunk' | 'destroy'
const OPS = new Set<Op>(['seen', 'unseen', 'flag', 'unflag', 'move', 'archive', 'trash', 'junk', 'notjunk', 'destroy'])

const idList = (v: unknown, max = 500): string[] => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && ID.test(x)))].slice(0, max) : [])

/**
 * Flags and moves. `threadIds` reach every message of those conversations (in `from`, when that
 * is given: archiving a conversation from the Inbox leaves its Sent replies where they are).
 */
async function actInner(acc: Linked, body: { op?: unknown; emailIds?: unknown; threadIds?: unknown; to?: unknown; from?: unknown }) {
  const op = body.op as Op
  if (!OPS.has(op)) throw new HttpError(400, 'Unknown action')
  const emailIds = idList(body.emailIds)
  const threadIds = idList(body.threadIds, 200)
  if (!emailIds.length && !threadIds.length) throw new HttpError(400, 'Nothing chosen')
  const m = await meta(acc)
  const s = await session(acc)
  const calls: Call[] = []
  if (threadIds.length) {
    calls.push(['Thread/get', { ids: threadIds }, 't'])
    calls.push(['Email/get', { '#ids': { resultOf: 't', name: 'Thread/get', path: '/list/*/emailIds' }, properties: ['id', 'mailboxIds', 'keywords'] }, 'te'])
  }
  if (emailIds.length) calls.push(['Email/get', { ids: emailIds, properties: ['id', 'mailboxIds', 'keywords'] }, 'e'])
  const r = await jmap(acc, calls)
  const found = [...(threadIds.length ? (r.get('te', 'Email/get').list as Json[]) : []), ...(emailIds.length ? (r.get('e', 'Email/get').list as Json[]) : [])]
  const emails = [...new Map(found.map((e) => [e.id as string, e])).values()]
  const from = typeof body.from === 'string' && m.mailboxes.some((b) => b.id === body.from) ? body.from : null

  const update: Record<string, Json> = {}
  const destroy: string[] = []
  const move = (to: string, extra: Json = {}) => {
    const keep = new Set([m.role('sent'), m.role('drafts')].filter(Boolean))
    for (const e of emails) {
      const boxes = Object.keys(e.mailboxIds ?? {})
      if (boxes.length === 1 && boxes[0] === to) {
        if (Object.keys(extra).length) update[e.id] = extra
        continue
      }
      if (from) {
        if (!boxes.includes(from)) continue
        update[e.id] = { [`mailboxIds/${from}`]: null, [`mailboxIds/${to}`]: true, ...extra }
      } else {
        // A whole conversation from a search: the user's own sent mail and drafts stay put.
        if (threadIds.length && boxes.some((b) => keep.has(b)) && !emailIds.includes(e.id)) continue
        update[e.id] = { mailboxIds: { [to]: true }, ...extra }
      }
    }
  }
  const need = (role: string, what: string) => {
    const id = m.role(role)
    if (!id) throw new HttpError(400, `${acc.label} has no ${what} mailbox`)
    return id
  }
  if (op === 'seen' || op === 'unseen') for (const e of emails) update[e.id] = { 'keywords/$seen': op === 'seen' ? true : null }
  else if (op === 'flag' || op === 'unflag') for (const e of emails) update[e.id] = { 'keywords/$flagged': op === 'flag' ? true : null }
  else if (op === 'move') {
    const to = typeof body.to === 'string' && m.mailboxes.some((b) => b.id === body.to) ? body.to : null
    if (!to) throw new HttpError(400, 'No such mailbox')
    move(to)
  } else if (op === 'archive') move(need('archive', 'Archive'))
  else if (op === 'trash') move(need('trash', 'Trash'))
  else if (op === 'junk') move(need('junk', 'Junk'), { 'keywords/$junk': true, 'keywords/$notjunk': null })
  else if (op === 'notjunk') move(need('inbox', 'Inbox'), { 'keywords/$junk': null, 'keywords/$notjunk': true })
  else if (op === 'destroy') {
    // Gone for good: only what is in Trash and nowhere else (a conversation's Sent copies stay).
    const trash = need('trash', 'Trash')
    const inTrash = (e: Json) => Object.keys(e.mailboxIds ?? {}).every((b) => b === trash)
    if (emails.some((e) => emailIds.includes(e.id) && !inTrash(e))) throw new HttpError(400, 'Only messages in Trash can be deleted for good')
    destroy.push(...emails.filter(inTrash).map((e) => e.id))
    if (!destroy.length) throw new HttpError(400, 'Only messages in Trash can be deleted for good')
  }
  const ids = Object.keys(update)
  const chunks: Call[] = []
  for (let i = 0; i < ids.length; i += s.maxObjectsInSet) chunks.push(['Email/set', { update: Object.fromEntries(ids.slice(i, i + s.maxObjectsInSet).map((id) => [id, update[id]])) }, `u${i}`])
  for (let i = 0; i < destroy.length; i += s.maxObjectsInSet) chunks.push(['Email/set', { destroy: destroy.slice(i, i + s.maxObjectsInSet) }, `d${i}`])
  if (!chunks.length) return { changed: 0 }
  const done = await jmap(acc, chunks)
  let changed = 0
  for (const [, , id] of chunks) {
    const set = done.get(id, 'Email/set')
    const failed = Object.values({ ...(set.notUpdated ?? {}), ...(set.notDestroyed ?? {}) }) as Json[]
    if (failed.length) throw new HttpError(502, `The mail server refused ${failed.length === 1 ? 'one change' : `${failed.length} changes`}: ${failed[0].description ?? failed[0].type}`)
    changed += Object.keys(set.updated ?? {}).length + (set.destroyed ?? []).length
  }
  metas.delete(acc.key) // unread counts moved
  tellPages(acc.user.id, 'mail', { account: acc.id })
  return { changed }
}

// ---------------------------------------------------------------------------------------------
// Drafts and sending

type DraftInput = {
  /** The draft this one replaces (each save makes a new one: JMAP messages can't be changed). */
  id?: unknown
  identityId?: unknown
  to?: unknown
  cc?: unknown
  bcc?: unknown
  subject?: unknown
  text?: unknown
  attachments?: unknown
  inReplyTo?: unknown
  references?: unknown
  /** The message answered or forwarded, which gets $answered or $forwarded once sent. */
  replyOf?: unknown
  forwardOf?: unknown
}

function cleanAddresses(v: unknown, what: string): Address[] {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v) || v.length > 100) throw new HttpError(400, `Bad ${what}`)
  return v.map((a) => {
    const email = String((a as Json)?.email ?? '').trim()
    if (!EMAIL.test(email) || email.length > 254) throw new HttpError(400, `${email || 'An empty address'} is not an email address`)
    const name = typeof (a as Json)?.name === 'string' ? (a as Json).name.trim().slice(0, 200) : ''
    return { name: name || null, email }
  })
}

const messageIds = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length < 1000 && !/[\s<>]/.test(x)).slice(-50) : [])

function draftEmail(m: Meta, d: DraftInput): { email: Json; identity: Identity | null } {
  const drafts = m.role('drafts')
  if (!drafts) throw new HttpError(400, 'This account has no Drafts mailbox')
  const identity = m.identities.find((i) => i.id === d.identityId) ?? m.identities[0] ?? null
  const to = cleanAddresses(d.to, 'To')
  const cc = cleanAddresses(d.cc, 'Cc')
  const bcc = cleanAddresses(d.bcc, 'Bcc')
  const files = Array.isArray(d.attachments) ? d.attachments.slice(0, 100) : []
  const attachments = files.map((a: Json) => {
    if (typeof a?.blobId !== 'string' || !ID.test(a.blobId)) throw new HttpError(400, 'Bad attachment')
    const type = typeof a.type === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(a.type) ? a.type : 'application/octet-stream'
    return { blobId: a.blobId, type, name: String(a.name ?? 'attachment').replace(/[\r\n"\\/]/g, '_').slice(0, 200), disposition: 'attachment' }
  })
  const email: Json = {
    mailboxIds: { [drafts]: true },
    keywords: { $draft: true, $seen: true },
    ...(identity ? { from: [{ name: identity.name || null, email: identity.email }] } : {}),
    ...(to.length ? { to } : {}),
    ...(cc.length ? { cc } : {}),
    ...(bcc.length ? { bcc } : {}),
    ...(identity?.replyTo?.length ? { replyTo: identity.replyTo } : {}),
    subject: String(d.subject ?? '').replace(/[\r\n]+/g, ' ').slice(0, 998),
    ...(messageIds(d.inReplyTo).length ? { inReplyTo: messageIds(d.inReplyTo) } : {}),
    ...(messageIds(d.references).length ? { references: messageIds(d.references) } : {}),
    bodyValues: { body: { value: String(d.text ?? '').slice(0, 2_000_000) } },
    textBody: [{ partId: 'body', type: 'text/plain' }],
    ...(attachments.length ? { attachments } : {}),
  }
  return { email, identity }
}

/** An old draft to replace: only if it really is a draft, so a save never deletes a received message. */
async function oldDraftInner(acc: Linked, id: unknown): Promise<string | null> {
  if (typeof id !== 'string' || !ID.test(id)) return null
  const r = await jmap(acc, [['Email/get', { ids: [id], properties: ['keywords'] }, 'g']])
  const e = (r.get('g', 'Email/get').list as Json[])[0]
  return e?.keywords?.$draft ? id : null
}

/** Saves a draft (replacing the one before); answers its new id. */
async function saveDraftInner(acc: Linked, d: DraftInput): Promise<{ id: string }> {
  const m = await meta(acc)
  const { email } = draftEmail(m, d)
  const old = await oldDraft(acc, d.id)
  const r = await jmap(acc, [['Email/set', { create: { draft: email }, ...(old ? { destroy: [old] } : {}) }, 's']])
  const set = r.get('s', 'Email/set')
  const created = set.created?.draft
  if (!created) throw new HttpError(502, `The mail server refused the draft: ${set.notCreated?.draft?.description ?? set.notCreated?.draft?.type ?? 'error'}`)
  tellPages(acc.user.id, 'mail', { account: acc.id })
  return { id: created.id }
}

async function discardDraftInner(acc: Linked, id: unknown) {
  const old = await oldDraft(acc, id)
  if (!old) return
  const r = await jmap(acc, [['Email/set', { destroy: [old] }, 's']])
  r.get('s', 'Email/set')
  tellPages(acc.user.id, 'mail', { account: acc.id })
}

/**
 * Sends: the message is made in Drafts and submitted with the chosen identity in one request;
 * once the server has taken it, it moves to Sent and loses $draft (onSuccessUpdateEmail), and the
 * draft it came from goes. The answered message gets $answered ($forwarded for a forward).
 */
/** `task`: the agent task the mail is from (its reports, a run's mail_send): it carries TASK_HEADER, so it never starts a task. */
async function sendInner(acc: Linked, d: DraftInput, opts: { task?: string } = {}): Promise<{ id: string }> {
  const s = await session(acc)
  if (!s.submission) throw new HttpError(400, `${acc.label} does not allow sending with this token (it needs Submission access)`)
  const m = await meta(acc)
  const { email, identity } = draftEmail(m, d)
  if (opts.task && /^[0-9a-f-]{36}$/.test(opts.task)) email[`header:${TASK_HEADER}:asText`] = opts.task
  if (!identity) throw new HttpError(400, 'This account has no identity to send from')
  if (!email.to && !email.cc && !email.bcc) throw new HttpError(400, 'Who is it to?')
  const drafts = m.role('drafts')!
  const sent = m.role('sent')
  const old = await oldDraft(acc, d.id)
  const answered = typeof d.replyOf === 'string' && ID.test(d.replyOf) ? d.replyOf : null
  const forwarded = typeof d.forwardOf === 'string' && ID.test(d.forwardOf) ? d.forwardOf : null
  // Without a Sent mailbox the message would be in none: then it stays in Drafts, sent.
  const afterwards = sent ? { [`mailboxIds/${drafts}`]: null, [`mailboxIds/${sent}`]: true, 'keywords/$draft': null } : { 'keywords/$draft': null }
  const calls: Call[] = [
    ['Email/set', { create: { draft: email } }, 'e'],
    ['EmailSubmission/set', { create: { send: { identityId: identity.id, emailId: '#draft' } }, onSuccessUpdateEmail: { '#send': afterwards } }, 's'],
  ]
  if (old) calls.push(['Email/set', { destroy: [old] }, 'old'])
  if (answered || forwarded) calls.push(['Email/set', { update: Object.fromEntries([...(answered ? [[answered, { 'keywords/$answered': true }]] : []), ...(forwarded ? [[forwarded, { 'keywords/$forwarded': true }]] : [])]) }, 'k'])
  const r = await jmap(acc, calls)
  const made = r.get('e', 'Email/set')
  if (!made.created?.draft) throw new HttpError(502, `The mail server refused the message: ${made.notCreated?.draft?.description ?? made.notCreated?.draft?.type ?? 'error'}`)
  const sub = r.get('s', 'EmailSubmission/set')
  if (!sub.created?.send) {
    // Not sent: what was made stays a draft, for another try.
    const why = sub.notCreated?.send
    throw new HttpError(502, `Not sent: ${why?.description ?? why?.type ?? 'the mail server refused it'}`)
  }
  metas.delete(acc.key)
  tellPages(acc.user.id, 'mail', { account: acc.id })
  return { id: made.created.draft.id }
}

// ---------------------------------------------------------------------------------------------
// Blobs

/** POST /api/mail/:id/upload: the request's bytes into the account's blob store. */
async function uploadInner(acc: Linked, req: IncomingMessage, type: string | null): Promise<{ blobId: string; type: string; size: number }> {
  // A custom header means a cross-site form can't post here (it would need a preflight).
  if (req.headers['x-mail-upload'] !== '1') throw new HttpError(400, 'Upload with X-Mail-Upload: 1')
  const s = await session(acc)
  const contentType = type && /^[\w.+-]+\/[\w.+-]+$/.test(type) ? type : 'application/octet-stream'
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > s.maxSizeUpload) throw new HttpError(413, `Attachments can be at most ${Math.floor(s.maxSizeUpload / 1_000_000)} MB here`)
    chunks.push(chunk as Buffer)
  }
  bodyRead(req)
  const res = await mailFetch(acc, fill(s.uploadUrl, { accountId: s.accountId }), {
    method: 'POST',
    headers: { ...bearer(acc.token), 'Content-Type': contentType },
    body: Buffer.concat(chunks),
    signal: AbortSignal.timeout(120_000),
  }).catch((e) => (rethrowEgress(e), null))
  if (!res) throw new HttpError(502, `${acc.label} did not answer`)
  const body = JSON.parse((await readCapped(res, 64 * 1024)).toString('utf8') || '{}') as Json
  if (!res.ok || typeof body.blobId !== 'string') throw new HttpError(502, `${acc.label} refused the upload (${res.status})`)
  return { blobId: body.blobId, type: String(body.type ?? contentType), size: Number(body.size) || size }
}

/** `range`: a byte range asked for by a player seeking in audio or video (passed on as it is). */
async function fetchBlobInner(acc: Linked, blobId: string, name: string, type: string, range: string | null = null): Promise<Response> {
  if (!ID.test(blobId)) throw new HttpError(400, 'Bad attachment')
  const s = await session(acc)
  const headers: Record<string, string> = { ...bearer(acc.token) }
  if (range) headers.Range = range
  const res = await mailFetch(acc, fill(s.downloadUrl, { accountId: s.accountId, blobId, name: name || 'attachment', type: type || 'application/octet-stream' }), { headers, signal: AbortSignal.timeout(120_000) }).catch((e) => (rethrowEgress(e), null))
  if (!res) throw new HttpError(502, `${acc.label} did not answer`)
  if (res.status === 404) throw new HttpError(404, 'That attachment is gone')
  if (res.status === 416) throw new HttpError(416, 'Range not satisfiable')
  if (!res.ok) throw new HttpError(502, `${acc.label} answered ${res.status}`)
  return res
}

async function blobTextInner(acc: Linked, blobId: string, max: number): Promise<string> {
  return (await readCapped(await fetchBlob(acc, blobId, 'invite.ics', 'text/calendar'), max)).toString('utf8')
}

/** Pictures the browser may show as they are; anything else is a download. Never SVG or HTML. */
const SHOWABLE = /^image\/(png|jpe?g|gif|webp|bmp|avif)$/i
/** Audio and video that Player plays from the attachment's address (and seeks in): only these, never a type a browser renders as a page. */
const PLAYABLE = /^(audio\/(mpeg|mp3|mp4|aac|ogg|opus|wav|x-wav|wave|webm|flac|x-flac|x-m4a)|video\/(mp4|webm|ogg|quicktime))$/i

async function pipeBlob(res: ServerResponse, blob: Response, name: string, type: string, inline: boolean, head: boolean) {
  const show = inline && (SHOWABLE.test(type) || PLAYABLE.test(type))
  const headers: Record<string, string> = {
    'Content-Type': show ? type.toLowerCase() : 'application/octet-stream',
    'Content-Disposition': `${show ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name || 'attachment')}`,
    'Cache-Control': 'private, no-store',
    ...SECURITY,
    ...UNTRUSTED,
  }
  const length = blob.headers.get('content-length')
  if (length && /^\d+$/.test(length)) headers['Content-Length'] = length
  // Part of it (a player seeking), when the mail server answered the range asked for.
  const range = blob.headers.get('content-range') ?? ''
  const partial = blob.status === 206 && /^bytes \d+-\d+\/(\d+|\*)$/.test(range)
  if (partial) headers['Content-Range'] = range
  if (show && PLAYABLE.test(type)) headers['Accept-Ranges'] = partial || blob.headers.get('accept-ranges') === 'bytes' ? 'bytes' : 'none'
  res.writeHead(partial ? 206 : 200, headers)
  if (head || !blob.body) {
    await blob.body?.cancel().catch(() => {})
    return res.end()
  }
  const body = Readable.fromWeb(blob.body as import('node:stream/web').ReadableStream)
  res.on('close', () => body.destroy())
  body.on('error', () => res.destroy())
  body.pipe(res)
}

/** GET /api/mail/inline/<sealed>: an inline picture for the message frame (no cookie there). */
async function serveInline(req: IncomingMessage, res: ServerResponse, token: string, head: boolean) {
  let claim: { k: string; session: SessionBinding; u: number; a: number; b: string; t: string; e: number }
  try {
    claim = JSON.parse(decrypt(Buffer.from(token, 'base64url').toString('utf8')))
  } catch {
    throw new HttpError(404, 'Not found')
  }
  if (!claim || claim.e < Date.now() || !SHOWABLE.test(claim.t)) throw new HttpError(404, 'Not found')
  const user = userById(claim.u)
  if (!user) throw new HttpError(404, 'Not found')
  const acc = linked(user, claim.a)
  if (claim.k !== acc.key || !claim.session || claim.session.userId !== user.id) throw new HttpError(404, 'Not found')
  await runPrivateRequest(req, res, user, async () => {
    bindMailRequest(acc)
    await pipeBlob(res, await fetchBlob(acc, claim.b, 'image', claim.t), 'image', claim.t, true, head)
  }, claim.session)
}

// ---------------------------------------------------------------------------------------------
// People: recent correspondents, for the recipient fields until Contacts takes over

type Person = { name: string | null; email: string; count: number; last: string }
const people = new Map<string, { at: number; list: Person[] }>()

/** Whom the account wrote to (Sent) and heard from (Inbox) lately, most often first. */
async function correspondentsInner(acc: Linked): Promise<Person[]> {
  const known = people.get(acc.key)
  if (known && Date.now() - known.at < 10 * 60_000) return known.list
  const m = await meta(acc)
  const sent = m.role('sent')
  const inbox = m.role('inbox')
  const calls: Call[] = []
  const recent = (box: string, id: string, props: string[]) => {
    calls.push(['Email/query', { filter: { inMailbox: box }, sort: [{ property: 'receivedAt', isAscending: false }], limit: 250 }, `${id}q`])
    calls.push(['Email/get', { '#ids': { resultOf: `${id}q`, name: 'Email/query', path: '/ids' }, properties: [...props, 'receivedAt'] }, id])
  }
  if (sent) recent(sent, 's', ['to', 'cc', 'bcc'])
  if (inbox) recent(inbox, 'i', ['from'])
  const map = new Map<string, Person>()
  if (calls.length) {
    const r = await jmap(acc, calls)
    const add = (a: Address, at: string, weight: number) => {
      const key = a.email.toLowerCase()
      const p = map.get(key) ?? { name: a.name, email: a.email, count: 0, last: '' }
      p.count += weight
      if (!p.name && a.name) p.name = a.name
      if (at > p.last) p.last = at
      map.set(key, p)
    }
    if (sent) for (const e of r.get('s', 'Email/get').list as Json[]) for (const a of [...addresses(e.to), ...addresses(e.cc), ...addresses(e.bcc)]) add(a, e.receivedAt ?? '', 3)
    if (inbox) for (const e of r.get('i', 'Email/get').list as Json[]) for (const a of addresses(e.from)) add(a, e.receivedAt ?? '', 1)
  }
  const own = new Set(m.identities.map((i) => i.email.toLowerCase()))
  const list = [...map.values()].filter((p) => !own.has(p.email.toLowerCase()) && !/^(no-?reply|mailer-daemon|bounce)/i.test(p.email)).sort((a, b) => b.count - a.count || b.last.localeCompare(a.last))
  assertMail(acc)
  people.set(acc.key, { at: Date.now(), list })
  return list
}

async function suggestInner(acc: Linked, q: string): Promise<{ name: string | null; email: string }[]> {
  const needle = q.trim().toLowerCase()
  const list = await correspondents(acc)
  return list
    .filter((p) => !needle || p.email.toLowerCase().includes(needle) || (p.name ?? '').toLowerCase().includes(needle))
    .slice(0, 8)
    .map(({ name, email }) => ({ name, email }))
}

// ---------------------------------------------------------------------------------------------
// Push: new mail and live updates

/** When each user last used Mail (any /api/mail request): push stays on for a while after. */
const lastUse = new Map<number, number>()
const USE_WINDOW = 30 * 60_000
/** Polling, when the server has no EventSource or it keeps failing; and how often the lines are looked after (scripts/mail-check.ts makes both quick). */
const POLL_MS = Number(process.env.MAIL_POLL_MS) || 2 * 60_000
const WATCH_MS = Number(process.env.MAIL_WATCH_MS) || 60_000

type Live = { key: string; accountId: number; userId: number; stopped: boolean; abort: AbortController | null; mode: 'stream' | 'poll'; failures: number; nextPoll: number; emailState: string | null; mailboxState: string | null; chain: Promise<void>; connected: boolean }
const live = new Map<string, Live>()

function stopLive(id: string) {
  const l = live.get(id)
  if (!l) return
  l.stopped = true
  l.abort?.abort()
  live.delete(id)
}

/** An account that may sign in, enough of it for the requests made on its behalf (egress checks who is an admin). */
function userById(id: number): User | null {
  const row = database().prepare('SELECT id, github_id, login, name, avatar FROM users WHERE id = ? AND banned_at IS NULL').get(id) as { id: number; github_id: number; login: string; name: string | null; avatar: string | null } | undefined
  return row ? { id: row.id, githubId: row.github_id, login: row.login, name: row.name, avatar: row.avatar, githubToken: '', githubScopes: [], admin: isAdmin(row.github_id) } : null
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms).unref())

/** The account as it is now (or null once it was removed), for a long-running push line. */
function current(l: Live): Linked | null {
  const user = userById(l.userId)
  if (!user) return null
  try {
    const acc = linked(user, l.accountId)
    return acc.key === l.key ? acc : null
  } catch {
    return null
  }
}

/** One check at a time per account, in order. */
const queueCheck = (l: Live) => (l.chain = l.chain.then(() => checkChanges(l)).catch((e) => console.error(`mail push (${l.accountId}):`, (e as Error).message)))

/**
 * What changed since the last check (Email/changes): new messages in the Inbox, unread, become
 * notifications, each once; any change tells the account's open pages.
 */
async function checkChanges(l: Live) {
  const acc = current(l)
  if (!acc || l.stopped) return
  if (!l.emailState) {
    const stored = (table().prepare('SELECT push_state FROM jmap_accounts WHERE id = ?').get(acc.id) as { push_state: string | null } | undefined)?.push_state
    if (stored) l.emailState = stored
    else {
      const r = await jmap(acc, [['Email/get', { ids: [] }, 'g']])
      l.emailState = String(r.get('g', 'Email/get').state ?? '')
      assertMail(acc)
      table().prepare('UPDATE jmap_accounts SET push_state = ? WHERE id = ?').run(l.emailState, acc.id)
      return
    }
  }
  const created: string[] = []
  let changed = false
  for (let round = 0; round < 5; round++) {
    const r = await jmap(acc, [['Email/changes', { sinceState: l.emailState, maxChanges: 200 }, 'c']])
    const err = r.error('c')
    if (err) {
      // Too far behind (or the state is unknown): start again from now.
      const fresh = await jmap(acc, [['Email/get', { ids: [] }, 'g']])
      l.emailState = String(fresh.get('g', 'Email/get').state ?? '')
      changed = true
      break
    }
    const c = r.get('c', 'Email/changes')
    created.push(...((c.created ?? []) as string[]))
    if ((c.created ?? []).length || (c.updated ?? []).length || (c.destroyed ?? []).length) changed = true
    l.emailState = String(c.newState ?? l.emailState)
    if (!c.hasMoreChanges) break
  }
  assertMail(acc)
  table().prepare('UPDATE jmap_accounts SET push_state = ? WHERE id = ?').run(l.emailState, acc.id)
  if (changed) {
    metas.delete(acc.key)
    tellPages(acc.user.id, 'mail', { account: acc.id })
  }
  if (created.length)
    try {
      await announce(acc, created.slice(-100))
    } finally {
      // Agent tasks started by new mail: their own errors never hold up notifications, nor theirs these.
      await taskMail(acc, created.slice(-200)).catch((e) => console.error(`mail push (${acc.id}): tasks:`, (e as Error).message))
    }
}

// New mail for agent tasks (server/agentTasks.ts registers the hook): the accounts some task
// watches, and the new messages of those, fetched once per batch of changes, whatever the number
// of tasks. Mail a task sent itself is marked by its header (TASK_HEADER).

type NewMailHook = {
  /** "<user id>:<account id>" of every account an active new-mail task watches */
  watched: () => Set<string>
  arrived: (user: User, accountId: number, mails: ArrivedMail[], boxes: { id: string; role: string | null; name: string }[]) => void
}
let newMailHook: NewMailHook | null = null
export const setNewMailHook = (hook: NewMailHook) => void (newMailHook = hook)

async function taskMailInner(acc: Linked, ids: string[]) {
  if (!newMailHook || !ids.length || !newMailHook.watched().has(`${acc.user.id}:${acc.id}`)) return
  const header = `header:${TASK_HEADER}:asText`
  const r = await jmap(acc, [['Email/get', { ids, properties: ['id', 'mailboxIds', 'keywords', 'from', 'to', 'cc', 'subject', 'hasAttachment', 'receivedAt', header] }, 'g']])
  const m = await meta(acc)
  const mails: ArrivedMail[] = (r.get('g', 'Email/get').list as Json[]).map((e) => ({
    id: String(e.id),
    mailboxIds: Object.keys(e.mailboxIds ?? {}),
    from: addresses(e.from),
    to: addresses(e.to),
    cc: addresses(e.cc),
    subject: String(e.subject ?? ''),
    hasAttachment: !!e.hasAttachment,
    receivedAt: Date.parse(e.receivedAt) || 0,
    draft: !!e.keywords?.$draft,
    fromTask: typeof e[header] === 'string' && !!e[header].trim(),
  }))
  assertMail(acc)
  newMailHook.arrived(acc.user, acc.id, mails, m.mailboxes.map((b) => ({ id: b.id, role: b.role, name: b.name })))
}

async function announceInner(acc: Linked, ids: string[]) {
  const prefs = normalizePrefs(readState(acc.user).notify?.value)
  if (!allows(prefs, 'mail.new')) return
  const r = await jmap(acc, [
    ['Mailbox/query', { filter: { role: 'inbox' } }, 'b'],
    ['Email/get', { ids, properties: ['id', 'threadId', 'from', 'subject', 'preview', 'mailboxIds', 'keywords', 'receivedAt'] }, 'g'],
  ])
  const inbox = (r.get('b', 'Mailbox/query').ids as string[])[0]
  const cutoff = Date.now() - 2 * 864e5
  const fresh = (r.get('g', 'Email/get').list as Json[])
    .filter((e) => inbox && e.mailboxIds?.[inbox] && !e.keywords?.$seen && !e.keywords?.$draft && Date.parse(e.receivedAt) > cutoff)
    .filter((e) => (assertMail(acc), claimOnce(acc.user, `mail:${sha256(JSON.stringify([acc.key, e.id]))}`)))
  assertMail(acc)
  if (!fresh.length) return
  const who = (e: Json) => addresses(e.from)[0]?.name || addresses(e.from)[0]?.email || 'Someone'
  if (fresh.length > 3) {
    const names = [...new Set(fresh.map(who))]
    notify(acc.user, { source: 'mail.new', title: `${fresh.length} new emails`, body: `From ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` and ${names.length - 3} more` : ''} · ${acc.label}`, action: { app: 'mail', props: { account: String(acc.id) } }, tag: `mail-${acc.id}` })
    return
  }
  for (const e of fresh)
    notify(acc.user, {
      source: 'mail.new',
      title: who(e),
      body: [String(e.subject ?? '') || '(No subject)', String(e.preview ?? '').slice(0, 200)].filter(Boolean).join('\n'),
      action: { app: 'mail', props: { account: String(acc.id), email: e.id } },
      tag: `mail-${acc.id}-${e.id}`,
    })
}

/** The account's EventSource, read for as long as the line is wanted; polling when there is none. */
async function stream(l: Live) {
  while (!l.stopped) {
    const acc = current(l)
    if (!acc) return stopLive(l.key)
    let s: Session
    try {
      s = await session(acc)
    } catch {
      await sleep(Math.min(10 * 60_000, 15_000 * 2 ** l.failures++))
      continue
    }
    if (!s.eventSourceUrl) {
      l.mode = 'poll'
      return
    }
    await queueCheck(l) // where things stand (and what came while the line was down)
    const abort = new AbortController()
    l.abort = abort
    let quiet: ReturnType<typeof setTimeout> | null = null
    // A ping is asked for every 60 s: nothing for three minutes means the line is dead.
    const watch = () => {
      if (quiet) clearTimeout(quiet)
      quiet = setTimeout(() => abort.abort(), 180_000)
      quiet.unref()
    }
    try {
      const url = fill(s.eventSourceUrl, { types: 'Email,Mailbox', closeafter: 'no', ping: '60' })
      const res = await mailFetch(acc, url, { headers: { ...bearer(acc.token), Accept: 'text/event-stream', 'Cache-Control': 'no-cache' }, signal: abort.signal })
      if (!res.ok || !res.body) throw new Error(`EventSource answered ${res.status}`)
      l.connected = true
      watch()
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done || l.stopped) break
        watch()
        l.failures = 0
        buffer += value
        if (buffer.length > 1_000_000) throw new Error('EventSource sent too much at once')
        let cut: number
        while ((cut = buffer.search(/\r?\n\r?\n/)) >= 0) {
          const block = buffer.slice(0, cut)
          buffer = buffer.slice(cut).replace(/^\r?\n\r?\n/, '')
          const event = /^event:\s*(.*)$/m.exec(block)?.[1]?.trim() ?? 'message'
          const data = [...block.matchAll(/^data:\s?(.*)$/gm)].map((m) => m[1]).join('\n')
          if (event !== 'state' || !data) continue
          let change: Json
          try {
            change = JSON.parse(data)
          } catch {
            continue
          }
          const mine = change?.changed?.[s.accountId] as Record<string, string> | undefined
          if (!mine) continue
          if (mine.Email && mine.Email !== l.emailState) void queueCheck(l)
          else if (mine.Mailbox && mine.Mailbox !== l.mailboxState) {
            assertMail(acc)
            metas.delete(acc.key)
            tellPages(acc.user.id, 'mail', { account: acc.id })
          }
          if (mine.Mailbox) l.mailboxState = mine.Mailbox
        }
      }
    } catch {
      l.failures++
    } finally {
      if (quiet) clearTimeout(quiet)
      l.abort = null
    }
    if (l.stopped) return
    // A line that never worked three times over: poll instead.
    if (!l.connected && l.failures >= 3) {
      l.mode = 'poll'
      return
    }
    await sleep(Math.min(5 * 60_000, 2_000 * 2 ** Math.min(l.failures, 8)))
  }
}

/** Whether a push line is worth keeping for this account: mail notifications on, Mail used lately, or an agent task starts on its new mail (`watched`, read once per tick). */
function useful(user: User, accountId: number, watched: Set<string>): boolean {
  if (watched.has(`${user.id}:${accountId}`)) return true
  if (Date.now() - (lastUse.get(user.id) ?? 0) < USE_WINDOW) return true
  return allows(normalizePrefs(readState(user).notify?.value), 'mail.new')
}

/** The watcher's tick: push lines started and stopped as wanted, polled accounts checked. */
export async function mailWatch() {
  const rows = table().prepare('SELECT id, user_id FROM jmap_accounts').all() as { id: number; user_id: number }[]
  const users = new Map(accounts().map((u) => [u.id, u]))
  const wanted = new Map<string, Linked>()
  const watched = newMailHook?.watched() ?? new Set<string>()
  for (const r of rows) {
    const user = users.get(r.user_id)
    if (user && useful(user, r.id, watched)) { const acc = linked(user, r.id); wanted.set(acc.key, acc) }
  }
  for (const id of [...live.keys()]) if (!wanted.has(id)) stopLive(id)
  for (const [key, acc] of wanted) {
    let l = live.get(key)
    if (!l) {
      l = { key, accountId: acc.id, userId: acc.user.id, stopped: false, abort: null, mode: 'stream', failures: 0, nextPoll: 0, emailState: null, mailboxState: null, chain: Promise.resolve(), connected: false }
      live.set(key, l)
      const started = l
      void stream(started).catch((e) => console.error(`mail push (${started.accountId}):`, (e as Error).message))
    }
    if (l.mode === 'poll' && Date.now() >= l.nextPoll) {
      l.nextPoll = Date.now() + POLL_MS
      void queueCheck(l)
    }
  }
}

registerWatcher({ name: 'mail', every: WATCH_MS, run: mailWatch })

// ---------------------------------------------------------------------------------------------
// For the other apps (server/pim.ts): one message's facts, mail with someone, a message found by
// its Message-ID, and an invitation's answer sent by email (iMIP). Each reads the account again
// here; nothing about a message is taken from the browser.

export type { Linked as MailAccount }
/** One of the user's linked accounts (404 when it is not theirs). */
export const mailAccount = (user: User, id: unknown): Linked => linked(user, id)
export const mailAccounts = (user: User): Linked[] => listMail(user).map((a) => linked(user, a.id))

/** The addresses the account sends as: its identities and its username, lower case. */
async function ownAddressesInner(acc: Linked): Promise<string[]> {
  const [m, s] = await Promise.all([meta(acc), session(acc)])
  return [...new Set([...m.identities.map((i) => i.email), s.username].filter((e) => EMAIL.test(e)).map((e) => e.toLowerCase()))]
}

export type MessageFacts = { id: string; threadId: string; subject: string; from: Address[]; to: Address[]; cc: Address[]; receivedAt: string; preview: string; messageId: string | null; ics: string | null }

/** What other apps need of a message: its people, a snippet, its Message-ID and its invitation's iCalendar text. */
async function messageFactsInner(acc: Linked, emailId: unknown): Promise<MessageFacts> {
  if (typeof emailId !== 'string' || !ID.test(emailId)) throw new HttpError(400, 'Bad message')
  const r = await jmap(acc, [['Email/get', { ids: [emailId], properties: ['id', 'threadId', 'subject', 'from', 'to', 'cc', 'receivedAt', 'preview', 'messageId', 'textBody', 'attachments', 'bodyValues'], fetchTextBodyValues: true, maxBodyValueBytes: 256 * 1024 }, 'g']])
  const e = (r.get('g', 'Email/get').list as Json[])[0]
  if (!e) throw new HttpError(404, 'That message is gone')
  const parts = [...(Array.isArray(e.attachments) ? e.attachments : []), ...(Array.isArray(e.textBody) ? e.textBody : [])] as Json[]
  const part = parts.find((p) => typeof p.blobId === 'string' && ID.test(p.blobId) && (/^text\/calendar\b/i.test(String(p.type)) || /\.ics$/i.test(String(p.name ?? ''))))
  const ics = part ? ((e.bodyValues?.[part.partId]?.value as string | undefined) ?? (await blobText(acc, part.blobId, 256 * 1024).catch(() => null))) : null
  const mid = Array.isArray(e.messageId) && typeof e.messageId[0] === 'string' ? e.messageId[0] : null
  return { id: e.id, threadId: e.threadId, subject: String(e.subject ?? ''), from: addresses(e.from), to: addresses(e.to), cc: addresses(e.cc), receivedAt: String(e.receivedAt ?? ''), preview: String(e.preview ?? ''), messageId: mid, ics }
}

/** The latest conversations with any of these people (from, to or cc), outside Drafts, Trash and Junk. */
async function mailWithInner(acc: Linked, emails: string[], limit: number): Promise<ThreadRow[]> {
  const people = emails.filter((e) => EMAIL.test(e)).slice(0, 20)
  if (!people.length) return []
  const m = await meta(acc)
  const away = [m.role('drafts'), m.role('trash'), m.role('junk')].filter((x): x is string => !!x)
  const anyone = { operator: 'OR', conditions: people.flatMap((email) => [{ from: email }, { to: email }, { cc: email }]) }
  const filter = away.length ? { operator: 'AND', conditions: [anyone, { inMailboxOtherThan: away }] } : anyone
  const r = await jmap(acc, [
    ['Email/query', { filter, sort: [{ property: 'receivedAt', isAscending: false }], collapseThreads: true, limit: Math.max(1, Math.min(limit, 20)) }, 'q'],
    ['Email/get', { '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: ROW_PROPS }, 'g'],
  ])
  const byId = new Map((r.get('g', 'Email/get').list as Json[]).map((e) => [e.id, e]))
  return (r.get('q', 'Email/query').ids as string[]).map((id) => byId.get(id)).filter((e): e is Json => !!e).map((e) => toRow(e, 1))
}

/** The message with this Message-ID (without its angle brackets) in the account, or null. */
async function findByMessageIdInner(acc: Linked, messageId: string): Promise<{ id: string; threadId: string } | null> {
  if (!messageId || messageId.length > 998 || /[\s<>]/.test(messageId)) return null
  const r = await jmap(acc, [
    ['Email/query', { filter: { header: ['Message-ID', messageId] }, sort: [{ property: 'receivedAt', isAscending: false }], limit: 5 }, 'q'],
    ['Email/get', { '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: ['id', 'threadId', 'messageId'] }, 'g'],
  ])
  // The header filter matches text inside the field: only an exact Message-ID counts.
  const e = (r.get('g', 'Email/get').list as Json[]).find((x) => Array.isArray(x.messageId) && x.messageId.includes(messageId))
  return e ? { id: e.id, threadId: e.threadId } : null
}

// ---------------------------------------------------------------------------------------------
// For the Agents app (server/agentMail.ts): an account's mailboxes and identities, and messages
// with their bodies as the server's own text parts (no HTML rendering, no pictures, nothing
// fetched but the message itself, and nothing marked read).

/** The account's mailboxes and the addresses it sends as, and whether its token may send. */
async function mailMetaInner(acc: Linked): Promise<{ mailboxes: Mailbox[]; identities: Identity[]; canSend: boolean }> {
  const [m, s] = await Promise.all([meta(acc), session(acc)])
  return { mailboxes: m.mailboxes, identities: m.identities, canSend: s.submission }
}

export type PlainMessage = {
  id: string
  threadId: string
  mailboxIds: string[]
  subject: string
  from: Address[]
  to: Address[]
  cc: Address[]
  bcc: Address[]
  replyTo: Address[]
  receivedAt: string
  seen: boolean
  flagged: boolean
  draft: boolean
  messageId: string[]
  references: string[]
  /** The body parts the server picked for reading as text, in order (HTML when a message has no plain text). */
  body: { type: 'text' | 'html'; value: string }[]
  truncated: boolean
  attachments: { blobId: string; name: string; type: string; size: number }[]
}

/**
 * Messages by id, or every message of the given conversations (oldest first), with their text
 * parts when `bodies`. `missing` names the ids the account does not have.
 */
async function plainMessagesInner(acc: Linked, target: { emailIds?: string[]; threadIds?: string[] }, bodies: boolean): Promise<{ messages: PlainMessage[]; missing: string[] }> {
  const emailIds = idList(target.emailIds, 100)
  const threadIds = idList(target.threadIds, 50)
  const props = ['id', 'threadId', 'mailboxIds', 'keywords', 'from', 'to', 'cc', 'bcc', 'replyTo', 'subject', 'receivedAt', 'messageId', 'references', 'attachments', ...(bodies ? ['textBody', 'bodyValues'] : [])]
  const args = { properties: props, ...(bodies ? { fetchTextBodyValues: true, maxBodyValueBytes: 256 * 1024 } : {}) }
  const calls: Call[] = []
  if (threadIds.length) {
    calls.push(['Thread/get', { ids: threadIds }, 't'])
    calls.push(['Email/get', { '#ids': { resultOf: 't', name: 'Thread/get', path: '/list/*/emailIds' }, ...args }, 'te'])
  }
  if (emailIds.length) calls.push(['Email/get', { ids: emailIds, ...args }, 'e'])
  if (!calls.length) return { messages: [], missing: [] }
  const r = await jmap(acc, calls)
  const threads = threadIds.length ? (r.get('t', 'Thread/get').list as Json[]) : []
  const order = new Map<string, number>()
  threads.forEach((t) => (t.emailIds as string[]).forEach((id) => order.set(id, order.size)))
  const found = [...(threadIds.length ? (r.get('te', 'Email/get').list as Json[]) : []), ...(emailIds.length ? (r.get('e', 'Email/get').list as Json[]) : [])]
  const byId = new Map(found.map((e) => [String(e.id), e]))
  const missing = [...emailIds.filter((id) => !byId.has(id)), ...threadIds.filter((id) => !threads.some((t) => t.id === id))]
  const list = [...byId.values()].sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity) || String(a.receivedAt).localeCompare(String(b.receivedAt)))
  const messages = list.map((e): PlainMessage => {
    const values = (e.bodyValues ?? {}) as Record<string, { value?: string; isTruncated?: boolean }>
    const k = e.keywords ?? {}
    return {
      id: String(e.id),
      threadId: String(e.threadId),
      mailboxIds: Object.keys(e.mailboxIds ?? {}),
      subject: String(e.subject ?? ''),
      from: addresses(e.from),
      to: addresses(e.to),
      cc: addresses(e.cc),
      bcc: addresses(e.bcc),
      replyTo: addresses(e.replyTo),
      receivedAt: String(e.receivedAt ?? ''),
      seen: !!k.$seen,
      flagged: !!k.$flagged,
      draft: !!k.$draft,
      messageId: messageIds(e.messageId),
      references: messageIds(e.references),
      body: (Array.isArray(e.textBody) ? (e.textBody as Json[]) : [])
        .filter((p) => /^text\/(plain|html)\b/i.test(String(p.type)) && typeof values[p.partId]?.value === 'string')
        .map((p) => ({ type: /^text\/html\b/i.test(String(p.type)) ? 'html' : 'text', value: values[p.partId].value! })),
      truncated: Object.values(values).some((v) => v.isTruncated),
      attachments: (Array.isArray(e.attachments) ? (e.attachments as Json[]) : [])
        .filter((p) => typeof p.blobId === 'string' && ID.test(p.blobId))
        .map((p) => ({ blobId: p.blobId, name: String(p.name ?? '') || 'attachment', type: String(p.type ?? 'application/octet-stream'), size: Number(p.size) || 0 })),
    }
  })
  return { messages, missing }
}

/** A header's words: as they are when plain ASCII, otherwise an RFC 2047 encoded word. */
const headerWords = (s: string) => {
  const clean = s.replace(/[\r\n]+/g, ' ').trim()
  return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`
}
const mailbox = (a: Address) => (a.name ? `${/^[\x20-\x7e]*$/.test(a.name) ? `"${a.name.replace(/["\\\r\n]/g, '')}"` : headerWords(a.name)} <${a.email}>` : `<${a.email}>`)
const base64Lines = (s: string) => Buffer.from(s, 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n')

/**
 * Sends an iTIP message (RFC 5546) by email (iMIP, RFC 6047): a plain-text part and the
 * iCalendar one as text/calendar with its METHOD, as alternatives. JMAP can't set a part's
 * Content-Type parameters, so the message is written here whole and brought in with
 * Email/import, then submitted like any other (and moved to Sent).
 */
async function sendItipInner(acc: Linked, opts: { from: string; to: Address; subject: string; text: string; ics: string; method: string }): Promise<{ id: string }> {
  const s = await session(acc)
  if (!s.submission) throw new HttpError(400, `${acc.label} does not allow sending with this token (it needs Submission access)`)
  if (!EMAIL.test(opts.to.email)) throw new HttpError(400, 'The organiser has no email address')
  const m = await meta(acc)
  const identity = m.identities.find((i) => i.email.toLowerCase() === opts.from.toLowerCase()) ?? m.identities[0]
  if (!identity) throw new HttpError(400, 'This account has no identity to send from')
  const drafts = m.role('drafts')
  if (!drafts) throw new HttpError(400, 'This account has no Drafts mailbox')
  const sent = m.role('sent')
  const boundary = `mvlos-${randomBytes(12).toString('hex')}`
  const domain = identity.email.split('@')[1] ?? 'mvlos'
  const raw = [
    `From: ${mailbox({ name: identity.name || null, email: identity.email })}`,
    `To: ${mailbox(opts.to)}`,
    `Subject: ${headerWords(opts.subject).slice(0, 900)}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${randomBytes(16).toString('hex')}@${domain}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(opts.text),
    `--${boundary}`,
    `Content-Type: text/calendar; method=${opts.method}; charset=utf-8`,
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(opts.ics),
    `--${boundary}--`,
    '',
  ].join('\r\n')
  const res = await mailFetch(acc, fill(s.uploadUrl, { accountId: s.accountId }), { method: 'POST', headers: { ...bearer(acc.token), 'Content-Type': 'message/rfc822' }, body: Buffer.from(raw, 'utf8'), signal: AbortSignal.timeout(TIMEOUT) }).catch((e) => (rethrowEgress(e), null))
  if (!res) throw new HttpError(502, `${acc.label} did not answer`)
  const up = JSON.parse((await readCapped(res, 64 * 1024)).toString('utf8') || '{}') as Json
  if (!res.ok || typeof up.blobId !== 'string') throw new HttpError(502, `${acc.label} refused the upload (${res.status})`)
  const afterwards = sent ? { [`mailboxIds/${drafts}`]: null, [`mailboxIds/${sent}`]: true, 'keywords/$draft': null } : { 'keywords/$draft': null }
  const r = await jmap(acc, [
    ['Email/import', { emails: { reply: { blobId: up.blobId, mailboxIds: { [drafts]: true }, keywords: { $draft: true, $seen: true } } } }, 'i'],
    ['EmailSubmission/set', { create: { send: { identityId: identity.id, emailId: '#reply' } }, onSuccessUpdateEmail: { '#send': afterwards } }, 's'],
  ])
  const made = r.get('i', 'Email/import')
  if (!made.created?.reply) throw new HttpError(502, `The mail server refused the reply: ${made.notCreated?.reply?.description ?? made.notCreated?.reply?.type ?? 'error'}`)
  const sub = r.get('s', 'EmailSubmission/set')
  if (!sub.created?.send) throw new HttpError(502, `Not sent: ${sub.notCreated?.send?.description ?? sub.notCreated?.send?.type ?? 'the mail server refused it'}`)
  metas.delete(acc.key)
  tellPages(acc.user.id, 'mail', { account: acc.id })
  return { id: made.created.reply.id }
}

// ---------------------------------------------------------------------------------------------
// The API

/** Every /api/mail route (server/api.ts hands them over); resolves true when it answered. */
export async function handleMailApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const path = url.pathname
  const method = req.method ?? 'GET'
  const head = method === 'HEAD'
  const read = method === 'GET' || head
  // Inline pictures in the message frame: a sealed link, not the session (the frame sends no cookie).
  const inline = /^\/api\/mail\/inline\/([\w-]{20,2000})$/.exec(path)
  if (inline && read) return await serveInline(req, res, inline[1], head), true

  const user = requireUser(req)
  lastUse.set(user.id, Date.now())
  const q = (k: string) => url.searchParams.get(k)
  if (path === '/api/mail/accounts' && read) return json(res, 200, { accounts: listMail(user) }), true
  if (path === '/api/mail/accounts' && method === 'POST') {
    const info = await addMail(user, await readJson(req, 16 * 1024))
    void withoutPrivateRequest(() => mailWatch()).catch(() => {})
    return json(res, 200, info), true
  }
  // A sender's brand icon by domain (server/mailicons.ts): for the avatars in the list and reader.
  const icon = /^\/api\/mail\/icon\/([a-z0-9.-]{1,253})$/i.exec(path)
  if (icon && read) return await serveSenderIcon(res, icon[1], head, user.id), true
  const removing = /^\/api\/mail\/accounts\/(\d+)$/.exec(path)
  if (removing && method === 'DELETE') return removeMail(user, Number(removing[1])), json(res, 200, { ok: true }), true

  const route = /^\/api\/mail\/(\d+)\/([a-z]+)(?:\/([A-Za-z0-9_-]{1,255}))?$/.exec(path)
  if (!route) throw new HttpError(404, 'Not found')
  const acc = linked(user, route[1])
  bindMailRequest(acc)
  const [, , what, id] = route
  if (what === 'bootstrap' && read) {
    const [m, s] = await Promise.all([meta(acc, true), session(acc)])
    return json(res, 200, { mailboxes: m.mailboxes, identities: m.identities, maxSizeUpload: s.maxSizeUpload, canSend: s.submission, username: s.username }), true
  }
  if (what === 'threads' && read) return json(res, 200, await listThreads(acc, { mailbox: q('mailbox'), q: q('q'), position: Number(q('position')), limit: Number(q('limit')) })), true
  if (what === 'thread' && read && id) return json(res, 200, await getThread(acc, id, idList((q('images') ?? '').split(',')))), true
  if (what === 'message' && read && id) return json(res, 200, await getMessage(acc, id, q('images') === '1')), true
  if (what === 'act' && method === 'POST') return json(res, 200, await act(acc, await readJson(req, 64 * 1024))), true
  if (what === 'draft' && method === 'POST') return json(res, 200, await saveDraft(acc, await readJson(req, 4 * 1024 * 1024))), true
  if (what === 'draft' && method === 'DELETE' && id) return await discardDraft(acc, id), json(res, 200, { ok: true }), true
  if (what === 'send' && method === 'POST') return json(res, 200, await send(acc, await readJson(req, 4 * 1024 * 1024))), true
  if (what === 'upload' && method === 'POST') return json(res, 200, await upload(acc, req, q('type'))), true
  if (what === 'blob' && read && id) {
    const name = (q('name') ?? 'attachment').slice(0, 200)
    const type = (q('type') ?? 'application/octet-stream').slice(0, 100)
    const shown = q('inline') === '1'
    // Seeking in audio or video: the range goes on to the mail server (only for what plays inline).
    const range = shown && PLAYABLE.test(type) && /^bytes=\d*-\d*$/.test(req.headers.range ?? '') ? req.headers.range! : null
    return await pipeBlob(res, await fetchBlob(acc, id, name, type, range), name, type, shown, head), true
  }
  if (what === 'suggest' && read) return json(res, 200, { people: await suggest(acc, (q('q') ?? '').slice(0, 100)) }), true
  throw new HttpError(404, 'Not found')
}

const session = mailOperation(sessionInner)

const jmap = mailOperation(jmapInner)

const meta = mailOperation(metaInner)

export const listThreads = mailOperation(listThreadsInner)

const render = mailOperation(renderInner)

export const getThread = mailOperation(getThreadInner)

export const getMessage = mailOperation(getMessageInner)

export const act = mailOperation(actInner)

const oldDraft = mailOperation(oldDraftInner)

export const saveDraft = mailOperation(saveDraftInner)

export const discardDraft = mailOperation(discardDraftInner)

export const send = mailOperation(sendInner)

const upload = mailOperation(uploadInner)

const fetchBlob = mailOperation(fetchBlobInner)

const blobText = mailOperation(blobTextInner)

const correspondents = mailOperation(correspondentsInner)

const suggest = mailOperation(suggestInner)

const announce = mailOperation(announceInner)

const taskMail = mailOperation(taskMailInner)

export const ownAddresses = mailOperation(ownAddressesInner)

export const messageFacts = mailOperation(messageFactsInner)

export const mailWith = mailOperation(mailWithInner)

export const findByMessageId = mailOperation(findByMessageIdInner)

export const mailMeta = mailOperation(mailMetaInner)

export const plainMessages = mailOperation(plainMessagesInner)

export const sendItip = mailOperation(sendItipInner)
