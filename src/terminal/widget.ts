import { prepare, lookup, actorOf } from './fs'
import { readFile } from './read'
import { CmdError, type Ctx } from './types'
import { prettyPath, resolvePath } from './vfs'
import { defaultFiles, widgetSDK } from '../widgets/platform/defaults'
import { MOCK_INPUT } from '../widgets/platform/mocks'
import { buildPackage, descriptor, mutation, supportsCapabilities, CUSTOM_KIND, KIND_CAPABILITIES, LIMITS, type Capability, type Descriptor, type Files, type InstanceKind, type Snapshot, type SourceIdentity, type WidgetInput } from '../widgets/platform/package'

// widget: how an agent makes a widget, through the terminal tool it already has. Writing the files is
// write_file/edit_file's job (with their own hash rules); this command only reads a source folder, builds
// it exactly as the Widget Workshop does, runs it in the same bounded VM and, when the user allows it,
// activates it. `activate` is the only subcommand that changes anything, it never runs without the
// user's yes in a desktop dialog, and it writes the same installation record the Workshop does.
//
// The folder is read through the call's policy (the same reads as cat), so a folder outside the work folder
// is refused where it is read. Everything that is the browser's (the VM, the installation records, the
// dialog, the preview window) sits behind WidgetHost: agentHost.ts is the real one, the check script
// puts a stand-in in its place.

const USAGE = 'widget docs|list|validate <dir>|test <dir>|preview <dir>|activate <dir> (--new|--instance <id>) [--generation <n>]'

export const CAPABILITY_TEXT: Record<Capability, string> = {
  'custom.state': "a small saved state of its own (up to 4 KiB, replaced only by its explicit button actions) and the clock",
  'note.read': 'read one bound note',
  'note.write': 'edit that note through explicit interactions',
  'weather.read': 'read the host-selected forecast',
  'agenda.read': 'read agenda data',
  'agenda.act': 'act on agenda items through explicit interactions',
  'inbox.read': 'read inbox data',
  'inbox.navigate': 'open inbox items',
  'status.read': 'read status checks',
  'status.navigate': 'open status checks',
  'minecraft.read': 'read the Minecraft server state',
  'minecraft.act': 'act on the Minecraft server through explicit interactions',
}

export type ApprovalRequest = {
  name: string
  id: string
  digest: string
  instance: string
  kind: InstanceKind
  isNew: boolean
  generation: number
  dir: string
  capabilities: { id: Capability; text: string }[]
}

export type InstalledWidget = { instance: string; kind: string; name: string; digest: string; generation: number }
export type Current = { exists: boolean; kind?: InstanceKind; generation: number; identity: string; digest?: string; source?: SourceIdentity }

/** What the browser provides; absent parts mean there is nothing to ask or show (a node check, a text console). */
export type WidgetHost = {
  /** The bounded VM, with the call's signal: aborting it stops the run */
  run: (snapshot: Snapshot, input: WidgetInput, event: string | undefined, signal: AbortSignal) => Promise<unknown>
  installed: () => InstalledWidget[]
  current: (instance: string) => Current
  identity: (path: string) => Promise<SourceIdentity>
  readSource: (identity: SourceIdentity) => Promise<Files>
  signedIn: () => boolean
  activate: (instance: string, kind: InstanceKind, revision: { source: SourceIdentity; snapshot: Snapshot }, expectedGeneration: number, expectedIdentity: string) => Promise<void>
  allow: (instance: string, revision: { source: SourceIdentity; snapshot: Snapshot }) => void
  /** The user's answer in an OS dialog; resolves false for Deny, Escape and a cancelled call. */
  approve?: (request: ApprovalRequest, signal: AbortSignal) => Promise<boolean>
  preview?: (path: string) => void
  placed?: (kind: InstanceKind, instance: string, fresh: boolean) => void
}

let override: WidgetHost | null = null
/** For the check script: the stand-in host. Pass null to use the browser's again. */
export const setWidgetHost = (host: WidgetHost | null) => void (override = host)
async function hostOf(): Promise<WidgetHost> {
  return override ?? (await import('../widgets/platform/agentHost')).browserHost
}

