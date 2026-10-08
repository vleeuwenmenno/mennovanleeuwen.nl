import { loadRecents } from '../data/recents'
import { CmdError, type Ctx } from './types'

// A simulated Pepper CLI against a pretend lab cluster: 3 masters and 4 minions. The command
// grammar, outcome names and output layout follow the real CLI (pepper.mvl.sh, pepper/cli's
// state_output.go); the cluster, states and timings are made up and nothing leaves the browser.

const c = (color: string, s: string) => `{c:${color}}${s}{/}`
const link = (url: string, text = url) => `{link:${url}}${text}{/}`

// ---------------------------------------------------------------------------------------------
// The pretend cluster

type MockNode = { id: string; role: 'master' | 'minion'; leader?: boolean; platform: string; os: string; labels: Record<string, string>; advertise: string }

const NODES: MockNode[] = [
  { id: 'master-1', role: 'master', leader: true, platform: 'linux/amd64', os: 'Debian 13', labels: { role: 'control', site: 'ams' }, advertise: 'master-1.lab.mvl.sh' },
  { id: 'master-2', role: 'master', platform: 'linux/amd64', os: 'Debian 13', labels: { role: 'control', site: 'ams' }, advertise: 'master-2.lab.mvl.sh' },
  { id: 'master-3', role: 'master', platform: 'linux/arm64', os: 'Debian 13', labels: { role: 'control', site: 'fra' }, advertise: 'master-3.lab.mvl.sh' },
  { id: 'web-01', role: 'minion', platform: 'linux/amd64', os: 'Ubuntu 24.04', labels: { role: 'web', site: 'ams' }, advertise: 'web-01.lab.mvl.sh' },
  { id: 'web-02', role: 'minion', platform: 'linux/amd64', os: 'Ubuntu 24.04', labels: { role: 'web', site: 'fra' }, advertise: 'web-02.lab.mvl.sh' },
  { id: 'db-01', role: 'minion', platform: 'linux/amd64', os: 'Debian 13', labels: { role: 'db', site: 'ams' }, advertise: 'db-01.lab.mvl.sh' },
  { id: 'mc-01', role: 'minion', platform: 'linux/arm64', os: 'Ubuntu 24.04', labels: { role: 'game', site: 'ams' }, advertise: 'cloud.mvl.sh' },
]

const LOCAL: MockNode = { id: 'mvlos', role: 'minion', platform: 'wasm32/browser', os: 'MvL OS 1.0', labels: { role: 'cv' }, advertise: 'localhost' }

type Entry = {
  id: string
  action: string
  meta?: string
  src: string
  /** Does this entry have work to do before the first apply? */
  pending: (n: MockNode) => boolean
  diff?: string[]
  message?: string
  risk?: { category: string; reason: string }
}

