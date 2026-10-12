// Records the fixtures for `pnpm check:terminal-vt` (scripts/terminal-vt.ts) and `vtdemo`:
// real programs (Neovim, less, top, nano and tmux itself) run in a tmux pane of 80×24, with
// pipe-pane catching every byte they write. At each checkpoint the script also asks tmux, a
// real terminal emulator, what the pane shows: its text, its colours, the cursor and the modes.
// The check replays the bytes into our emulator and compares.
//
//   node scripts/terminal-vt-record.ts [name…]
//
// Needs tmux, nvim, less, top and nano. Writes src/terminal/vt/fixtures/<name>.json. Runs on its
// own tmux server (-L mvlos-vt-rec), so it leaves any other tmux alone.

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'

const COLS = 80
const ROWS = 24
const SOCKET = 'mvlos-vt-rec'
const OUT = new URL('../src/terminal/vt/fixtures/', import.meta.url)

mkdirSync(OUT, { recursive: true })
const dir = mkdtempSync(join(tmpdir(), 'mvlos-vt-'))
const conf = join(dir, 'tmux.conf')
writeFileSync(conf, ['set -g default-terminal xterm-256color', 'set -g status off', 'set -g escape-time 0', 'set -g history-limit 0', ''].join('\n'))
// The inner tmux (the tmux scenario): its own server and a plain shell, so the prompt is short.
const innerConf = join(dir, 'inner.conf')
writeFileSync(innerConf, ['set -g default-shell /bin/sh', 'set -g escape-time 0', 'set -g status-left "[demo] "', 'set -g status-right "mvlos"', ''].join('\n'))
const stamp = join(dir, 'stamp.mjs')
writeFileSync(stamp, `import { appendFileSync } from 'node:fs'\nprocess.stdin.on('data', (b) => appendFileSync(process.argv[2], JSON.stringify([Date.now(), b.toString('base64')]) + '\\n'))\n`)

// Files the programs open.
const sample = join(dir, 'deploy.sh')
writeFileSync(
  sample,
  `#!/bin/sh
# Deploys the site: builds, tags and pushes.
set -eu

VERSION="\${1:-1.0.0}"
echo "Building MvL OS $VERSION"
for step in typecheck build test; do
  pnpm "$step" || exit 1
done
git tag "v$VERSION" && git push --tags
`,
)
const log = join(dir, 'build.log')
const esc = '\x1b'
writeFileSync(
  log,
  Array.from({ length: 60 }, (_, i) => {
    const n = i + 1
    if (n % 10 === 0) return `${esc}[1;31merror${esc}[0m line ${n}: something went ${esc}[4mwrong${esc}[24m here, with a long tail that goes past the edge of an eighty column terminal so less has to wrap it`
    if (n % 7 === 0) return `${esc}[33mwarn${esc}[0m  line ${n}: ${esc}[38;5;208m256-colour orange${esc}[0m and ${esc}[38;2;120;200;255mtruecolour blue${esc}[0m`
    return `${esc}[32mok${esc}[0m    line ${n}: compiled module-${n}.ts`
  }).join('\n') + '\n',
)
const notes = join(dir, 'notes.txt')
writeFileSync(notes, 'Things to try in the terminal:\n- vim\n- htop\n- tmux\n')

// top shows only these stand-ins, not the machine's own processes.
const sleepers = [spawn('sleep', ['600']), spawn('sleep', ['600']), spawn('sleep', ['600'])]