const fail = (message: string, status = 1) => new CmdError(`widget: ${message}`, false, status)
/** A failure whose output is already printed: only the exit status is left. */
const silent = () => new CmdError('', true, 1)
const err = (ctx: Ctx, text: string) => (ctx.stderr ?? ctx.print)(text)
const utf8 = (text: string) => new TextEncoder().encode(text).length
const join = (dir: string, name: string) => (dir === '/' ? `/${name}` : `${dir}/${name}`)
const KiB = (n: number) => `${Math.round(n / 102.4) / 10} KiB`

// --- reading a folder through the call's policy --------------------------------------------------------

async function readFolder(ctx: Ctx, dir: string): Promise<{ abs: string; files: Files }> {
  const abs = resolvePath(ctx.cwd, dir)
  const actor = actorOf(ctx)
  const files: Files = Object.create(null)
  let entries = 0
  let bytes = 0
  const walk = async (path: string, prefix: string, depth: number) => {
    ctx.signal.throwIfAborted()
    if (depth > 8) throw fail(`${prefix}: folders nest deeper than 8 levels`)
    const refused = ctx.policy?.read(path)
    if (refused) throw fail(refused)
    await prepare(path, 'ls', [], actor)
    const node = lookup(path)
    if (!node) throw fail(`${dir}: No such file or directory`)
    if (node.type !== 'dir') throw fail(`${dir}: Not a directory (give the package folder)`)
    for (const [name, child] of [...node.children].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const rel = `${prefix}${name}`
      if (rel === 'dist' || rel.startsWith('dist/') || rel === 'build.json') continue
      if (++entries > LIMITS.files) throw fail(`${rel}: more than ${LIMITS.files} files and folders in the package (limit ${LIMITS.files})`)
      if (!/^[a-zA-Z0-9_./-]{1,160}$/.test(rel)) throw fail(`${rel}: not a valid package path (a-z A-Z 0-9 _ . / - only, at most 160 characters)`)
      const full = join(path, name)
      if (child.type === 'dir') {
        await walk(full, `${rel}/`, depth + 1)
        continue
      }
      if (child.size !== undefined && child.size > LIMITS.fileBytes) throw fail(`${rel}: ${child.size} bytes is over the ${LIMITS.fileBytes} byte (${KiB(LIMITS.fileBytes)}) limit for one file`)
      await prepare(path, 'cat', [name], actor)
      const text = readFile(ctx, full, 'widget')
      const size = utf8(text)
      if (size > LIMITS.fileBytes) throw fail(`${rel}: ${size} bytes is over the ${LIMITS.fileBytes} byte (${KiB(LIMITS.fileBytes)}) limit for one file`)
      if ((bytes += size) > LIMITS.sourceBytes) throw fail(`${rel}: the package source goes over ${LIMITS.sourceBytes} bytes (${KiB(LIMITS.sourceBytes)}) in total at this file`)
      files[rel] = text
    }
  }
  await walk(abs, '', 0)
  return { abs, files }
}

const explain = (e: unknown) => (e instanceof SyntaxError ? `a JSON file is not valid JSON (${e.message}); manifest.json, styles/tokens.json and tests/*.json are strict JSON` : e instanceof Error ? e.message : String(e))

async function buildFolder(ctx: Ctx, dir: string) {
  if (!dir) throw fail(`missing folder: ${USAGE}`)
  const { abs, files } = await readFolder(ctx, dir)
  ctx.signal.throwIfAborted()
  try {
    return { abs, files, snapshot: await buildPackage(files) }
  } catch (e) {
    throw fail(`${prettyPath(abs)}: package rejected: ${explain(e)}`)
  }
}

// --- the outline of a rendered widget ----------------------------------------------------------------------