const STATES: Record<string, { selector: (n: MockNode) => boolean; entries: Entry[] }> = {
  'common.packages': {
    selector: (n) => n !== LOCAL,
    entries: [
      { id: 'base-tools', action: 'packages.installed', meta: 'curl, git, htop, jq', src: 'common/packages.star:4', pending: () => false },
      { id: 'unattended-upgrades', action: 'packages.installed', src: 'common/packages.star:11', pending: (n) => n.id === 'web-02' || n.id === 'mc-01', message: 'install unattended-upgrades 2.9.1' },
    ],
  },
  'common.ssh.server': {
    selector: (n) => n !== LOCAL,
    entries: [
      { id: 'sshd-config', action: 'file.managed', meta: '/etc/ssh/sshd_config.d/10-pepper.conf', src: 'common/ssh/server.star:9', pending: (n) => n.id === 'db-01', diff: ['-PasswordAuthentication yes', '+PasswordAuthentication no', '+KbdInteractiveAuthentication no'], risk: { category: 'access', reason: 'disables password logins for sshd' } },
      { id: 'sshd', action: 'service.running', src: 'common/ssh/server.star:21', pending: (n) => n.id === 'db-01', message: 'reload: watched entry sshd-config changed' },
    ],
  },
  'common.users': {
    selector: (n) => n !== LOCAL,
    entries: [{ id: 'menno', action: 'accounts.user', meta: 'groups: sudo, docker', src: 'common/users.star:6', pending: () => false }],
  },
  'roles.web': {
    selector: (n) => n.labels.role === 'web',
    entries: [
      { id: 'nginx', action: 'packages.installed', src: 'roles/web.star:5', pending: () => false },
      { id: 'nginx-site', action: 'file.managed', meta: '/etc/nginx/sites-enabled/mvl.conf', src: 'roles/web.star:12', pending: (n) => n.id === 'web-01', diff: ['   server_name mennovanleeuwen.nl;', '-  listen 80;', '+  listen 443 ssl;', '+  http2 on;'] },
      { id: 'nginx-service', action: 'service.running', meta: 'nginx', src: 'roles/web.star:24', pending: (n) => n.id === 'web-01', message: 'reload: watched entry nginx-site changed' },
      { id: 'savuvo', action: 'compose.project', meta: '/srv/savuvo/compose.yaml', src: 'roles/web.star:31', pending: () => false },
    ],
  },
  'roles.db': {
    selector: (n) => n.labels.role === 'db',
    entries: [
      { id: 'postgresql', action: 'packages.installed', meta: 'postgresql-17', src: 'roles/db.star:4', pending: () => false },
      { id: 'swappiness', action: 'sysctl.value', meta: 'vm.swappiness = 10', src: 'roles/db.star:10', pending: () => true, diff: ['-vm.swappiness = 60', '+vm.swappiness = 10'] },
      { id: 'postgresql-service', action: 'service.running', src: 'roles/db.star:16', pending: () => false },
    ],
  },
  'roles.minecraft': {
    selector: (n) => n.labels.role === 'game',
    entries: [
      { id: 'world-volume', action: 'mount.mounted', meta: '/srv/minecraft', src: 'roles/minecraft.star:5', pending: () => false },
      { id: 'minecraft', action: 'compose.project', meta: 'itzg/minecraft-server · java 1.20.1', src: 'roles/minecraft.star:12', pending: () => true, diff: ['   MEMORY: 6G', '-  MAX_PLAYERS: "10"', '+  MAX_PLAYERS: "20"'], risk: { category: 'availability', reason: 'recreates the minecraft container' } },
    ],
  },
  'cv.desktop': {
    selector: (n) => n === LOCAL,
    entries: [
      { id: 'react', action: 'packages.installed', meta: 'react 19, vite 8', src: 'cv/desktop.star:3', pending: () => false },
      { id: 'sticky-note', action: 'file.managed', meta: '~/headlines.txt', src: 'cv/desktop.star:8', pending: () => false },
      { id: 'coffee', action: 'service.running', meta: 'menno', src: 'cv/desktop.star:14', pending: () => true, message: 'start: coffee level below threshold' },
      { id: 'side-projects', action: 'commands.run', meta: 'git init yet-another-idea', src: 'cv/desktop.star:20', pending: () => true, risk: { category: 'other', reason: 'may consume the entire weekend' } },
    ],
  },
}
const HIGHSTATE = ['common.packages', 'common.ssh.server', 'common.users', 'roles.web', 'roles.db', 'roles.minecraft', 'cv.desktop']

// Session state: what has been applied, and the job history it produced.
const applied = new Set<string>() // `${node}/${entry}`
type Run = { id: string; mode: 'apply' | 'test'; status: string; changes: number; nodes: number; created: number; durationMs: number; target: string }
const history: Run[] = [
  { id: 'run-4c1e9a', mode: 'apply', status: 'succeeded', changes: 3, nodes: 7, created: Date.now() - 3 * 3600_000, durationMs: 4210, target: "'*'" },
  { id: 'run-b07d22', mode: 'test', status: 'succeeded', changes: 3, nodes: 7, created: Date.now() - 3.1 * 3600_000, durationMs: 1830, target: "'*'" },
  { id: 'run-91aa0f', mode: 'apply', status: 'succeeded', changes: 1, nodes: 1, created: Date.now() - 26 * 3600_000, durationMs: 2120, target: "'mc-01'" },
]

// ---------------------------------------------------------------------------------------------
// Helpers

function pepperError(error: string, cause: string, next: string): CmdError {
  return new CmdError(`${c('red', 'Error:')} ${error}\n${c('muted', 'Cause:')} ${cause}\n${c('muted', 'Next:')} ${next}`, true)
}

const readOnly = (what: string) =>
  pepperError(`${what} is not available on the demo cluster.`, 'This lab only exists inside a CV in your browser; it has nothing to change.', `Read the real thing at ${link('https://pepper.mvl.sh/start/create-cluster/', 'pepper.mvl.sh')}.`)

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true })
  })

