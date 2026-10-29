import { isAdmin, maxUsers, registration, type User } from './auth.ts'
import { database, setAppSetting } from './db.ts'
import { HttpError } from './http.ts'
import { limitMb, usedBytes } from './quota.ts'
import { ban, deleteUser, signOutEverywhere, unban } from './users.ts'

// Settings → Users, for admins (ADMIN_GITHUB_IDS): every account with what it links and how much it
// stores, never what it stores. Ban, sign out, delete, and whether new accounts may sign up.

const PAGE = 50
/** Integrations shown by name; settings rows (Agents, web search) are not services. */
const SERVICES: Record<string, string> = { seafile: 'Seafile', onlyoffice: 'OnlyOffice', ollama: 'Ollama', updown: 'updown.io' }

export type AdminUser = {
  id: number
  login: string
  name: string | null
  avatar: string | null
  joinedAt: number
  lastSeenAt: number | null
  banned: { at: number; reason: string | null } | null
  admin: boolean
  services: string[]
  storageBytes: number
  threads: number
}

type Row = { id: number; github_id: number; login: string; name: string | null; avatar: string | null; created_at: number; last_seen_at: number | null; banned_at: number | null; ban_reason: string | null }

function describe(r: Row): AdminUser {
  const db = database()
  const count = (sql: string) => (db.prepare(sql).get(r.id) as { n: number }).n
  const services = [
    ...Array.from({ length: count('SELECT COUNT(*) AS n FROM forges WHERE user_id = ?') }, () => 'Gitea/Forgejo'),
    ...(count('SELECT COUNT(*) AS n FROM google WHERE user_id = ?') ? ['Google Calendar'] : []),
    ...Array.from({ length: count('SELECT COUNT(*) AS n FROM caldav WHERE user_id = ?') }, () => 'CalDAV'),
    ...(db.prepare('SELECT name FROM integrations WHERE user_id = ?').all(r.id) as { name: string }[]).map((i) => SERVICES[i.name]).filter(Boolean),
  ]
  return {
    id: r.id,
    login: r.login,
    name: r.name,
    avatar: r.avatar,
    joinedAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    banned: r.banned_at ? { at: r.banned_at, reason: r.ban_reason } : null,
    admin: isAdmin(r.github_id),
    services,
    storageBytes: usedBytes(r.id),
    // Chat threads: not a task run's hidden transcript (quick = 3) nor a subagent's (quick = 4).
    threads: count('SELECT COUNT(*) AS n FROM agent_threads WHERE user_id = ? AND quick NOT IN (3, 4)'),
  }
}

const COLS = 'id, github_id, login, name, avatar, created_at, last_seen_at, banned_at, ban_reason'

/** A page of accounts, most recently seen first, searched by login or name. */
export function listUsers(q: string | null, cursor: string | null): { users: AdminUser[]; next: string | null } {
  const offset = Math.max(0, Math.floor(Number(cursor) || 0))
  const text = (q ?? '').trim().toLowerCase().slice(0, 100)
  const like = `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
  const rows = database()
    .prepare(`SELECT ${COLS} FROM users WHERE ? = '' OR LOWER(login) LIKE ? ESCAPE '\\' OR LOWER(IFNULL(name, '')) LIKE ? ESCAPE '\\' ORDER BY last_seen_at IS NULL, last_seen_at DESC, id DESC LIMIT ? OFFSET ?`)
    .all(text, like, like, PAGE + 1, offset) as Row[]
  return { users: rows.slice(0, PAGE).map(describe), next: rows.length > PAGE ? String(offset + PAGE) : null }
}

export function adminStats() {
  const { count, max, open } = registration()
  const banned = (database().prepare('SELECT COUNT(*) AS n FROM users WHERE banned_at IS NOT NULL').get() as { n: number }).n
  return { count, max, open, banned, storageMb: limitMb() }
}

/** Opens or closes sign-up, sets how many accounts may exist, and how much room each one gets. */
export function updateSettings(body: { registration?: unknown; maxUsers?: unknown; storageMb?: unknown }) {
  if (body.storageMb !== undefined) {
    const mb = Number(body.storageMb)
    if (!Number.isInteger(mb) || mb < 1 || mb > 1_000_000) throw new HttpError(400, 'Room per account is a whole number of MB, from 1 to 1000000')
    setAppSetting('user_storage_mb', String(mb))
  }
  if (body.registration !== undefined) {
    if (body.registration !== 'open' && body.registration !== 'closed') throw new HttpError(400, 'Registration is open or closed')
    setAppSetting('registration', body.registration)
  }
  if (body.maxUsers !== undefined) {
    const n = Number(body.maxUsers)
    if (!Number.isInteger(n) || n < 0 || n > 100_000) throw new HttpError(400, 'The cap is a whole number from 0')
    setAppSetting('max_users', String(n))
  }
  return { ...adminStats(), max: maxUsers() }
}

/** An account the admin may act on: not themselves, not another admin. */
function target(admin: User, raw: string): number {
  const id = Number(raw)
  const row = database().prepare('SELECT github_id FROM users WHERE id = ?').get(id) as { github_id: number } | undefined
  if (!row) throw new HttpError(404, 'No such user')
  if (id === admin.id) throw new HttpError(400, 'Not on your own account (Settings → Account can delete it)')
  if (isAdmin(row.github_id)) throw new HttpError(400, 'Admins are set in ADMIN_GITHUB_IDS on the server, not here')
  return id
}

export function adminUser(raw: string): AdminUser {
  const row = database().prepare(`SELECT ${COLS} FROM users WHERE id = ?`).get(Number(raw)) as Row | undefined
  if (!row) throw new HttpError(404, 'No such user')
  return describe(row)
}

export function banUser(admin: User, raw: string, body: { reason?: unknown }) {
  const id = target(admin, raw)
  ban(id, typeof body.reason === 'string' ? body.reason : '')
  return adminUser(raw)
}

export function unbanUser(admin: User, raw: string) {
  const id = target(admin, raw)
  unban(id)
  return adminUser(raw)
}

export function signOutUser(admin: User, raw: string) {
  signOutEverywhere(target(admin, raw))
  return adminUser(raw)
}

export async function removeUser(admin: User, raw: string) {
  await deleteUser(target(admin, raw))
}