const clip = (text: string, n = 60) => (text.length > n ? `${text.slice(0, n - 1)}…` : text)
function outline(view: Descriptor, depth = 0, out: string[] = []): string[] {
  const bits = [view.type, view.text !== undefined ? JSON.stringify(clip(view.text)) : '', view.event ? `-> ${view.event}` : '', view.tone && view.tone !== 'normal' ? `[${view.tone}]` : ''].filter(Boolean)
  out.push(`${'  '.repeat(depth)}${bits.join(' ')}`)
  for (const child of view.children ?? []) outline(child, depth + 1, out)
  return out
}
const textsOf = (view: Descriptor): string[] => [...(view.text !== undefined ? [view.text] : []), ...(view.children ?? []).flatMap(textsOf)]
const eventsOf = (view: Descriptor): string[] => [...(view.type === 'button' && view.event ? [view.event] : []), ...(view.children ?? []).flatMap(eventsOf)]
const stable = (v: unknown): string => (Array.isArray(v) ? `[${v.map(stable).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}` : JSON.stringify(v) ?? 'null')
const reason = (e: unknown) => (e instanceof Error ? `${(e as { code?: string }).code ? `[${(e as { code?: string }).code}] ` : ''}${e.message}` : String(e))

// --- subcommands ----------------------------------------------------------------------------------------------

const summary = (snapshot: Snapshot, files: Files, abs: string) => {
  const m = snapshot.manifest
  const total = Object.values(files).reduce((n, t) => n + utf8(t), 0)
  return [
    `OK ${prettyPath(abs)}: "${m.name}" (${m.id})`,
    `digest ${snapshot.digest}`,
    `files ${Object.keys(files).length} of ${LIMITS.files}, ${total} of ${LIMITS.sourceBytes} bytes`,
    `entry ${m.entry} · ${m.settings.appearance} · ${m.sizing.width}x${m.sizing.height} · ${m.phone ? 'phone: yes' : 'phone: no (hidden on a phone)'}`,
    `capabilities ${m.capabilities.length ? m.capabilities.join(', ') : 'none'}`,
    `fits ${(Object.keys(KIND_CAPABILITIES) as InstanceKind[]).filter((k) => supportsCapabilities(k, m.capabilities)).join(', ')}`,
  ]
}

async function validate(ctx: Ctx, dir: string) {
  const { abs, files, snapshot } = await buildFolder(ctx, dir)
  for (const line of summary(snapshot, files, abs)) ctx.print(line)
}