const runId = () => `run-${Math.random().toString(16).slice(2, 8)}`
const fmtDur = (ms: number) => (ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`)
const ago = (ts: number) => {
  const m = Math.round((Date.now() - ts) / 60000)
  return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`
}

function table(headers: string[], rows: string[][]): string {
  const strip = (s: string) => s.replace(/\{(?:c|link):[^}]*\}|\{\/\}/g, '')
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => strip(r[i] ?? '').length)))
  const line = (cells: string[]) => cells.map((cell, i) => cell + ' '.repeat(Math.max(0, widths[i] - strip(cell).length))).join('  ').trimEnd()
  return [c('muted', line(headers)), ...rows.map(line)].join('\n')
}

/** Target selectors: '*', globs, id:NAME, label:KEY=VALUE, comma-separated lists. */
function select(target: string): MockNode[] {
  const parts = target.split(',').map((p) => p.trim()).filter(Boolean)
  const matches = (n: MockNode, sel: string) => {
    if (sel.startsWith('id:')) return n.id === sel.slice(3)
    if (sel.startsWith('label:')) {
      const [k, v] = sel.slice(6).split('=')
      return v === undefined ? k in n.labels : n.labels[k] === v
    }
    const re = new RegExp('^' + sel.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$')
    return re.test(n.id)
  }
  return NODES.filter((n) => parts.some((p) => matches(n, p)))
}

function resolveTarget(target: string | null, local: boolean): MockNode[] {
  if (local) return [LOCAL]
  if (!target) throw pepperError('This command needs a target.', 'No target selector or --local was given.', `Pass a target such as ${c('green', "'*'")} or ${c('green', "'label:role=web'")}, or use ${c('green', '--local')}.`)
  const nodes = select(target)
  if (!nodes.length) throw pepperError(`Target ${target} matched no nodes.`, `The inventory has ${NODES.length} nodes: ${NODES.map((n) => n.id).join(', ')}.`, `Run ${c('green', 'pepper nodes list')} to see IDs and labels.`)
  return nodes
}

function statesFor(node: MockNode, requested: string[]): string[] {
  const roots = requested.length && !(requested.length === 1 && requested[0] === 'top') ? requested : HIGHSTATE
  for (const r of roots) if (!STATES[r]) throw pepperError(`State ${r} does not exist.`, `No ${r.replace(/\./g, '/')}.star below the state roots.`, `Run ${c('green', 'pepper state list')} to see available states.`)
  return roots.filter((r) => STATES[r].selector(node))
}

// ---------------------------------------------------------------------------------------------
// Commands

const COMMAND_GROUPS = ['state', 'blends', 'nodes', 'node', 'cluster', 'job', 'extension', 'repo', 'version', 'help', 'update', 'upgrade', 'completion', 'pki', 'daemon', 'ssh-serve', 'skills']

function help(): string {
  return [
    'Pepper evaluates Starlark states into deterministic per-node graphs and applies',
    'them to Linux machines through one active master.',
    '',
    c('bold', 'Usage'),
    "  pepper [GLOBAL FLAGS] TARGET state apply [--test] [STATE...]",
    '  pepper [GLOBAL FLAGS] TARGET blends.get|keys|items|top [PATH]',
    '  pepper [GLOBAL FLAGS] COMMAND',
    '',
    c('bold', 'Commands'),
    `  ${c('green', 'state')}       apply, validate, render, list and search states`,
    `  ${c('green', 'blends')}      inspect per-node Blend data`,
    `  ${c('green', 'nodes')}       list, ping and inspect node labels`,
    `  ${c('green', 'cluster')}     status, invitations and membership`,
    `  ${c('green', 'job')}         durable job history`,
    `  ${c('green', 'extension')}   list and describe extensions`,
    `  ${c('green', 'repo')}        validate the state repository`,
    `  ${c('green', 'version')}     print the version`,
    '',
    c('bold', 'Global flags'),
    '  --local  --output=human|ndjson  --master  --repo  --verbose/-v',
    '',
    c('muted', `This is a simulated lab: ${NODES.filter((n) => n.role === 'master').length} masters, ${NODES.filter((n) => n.role === 'minion').length} minions, nothing real.`),
    `Try ${c('green', 'pepper nodes list')}, ${c('green', "pepper '*' state apply --test")} or ${c('green', "pepper 'label:role=web' blends.items")}`,
    `Docs: ${link('https://pepper.mvl.sh')}  Source: ${link('https://git.mvl.sh/pepper')}`,
  ].join('\n')
}

async function version(): Promise<string> {
  const s = await loadRecents().catch(() => null)
  const latest = (repo: string, fallback: string) => s?.items.find((i) => i.repo === `pepper/${repo}` && i.kind === 'release')?.title.replace(/^Released /, '') ?? fallback
  return [`pepper ${latest('cli', 'v0.22.0')} (linux/amd64)`, c('muted', `core ${latest('core', 'v2.4.1')} · docs ${latest('docs', 'v0.1.20')} · simulated in your browser`)].join('\n')
}

function nodesList(): string {
  return table(
    ['NODE', 'ROLE', 'STATUS', 'PLATFORM', 'OS', 'LABELS', 'LAST SEEN'],
    NODES.map((n) => [n.id, n.role + (n.leader ? c('accent', ' ★') : ''), c('green', 'ready'), n.platform, n.os, Object.entries(n.labels).map(([k, v]) => `${k}=${v}`).join(','), `${2 + (n.id.length % 5)}s ago`]),
  )
}

async function nodesPing(ctx: Ctx, target: string): Promise<string> {
  const nodes = select(target)
  if (!nodes.length) throw pepperError(`Target ${target} matched no nodes.`, 'The selector is valid but nothing in the inventory matches it.', `Run ${c('green', 'pepper nodes list')} to see node IDs and labels.`)
  if (ctx.tty) ctx.print(c('muted', `ping job submitted through master-1 · ${nodes.length} node${nodes.length === 1 ? '' : 's'}`))
  await sleep(350 + Math.random() * 300, ctx.signal)
  if (ctx.signal.aborted) return c('yellow', 'canceled')
  return table(
    ['NODE', 'STATUS', 'RESPONSE'],
    nodes.map((n) => [n.id, c('green', 'pong'), `${(n.labels.site === 'fra' ? 9 : 2) + Math.random() * 4 | 0}ms`]),
  )
}

function nodesLabels(id: string | undefined): string {
  const n = NODES.find((x) => x.id === id)
  if (!n) throw pepperError(`Node ${id ?? '(none)'} is not in the inventory.`, 'nodes labels takes one node ID.', `Run ${c('green', 'pepper nodes list')} to see node IDs.`)
  return table(['LABEL', 'VALUE'], Object.entries(n.labels))
}

function clusterStatus(): string {
  const masters = NODES.filter((n) => n.role === 'master')
  return [
    `${c('bold', 'Cluster')}  lab.mvl.sh · ${masters.length} voters · quorum healthy`,
    `${c('bold', 'Leader')}   master-1 (epoch 14, leading for 5 days)`,
    '',
    table(
      ['MEMBER', 'ROLE', 'ETCD', 'STATUS', 'ADVERTISE'],
      masters.map((n) => [n.id, n.leader ? c('accent', 'leader') : 'follower', 'voter', c('green', 'available'), n.advertise]),
    ),
    '',
    c('muted', `${NODES.length - masters.length} minions in node inventory (not etcd voters)`),
  ].join('\n')
}

function stateList(query?: string): string {
  const names = Object.keys(STATES).filter((s) => !query || s.includes(query.toLowerCase()))
  if (!names.length) return c('muted', `no states match ${query}`)
  const tree: Record<string, string[]> = {}
  for (const n of names) {
    const [group, ...rest] = n.split('.')
    ;(tree[group] ??= []).push(rest.join('.'))
  }
  return Object.entries(tree)
    .map(([group, kids]) => [c('blue', group + '/'), ...kids.map((k, i) => `${i === kids.length - 1 ? '└── ' : '├── '}${group}.${k} ${c('muted', `${group}/${k.replace(/\./g, '/')}.star`)}`)].join('\n'))
    .join('\n')
}

function stateValidate(nodes: MockNode[], requested: string[]): string {
  return [
    ...nodes.map((n) => {
      const roots = statesFor(n, requested)
      const entries = roots.reduce((a, r) => a + STATES[r].entries.length, 0)
      const digest = [...`${n.id}${roots.join()}`].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7).toString(16).padStart(8, '0')
      return `${c('cyan', n.id.padEnd(9))} ${requested[0] ?? 'top'} · ${entries} entries · ${roots.length} files · graph sha256:${digest}…`
    }),
    c('green', `valid · ${nodes.length} node${nodes.length === 1 ? '' : 's'}`),
  ].join('\n')
}

