import { appDataDenial } from './appData'
import type { TerminalResource } from '../data/terminalResources'
import { agentGrepRefusal, parseGrepArgs } from './grepArgs'
import { parseSf, sfPath } from '../data/seafile'
import { whereIs, mounts } from '../data/mounts'
import { STEERING } from '../data/steering'
import { resolvePath } from './vfs'

// What an agent's terminal call may do, checked where it happens. The server decides whether a call
// runs, waits for the user or is refused (server/agents.ts decide) and sends the grant that goes
// with it; the check here is on what the shell then resolves: every command after expansion (so
// variables, globs, eval, source, nested scripts and functions are all seen as the commands they
// become), every redirect target, every script that is read, and, in fs.ts, every file written.
// The text of the command line is never what is trusted.
//
// Nothing is granted silently: a call may write only in the work folder, delete only when its text
// names rm or rmdir, use the network only when its text names a network command, and touch the
// files that steer the agent (AGENTS.md, CLAUDE.md, .agents/, .claude/) only after fresh explicit approval.
// Archive and bulk directory mutations fail closed; lexical paths alone never establish identity.

export type Grant = {
  /** The thread's permission mode, for the capability report */
  appDataRead?: readonly TerminalResource[]
  mode: string
  /** The work folder as a terminal path; null when the thread has none */
  root: string | null
  /** Immutable backing identity from the server's work folder. */
  backing?: { repo: string; path: string }
  /** May write inside the work folder */
  write: boolean
  /** May delete inside the work folder (rm, rmdir) */
  delete: boolean
  /** May use the network commands */
  network: boolean
  /** May write the files that steer the agent */
  steering: boolean
}

/** What the shell and fs.ts ask of a call's policy; each answers a reason to refuse, or null. */
export interface Policy {
  readonly grant: Grant
  /** A command as the shell resolved it (name and arguments after expansion). */
  command(name: string, args: string[], cwd: string): string | null
  read(abs: string): string | null
  tree(abs: string): string | null
  write(abs: string, op?: 'write' | 'delete'): string | null
  /** Moving the working directory there. */
  cwd(abs: string): string | null
}

export type Effect = 'pure' | 'read' | 'write' | 'delete' | 'network' | 'resource' | 'blocked'

/**
 * What each command of the registry does to the world, for the agents' terminal. A command that is
 * not here does not run for an agent, so a new command is shut out until someone decides (the
 * check script lists every registered command against this table).
 */
export const EFFECTS: Record<string, Effect> = {
  // The shell's own commands. source, eval, command and msh only run other commands, which are checked in turn.
  ':': 'pure', true: 'pure', false: 'pure', echo: 'pure', printf: 'pure', export: 'pure', unset: 'pure', set: 'pure', local: 'pure', shift: 'pure', return: 'pure', exit: 'pure', break: 'pure', continue: 'pure', read: 'pure',
  source: 'pure', '.': 'pure', alias: 'pure', unalias: 'pure', eval: 'pure', command: 'pure', type: 'pure', getopts: 'pure', wait: 'pure', trap: 'pure', sleep: 'pure', msh: 'pure', sh: 'pure', bash: 'pure',
  test: 'read', '[': 'read',
  // Information about the session and plain computation.
  help: 'pure', man: 'pure', pwd: 'pure', whoami: 'pure', id: 'pure', hostname: 'pure', uname: 'pure', date: 'pure', uptime: 'pure', history: 'pure', env: 'pure', which: 'pure', clear: 'pure', tty: 'pure', stty: 'pure',
  fastfetch: 'pure', neofetch: 'pure', fortune: 'pure', cowsay: 'pure', figlet: 'pure', lolcat: 'pure', cal: 'pure', calc: 'pure', units: 'pure', bc: 'pure', seq: 'pure', basename: 'pure', dirname: 'pure',
  df: 'pure', free: 'pure', nproc: 'pure', lscpu: 'pure', ip: 'pure', ifconfig: 'pure', xrandr: 'pure', findmnt: 'pure', lsblk: 'pure', ps: 'pure', git: 'network', changelog: 'network', releases: 'network',
  // Commands that read the files they are given (and the shell's own `cd`).
  cd: 'read', ls: 'read', ll: 'read', cat: 'read', less: 'read', more: 'read', bat: 'read', head: 'read', tail: 'read', wc: 'read', grep: 'read', sort: 'read', uniq: 'read', tree: 'read', du: 'read', find: 'read', fd: 'blocked',
  'jq-safe': 'pure', mvl: 'resource', jq: 'blocked', sha1sum: 'read', sha256sum: 'read', sha384sum: 'read', sha512sum: 'read', md5sum: 'read', xxd: 'read', hexdump: 'read', od: 'read', tar: 'blocked', unzip: 'blocked',
  // Commands that write what they are given.
  touch: 'write', mkdir: 'write', tee: 'write', cp: 'write', mv: 'write', chmod: 'write',
  rm: 'delete', rmdir: 'delete',
  // The network.
  curl: 'network', wget: 'network', ping: 'network', dig: 'network', host: 'network', nslookup: 'network', whois: 'network', pepper: 'network',
}