/** Runs the package: the mock input, each button of that view, and every tests/*.json case. Prints a line each; true when all passed. */
async function runTests(ctx: Ctx, host: WidgetHost, dir: string): Promise<{ ok: boolean; abs: string }> {
  const { abs, files, snapshot } = await buildFolder(ctx, dir)
  const run = (input: WidgetInput, event?: string) => {
    ctx.signal.throwIfAborted()
    return host.run(snapshot, input, event, ctx.signal)
  }
  let passed = 0
  let failed = 0
  const report = (ok: boolean, name: string, detail = '') => {
    if (ok) passed++
    else failed++
    ctx.print(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
  }
  ctx.print(`building ${prettyPath(abs)}: "${snapshot.manifest.name}" digest ${snapshot.digest.slice(0, 16)}`)
  let view: Descriptor | null = null
  try {
    view = descriptor(await run(MOCK_INPUT))
    report(true, 'mock render', `${outline(view).length} nodes`)
  } catch (e) {
    ctx.signal.throwIfAborted()
    report(false, 'mock render', reason(e))
  }
  if (view) {
    const lines = outline(view)
    ctx.print('outline:')
    for (const line of lines.slice(0, 60)) ctx.print(`  ${line}`)
    if (lines.length > 60) ctx.print(`  … ${lines.length - 60} more`)
    for (const event of [...new Set(eventsOf(view))].slice(0, 8)) {
      try {
        const effect = mutation(await run(MOCK_INPUT, event))
        report(true, `event ${event}`, effect ? `${effect.type}${'state' in effect ? ` ${clip(JSON.stringify(effect.state), 80)}` : ''}` : 'no effect')
      } catch (e) {
        ctx.signal.throwIfAborted()
        report(false, `event ${event}`, reason(e))
      }
    }
  }
  for (const [path, text] of Object.entries(files).filter(([p]) => /^tests\/.*\.json$/.test(p))) {
    let spec: { description?: unknown; input?: unknown; event?: unknown; expect?: { text?: unknown; absent?: unknown; mutation?: unknown } }
    try {
      spec = JSON.parse(text)
      if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('a test case is a JSON object')
    } catch (e) {
      report(false, path, reason(e))
      continue
    }
    const name = `${path}${typeof spec.description === 'string' && spec.description ? ` (${clip(spec.description, 50)})` : ''}`
    const extra = spec.input && typeof spec.input === 'object' && !Array.isArray(spec.input) ? (spec.input as Record<string, unknown>) : {}
    const input = { ...MOCK_INPUT, ...extra, custom: { ...MOCK_INPUT.custom, ...(extra.custom && typeof extra.custom === 'object' ? (extra.custom as object) : {}) } } as WidgetInput
    const problems: string[] = []
    try {
      const flat = textsOf(descriptor(await run(input))).join('\n')
      const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
      for (const needle of list(spec.expect?.text)) if (!flat.includes(needle)) problems.push(`output lacks "${needle}"`)
      for (const needle of list(spec.expect?.absent)) if (flat.includes(needle)) problems.push(`output still has "${needle}"`)
      if (typeof spec.event === 'string') {
        const effect = mutation(await run(input, spec.event))
        if (spec.expect && 'mutation' in spec.expect && stable(effect) !== stable(spec.expect.mutation)) problems.push(`event ${spec.event} gave ${clip(stable(effect), 120)}, expected ${clip(stable(spec.expect.mutation), 120)}`)
      }
    } catch (e) {
      ctx.signal.throwIfAborted()
      problems.push(reason(e))
    }
    report(!problems.length, name, problems.join('; '))
  }
  ctx.print(`${passed} passed, ${failed} failed`)
  return { ok: failed === 0, abs }
}

async function test(ctx: Ctx, host: WidgetHost, dir: string) {
  if (!(await runTests(ctx, host, dir)).ok) throw silent()
}

async function preview(ctx: Ctx, host: WidgetHost, dir: string) {
  const { ok, abs } = await runTests(ctx, host, dir)
  // The window is a convenience for the user; it never writes anything, and a failed run still shows what is wrong.
  if (host.preview && !ctx.console) {
    ctx.signal.throwIfAborted()
    host.preview(abs)
    ctx.print('preview: opened in the Widget Workshop (mock data, nothing activated)')
  } else ctx.print('preview: no desktop here; the outline above is what the widget draws with mock data')
  if (!ok) throw silent()
}

/** The same id for the same folder and build, so a retry of a lost answer finds its own widget instead of making a second. */
async function newInstance(digest: string, abs: string) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${digest}\n${abs}`))
  return `custom-${[...new Uint8Array(hash)].slice(0, 4).map((b) => b.toString(16).padStart(2, '0')).join('')}`
}

function flags(args: string[]) {
  let dir = ''
  let instance = ''
  let fresh = false
  let generation: number | null = null
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--new') fresh = true
    else if (a === '--instance') instance = args[++i] ?? ''
    else if (a.startsWith('--instance=')) instance = a.slice(11)
    else if (a === '--generation' || a.startsWith('--generation=')) {
      const raw = a === '--generation' ? args[++i] : a.slice(13)
      generation = /^\d+$/.test(raw ?? '') ? Number(raw) : NaN
    } else if (a.startsWith('-')) throw fail(`unknown option ${a}: ${USAGE}`)
    else if (!dir) dir = a
    else throw fail(`one folder at a time: ${USAGE}`)
  }
  if (generation !== null && !Number.isSafeInteger(generation)) throw fail('--generation takes the whole number `widget list` shows')
  return { dir, instance, fresh, generation }
}

async function activateCommand(ctx: Ctx, host: WidgetHost, args: string[]) {
  const { dir, instance: wanted, fresh, generation } = flags(args)
  if (fresh === !!wanted) throw fail('say which widget: --new (a new custom widget) or --instance <id> (an installed one, see `widget list`)')
  if (ctx.policy?.grant.mode === 'plan') throw fail('activation is not available in plan mode')
  if (!host.signedIn()) throw fail('sign in first: widgets belong to an account')
  const { abs, snapshot } = await buildFolder(ctx, dir)
  const manifest = snapshot.manifest
  let identity: SourceIdentity
  try {
    identity = await host.identity(abs)
  } catch (e) {
    throw fail(`${prettyPath(abs)}: ${explain(e)} (a widget's source folder must be in your browser files or Seafile)`)
  }
  ctx.signal.throwIfAborted()
  const instance = fresh ? await newInstance(snapshot.digest, abs) : wanted
  const before = host.current(instance)
  if (!fresh && !before.exists) throw fail(`${instance} is not an installed widget; run \`widget list\`, or use --new`)
  const kind: InstanceKind = fresh ? CUSTOM_KIND : before.kind!
  if (!supportsCapabilities(kind, manifest.capabilities)) throw fail(`this package asks for ${manifest.capabilities.join(', ')}, which a ${kind} widget cannot have (${KIND_CAPABILITIES[kind].join(', ') || 'none'} allowed)`)
  // The same revision from the same folder is already there: a retry of an answer that got lost changes nothing.
  if (before.exists && before.digest === snapshot.digest && JSON.stringify(before.source) === JSON.stringify(identity)) {
    ctx.print(`already active: ${instance} runs digest ${snapshot.digest.slice(0, 16)} at generation ${before.generation} (no change)`)
    return
  }
  if (generation !== null && generation !== before.generation) throw fail(`conflict: ${instance} is at generation ${before.generation}, not ${generation}; run \`widget list\` and decide again (nothing was written)`)

  if (!host.approve || ctx.console) throw fail('activation requires approval, and there is no desktop here to ask the user (nothing was written)')
  const approved = await host.approve({ name: manifest.name, id: manifest.id, digest: snapshot.digest, instance, kind, isNew: fresh, generation: before.generation, dir: prettyPath(abs), capabilities: manifest.capabilities.map((id) => ({ id, text: CAPABILITY_TEXT[id] })) }, ctx.signal)
  // The thread may have been closed while the question was open: nothing happens for a call nobody waits on.
  ctx.signal.throwIfAborted()
  if (!approved) throw fail('activation requires approval: the user denied it (nothing was written)', 1)

  // What was approved is what gets installed: the folder and the installation are looked at again.
  const now = host.current(instance)
  if (now.generation !== before.generation || now.identity !== before.identity) throw fail('conflict: the installation changed while the user was deciding; run `widget list` and try again (nothing was written)')
  let rebuilt: Snapshot
  try {
    rebuilt = await buildPackage(await host.readSource(identity))
  } catch (e) {
    throw fail(`${prettyPath(abs)}: the source cannot be read again: ${explain(e)} (nothing was written)`)
  }
  if (rebuilt.digest !== snapshot.digest) throw fail('the source changed after it was approved; run `widget test` and activate again (nothing was written)')
  ctx.signal.throwIfAborted()
  const revision = { source: identity, snapshot: rebuilt }
  try {
    await host.activate(instance, kind, revision, before.generation, before.identity)
  } catch (e) {
    const message = explain(e)
    throw fail(/removed/.test(message) ? `${message} (change the source so its digest differs, or use another folder)` : `activation failed: ${message}`)
  }
  host.allow(instance, revision)
  host.placed?.(kind, instance, fresh)
  const after = host.current(instance)
  ctx.print(`activated ${instance} (${kind}) "${manifest.name}" digest ${snapshot.digest.slice(0, 16)} generation ${after.generation}`)
  if (fresh) ctx.print(`placed on the desktop. To change it later: edit the folder, \`widget test\`, then \`widget activate ${dir} --instance ${instance}\``)
}