function stateRender(nodes: MockNode[], requested: string[]): string {
  if (nodes.length > 1) throw pepperError('Human render output needs exactly one node.', `The target matched ${nodes.length} nodes.`, `Narrow the target (for example ${c('green', "'id:web-01'")}) or pass ${c('green', '--output ndjson')}.`)
  const n = nodes[0]
  const lines = ['version: 4', `node: ${n.id}`, 'entries:']
  for (const r of statesFor(n, requested))
    for (const e of STATES[r].entries) {
      lines.push(`  ${r}#${e.id}:`, `    action: ${e.action}`)
      if (e.meta) lines.push(`    target: ${JSON.stringify(e.meta)}`)
      lines.push(`    source: ${e.src}`)
    }
  return lines.join('\n')
}

const BLENDS: Record<string, unknown> = {
  application: { name: 'mvl', port: 8080, domains: ['mennovanleeuwen.nl', 'mvl.sh'] },
  infra: { versions: { nginx: '1.26', postgresql: '17', minecraft: '1.20.1' }, timezone: 'Europe/Amsterdam' },
  ssh: { password_auth: false, port: 22 },
}

function blendsFor(n: MockNode): Record<string, unknown> {
  return { node: { id: n.id, role: n.role, labels: n.labels, platform: n.platform }, ...BLENDS, ...(n.labels.role === 'game' ? { minecraft: { max_players: 20, motd: 'StarDebris game server bros' } } : {}) }
}

