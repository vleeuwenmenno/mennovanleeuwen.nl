// Checks that server/db.ts keeps DATA_DIR private: directory 0700, mvlos.db and secret.key 0600, on a
// fresh install and when they already exist with looser modes (an older install):
// `node scripts/data-perms-check.ts`. Windows has no POSIX modes, so the mode assertions are skipped there.
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'data-perms-check-'))
const dir = join(root, 'data')
const mode = (p: string) => statSync(p).mode & 0o777
let failed = false

function expect(label: string, file: string, want: number) {
  const got = mode(file)
  if (got !== want) failed = true
  console.log(`${label}: ${got.toString(8).padStart(4, '0')} ${got === want ? 'ok' : `WANTED ${want.toString(8).padStart(4, '0')}`}`)
}

// Each start runs in its own process with an ordinary umask and no SESSION_SECRET, so secret.key is generated.
function start() {
  const env = { ...process.env, DATA_DIR: dir }
  delete env.SESSION_SECRET
  const code = "process.umask(0o022); const m = await import('./server/db.ts'); m.database().exec('CREATE TABLE IF NOT EXISTS probe (x)'); m.encrypt('probe')"
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env, stdio: 'inherit' })
  if (r.status !== 0) failed = true
}

try {
  if (process.platform === 'win32') {
    console.log('Windows: no POSIX modes, assertions skipped')
  } else {
    start()
    expect('fresh DATA_DIR', dir, 0o700)
    expect('fresh mvlos.db', join(dir, 'mvlos.db'), 0o600)
    expect('fresh secret.key', join(dir, 'secret.key'), 0o600)

    chmodSync(dir, 0o755)
    chmodSync(join(dir, 'mvlos.db'), 0o644)
    chmodSync(join(dir, 'secret.key'), 0o644)
    start()
    expect('existing DATA_DIR', dir, 0o700)
    expect('existing mvlos.db', join(dir, 'mvlos.db'), 0o600)
    expect('existing secret.key', join(dir, 'secret.key'), 0o600)
    for (const ext of ['-wal', '-shm']) if (existsSync(join(dir, `mvlos.db${ext}`))) expect(`mvlos.db${ext}`, join(dir, `mvlos.db${ext}`), 0o600)
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
