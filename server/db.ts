import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// The site's only persistent state: signed-in users, their sessions, linked Gitea/Forgejo
// instances, a linked Google Calendar, synced desktop state (notes, window layout, launchers) and
// the Minecraft server's history. One SQLite file in DATA_DIR (default ./data), opened on first use.
//
// Access tokens and passwords (GitHub, Gitea, Google, CalDAV, updown.io, Ollama) are encrypted at rest
// with AES-256-GCM. The key comes from SESSION_SECRET, or a random one generated once into
// DATA_DIR/secret.key.

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
    CREATE TABLE IF NOT EXISTS caldav (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      base_url TEXT NOT NULL,
      username TEXT NOT NULL,
      password TEXT NOT NULL,
      created_at INTEGER NOT NULL
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
    -- The Agents app (server/agents.ts): threads with their messages, and what the agent was asked
    -- to remember about the owner across threads.
    CREATE TABLE IF NOT EXISTS agent_threads (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      mode TEXT NOT NULL,
      model TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS agent_threads_user ON agent_threads (user_id, updated_at);
    CREATE TABLE IF NOT EXISTS agent_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      thinking TEXT,
      tool_calls TEXT,
      tool_name TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS agent_messages_thread ON agent_messages (thread_id, id);
    CREATE TABLE IF NOT EXISTS agent_memories (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      thread_id TEXT,
      created_at INTEGER NOT NULL
    );
  `)
  // Added later: the scopes Google granted (editing needs calendar.events).
  if (!(db.prepare('PRAGMA table_info(google)').all() as { name: string }[]).some((c) => c.name === 'scopes')) db.exec('ALTER TABLE google ADD COLUMN scopes TEXT')
  // Added later: which tool groups a thread may use (JSON; null for all), and files attached to a message.
  if (!(db.prepare('PRAGMA table_info(agent_threads)').all() as { name: string }[]).some((c) => c.name === 'tools')) db.exec('ALTER TABLE agent_threads ADD COLUMN tools TEXT')
  if (!(db.prepare('PRAGMA table_info(agent_messages)').all() as { name: string }[]).some((c) => c.name === 'attachments')) db.exec('ALTER TABLE agent_messages ADD COLUMN attachments TEXT')
  // Added later: projects (threads grouped in the sidebar, with a memory of their own), pinned
  // threads, and memories sorted by scope (the owner, or one project) and category ("People/Friends").
  db.exec(`CREATE TABLE IF NOT EXISTS agent_projects (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    sort INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`)
  const cols = (t: string) => (db!.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name)
  if (!cols('agent_threads').includes('project_id')) db.exec('ALTER TABLE agent_threads ADD COLUMN project_id INTEGER')
  if (!cols('agent_threads').includes('pinned')) db.exec('ALTER TABLE agent_threads ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0')
  if (!cols('agent_memories').includes('project_id')) db.exec('ALTER TABLE agent_memories ADD COLUMN project_id INTEGER')
  if (!cols('agent_memories').includes('category')) db.exec("ALTER TABLE agent_memories ADD COLUMN category TEXT NOT NULL DEFAULT ''")
  if (!cols('agent_memories').includes('updated_at')) db.exec('ALTER TABLE agent_memories ADD COLUMN updated_at INTEGER')
  // A thread's todo list, for long jobs: the agent keeps it up to date, the window shows it.
  if (!cols('agent_threads').includes('todos')) db.exec('ALTER TABLE agent_threads ADD COLUMN todos TEXT')
  // A quick answer asked from Spotlight: kept out of the Agents app until it is continued there.
  if (!cols('agent_threads').includes('quick')) db.exec('ALTER TABLE agent_threads ADD COLUMN quick INTEGER NOT NULL DEFAULT 0')
  // Added later: how many tokens a thread's last reply took up in the model's context.
  if (!(db.prepare('PRAGMA table_info(agent_threads)').all() as { name: string }[]).some((c) => c.name === 'context_tokens')) db.exec('ALTER TABLE agent_threads ADD COLUMN context_tokens INTEGER')
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