/** Installed widgets, and the package folders under the current folder (two levels). */
async function list(ctx: Ctx, host: WidgetHost) {
  ctx.print('installed widgets (id, kind, name, digest, generation):')
  const installed = host.installed()
  if (!installed.length) ctx.print('  none')
  for (const i of installed) ctx.print(`  ${i.instance}  ${i.kind}  ${JSON.stringify(i.name)}  ${i.digest.slice(0, 16)}  generation ${i.generation}`)
  ctx.print(`source folders under ${prettyPath(ctx.cwd)}:`)
  const found: string[] = []
  const actor = actorOf(ctx)
  let scanned = 0
  const scan = async (path: string, depth: number) => {
    if (scanned++ > 60) return
    ctx.signal.throwIfAborted()
    try {
      if (ctx.policy?.read(path)) return
      await prepare(path, 'ls', [], actor)
    } catch (e) {
      ctx.signal.throwIfAborted()
      return void err(ctx, `  (cannot list ${prettyPath(path)}: ${reason(e)})`)
    }
    const node = lookup(path)
    if (node?.type !== 'dir') return
    if (node.children.get('manifest.json')?.type === 'file') {
      let label = ''
      try {
        await prepare(path, 'cat', ['manifest.json'], actor)
        const m = JSON.parse(readFile(ctx, join(path, 'manifest.json'), 'widget')) as { id?: unknown; name?: unknown }
        label = `  ${m.name} (${m.id})`
      } catch {
        label = '  (manifest.json does not read)'
      }
      found.push(`  ${path === ctx.cwd ? '.' : path.startsWith(`${ctx.cwd}/`) ? path.slice(ctx.cwd.length + 1) : prettyPath(path)}${label}`)
    }
    if (depth < 2) for (const [name, child] of [...node.children].sort(([a], [b]) => (a < b ? -1 : 1))) if (child.type === 'dir' && !name.startsWith('.') && name !== 'node_modules') await scan(join(path, name), depth + 1)
  }
  await scan(ctx.cwd, 0)
  if (!found.length) ctx.print('  none (a package folder has manifest.json; `widget docs template` shows the starter)')
  for (const line of found) ctx.print(line)
}

