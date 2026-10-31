import { TERMINAL_RESOURCES } from '../data/terminalResources'
import { SAFE_JQ_LIMITS } from './jq-safe'
import { getLibraries } from '../data/seafile'
import { getAccount } from '../os/account'
import { browserMountPoint, isSeafileType, mounts, whereIs } from '../data/mounts'
import { MSH_VERSION, SHELL_BUILTINS } from './msh/interp'
import { EFFECTS, commandBounds } from './policy'
import { reserve } from './bounds'
import type { Ctx } from './types'

// What this session can do, as data: `help --json` in the terminal and the agents' terminal_capabilities
// tool. The command list comes from the same registry `help`, `man` and Tab read (commands.ts), so
// the human and the machine view cannot drift apart; the options of a command are the ones its own
// usage line names, nothing is filled in from other systems. What it says about files, limits and
// permissions is this session's: an agent's call reports the policy and the budget it actually runs under.

export type CommandInfo = { desc: string; usage?: string; man?: string; hidden?: boolean }

/** How `help` groups the commands: the human listing and the machine one are both made from this. */
export const HELP_GROUPS: [string, string[]][] = [
  ['Explore', ['ls', 'cd', 'pwd', 'cat', 'tree', 'find', 'fd', 'open', 'go', 'files', 'visited']],
  ['Apps', ['photos', 'mail', 'contacts', 'tasks', 'weather', 'games']],
  ['About me', ['whoami', 'cv', 'projects', 'pepper', 'contribs', 'recent', 'changelog', 'git', 'heatmap', 'stars', 'contact']],
  ['Files', ['nano', 'touch', 'mkdir', 'cp', 'mv', 'rm', 'chmod', 'tee', 'unzip', 'tar', 'mount', 'umount', 'findmnt', 'lsblk', 'fscrypt']],
  ['Text', ['grep', 'head', 'tail', 'wc', 'sort', 'uniq', 'xxd', 'echo', 'calc', 'jq-safe', 'jq', 'sha256sum', 'md5sum']],
  ['Network', ['curl', 'wget', 'whois', 'ping', 'dig', 'host', 'nslookup', 'minecraft']],
  ['Device', ['htop', 'df', 'du', 'free', 'nproc', 'lscpu', 'xrandr', 'ip', 'watch']],
  ['Shell', ['msh', 'test', 'printf', 'read', 'source', 'alias', 'unalias', 'type', 'sleep', 'seq', 'basename', 'dirname']],
  ['Agents', ['agents', 'skills', 'mvl', 'widget']],
  ['System', ['keys', 'ps', 'kill', 'uname', 'uptime', 'date', 'cal', 'history', 'sudo', 'env', 'export', 'theme', 'tty', 'reboot', 'shutdown', 'clear', 'exit']],
  ['Fun', ['games', 'fastfetch', 'fortune', 'cowsay', 'figlet', 'lolcat', 'cmatrix', 'sl']],
]

/** The group a command is listed under in `help`; everything else (and the shell's builtins) is "More". */
export const groupOf = (name: string) => HELP_GROUPS.find(([, names]) => names.includes(name))?.[0] ?? 'More'

export type CommandOption = { flag: string; takesValue: boolean }

/**
 * The options a usage line names: `[-a] [-l]` gives -a and -l, `[-vzkO]` gives each letter, `-c count`
 * and `[--model m]` take a value. Usage text is not a parser schema: `complete` is always false.
 * Supported long options and aliases may be absent; the manual remains the detailed reference.
 */