function yaml(v: unknown, indent = 0): string {
  const pad = ' '.repeat(indent)
  if (Array.isArray(v)) return v.map((x) => `${pad}- ${typeof x === 'object' ? '\n' + yaml(x, indent + 2) : x}`).join('\n')
  if (v && typeof v === 'object')
    return Object.entries(v)
      .map(([k, x]) => (x && typeof x === 'object' ? `${pad}${c('cyan', k)}:\n${yaml(x, indent + 2)}` : `${pad}${c('cyan', k)}: ${x}`))
      .join('\n')
  return pad + String(v)
}

function blends(nodes: MockNode[], verb: string, arg?: string): string {
  const get = (obj: unknown, path?: string) => (path ? path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj) : obj)
  const per = (n: MockNode) => {
    const data = blendsFor(n)
    if (verb === 'get') {
      if (!arg) throw pepperError('blends.get needs a PATH.', 'No dotted path was given.', `Try ${c('green', 'blends.get application.port')}.`)
      const v = get(data, arg)
      if (v === undefined) throw pepperError(`Blend path ${arg} is missing on ${n.id}.`, 'get returns one exact path and fails when it does not exist.', `Use ${c('green', 'blends.keys')} to see what exists.`)
      return typeof v === 'object' ? yaml(v) : String(v)
    }
    if (verb === 'keys') {
      const v = get(data, arg)
      return v && typeof v === 'object' ? Object.keys(v).sort().join('\n') : c('muted', '(no keys)')
    }
    if (verb === 'top')
      return ['common.blend  ' + c('muted', 'rule *'), ...(n.labels.role ? [`roles/${n.labels.role}.blend  ${c('muted', `rule label:role=${n.labels.role}`)}`] : [])].join('\n')
    return yaml(data)
  }
  if (nodes.length === 1) return per(nodes[0])
  return nodes.map((n) => `${c('bold', n.id)}\n${per(n).replace(/^/gm, '  ')}`).join('\n\n')
}

function jobList(includeTests: boolean): string {
  const rows = history.filter((r) => includeTests || r.mode !== 'test').sort((a, b) => b.created - a.created)
  if (!rows.length) return c('muted', 'no runs in the last 24h')
  return table(
    ['RUN', 'MODE', 'STATUS', 'CHANGES/NODES', 'PHASE', 'CREATED', 'DURATION'],
    rows.map((r) => [r.id, r.mode, c(r.status === 'succeeded' ? 'green' : 'red', r.status), `${r.changes}/${r.nodes}`, 'done', ago(r.created), fmtDur(r.durationMs)]),
  )
}

