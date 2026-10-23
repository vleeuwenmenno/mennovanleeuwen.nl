// What a page signed in with this session says about itself: X-MvL-Account, its account's id (or
// `visitor` for no valid session). The server refuses changes without it (server/api.ts,
// src/os/accountSpace.ts), so checks that talk to the server as a page send it too. Needs the
// check's DATA_DIR set (it reads the sessions from the same database).

export async function asPage(sid: string): Promise<Record<string, string>> {
  const { database, sha256 } = await import('../server/db.ts')
  const row = database().prepare('SELECT user_id FROM sessions WHERE id = ? AND expires_at > ?').get(sha256(sid), Date.now()) as { user_id: number } | undefined
  return { 'X-MvL-Account': row ? String(row.user_id) : 'visitor' }
}
