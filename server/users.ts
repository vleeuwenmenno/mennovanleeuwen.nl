import { stopTurnsOf } from './agents.ts'
import { isAdmin, type User } from './auth.ts'
import { database, decrypt, userGone } from './db.ts'
import { disconnectGoogle } from './google.ts'
import { HttpError } from './http.ts'
import { unlinkSeafile } from './seafile.ts'

// What happens to a whole account: signed out everywhere, banned (and let back in), deleted.
// Used by Settings → Account (deleting your own) and the admin's Settings → Users (server/admin.ts).

type Row = { id: number; login: string; name: string | null; avatar: string | null; github_token: string }

function userById(id: number): User {
  const row = database().prepare('SELECT id, login, name, avatar, github_token FROM users WHERE id = ?').get(id) as Row | undefined
  if (!row) throw new HttpError(404, 'No such user')
  let githubToken = ''
  try {
    githubToken = decrypt(row.github_token)
  } catch {
    /* sealed with another SESSION_SECRET: nothing to revoke */
  }
  return { id: row.id, login: row.login, name: row.name, avatar: row.avatar, githubToken, githubScopes: [], admin: isAdmin(row.login) }
}

/** Ends every session the account has, and stops its running Agents turns. */
export function signOutEverywhere(id: number) {
  database().prepare('DELETE FROM sessions WHERE user_id = ?').run(id)
  stopTurnsOf(id)
}

/** Keeps the account (and its spot) but signs it out and lets it no longer sign in. */
export function ban(id: number, reason: string) {
  userById(id)
  database().prepare('UPDATE users SET banned_at = ?, ban_reason = ? WHERE id = ?').run(Date.now(), reason.trim().slice(0, 200) || null, id)
  signOutEverywhere(id)
}

export function unban(id: number) {
  userById(id)
  database().prepare('UPDATE users SET banned_at = NULL, ban_reason = NULL WHERE id = ?').run(id)
}

/** Takes this app off the GitHub account, so the token stops working there too. */
async function revokeGithub(token: string) {
  const id = process.env.GITHUB_CLIENT_ID
  const secret = process.env.GITHUB_CLIENT_SECRET
  if (!token || !id || !secret) return
  await fetch(`https://api.github.com/applications/${id}/grant`, {
    method: 'DELETE',
    headers: { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'mvlos' },
    body: JSON.stringify({ access_token: token }),
    signal: AbortSignal.timeout(8000),
  }).catch(() => {})
}

/**
 * Deletes an account and everything it stored: tokens are revoked where the service allows
 * (GitHub, Google, Seafile), then the row goes and every table that belongs to it with it
 * (ON DELETE CASCADE), and the modules forget what they kept in memory (onUserGone).
 */
export async function deleteUser(id: number) {
  const user = userById(id)
  signOutEverywhere(id)
  await Promise.all([disconnectGoogle(user).catch(() => {}), unlinkSeafile(user).catch(() => {}), revokeGithub(user.githubToken)])
  database().prepare('DELETE FROM users WHERE id = ?').run(id)
  userGone(id)
}