function jobShow(id?: string): string {
  const r = history.find((x) => x.id === id)
  if (!r) throw pepperError(`Run ${id ?? '(none)'} was not found.`, 'Job history keeps runs from the last 24 hours on this cluster.', `Run ${c('green', 'pepper job list --include-tests')} to see run IDs.`)
  return [
    `${c('bold', 'Run')}       ${r.id}`,
    `${c('bold', 'Mode')}      ${r.mode}`,
    `${c('bold', 'Target')}    ${r.target}`,
    `${c('bold', 'Status')}    ${c('green', r.status)}`,
    `${c('bold', 'Owner')}     master-1 (epoch 14)`,
    `${c('bold', 'Changed')}   ${r.changes} entries on ${r.nodes} nodes`,
    `${c('bold', 'Created')}   ${new Date(r.created).toLocaleString('en-GB')} (${ago(r.created)})`,
    `${c('bold', 'Duration')}  ${fmtDur(r.durationMs)}`,
  ].join('\n')
}

function extensionList(): string {
  const ext = [
    ['core', 'v2.4.1', 'file, commands'],
    ['packages', 'v1.6.0', 'installed, removed, status'],
    ['service', 'v1.3.2', 'running, stopped, enabled'],
    ['accounts', 'v1.1.0', 'user, group'],
    ['containers', 'v1.4.0', 'compose.project, network'],
    ['mount', 'v1.0.3', 'mounted, fstab'],
    ['sysctl', 'v1.0.2', 'value'],
  ]
  return table(
    ['EXTENSION', 'VERSION', 'STATUS', 'SCOPE', 'PLATFORM', 'ACTIONS', 'COMMANDS'],
    ext.map(([name, v, actions]) => [name, v, c('green', 'locked'), 'repo', 'linux/amd64,arm64', actions, name === 'packages' ? 'search' : name === 'service' ? 'restart' : '—']),
  )
}

// --- state apply ---------------------------------------------------------------------------

type Outcome = 'WOULD CHANGE' | 'CHANGED' | 'CORRECT'
const OUTCOME_COLOR: Record<Outcome, string> = { 'WOULD CHANGE': 'yellow', CHANGED: 'green', CORRECT: 'muted' }