const tmux = (...args: string[]) => execFileSync('tmux', ['-L', SOCKET, '-f', conf, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

type Step = { keys?: string[]; literal?: string; wait?: number; run?: string[]; check?: string }
type Scenario = { name: string; title: string; command: string; steps: Step[] }

const SCENARIOS: Scenario[] = [
  {
    name: 'nvim',
    title: 'Neovim editing a shell script',
    command: `nvim --clean -n ${sample}`,
    steps: [
      { wait: 1500, check: 'opened, with syntax colours' },
      { keys: [':set number', 'Enter'], wait: 400 },
      { keys: ['j', 'j', 'o'], wait: 300 },
      { literal: 'echo "wide: 日本語 ok"' },
      { keys: ['Escape'], wait: 600, check: 'line numbers and a new line with wide characters' },
      { keys: [':vsplit', 'Enter'], wait: 600, check: 'split in two' },
      { keys: [':qa!', 'Enter'], wait: 800, check: 'quit: back on the normal screen' },
    ],
  },
  {
    name: 'less',
    title: 'less -R on a coloured build log',
    command: `less -R ${log}`,
    steps: [
      { wait: 1000, check: 'first page' },
      { keys: ['Space'], wait: 500, check: 'next page' },
      { literal: '/wrong', keys: ['Enter'], wait: 600, check: 'search: matches in inverse' },
      { keys: ['G'], wait: 500, check: 'the end' },
      { keys: ['q'], wait: 600, check: 'quit' },
    ],
  },
  {
    name: 'top',
    title: 'top',
    command: `top -d 60 -p ${sleepers.map((p) => p.pid).join(',')}`,
    steps: [
      { wait: 1500, check: 'first screen' },
      { keys: ['z'], wait: 800, check: 'colours on' },
      { keys: ['q'], wait: 600, check: 'quit' },
    ],
  },
  {
    name: 'nano',
    title: 'GNU nano',
    command: `nano --ignorercfiles ${notes}`,
    steps: [
      { wait: 1000, check: 'opened' },
      { keys: ['Down', 'Down', 'Down', 'Down', 'End'], wait: 200 },
      { literal: '- nano, which is right here', keys: ['Enter'], wait: 500, check: 'typed a line' },
      { keys: ['C-x'], wait: 500, check: 'asks to save' },
      { keys: ['n'], wait: 600, check: 'quit without saving' },
    ],
  },
  {
    name: 'tmux',
    title: 'tmux inside the terminal: panes, a status bar and scroll regions',
    command: `tmux -L mvlos-vt-inner -f ${innerConf} new-session -s demo`,
    steps: [
      { wait: 1200, check: 'a new session' },
      { literal: 'printf "\\033[1;34mhello from tmux\\033[0m\\n"; seq 1 30', keys: ['Enter'], wait: 600, check: 'output scrolled' },
      { keys: ['C-b', '%'], wait: 600, check: 'split side by side' },
      { literal: 'printf "\\033[42m green \\033[0m \\033[7m inverse \\033[0m \\033[1;38;5;208mbold orange\\033[0m\\n"', keys: ['Enter'], wait: 500 },
      { keys: ['C-b', '"'], wait: 600, check: 'and split again' },
      { run: ['-L', 'mvlos-vt-inner', 'kill-server'], wait: 800, check: 'tmux gone' },
    ],
  },
]

function state(pane: string) {
  const text = tmux('capture-pane', '-p', '-t', pane).split('\n').slice(0, ROWS)
  // -N keeps trailing blanks, which can be coloured (a title bar).
  const ansi = tmux('capture-pane', '-p', '-e', '-N', '-t', pane).split('\n').slice(0, ROWS)
  const f = tmux('display', '-p', '-t', pane, '#{cursor_x} #{cursor_y} #{alternate_on} #{cursor_flag} #{keypad_cursor_flag} #{keypad_flag} #{mouse_all_flag} #{mouse_button_flag} #{mouse_standard_flag} #{mouse_sgr_flag} #{insert_flag} #{wrap_flag} #{origin_flag} #{scroll_region_upper} #{scroll_region_lower}|#{pane_title}').trim()
  const [nums, title] = f.split('|')
  const n = nums.split(' ').map(Number)
  return {
    screen: text.map((l) => l.replace(/\s+$/, '')),
    ansi,
    cursor: [n[0], n[1]],
    alt: !!n[2],
    modes: {
      cursorVisible: !!n[3],
      appCursor: !!n[4],
      appKeypad: !!n[5],
      mouse: n[6] ? 1003 : n[7] ? 1002 : n[8] ? 1000 : 0,
      mouseSgr: !!n[9],
      insert: !!n[10],
      autowrap: !!n[11],
      origin: !!n[12],
    },
    region: [n[13], n[14]],
    // tmux names a pane after the machine until a program sets a title.
    title: title === hostname() ? '' : title,
  }
}

const which = process.argv.slice(2)
for (const sc of SCENARIOS) {
  if (which.length && !which.includes(sc.name)) continue
  const raw = join(dir, `${sc.name}.jsonl`)
  rmSync(raw, { force: true })
  try {
    tmux('kill-server')
  } catch {
    /* none running */
  }
  // The program starts a moment after the pane, once pipe-pane is listening, and the pane stays
  // a while after it quits, so its last screen can be read.
  tmux('new-session', '-d', '-x', String(COLS), '-y', String(ROWS), '-s', 'rec', `sleep 0.5; ${sc.command}; sleep 60`)
  tmux('pipe-pane', '-t', 'rec', '-o', `node ${stamp} ${raw}`)
  const checks: unknown[] = []
  for (const step of sc.steps) {
    if (step.literal) tmux('send-keys', '-t', 'rec', '-l', '--', step.literal)
    if (step.keys) tmux('send-keys', '-t', 'rec', ...step.keys)
    if (step.run) execFileSync('tmux', step.run)
    sleep(step.wait ?? 300)
    if (!step.check) continue
    const frames = existsSync(raw) ? readFileSync(raw, 'utf8').trim().split('\n').filter(Boolean).length : 0
    checks.push({ label: step.check, frame: frames, ...state('rec') })
  }
  tmux('kill-server')
  // Bytes as text: a decoder across the chunks keeps characters split over two of them whole.
  const decoder = new TextDecoder()
  const lines = readFileSync(raw, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as [number, string])
  const t0 = lines[0]?.[0] ?? 0
  let prev = t0
  const frames = lines.map(([t, b64]) => {
    const delay = t - prev
    prev = t
    return [delay, decoder.decode(Buffer.from(b64, 'base64'), { stream: true })] as [number, string]
  })
  writeFileSync(new URL(`${sc.name}.json`, OUT), JSON.stringify({ name: sc.name, title: sc.title, command: sc.command.replace(dir, '~'), cols: COLS, rows: ROWS, frames, checks }) + '\n')
  console.log(`${sc.name}: ${frames.length} chunks, ${frames.reduce((n, f) => n + f[1].length, 0)} characters, ${checks.length} checkpoints`)
}
rmSync(dir, { recursive: true, force: true })
for (const p of sleepers) p.kill()