export function optionsOf(usage: string | undefined): { options: CommandOption[]; complete: boolean } {
  if (!usage) return { options: [], complete: false }
  const options = new Map<string, boolean>()
  const re = /(?<![\w-])(--[a-zA-Z][\w-]*|-[a-zA-Z0-9]+)(?:=\S+|(\s+)(<[^>]+>|[A-Za-z][\w]*(?:\|[\w]+)*|\[-\]N)(?=\s*(?:\]|\||$|\[|-)))?/g
  for (const m of usage.matchAll(re)) {
    const flag = m[1]
    // After `usage: cmd`, a word that names the argument (-c count) is the flag's value, not a word of its own.
    const value = m[2] !== undefined && m[3] !== undefined ? true : m[0].includes('=')
    if (flag.startsWith('--') || flag.length === 2) options.set(flag, value || options.get(flag) === true)
    else for (const ch of flag.slice(1)) options.set(`-${ch}`, options.get(`-${ch}`) ?? false)
  }
  return { options: [...options].map(([flag, takesValue]) => ({ flag, takesValue })), complete: false }
}

/** msh's language, as this build has it (man msh has the detail). Each line is true of the interpreter in msh/. */
const SHELL_FEATURES = {
  syntax: ['pipelines (a | b)', 'lists (; && ||)', '! negation', 'if/elif/else', 'for', 'while', 'until', 'case', 'functions', 'named function parameters: name(a, b) { …; } (exact arity; local string snapshots; command-style calls)', '( subshell )', '{ group; }', '# comments', 'line continuation'],
  redirects: ['>', '>>', '<', '>|', '&>', '2>', '2>>', '2>&1', '>&2', '<<', '<<-', '<<\'EOF\''],
  expansion: ['$var and ${var}', '$1…$9, $#, $@, $*, $?, $0, $$, $RANDOM', '${v:-d} ${v:=d} ${v:+a} ${v:?m}', '${#v}', '${v#p} ${v##p} ${v%p} ${v%%p}', '${v/p/r} ${v//p/r}', '${v:off:len}', '$(cmd) and `cmd`', '$((arithmetic))', '~', 'globbing (* ? [..])'],
  options: ['set -e / +e (errexit)', 'set -u (nounset)', 'set -x (xtrace)', 'set -o pipefail', 'msh -n (syntax check only)', 'msh -x', 'msh -e', 'msh -c'],
  scripts: ['msh file args…', './file (needs the x bit and a #! for msh, sh or bash)', 'source file', 'stdin (echo … | msh)'],
  notSupported: ['expression-style function calls', 'parameter defaults, rest parameters, destructuring and type annotations', 'readonly variables', 'background jobs (& runs in the foreground)', 'job control', 'arrays', 'process substitution <(…)', 'real processes: commands are MvL OS’s own, not a Linux system’s'],
}

/** Whether files can be written where a path is: Seafile (unless read-only), the browser's store, and /tmp. */
const writableWhere = (w: ReturnType<typeof whereIs>, path: string) => (w.kind === 'sf' ? !w.ro : w.kind === 'browser' || path === '/tmp' || path.startsWith('/tmp/'))

type Mounted = { path: string; type: string; source: string; options: string[]; writable: boolean; agent?: { read: boolean; write: boolean } }

/**
 * `only`: one command's entry. `compact`: the command list as name, group, summary, availability and option
 * flags, which is what an agent reads first (ask for one command to get its usage and manual too).
 */
