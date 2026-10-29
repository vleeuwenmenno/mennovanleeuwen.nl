import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto'
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// The site's only persistent state: users, their sessions, linked Gitea/Forgejo
// instances, a linked Google Calendar, synced desktop state (notes, window layout, launchers) and
// the Minecraft server's history. One SQLite file in DATA_DIR (default ./data), opened on first use.
//
// Access tokens and passwords (GitHub, Gitea, Google, CalDAV, updown.io, Ollama) are encrypted at rest
// with AES-256-GCM. The key comes from SESSION_SECRET, or a random one generated once into
// DATA_DIR/secret.key.
//
// The database holds plaintext user data, so on every start DATA_DIR is set to 0700 and mvlos.db
// (plus its -wal and -shm files) and secret.key to 0600: existing installs are corrected too, not
// just new ones. The private directory keeps the WAL/SHM files closed to other users whatever
// mode SQLite gives them. Windows has no POSIX modes, so nothing is changed there.

const DATA_DIR = resolve(process.env.DATA_DIR ?? 'data')
const POSIX = process.platform !== 'win32'

let db: DatabaseSync | null = null
let key: Buffer | null = null

function privateDir() {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
  if (POSIX) chmodSync(DATA_DIR, 0o700)
}

function privateFile(file: string) {
  if (POSIX && existsSync(file)) chmodSync(file, 0o600)
}

function secret(): Buffer {
  if (process.env.SESSION_SECRET) return Buffer.from(process.env.SESSION_SECRET, 'utf8')
  const file = join(DATA_DIR, 'secret.key')
  privateDir()
  if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString('base64'), { mode: 0o600 })
  privateFile(file)
  return Buffer.from(readFileSync(file, 'utf8').trim(), 'base64')
}

// Installed by privateRequest without importing auth back into this storage module. Every local
// commit uses the current request/aggregate authority, including helpers that await providers.
const rollbackOnly = (sql: string) => /^\s*ROLLBACK(?:\s+TRANSACTION)?\s*;?\s*$/i.test(sql)
let checkWrite = () => {}
export const guardDatabaseWrites = (check: () => void) => { checkWrite = check }