async function stateApply(ctx: Ctx, nodes: MockNode[], requested: string[], flags: Set<string>, targetText: string): Promise<string> {
  const test = flags.has('--test')
  const summaryOnly = flags.has('--summary')
  const details = flags.has('--details') || flags.has('--only=')
  const out: string[] = []
  const emit = (line: string) => (ctx.tty ? ctx.print(line) : out.push(line))
  const id = runId()
  const started = performance.now()

  const plan = nodes.map((n) => ({
    node: n,
    entries: statesFor(n, requested).flatMap((r) => STATES[r].entries.map((e) => ({ e, pending: e.pending(n) && !applied.has(`${n.id}/${e.id}`) }))),
  }))
  const checks = plan.reduce((a, p) => a + p.entries.length, 0)

  await sleep(260, ctx.signal)
  const prepareMs = performance.now() - started
  emit(c('cyan', `PLAN  ${id} · ${checks} state checks`))

  // A real apply only shows the apply cards; the plan cards would repeat them.
  const phase = async (name: 'plan' | 'apply', quiet = false) => {
    let changed = 0
    for (const { node, entries } of plan) {
      await sleep(120 + Math.random() * 180, ctx.signal)
      if (ctx.signal.aborted) return -1
      const outcomeOf = (pending: boolean): Outcome => (pending ? (name === 'plan' ? 'WOULD CHANGE' : 'CHANGED') : 'CORRECT')
      const counts = { 'WOULD CHANGE': 0, CHANGED: 0, CORRECT: 0 }
      for (const x of entries) counts[outcomeOf(x.pending)]++
      changed += counts['WOULD CHANGE'] + counts.CHANGED
      const risks = entries.filter((x) => x.pending && x.e.risk).map((x) => x.e.risk!)
      const nodeMs = 40 * entries.length + Math.random() * 300
      const header = [
        c('cyan', node.id),
        c('muted', name),
        ...(['WOULD CHANGE', 'CHANGED', 'CORRECT'] as Outcome[]).filter((o) => counts[o]).map((o) => `${counts[o]} ${o.toLowerCase()}`),
        ...risks.map((r) => c('muted', `1 ${r.category} risk`)),
        c('muted', fmtDur(nodeMs)),
      ].join(' · ')
      const shown = summaryOnly ? [] : entries.filter((x) => details || x.pending)
      const lines = [`╭ ${header}`]
      for (const { e, pending } of shown) {
        const outcome = outcomeOf(pending)
        const meta = [e.meta, e.action, `${10 + ((e.id.length * 7) % 60)}ms`].filter(Boolean).join(' · ')
        lines.push('│', `│ ${c(OUTCOME_COLOR[outcome], outcome.padEnd(9))} ${e.id} · ${meta} · ${c('muted', `from ${e.src}`)}`)
        if (outcome === 'CORRECT' && !details) continue
        if (pending && e.risk) lines.push(`│   ${c('red', `RISK ${e.risk.category.toUpperCase()}`)} · ${e.risk.reason}`)
        if (pending && e.message) lines.push(`│   ${e.message}`)
        if (pending && e.diff) for (const d of e.diff) lines.push(`│   ${d.startsWith('+') ? c('green', d) : d.startsWith('-') ? c('red', d) : c('muted', d)}`)
      }
      lines.push('╰')
      if (!quiet) emit(lines.join('\n'))
    }
    return changed
  }

  const planStart = performance.now()
  const wouldChange = await phase('plan', !test)
  const planMs = performance.now() - planStart
  if (wouldChange < 0) {
    emit(c('yellow', `CANCELED  job ${id} · canceled during plan`))
    return out.join('\n')
  }

  let applyMs = 0
  let changedCount = 0
  if (!test && wouldChange === 0) await phase('plan')
  if (!test && wouldChange > 0) {
    emit(c('cyan', `APPLY  ${id} · ${checks} state checks`))
    const t = performance.now()
    changedCount = await phase('apply')
    applyMs = performance.now() - t
    if (changedCount < 0) {
      emit(c('yellow', `CANCELED  job ${id} · canceled during apply`))
      return out.join('\n')
    }
    for (const p of plan) for (const x of p.entries) if (x.pending) applied.add(`${p.node.id}/${x.e.id}`)
  }

  const total = performance.now() - started
  const correct = checks - wouldChange
  const parts = [
    `job ${id}`,
    `${checks}/${checks} reported`,
    ...(test ? (wouldChange ? [`${wouldChange} would change`] : []) : changedCount ? [`${changedCount} changed`] : []),
    `${correct} correct`,
    `prepare ${fmtDur(prepareMs)}`,
    `plan ${fmtDur(planMs)}`,
    ...(applyMs ? [`apply ${fmtDur(applyMs)}`] : []),
    `total ${fmtDur(total)}`,
  ]
  emit(`${c('green', test ? 'PLAN COMPLETE' : 'DONE')}  ${parts.join(' · ')}`)
  if (test && wouldChange) emit(c('muted', `Nothing was changed. Run without --test to apply: pepper ${targetText} state apply`))
  if (!test && wouldChange === 0) emit(c('muted', 'Everything already matched. Idempotent, as promised.'))
  if (!ctx.signal.aborted && nodes[0] !== LOCAL)
    history.push({ id, mode: test ? 'test' : 'apply', status: 'succeeded', changes: test ? wouldChange : changedCount, nodes: nodes.length, created: Date.now(), durationMs: Math.round(total), target: targetText })
  return out.join('\n')
}

// ---------------------------------------------------------------------------------------------
// Entry point