// --- docs -------------------------------------------------------------------------------------------------------------

const sectionOf = (name: string) => {
  const parts = widgetSDK.split(/^## /m).slice(1)
  const hit = parts.find((p) => p.startsWith(`${name}\n`))
  return hit ? `## ${hit.trimEnd()}` : ''
}

function docs(topic: string): string {
  const template = defaultFiles('custom-template')
  if (topic === 'template') return Object.entries(template).map(([path, text]) => `=== ${path} ===\n${text.trimEnd()}`).join('\n\n')
  if (topic === 'full') return widgetSDK
  if (topic) throw fail(`no topic ${topic}: widget docs [full|template]`)
  const capabilities = (Object.keys(KIND_CAPABILITIES) as InstanceKind[]).map((k) => `  ${k}: ${KIND_CAPABILITIES[k].join(', ')}`)
  return [
    '# Making a widget (MvL OS widget SDK 1)',
    '',
    'A widget is a folder of plain files, run in a bounded JavaScript sandbox. You write the files with write_file / edit_file; this command checks, tests and (with the user\'s yes) activates them. Loop:',
    '  1. `widget docs template` prints the starter package; write_file each file into a new folder (e.g. daily-tally/) inside the work folder.',
    '  2. `widget validate <dir>` builds it: errors name the file and the reason, exit 1. On success it prints the manifest summary and the digest.',
    '  3. `widget test <dir>` runs the sandbox on mock data, then every button the view has, then every tests/*.json case: PASS/FAIL lines, the rendered outline, runtime errors and limits. Exit 1 on any failure.',
    '  4. `widget preview <dir>` is `test` plus a Widget Workshop window on mock data for the user. It never writes installation state.',
    '  5. `widget activate <dir> --new` (a new custom widget) or `--instance <id> [--generation <n>]` (replace an installed one; ids and generations from `widget list`). The user is asked in a dialog (package, digest, widget, access) and Allow/Deny decides. Denied or no desktop: exit 1 `activation requires approval`, nothing changes.',
    '  `--new` is safe to retry: its id comes from the folder and the digest, so the same call again answers `already active` and changes nothing. Edited source is a different digest: use `--instance <id>` to update the widget instead of making a second one.',
    '  `widget list` shows installed widgets (id, kind, name, digest, generation) and package folders under the current folder.',
    '',
    'Package files (UTF-8 only): manifest.json, README.md, styles/tokens.json (required); src/*.js (the entry named in the manifest); optional assets/*.txt|json and tests/*.json.',
    `Limits: ${LIMITS.files} files, ${LIMITS.fileBytes} bytes per file, ${LIMITS.sourceBytes} bytes in all, ${LIMITS.outputBytes} byte output, ${LIMITS.nodes} nodes, ${LIMITS.depth} levels, ${LIMITS.memory / 1024 / 1024} MiB VM memory, ${LIMITS.cpuMs} ms CPU per call, custom state ${LIMITS.customStateBytes} bytes. No fetch, DOM, timers, async or npm: import only relative src/*.js and @mvlos/widget.`,
    'Capabilities per widget kind (manifest.capabilities; a custom widget only has custom.state):',
    ...capabilities,
    '',
    'tests/*.json case: {"schema":1,"description":"...","input":{"custom":{"state":{...},"today":"2026-10-31"}},"event":"inc","expect":{"text":["1 all time"],"absent":["error"],"mutation":{"type":"custom.replace","state":{...},"expectedRevision":"..."}}}',
    '  input is merged over the mock input; text/absent are checked against the rendered text; with event, the effect it returns must equal expect.mutation (null means none). Every field but schema is optional; a case without expect passes when it renders.',
    '',
    sectionOf('Execution'),
    '',
    sectionOf('Manifest'),
    '',
    sectionOf('Descriptor vocabulary'),
    '',
    sectionOf('Custom widgets'),
    '',
    '`widget docs full` prints the whole SDK reference.',
  ].join('\n')
}

// --- the command ----------------------------------------------------------------------------------------------

const SUBS = ['docs', 'list', 'validate', 'test', 'preview', 'activate']

const MAN = `{c:bold}NAME{/}
       widget - make, check and activate a desktop widget (for agents and people)

{c:bold}SYNOPSIS{/}
       widget docs [full|template]
       widget list
       widget validate <dir>
       widget test <dir>
       widget preview <dir>
       widget activate <dir> --new
       widget activate <dir> --instance <id> [--generation <n>]

{c:bold}DESCRIPTION{/}
       A widget is a folder with manifest.json, README.md, styles/tokens.json and src/*.js.
       validate builds it like the Widget Workshop does and prints the digest; test runs it in
       the bounded sandbox on mock data and every tests/*.json case; preview also opens the
       Workshop for the user. Only activate changes anything: it asks the user in a dialog and
       installs the exact revision that was approved. Denied, or no dialog to ask in: exit 1,
       "activation requires approval", no change. Retrying the same activate is harmless.
       Reads follow the same permission rules as cat.

       Recommended loop: write the files, validate, test, preview, activate. widget docs has the
       SDK reference, the limits and the starter package.`

export const widgetCommands = {
  widget: {
    desc: 'make, test and activate desktop widgets',
    usage: `usage: ${USAGE}`,
    man: MAN,
    complete: (args: string[], word: string) => (args.length ? [] : SUBS.filter((s) => s.startsWith(word)).map((s) => ({ value: s, label: s }))),
    async run(ctx: Ctx) {
      const [sub, ...rest] = ctx.args
      if (!sub || !SUBS.includes(sub)) throw fail(`${sub ? `unknown subcommand ${sub}: ` : ''}${USAGE}`)
      if (sub === 'docs') return docs(rest[0] ?? '')
      const host = await hostOf()
      if (sub === 'list') return list(ctx, host)
      if (sub === 'activate') return activateCommand(ctx, host, rest)
      const { dir, instance, fresh, generation } = flags(rest)
      if (instance || fresh || generation !== null) throw fail(`${sub} takes only a folder`)
      if (sub === 'validate') return validate(ctx, dir)
      if (sub === 'test') return test(ctx, host, dir)
      return preview(ctx, host, dir)
    },
  },
}
