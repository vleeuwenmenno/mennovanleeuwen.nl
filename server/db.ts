import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// The site's only persistent state: signed-in users, their sessions, linked Gitea/Forgejo
// instances, a linked Google Calendar, synced desktop state (notes, window layout, launchers) and
// the Minecraft server's history. One SQLite file in DATA_DIR (default ./data), opened on first use.
//
// Access tokens (GitHub, Gitea, Google, updown.io) are encrypted at rest with AES-256-GCM. The key comes from
// SESSION_SECRET, or a random one generated once into DATA_DIR/secret.key.

const DATA_DIR = resolve(process.env.DATA_DIR ?? 'data')

let db: DatabaseSync | null = null
let key: Buffer | null = null

function secret(): Buffer {
  if (process.env.SESSION_SECRET) return Buffer.from(process.env.SESSION_SECRET, 'utf8')
  const file = join(DATA_DIR, 'secret.key')
  if (!existsSync(file)) {
    writeFileSync(file, randomBytes(32).toString('base64'), { mode: 0o600 })
    chmodSync(file, 0o600)
  }
  return Buffer.from(readFileSync(file, 'utf8').trim(), 'base64')
}

export function database(): DatabaseSync {
  if (db) return db
  mkdirSync(DATA_DIR, { recursive: true })
  db = new DatabaseSync(join(DATA_DIR, 'mvlos.db'))
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      github_id INTEGER NOT NULL UNIQUE,
      login TEXT NOT NULL,
      name TEXT,
      avatar TEXT,
      github_token TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS forges (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      base_url TEXT NOT NULL,
      username TEXT NOT NULL,
      token TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS state (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, key)
    );
    CREATE TABLE IF NOT EXISTS integrations (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      secret TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, name)
    );
    CREATE TABLE IF NOT EXISTS google (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      access_token TEXT,
      expires_at INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    -- The Minecraft server, pinged every 30 s (server/minecraft.ts): one row per ping, and one
    -- per player visit, open (left_at NULL) while they are still on.
    CREATE TABLE IF NOT EXISTS mc_samples (
      at INTEGER PRIMARY KEY,
      online INTEGER NOT NULL,
      players INTEGER NOT NULL,
      latency INTEGER
    );
    CREATE TABLE IF NOT EXISTS mc_sessions (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      joined_at INTEGER NOT NULL,
      left_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS mc_sessions_open ON mc_sessions (left_at);
  `)
  key = Buffer.from(hkdfSync('sha256', secret(), 'mvlos', 'token-encryption', 32))
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now())
  return db
}

export function encrypt(plain: string): string {
  database()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key!, iv)
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), body.toString('base64')].join('.')
}

export function decrypt(sealed: string): string {
  database()
  const [v, iv, tag, body] = sealed.split('.')
  if (v !== 'v1') throw new Error('Unknown token format')
  const decipher = createDecipheriv('aes-256-gcm', key!, Buffer.from(iv, 'base64'))
  decipher.setAuthTag(Buffer.from(tag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8')
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