export async function pepper(ctx: Ctx): Promise<string | void> {
  const args = [...ctx.args]
  let local = false
  const flags = new Set<string>()
  // Global flags come first, as in the real CLI.
  while (args[0]?.startsWith('-')) {
    const f = args.shift()!
    if (f === '--local') local = true
    else if (f === '-h' || f === '--help') return help()
    else if (f === '--version') return version()
    else if (f.startsWith('--output')) {
      if (f.includes('ndjson') || args[0] === 'ndjson') throw readOnly('NDJSON output')
      if (!f.includes('=')) args.shift()
    } else if (f === '-v' || f === '--verbose' || f.startsWith('--color') || f.startsWith('--repo') || f.startsWith('--master') || f.startsWith('--config')) {
      if (!f.includes('=') && !['-v', '--verbose'].includes(f)) args.shift()
    } else throw pepperError(`Unknown global flag ${f}.`, 'Global flags must precede the target or command.', `Run ${c('green', 'pepper --help')} for the list.`)
  }
  if (!args.length) return help()

  let target: string | null = null
  if (!COMMAND_GROUPS.includes(args[0]) && !args[0].startsWith('blends.')) target = args.shift()!
  const [group, sub, ...rest] = args
  for (const r of rest) if (r.startsWith('--')) flags.add(r)
  const positional = rest.filter((r) => !r.startsWith('--'))
  if (rest.includes('-h') || rest.includes('--help') || sub === '-h' || sub === '--help') return help()

  if (target && (!group || ['nodes', 'node', 'cluster', 'job', 'repo', 'extension', 'version', 'help'].includes(group)))
    throw pepperError(`${group ?? 'Nothing'} does not take a target.`, `${target} looks like a target selector, but this command runs against the cluster as a whole.`, `Drop the target: ${c('green', `pepper ${[group, sub].filter(Boolean).join(' ')}`)}.`)

  switch (group) {
    case 'help':
      return help()
    case 'version':
      return version()
    case 'nodes':
    case 'node':
      if (!sub || sub === 'list') return nodesList()
      if (sub === 'ping') return nodesPing(ctx, positional[0] ?? '*')
      if (sub === 'labels') return nodesLabels(positional[0])
      if (sub === 'token') throw readOnly('Issuing join tokens')
      break
    case 'cluster':
      if (!sub || sub === 'status') return clusterStatus()
      if (sub === 'invite' && positional[0] === 'list')
        return table(['INVITATION', 'NODE', 'ROLE', 'STATE', 'ISSUED', 'CLAIMED', 'EXPIRES'], [['inv-3f2a', 'web-03', 'minion', 'pending', ago(Date.now() - 4 * 60000), '—', 'in 11m']])
      if (['create', 'invite', 'join', 'promote', 'transfer', 'handoff'].includes(sub)) throw readOnly(`cluster ${sub}`)
      break
    case 'job':
      if (!sub || sub === 'list') return jobList(flags.has('--include-tests'))
      if (sub === 'show') return jobShow(positional[0])
      if (sub === 'watch') return jobShow(positional[0]) + '\n' + c('muted', 'run is already complete; nothing to watch')
      if (sub === 'cancel') throw readOnly('Cancelling jobs')
      break
    case 'extension':
      if (!sub || sub === 'list') return extensionList()
      if (['install', 'update', 'remove', 'sync', 'push', 'dev'].includes(sub)) throw readOnly(`extension ${sub}`)
      if (sub === 'search' || sub === 'describe') return extensionList()
      break
    case 'repo':
      if (sub === 'validate' || !sub) return `${c('green', 'repository valid')} · ${Object.keys(STATES).length} states · 3 blend files · 7 extensions locked in pepper.lock`
      throw readOnly(`repo ${sub}`)
    case 'update':
    case 'upgrade':
      return c('green', 'pepper is up to date.') + c('muted', ' (it is also imaginary)')
    case 'completion':
      return c('muted', `# ${sub ?? 'bash'} completion for a CLI that lives in a CV. You are already in the only shell that needs it.`)
    case 'state': {
      if (sub === 'list') return stateList()
      if (sub === 'search') {
        if (!positional[0]) throw pepperError('state search needs a QUERY.', 'One query is required.', `Try ${c('green', 'pepper state search ssh')}.`)
        return stateList(positional[0])
      }
      if (sub === 'lsp') return c('muted', 'Content-Length: 0\r\n\r\n(the language server would speak to your editor here)')
      const nodes = resolveTarget(target, local)
      if (sub === 'apply') return stateApply(ctx, nodes, positional, flags, target ? `'${target}'` : '--local')
      if (sub === 'validate') return stateValidate(nodes, positional)
      if (sub === 'render') return stateRender(nodes, positional)
      break
    }
    default:
      if (group?.startsWith('blends.') || group === 'blends') {
        const verb = group === 'blends' ? sub : group.slice(7)
        const arg = group === 'blends' ? positional[0] : sub
        if (verb === 'set' || verb === 'unset') throw readOnly(`blends.${verb}`)
        if (!['get', 'keys', 'items', 'top'].includes(verb ?? '')) throw pepperError(`blends.${verb ?? ''} is not a Blend command.`, 'Blend inspection supports get, keys, items and top.', `Try ${c('green', "pepper 'web-*' blends.items")}.`)
        return blends(resolveTarget(target, local), verb!, arg)
      }
  }
  throw pepperError(`Unknown command: ${[group, sub].filter(Boolean).join(' ')}.`, 'This simulated CLI covers the inspection and state commands.', `Run ${c('green', 'pepper --help')} to see what works here.`)
}
