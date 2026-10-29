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
// files that steer the agent (AGENTS.md, CLAUDE.md, .agents/, .claude/) only when its text names them.

export type Grant = {
  /** The thread's permission mode, for the capability report */
  mode: string
  /** The work folder as a terminal path; null when the thread has none */
  root: string | null
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
  write(abs: string, op?: 'write' | 'delete'): string | null
  /** Moving the working directory there. */
  cwd(abs: string): string | null
}

export type Effect = 'pure' | 'read' | 'write' | 'delete' | 'network' | 'blocked'

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
  df: 'pure', free: 'pure', nproc: 'pure', lscpu: 'pure', ip: 'pure', ifconfig: 'pure', xrandr: 'pure', findmnt: 'pure', lsblk: 'pure', ps: 'pure', git: 'pure', changelog: 'pure', releases: 'pure',
  // Commands that read the files they are given (and the shell's own `cd`).
  cd: 'read', ls: 'read', ll: 'read', cat: 'read', less: 'read', more: 'read', bat: 'read', head: 'read', tail: 'read', wc: 'read', grep: 'read', sort: 'read', uniq: 'read', tree: 'read', du: 'read', find: 'read', fd: 'read',
  jq: 'read', sha1sum: 'read', sha256sum: 'read', sha384sum: 'read', sha512sum: 'read', md5sum: 'read', xxd: 'read', hexdump: 'read', od: 'read', tar: 'read', unzip: 'read',
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
  const where = root ? `the work folder (${root})` : 'a work folder'
  const read = (abs: string): string | null => {
    if (!root || inside(root, abs) || HARMLESS_DEVICES.has(abs)) return null
    return `${abs}: outside ${where}`
  }
  const write = (abs: string, op: 'write' | 'delete' = 'write'): string | null => {
    if (abs === '/dev/null') return null
    if (!root) return `${abs}: this thread has no work folder, so nothing can be written`
    if (!grant.write) return `${abs}: this call may not change files (${grant.mode} mode)`
    if (!inside(root, abs)) return `${abs}: outside ${where}, the only place an agent writes`
    if (op === 'delete' && !grant.delete) return `${abs}: deleting needs the user's approval, and this call's text must name rm or rmdir`
    if (STEERING.test(abs) && !grant.steering) return `${abs}: steers the agent, so it only changes when the user approves a command naming it`
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
    write,
    cwd: (to) => (!root || inside(root, to) ? null : `${to}: outside ${where}`),
    command(rawName, args, cwd) {
      let name = rawName
      if (name.includes('/')) {
        // /bin/ls is ls; a path is a script, which is read (and so confined) when it runs.
        if (name.startsWith('/bin/') && !name.slice(5).includes('/')) name = name.slice(5)
        else return /\.game$/.test(name) ? `${name}: games do not run from the agent` : read(abs(cwd, name))
      }
      const effect = EFFECTS[name]
      if (effect === undefined || effect === 'blocked') return `${name}: not available to an agent (it opens apps, takes over the screen, or changes the session); \`help --json\` lists what runs`
      switch (effect) {
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
          return first(operands(args), (a) => read(abs(cwd, a)))
        }
        case 'write':
        case 'delete': {
          const ops = operands(args)
          if (name === 'chmod') ops.shift()
          if (name === 'cp') return first(ops.slice(0, -1), (a) => read(abs(cwd, a))) ?? first(ops.slice(-1), (a) => write(abs(cwd, a)))
          return first(ops, (a) => write(abs(cwd, a), effect === 'delete' ? 'delete' : 'write'))
        }
      }
      return null
    },
  }
}