/** find and fd options that run commands or write files: never for an agent. */
const FIND_ACTIONS = new Set(['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls'])
const FD_ACTIONS = new Set(['-x', '-X', '--exec', '--exec-batch'])
const FILE_TESTS = new Set(['-e', '-f', '-d', '-s', '-r', '-w', '-x', '-L', '-h', '-b', '-c', '-p', '-S'])
/** Devices that only produce or swallow bytes. */
const HARMLESS_DEVICES = new Set(['/dev/null', '/dev/zero', '/dev/urandom', '/dev/random'])

const inside = (root: string, abs: string) => abs === root || abs.startsWith(root === '/' ? '/' : `${root}/`)

/** The arguments that are not options (a lone - is stdin and stays out). */
const operands = (args: string[]) => args.filter((a) => a !== '-' && !a.startsWith('-'))

export function makePolicy(grant: Grant): Policy {
  const root = grant.root
  const original = root ? whereIs(root) : null
  const identity = (abs: string) => {
    if (!root || HARMLESS_DEVICES.has(abs)) return null
    const at = whereIs(abs)
    const expected = grant.backing ? { kind: 'sf', sf: sfPath(grant.backing.repo, grant.backing.path) } : original
    // Compare backing paths, not mount labels. A nested bind can escape even in the same repo.
    const key = (w: typeof original | typeof expected) => w?.kind === 'sf' ? w.sf : w && 'path' in w ? w.path : null
    const base = key(expected), path = key(at)
    return expected?.kind === at.kind && base !== null && path !== null && inside(base, path) ? null : `${abs}: backing filesystem is outside the authorized work folder`
  }
  const where = root ? `the work folder (${root})` : 'a work folder'
  const read = (abs: string): string | null => {
    if (identity(abs)) return identity(abs)
    if (!root || inside(root, abs) || HARMLESS_DEVICES.has(abs)) return null
    return `${abs}: outside ${where}`
  }
  const write = (abs: string, op: 'write' | 'delete' = 'write'): string | null => {
    if (abs === '/dev/null') return null
    if (identity(abs)) return identity(abs)
    if (whereIs(abs).kind === 'browser') return `${abs}: agent writes to browser storage are unavailable; use a Seafile work folder`
    if (!root) return `${abs}: this thread has no work folder, so nothing can be written`
    if (!grant.write) return `${abs}: this call may not change files (${grant.mode} mode)`
    if (!inside(root, abs)) return `${abs}: outside ${where}, the only place an agent writes`
    if (op === 'delete' && !grant.delete) return `${abs}: deleting needs the user's approval, and this call's text must name rm or rmdir`
    const resolved = whereIs(abs)
    const backingPath = resolved.kind === 'sf' ? parseSf(resolved.sf)?.p : 'path' in resolved ? resolved.path : undefined
    if ((STEERING.test(abs) || (backingPath !== undefined && STEERING.test(backingPath))) && !grant.steering) return `${abs}: steers the agent, so it only changes when the user approves a command naming it`
    return null
  }
  const first = <T>(items: T[], check: (item: T) => string | null) => {
    for (const item of items) {
      const why = check(item)
      if (why) return why
    }
    return null
  }
  const abs = (cwd: string, a: string) => resolvePath(cwd, a)

  return {
    grant,
    read,
    tree: (abs) => read(abs) ?? first(mounts().filter((m) => inside(abs, m.target)), (m) => read(m.target)),
    write,
    cwd: (to) => read(to) ?? (!root || inside(root, to) ? null : `${to}: outside ${where}`),
    command(rawName, args, cwd) {
      let name = rawName.includes('/') ? resolvePath(cwd, rawName) : rawName
      if (name.includes('/')) {
        // /bin/ls is ls; a path is a script, which is read (and so confined) when it runs.
        if (name.startsWith('/bin/') && !name.slice(5).includes('/')) name = name.slice(5)
        else return /\.game$/.test(name) ? `${name}: games do not run from the agent` : read(abs(cwd, name))
      }
      if (name === 'grep') {
        const why = agentGrepRefusal(parseGrepArgs(args))
        if (why) return why
      }
      if (name === 'find' && (args.some((a) => ['-regex', '-iregex'].includes(a)) || args.some((a) => a.length > 256 || (a.match(/\*/g)?.length ?? 0) > 1))) return 'find: agent searches allow bounded glob patterns only, not regular expressions'
      const effect = EFFECTS[name]
      if (effect === undefined || effect === 'blocked') return `${name}: not available to an agent (requires unsupported effects or unbounded synchronous execution); \`help --json\` lists what runs`
      switch (effect) {
        case 'resource':
          return appDataDenial(args, grant)
        case 'pure':
          return null
        case 'network':
          return grant.network ? null : `${name}: network commands run only when the approved command line names them (run ${name} directly, not from a script)`
        case 'read': {
          if (name === 'find' && args.some((a) => FIND_ACTIONS.has(a))) return `find: ${args.find((a) => FIND_ACTIONS.has(a))} runs commands or changes files, which an agent cannot do from find`
          if (name === 'fd' && args.some((a) => FD_ACTIONS.has(a))) return `fd: ${args.find((a) => FD_ACTIONS.has(a))} runs commands, which an agent cannot do from fd`
          if (name === 'test' || name === '[') {
            // Only the words a file test or -nt/-ot names are paths; the rest are strings being compared.
            const paths = args.filter((_, k) => FILE_TESTS.has(args[k - 1] ?? '') || ['-nt', '-ot'].includes(args[k - 1] ?? '') || ['-nt', '-ot'].includes(args[k + 1] ?? ''))
            return first(paths, (a) => read(abs(cwd, a)))
          }
          if (name === 'cd' && !operands(args).length) return root ? `cd: with no folder it goes home, outside ${where}` : null
          return first(fileOperands(name, args), (a) => read(abs(cwd, a)))
        }
        case 'write':
        case 'delete': {
          const ops = fileOperands(name, args)
          if (name === 'cp') return first(ops.slice(0, -1), (a) => read(abs(cwd, a))) ?? first(ops.slice(-1), (a) => write(abs(cwd, a)))
          return first(ops, (a) => write(abs(cwd, a), effect === 'delete' ? 'delete' : 'write'))
        }
      }
      return null
    },
  }
}