export function capabilities(registry: Record<string, CommandInfo>, ctx: Pick<Ctx, 'cwd' | 'env' | 'root' | 'tty' | 'policy' | 'budget'>, only?: string, compact = false) {
  const policy = ctx.policy
  const grant = policy?.grant
  const builtins = new Set(SHELL_BUILTINS)
  const names = [...new Set([...Object.keys(registry), ...builtins])].sort()
  const picked = only ? names.filter((n) => n === only) : names
  // Registry entries are static, but constructing the full overview is still retained work.
  reserve(ctx, picked.length * 1024)
  const full = picked.map((name) => {
    const info = registry[name]
    const { options, complete } = optionsOf(info?.usage)
    const effect = EFFECTS[name]
    // What this session may do with it: for an agent the policy answers (with no arguments, so what it says is only the kind of command), the terminal runs everything.
    const blocked = policy ? name === 'mvl' && grant?.appDataRead?.length ? null : policy.command(name, [], ctx.cwd) : null
    const restriction = policy ? (effect === 'network' && !grant?.network ? 'runs only when the approved command line names it' : effect === 'delete' && !grant?.delete ? 'needs the approved command line to name it' : blocked ?? undefined) : undefined
    return {
      name,
      group: groupOf(name),
      summary: info?.desc ?? 'shell builtin',
      kind: builtins.has(name) ? ('builtin' as const) : ('command' as const),
      ...(info?.hidden ? { alias: true } : {}),
      ...(['calc', 'units', 'bc'].includes(name) ? { conditionalNetwork: 'Exchange-rate cache misses require network authority; arithmetic, units and cached rates stay offline.' } : {}),
      ...(name === 'mvl' ? { resources: TERMINAL_RESOURCES.map(r => ({ ...r, available: policy ? !!grant?.appDataRead?.includes(r.id) : !!getAccount().user })) } : {}),
      ...(name === 'jq-safe' ? { limits: SAFE_JQ_LIMITS } : {}),
      usage: info?.usage ?? null,
      options,
      optionsComplete: info?.usage ? complete : false,
      manual: info ? (info.man ? `man ${name}` : `${name} --help`) : 'man msh',
      ...(policy && commandBounds(name) ? { bounds: commandBounds(name) } : {}),
      ...(policy ? { effect: effect ?? 'blocked', available: !blocked, ...(restriction ? { restriction } : {}) } : {}),
    }
  })

  const commands = compact && !only ? full.filter((c) => !('alias' in c)).map(({ name, group, summary, kind, options, optionsComplete, ...rest }) => ({ name, group, summary: summary.slice(0, 60), kind, options: options.map((o) => (o.takesValue ? `${o.flag} <v>` : o.flag)), ...(optionsComplete ? {} : { optionsComplete }), ...('bounds' in rest ? { bounds: rest.bounds } : {}), ...('conditionalNetwork' in rest ? { conditionalNetwork: rest.conditionalNetwork } : {}), ...('available' in rest ? { available: rest.available, ...(rest.available && rest.restriction ? { restriction: rest.restriction } : {}) } : {}) })) : full

  const all = mounts()
  reserve(ctx, all.length * 512)
  for (const m of all) reserve(ctx, (m.target.length + m.source.length + m.type.length + m.options.reduce((n, o) => n + o.length, 0)) * 8)
  const root = grant?.root ?? null
  // The mount that holds the work folder: the longest target that is a prefix of it.
  const holder = root ? all.filter((m) => root === m.target || root.startsWith(m.target === '/' ? '/' : `${m.target}/`)).sort((a, b) => b.target.length - a.target.length)[0] : undefined
  const mountList: Mounted[] = all.map((m) => {
    const w = whereIs(m.target)
    const fsWritable = !m.options.includes('ro') && writableWhere(w, m.target)
    const entry: Mounted = { path: m.target, type: m.type, source: m.source === 'seafile' ? 'all libraries' : m.source, options: m.options, writable: fsWritable }
    if (policy) {
      const holds = holder?.target === m.target
      entry.agent = { read: policy.read(m.target) === null || holds, write: !!grant?.write && holds && fsWritable }
    }
    return entry
  })
  const folder = root ? whereIs(root) : null
  const folderWritable = !!folder && !!root && writableWhere(folder, root)

  const libs = getLibraries()
  const account = getAccount()
  const integrations = [
    { id: 'seafile', available: !!account.seafile, detail: account.seafile ? `${libs ? libs.length : 'some'} libraries${all.some(isSeafileType) ? ', mounted' : ', none mounted'}` : 'not linked to an account' },
    { id: 'browser-files', available: !!browserMountPoint(), detail: browserMountPoint() ? `files kept in this browser, mounted at ${browserMountPoint()}` : 'only when signed in' },
    { id: 'network', available: true, detail: 'curl, wget, ping, dig, host, nslookup, whois (the browser fetches: only sites that allow it)', ...(policy ? { agent: grant?.network ? 'allowed for this call' : 'only when the approved command line names the command' } : {}) },
    ...TERMINAL_RESOURCES.map(r => ({ id: r.id, available: policy ? !!grant?.appDataRead?.includes(r.id) : !!account.user, detail: 'Authenticated read-only account data through mvl; server authorization applies to every request' })),
    { id: 'apps', available: !ctx.tty ? false : true, detail: 'open, photos, mail… start apps in the desktop', ...(policy ? { agent: 'not available to an agent' } : {}) },
  ]

  return {
    schema: 1,
    session: {
      kind: policy ? 'agent' : 'interactive',
      user: ctx.env.USER ?? null,
      home: ctx.env.HOME ?? null,
      cwd: ctx.cwd,
      root: !!ctx.root,
      stateKept: policy ? 'none: each call starts a fresh shell (files persist, variables, functions, aliases and the working directory do not)' : 'for this terminal: variables, functions, aliases, history',
    },
    shell: { name: 'msh', version: MSH_VERSION, interpreter: 'the same interpreter as the interactive terminal', builtins: [...builtins].sort(), ...SHELL_FEATURES },
    commands,
    filesystem: {
      mounts: mountList,
      ...(policy
        ? {
            workFolder: root ? { path: root, mount: holder?.target ?? null, writable: folderWritable && !!grant?.write } : null,
            agent: {
              read: root ? `inside the work folder (${root}); Seafile and /tmp text, bounded devices only` : 'Seafile and /tmp text, bounded devices only (no work folder)',
              write: !root ? 'nowhere (no work folder)' : grant?.write ? (folderWritable ? 'inside the work folder only' : 'nowhere: the work folder is on a read-only mount') : `nowhere (${grant?.mode} mode does not let this call change files)`,
              delete: grant?.delete ? 'inside the work folder' : 'not for this call (the approved command line must name rm or rmdir)',
              steeringFiles: grant?.steering ? 'writable for this call (the user approved a command naming them)' : 'AGENTS.md, CLAUDE.md, .agents/, .claude/ cannot be written by this call',
              symlinks: 'none exist in this filesystem',
            },
          }
        : {}),
    },
    integrations,
    limits: ctx.budget
      ? { syncTextChars: 65536, maxCommandArgs: 128, textInputsPerCommand: 1, accounting: 'conservative intermediate allocation reservations plus bytes and UTF-16 text; not heap measurement', maxSourceChars: 64_000, maxExpandedFields: 10_000, maxPatternChars: 256, maxPatternStars: 1, maxPatternInputChars: 4096, maxGrepPatternChars: 4096, maxIfsChars: 256, deadline: 'cooperative; synchronous JavaScript is not preempted', timeoutSeconds: ctx.budget.limits.timeoutMs / 1000, maxSteps: ctx.budget.limits.maxSteps, outputCharsPerStream: ctx.budget.limits.maxOutput, bufferCharsPerPipeOrSubstitution: ctx.budget.limits.maxBuffer, totalCharsWritten: ctx.budget.limits.maxTotal, variableChars: ctx.budget.limits.maxVariable, onLimit: 'the run stops; the result says why (termination) and what was cut (truncated)' }
      : null,
    sessionRights: grant ? { mode: grant.mode, write: !!root && grant.mode !== 'plan', writeApproval: ['bypass', 'acceptEdits'].includes(grant.mode) ? 'not required inside work folder' : 'required', deleteApproval: grant.mode === 'bypass' ? 'not required' : 'required', networkApproval: grant.mode === 'bypass' ? 'not required' : 'required', steeringApproval: 'fresh explicit approval always required', queryAuthority: 'permissions below apply only to this call' } : null,
    permissions: grant ? { mode: grant.mode, write: grant.write, delete: grant.delete, network: grant.network, steering: grant.steering, appDataRead: grant.appDataRead ?? [] } : null,
    notes: [
      'Commands are MvL OS’s own, not a Linux system’s: option lists are partial usage hints, not a complete parser schema.',
      ...(policy ? ['A command the policy refuses answers `msh: …` on stderr with status 126; the reason says which rule.'] : []),
    ],
  }
}