export function database(): DatabaseSync {
  if (db) return db
  privateDir()
  const file = join(DATA_DIR, 'mvlos.db')
  if (!existsSync(file)) closeSync(openSync(file, 'a', 0o600))
  privateFile(file)
  db = new DatabaseSync(file)
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
    -- Players hiding their name used to be recorded as "Anonymous Player" (not a valid name).
    DELETE FROM mc_sessions WHERE name = 'Anonymous Player';
    -- Nor are glued-together RCON answers ("There are 0 of a max of 20 players online:"): no real
    -- name has a space or runs past 16 characters.
    DELETE FROM mc_sessions WHERE name LIKE '% %' OR length(name) > 16;
    -- The Agents app (server/agents.ts): threads with their messages, and what the agent was asked
    -- to remember about the user across threads.
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
    CREATE TABLE IF NOT EXISTS agent_image_source_aliases (
      source_id TEXT NOT NULL,
      message_id INTEGER NOT NULL REFERENCES agent_messages(id) ON DELETE CASCADE,
      PRIMARY KEY (source_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS agent_image_source_aliases_message ON agent_image_source_aliases(message_id);
    CREATE TABLE IF NOT EXISTS agent_images (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      body BLOB NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS agent_images_thread ON agent_images (thread_id);
    CREATE TABLE IF NOT EXISTS agent_image_masks (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
      source_id TEXT NOT NULL,
      body BLOB NOT NULL,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS agent_image_masks_thread ON agent_image_masks(thread_id);
    CREATE TABLE IF NOT EXISTS agent_memories (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      thread_id TEXT,
      created_at INTEGER NOT NULL
    );
  `)
  privateFile(`${file}-wal`)
  privateFile(`${file}-shm`)
  // Added later: the scopes Google granted (editing needs calendar.events).
  if (!(db.prepare('PRAGMA table_info(google)').all() as { name: string }[]).some((c) => c.name === 'scopes')) db.exec('ALTER TABLE google ADD COLUMN scopes TEXT')
  // Added later: which tool groups a thread may use (JSON; null for all), and files attached to a message.
  if (!(db.prepare('PRAGMA table_info(agent_threads)').all() as { name: string }[]).some((c) => c.name === 'tools')) db.exec('ALTER TABLE agent_threads ADD COLUMN tools TEXT')
  if (!(db.prepare('PRAGMA table_info(agent_messages)').all() as { name: string }[]).some((c) => c.name === 'attachments')) db.exec('ALTER TABLE agent_messages ADD COLUMN attachments TEXT')
  // Added later: projects (threads grouped in the sidebar, with a memory of their own), pinned
  // threads, and memories sorted by scope (the user, or one project) and category ("People/Friends").
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
  // The notification hub (server/notifier.ts): each account's notification list (the bell, on every
  // device), and what was sent once already.
  db.exec(`CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source TEXT,
    title TEXT NOT NULL,
    body TEXT,
    icon TEXT,
    action TEXT,
    at INTEGER NOT NULL,
    read INTEGER NOT NULL DEFAULT 0
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS notifications_user ON notifications (user_id, at)')
  db.exec(`CREATE TABLE IF NOT EXISTS notify_once (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (user_id, key)
  )`)
  // Web Push (server/webpush.ts): the browsers and installed apps the user turned push on for.
  db.exec(`CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL UNIQUE,
    keys TEXT NOT NULL,
    device TEXT,
    created_at INTEGER NOT NULL
  )`)
  // Added later: the session that made the subscription (sessions.id). Messages only go to
  // subscriptions whose session is still valid, and signing out removes them (server/webpush.ts).
  if (!cols('push_subscriptions').includes('session_id')) db.exec('ALTER TABLE push_subscriptions ADD COLUMN session_id TEXT')
  // A quick answer asked from Spotlight: kept out of the Agents app until it is continued there.
  if (!cols('agent_threads').includes('quick')) db.exec('ALTER TABLE agent_threads ADD COLUMN quick INTEGER NOT NULL DEFAULT 0')
  // Added later: open sign-up. When someone was last seen, whether (and why) they were banned, and
  // the GitHub scopes their token has; app-wide settings the admin changes (registration, the cap).
  if (!cols('users').includes('last_seen_at')) db.exec('ALTER TABLE users ADD COLUMN last_seen_at INTEGER')
  if (!cols('users').includes('banned_at')) db.exec('ALTER TABLE users ADD COLUMN banned_at INTEGER')
  if (!cols('users').includes('ban_reason')) db.exec('ALTER TABLE users ADD COLUMN ban_reason TEXT')
  if (!cols('users').includes('github_scopes')) db.exec('ALTER TABLE users ADD COLUMN github_scopes TEXT')
  db.exec('CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  // Added later: a thread's work folder (JSON {repo, path, label}) and its permission mode, for
  // the terminal's agents command and the file tools.
  if (!cols('agent_threads').includes('workdir')) db.exec('ALTER TABLE agent_threads ADD COLUMN workdir TEXT')
  if (!cols('agent_threads').includes('permission')) db.exec('ALTER TABLE agent_threads ADD COLUMN permission TEXT')
  // Added later: how many tokens a thread's last reply took up in the model's context.
  if (!(db.prepare('PRAGMA table_info(agent_threads)').all() as { name: string }[]).some((c) => c.name === 'context_tokens')) db.exec('ALTER TABLE agent_threads ADD COLUMN context_tokens INTEGER')
  // Added later: messages written while a turn runs, waiting to be sent next (JSON, server/agents.ts).
  if (!cols('agent_threads').includes('queue')) db.exec('ALTER TABLE agent_threads ADD COLUMN queue TEXT')
  // Added later: when the thread's turns started (set while they run, so a crash is noticed on the
  // next start), and how the last turn was cut short (JSON {reason, error?, at}), for Retry.
  if (!cols('agent_threads').includes('turn_at')) db.exec('ALTER TABLE agent_threads ADD COLUMN turn_at INTEGER')
  if (!cols('agent_threads').includes('interrupted')) db.exec('ALTER TABLE agent_threads ADD COLUMN interrupted TEXT')
  // Added later: keeping titles up to date (server/agents.ts). Who set the title ('user' when it
  // was renamed by hand, which the automatic check never overrides; 'first' for a first title made
  // from the first message that is named again after the first answer; NULL or 'auto' otherwise), the
  // titles it had before (JSON [{title, until}], newest first), and the last message id when the
  // title was last decided on, so the check knows how much was said since.
  if (!cols('agent_threads').includes('title_source')) db.exec('ALTER TABLE agent_threads ADD COLUMN title_source TEXT')
  if (!cols('agent_threads').includes('title_history')) db.exec('ALTER TABLE agent_threads ADD COLUMN title_history TEXT')
  if (!cols('agent_threads').includes('title_mark')) db.exec('ALTER TABLE agent_threads ADD COLUMN title_mark INTEGER')
  // Always-on skills and rule instructions switched off in one thread (its chips; JSON list of
  // skill names and rule:<id>, src/data/agentSkillRules.ts).
  if (!cols('agent_threads').includes('skills_off')) db.exec('ALTER TABLE agent_threads ADD COLUMN skills_off TEXT')
  // The thinking effort picked for a thread (server/agentChatGPT.ts EFFORTS); null follows the mode.
  if (!cols('agent_threads').includes('effort')) db.exec('ALTER TABLE agent_threads ADD COLUMN effort TEXT')
  // Shared links to a thread or one answer (server/shares.ts): a snapshot taken when shared, read
  // by anyone with the token until it expires or is revoked. They go with their thread and account.
  db.exec(`CREATE TABLE IF NOT EXISTS agent_shares (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    message_id INTEGER,
    title TEXT NOT NULL,
    snapshot TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    views INTEGER NOT NULL DEFAULT 0
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS agent_shares_user ON agent_shares (user_id, created_at)')
  db.exec('CREATE INDEX IF NOT EXISTS agent_shares_thread ON agent_shares (thread_id)')
  db.exec('CREATE INDEX IF NOT EXISTS agent_shares_expiry ON agent_shares (expires_at) WHERE expires_at IS NOT NULL')
  // Added later: web sites the user allowed for good ("Allow github.com" on a web read the agent
  // asked about), for all their threads, and why a web read ran without asking (shown on its row).
  db.exec(`CREATE TABLE IF NOT EXISTS agent_domains (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    host TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, host)
  )`)
  if (!cols('agent_messages').includes('checked')) db.exec('ALTER TABLE agent_messages ADD COLUMN checked TEXT')
  // Added later: mail reads (searches and reads of the Agents app's mail tools) the user allowed
  // always, for all their threads (Settings → Agents → Permissions). No row: they ask (the default).
  db.exec(`CREATE TABLE IF NOT EXISTS agent_mail_reads (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    always INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`)
  // The Photos app (server/photos.ts): the Seafile folders chosen as photo sources, the index of
  // the photos and videos in them (what EXIF says, read from each file's first bytes), and the
  // folders' Seafile ids from the last full walk (an unchanged id means nothing in it changed).
  db.exec(`CREATE TABLE IF NOT EXISTS photo_sources (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    repo TEXT NOT NULL,
    path TEXT NOT NULL,
    PRIMARY KEY (user_id, repo, path)
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS photos (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    repo TEXT NOT NULL,
    path TEXT NOT NULL,
    kind TEXT NOT NULL,
    size INTEGER NOT NULL,
    mtime INTEGER NOT NULL,
    file_id TEXT NOT NULL,
    taken_at INTEGER NOT NULL,
    taken_src TEXT NOT NULL,
    taken_offset TEXT,
    width INTEGER,
    height INTEGER,
    orientation INTEGER,
    make TEXT,
    model TEXT,
    lens TEXT,
    exposure REAL,
    fnumber REAL,
    iso INTEGER,
    focal REAL,
    focal35 REAL,
    lat REAL,
    lon REAL,
    alt REAL,
    thumb BLOB,
    favourite INTEGER NOT NULL DEFAULT 0,
    UNIQUE (user_id, repo, path)
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS photos_taken ON photos (user_id, taken_at)')
  db.exec(`CREATE TABLE IF NOT EXISTS photo_dirs (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    repo TEXT NOT NULL,
    path TEXT NOT NULL,
    dir_id TEXT NOT NULL,
    PRIMARY KEY (user_id, repo, path)
  )`)
  // Which Seafile account the index is of (its URL and username): linking another one starts over.
  db.exec(`CREATE TABLE IF NOT EXISTS photo_accounts (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    seafile TEXT NOT NULL,
    scanned_at INTEGER
  )`)

  // Tasks kept on the site itself (server/tasks.ts), for accounts without CalDAV task lists: lists,
  // and each task as its own VTODO text, so it is read and changed like a CalDAV one. `etag` counts
  // the task's versions.
  db.exec(`CREATE TABLE IF NOT EXISTS task_lists (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    color TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS task_items (
    list_id INTEGER NOT NULL REFERENCES task_lists(id) ON DELETE CASCADE,
    uid TEXT NOT NULL,
    ics TEXT NOT NULL,
    etag INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (list_id, uid)
  )`)

  // The Agents app's icon library (server/agentOpenAI.ts): small PNGs by slug, per account, and
  // when each OpenAI picture was made, for the daily cap.
  db.exec(`CREATE TABLE IF NOT EXISTS agent_icons (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    slug TEXT NOT NULL,
    prompt TEXT NOT NULL,
    body BLOB NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, slug)
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS agent_image_usage (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    at INTEGER NOT NULL
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS agent_image_usage_user ON agent_image_usage (user_id, at)')
  // Real-world pictures the agents' find_image found (server/findImage.ts): downloaded once per
  // account by the server and served from /api/agents/images/<id>, so the browser never asks
  // the other site.
  db.exec(`CREATE TABLE IF NOT EXISTS agent_found_images (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    source_url TEXT NOT NULL,
    page_url TEXT,
    title TEXT NOT NULL,
    mime TEXT NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    hash TEXT NOT NULL,
    body BLOB NOT NULL,
    created_at INTEGER NOT NULL,
    used_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS agent_found_images_source ON agent_found_images (user_id, source_url)')
  db.prepare('DELETE FROM agent_image_usage WHERE at < ?').run(Date.now() - 2 * 86400_000)

  // Added later: a compaction (server/agents.ts), saved as a message with role 'compact' whose
  // content is the summary; this says how it came about (JSON {auto, reason?, instructions?, …}).
  if (!cols('agent_messages').includes('compact')) db.exec('ALTER TABLE agent_messages ADD COLUMN compact TEXT')
  // Thread stats (server/agentStats.ts): a reply's model call, a tool result's time. Older messages have none.
  if (!cols('agent_messages').includes('stats')) db.exec('ALTER TABLE agent_messages ADD COLUMN stats TEXT')
  if (!cols('agent_memories').includes('image_profile')) db.exec('ALTER TABLE agent_memories ADD COLUMN image_profile TEXT')
  if (!cols('agent_threads').includes('image_profile_id')) db.exec('ALTER TABLE agent_threads ADD COLUMN image_profile_id INTEGER')
  if (!cols('agent_memories').includes('image_learning')) db.exec('ALTER TABLE agent_memories ADD COLUMN image_learning TEXT')
  if (!cols('agent_images').includes('backend_scope')) db.exec('ALTER TABLE agent_images ADD COLUMN backend_scope TEXT')
  if (!cols('agent_images').includes('metadata')) db.exec('ALTER TABLE agent_images ADD COLUMN metadata TEXT')
  // Added later: masks the agent made with make_image_mask (origin 'auto') keep what they selected
  // (target, exclude, coverage, bounding box) so the thread can list and show every attempt.
  if (!cols('agent_image_masks').includes('origin')) db.exec("ALTER TABLE agent_image_masks ADD COLUMN origin TEXT NOT NULL DEFAULT 'editor'")
  if (!cols('agent_image_masks').includes('details')) db.exec('ALTER TABLE agent_image_masks ADD COLUMN details TEXT')
  if (!cols('agent_threads').includes('image_config')) db.exec('ALTER TABLE agent_threads ADD COLUMN image_config TEXT')
  // Agent tasks (server/agentTasks.ts): one-off and scheduled background runs of an agent, each
  // run in a hidden thread (agent_threads.quick = 3) whose messages are its transcript. JSON
  // columns hold the schedule, the permission policy (versioned: each run keeps the version and a
  // copy of what it ran under), where reports go, the per-run caps and the options. A run waiting
  // for the user keeps the calls it asks about in `pending` until `deadline`; agent_task_jobs holds
  // what is due later (an email when a notification was not seen in time, a report for a busy thread).
  db.exec(`CREATE TABLE IF NOT EXISTS agent_tasks (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    instruction TEXT NOT NULL,
    condition TEXT NOT NULL DEFAULT '',
    done_when TEXT NOT NULL DEFAULT '',
    schedule TEXT NOT NULL,
    timezone TEXT NOT NULL,
    state_note TEXT NOT NULL DEFAULT '',
    policy TEXT NOT NULL,
    policy_version INTEGER NOT NULL DEFAULT 1,
    report TEXT NOT NULL,
    caps TEXT NOT NULL,
    options TEXT NOT NULL,
    model TEXT,
    status TEXT NOT NULL,
    expires_at INTEGER,
    next_run_at INTEGER,
    last_run_at INTEGER,
    last_report_at INTEGER,
    failures INTEGER NOT NULL DEFAULT 0,
    created_from_thread TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS agent_tasks_user ON agent_tasks (user_id, created_at)')
  db.exec('CREATE INDEX IF NOT EXISTS agent_tasks_due ON agent_tasks (status, next_run_at)')
  db.exec(`CREATE TABLE IF NOT EXISTS agent_task_runs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    trigger TEXT NOT NULL,
    dry INTEGER NOT NULL DEFAULT 0,
    attempt INTEGER NOT NULL DEFAULT 0,
    quiet INTEGER NOT NULL DEFAULT 0,
    reported INTEGER NOT NULL DEFAULT 0,
    report_reason TEXT,
    summary TEXT,
    verdict TEXT,
    policy_version INTEGER NOT NULL,
    policy TEXT NOT NULL,
    queued_at INTEGER NOT NULL,
    started_at INTEGER,
    ended_at INTEGER,
    active_ms INTEGER NOT NULL DEFAULT 0,
    tokens_in INTEGER NOT NULL DEFAULT 0,
    tokens_out INTEGER NOT NULL DEFAULT 0,
    tool_calls INTEGER NOT NULL DEFAULT 0,
    thread_id TEXT,
    error TEXT,
    pending TEXT,
    deadline INTEGER,
    delivered TEXT
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS agent_task_runs_task ON agent_task_runs (task_id, queued_at)')
  db.exec('CREATE INDEX IF NOT EXISTS agent_task_runs_status ON agent_task_runs (status)')
  db.exec(`CREATE TABLE IF NOT EXISTS agent_task_jobs (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL REFERENCES agent_task_runs(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    due_at INTEGER NOT NULL,
    data TEXT
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS agent_task_jobs_due ON agent_task_jobs (due_at)')
  // New-mail tasks: the mail that matched a task, kept per task once (task, account, message), so
  // the same message delivered again, or seen again after a restart, never starts a second run.
  // `run_id` is null while it waits for its run; rows go after a week. A run keeps its own copy of
  // the mail that started it (agent_task_runs.trigger_mail); agent_tasks.mail_dropped counts mail
  // dropped while waiting (too many, or too old), told to the next run.
  db.exec(`CREATE TABLE IF NOT EXISTS agent_task_mail (
    task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id INTEGER NOT NULL,
    email_id TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    added_at INTEGER NOT NULL,
    meta TEXT NOT NULL,
    run_id TEXT,
    PRIMARY KEY (task_id, account_id, email_id)
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS agent_task_mail_waiting ON agent_task_mail (run_id, task_id, added_at)')
  if (!cols('agent_task_runs').includes('trigger_mail')) db.exec('ALTER TABLE agent_task_runs ADD COLUMN trigger_mail TEXT')
  // Message-IDs of mail tasks sent (their reports, a run's mail_send), a month long: a reply to one never starts a task.
  db.exec(`CREATE TABLE IF NOT EXISTS agent_task_sent (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL,
    sent_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, message_id)
  )`)
  // A mail task's hours at its cap (JSON, the latest few hour numbers): three in a row pause it.
  if (!cols('agent_tasks').includes('mail_capped')) db.exec('ALTER TABLE agent_tasks ADD COLUMN mail_capped TEXT')
  if (!cols('agent_tasks').includes('mail_dropped')) db.exec('ALTER TABLE agent_tasks ADD COLUMN mail_dropped INTEGER NOT NULL DEFAULT 0')
  // A task's work folder ({repo, path, label}, JSON; null: none), taken from the thread it was made in.
  if (!cols('agent_tasks').includes('workdir')) db.exec('ALTER TABLE agent_tasks ADD COLUMN workdir TEXT')
  // A run's own model (Run now on another model; null: the task's), its number within the task
  // (run #n), and the chat thread it continues (report "Continue in the thread it was made in"):
  // the thread whose context it was seeded with, and the message it landed as there.
  if (!cols('agent_task_runs').includes('model')) db.exec('ALTER TABLE agent_task_runs ADD COLUMN model TEXT')
  if (!cols('agent_task_runs').includes('number')) db.exec('ALTER TABLE agent_task_runs ADD COLUMN number INTEGER')
  if (!cols('agent_task_runs').includes('origin_thread')) db.exec('ALTER TABLE agent_task_runs ADD COLUMN origin_thread TEXT')
  if (!cols('agent_task_runs').includes('origin_message')) db.exec('ALTER TABLE agent_task_runs ADD COLUMN origin_message INTEGER')
  db.exec('CREATE INDEX IF NOT EXISTS agent_task_runs_origin ON agent_task_runs (origin_thread, status)')
  // What the app keeps about a message beyond its text (JSON): a task run's block or quiet line in
  // the thread it continues, a subagent's overview in its parent's thread.
  if (!cols('agent_messages').includes('meta')) db.exec('ALTER TABLE agent_messages ADD COLUMN meta TEXT')
  // Subagents (server/agents.ts): a hidden child thread (agent_threads.quick = 4) a chat agent
  // started, owned by its parent thread, with its name, the model and mode it was spawned with and
  // what it may use. `spawned_after`: the parent's user message it was spawned under (a rewind to
  // it or before drops the child and its late results). `status`: running, idle, stopped, failed
  // or interrupted. agent_inbox: what waits for a thread to read at its next round boundary, so
  // nobody writes into a running thread: a child's result for its parent, a message for a busy child.
  db.exec(`CREATE TABLE IF NOT EXISTS agent_subagents (
    id TEXT PRIMARY KEY REFERENCES agent_threads(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    parent_thread TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    status TEXT NOT NULL,
    spec TEXT NOT NULL,
    spawned_after INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    started_at INTEGER,
    ended_at INTEGER,
    active_ms INTEGER NOT NULL DEFAULT 0,
    tokens_in INTEGER NOT NULL DEFAULT 0,
    tokens_out INTEGER NOT NULL DEFAULT 0,
    tool_calls INTEGER NOT NULL DEFAULT 0,
    last_output TEXT,
    error TEXT
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS agent_subagents_parent ON agent_subagents (parent_thread, created_at)')
  db.exec(`CREATE TABLE IF NOT EXISTS agent_inbox (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS agent_inbox_thread ON agent_inbox (thread_id, id)')
  key =Buffer.from(hkdfSync('sha256', secret(), 'mvlos', 'token-encryption', 32))
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now())
  const prepare = db.prepare.bind(db), exec = db.exec.bind(db)
  db.prepare = ((...args: Parameters<typeof prepare>) => {
    const statement = prepare(...args)
    const run = statement.run.bind(statement)
    statement.run = ((...values: Parameters<typeof run>) => { if (!rollbackOnly(args[0])) checkWrite(); return run(...values) }) as typeof run
    return statement
  }) as typeof prepare
  db.exec = ((sql: string) => { if (!rollbackOnly(sql)) checkWrite(); return exec(sql) }) as typeof exec
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

/** An app-wide setting the admin changed (server/admin.ts), or null when it was never set. */
export function appSetting(name: string): string | null {
  const row = database().prepare('SELECT value FROM app_settings WHERE key = ?').get(name) as { value: string } | undefined
  return row?.value ?? null
}

export function setAppSetting(name: string, value: string) {
  database().prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(name, value)
}

const goneHandlers: ((userId: number) => void)[] = []

/** For modules that keep something per account in memory (caches, jobs): forget it when the account is deleted. */
export const onUserGone = (fn: (userId: number) => void) => void goneHandlers.push(fn)

/** Runs every onUserGone handler (server/users.ts, after deleting the account). */
export const userGone = (userId: number) => goneHandlers.forEach((fn) => fn(userId))

/**
 * The id for a new account: never one a deleted account had (SQLite reuses the highest rowid
 * after a delete), so nothing anyone kept about the old account can match the new one.
 */
export function nextUserId(): number {
  const { n } = database().prepare('SELECT MAX(id) AS n FROM users').get() as { n: number | null }
  const id = Math.max(n ?? 0, Number(appSetting('last_user_id') ?? 0)) + 1
  setAppSetting('last_user_id', String(id))
  return id
}

/** Opaque private identities; raw backend addresses/credentials never enter model context. */
export function privateDigest(value: string): string { database(); return createHmac('sha256', key!).update(value).digest('hex') }