/** Data-only commands have no filesystem preparation, including their cwd. Script/file reads
 * performed by shell builtins explicitly prepare as cat/ls; downloads check the actual write. */
export function hasNoFileOperands(name: string): boolean {
  return ['pure', 'network', 'resource'].includes(EFFECTS[name])
}

/** Files a command actually consumes. This follows MvL's parsers, not GNU option guesses.
 * Unknown/blocked commands retain conservative preparation; agent dispatch denies them first. */
export function fileOperands(name: string, args: string[]): string[] {
  if (hasNoFileOperands(name)) return []
  if (name === 'grep' || name === 'egrep') return parseGrepArgs(args).files.filter((p) => p !== '-')
  // cat aliases take literal names (no option parser). '-' alone denotes stdin.
  if (['cat', 'less', 'more', 'bat'].includes(name)) return args.filter(a => a !== '-')
  if (name === 'rmdir') return args
  if (name === 'tree') return args.slice(0, 1)
  if (name === 'cd') return args.slice(0, 1).filter(a => a !== '-')
  // These commands use commands.ts's letter-only flags parser; --foo is a filename.
  if (['ls', 'll', 'wc', 'sort', 'uniq', 'mkdir', 'cp', 'mv', 'rm', 'tee'].includes(name)) return args.filter(a => !/^-[a-zA-Z]+$/.test(a))
  if (name === 'du') {
    const files: string[] = []
    for (let i = 0; i < args.length; i++) {
      const a = args[i]
      if (a === '--') { files.push(...args.slice(i + 1)); break }
      if (a === '-d') { i++; continue }
      if (/^--max-depth=/.test(a) || /^-d\d+$/.test(a) || /^-[a-zA-Z]+$/.test(a)) continue
      if (['--help', '--all', '--total', '--summarize', '--one-file-system', '--human-readable', '--bytes', '--apparent-size'].includes(a)) continue
      // du's parser treats other words (even dash-prefixed ones) as paths.
      files.push(a)
    }
    return files
  }
  if (['head', 'tail', 'xxd', 'hexdump', 'od'].includes(name)) {
    const files: string[] = []
    const values: Record<string, readonly string[]> = {
      head: ['-n', '-c', '--lines', '--bytes'], tail: ['-n', '-c', '--lines', '--bytes'],
      xxd: ['-cols', '-len', '-groupsize', '-seek'], hexdump: ['-s', '-n'],
      od: ['-A', '-t', '-N', '-j'],
    }
    for (let i = 0; i < args.length; i++) {
      const a = args[i]
      if (a === '--' && ['head', 'tail', 'xxd'].includes(name)) {
        files.push(...args.slice(i + 1).filter(p => p !== '-')); break
      }
      if (values[name].includes(a)) { i++; continue }
      if (name === 'xxd' && a.startsWith('-') && !['-p', '-ps', '-postscript', '-plain', '-r', '-revert', '-u', '-uppercase'].includes(a)) {
        // In an xxd short-option bundle c/l/g/s consume the suffix or the next word.
        const at = [...a].findIndex((ch, k) => k > 0 && 'clgs'.includes(ch))
        if (at === a.length - 1) i++
        continue
      }
      if (!a.startsWith('-')) files.push(a)
    }
    return files
  }
  const words = operands(args)
  if (['jq', 'fd'].includes(name)) return words.slice(1)
  if (name === 'find') return args.slice(0, args.findIndex((a) => a.startsWith('-')) < 0 ? args.length : args.findIndex((a) => a.startsWith('-')))
  if (name === 'chmod') {
    let end = false, mode = false
    return args.filter(a => {
      if (!end && a === '--') { end = true; return false }
      if (!end && (/^-[Rcfv]+$/.test(a) || ['--recursive', '--changes', '--silent', '--quiet', '--verbose'].includes(a))) return false
      if (!mode) { mode = true; return false }
      return true
    })
  }
  // touch and checksums discard all dash-prefixed words; test's caller supplies file paths.
  return words
}
