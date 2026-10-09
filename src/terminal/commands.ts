import { contributions, headlines, profile, projects } from '../data/profile'
import { countFor, levels, loadContributions } from '../data/contributions'
import { fetchMinecraft, MC_ADDRESS } from '../data/minecraft'
import { fetchStars, loadRecents, timeAgo } from '../data/recents'
import type { AppId } from '../os/wm'
import { lookupAddress, RECORD_TYPES, resolve, resolverFor } from './dns'
import { pepper } from './pepper'
import { extraCommands } from './extra'
import { revealEmail } from '../data/email'
import { SHORTCUTS } from '../data/shortcuts'
import { GAME_CATALOG } from '../apps/games/catalog'
import { loadRates, smartCalc } from '../os/smartcalc'
import { THEMES as OMARCHY_THEMES } from '../os/omarchyThemes'
import { ACCENTS, setMode, setTheme, themeLabel, themeSettings } from '../os/theme'
import { reboot, shutdown } from '../os/powerState'
import { openLink } from '../data/links'
import { asWebAddress } from '../os/linkPreview'
import { signedIn } from '../os/account'
import { golinksSite, golinksTemplate, golinksUrl, maskGolinks, parseGolinks, setGolinks } from '../data/golinks'
import { age, fileKind, HOME, lookup, prettyPath, resolvePath, walk, type DirNode, type Node } from './vfs'

// Output markup understood by the terminal renderer:
//   {c:green}text{/}      colored span (green, red, yellow, blue, cyan, magenta, muted, accent, bold)
//   {link:https://…}text{/}  clickable link
//   {anim:sl}{/}          an animation component (only `sl` today)
// Pipes and redirects receive the text with this markup stripped.

export const strip = (s: string) => s.replace(/\{anim:[^}]*\}\{\/\}/g, '').replace(/\{(?:c|link|fg):[^}]*\}|\{\/\}/g, '')
const c = (color: string, s: string) => `{c:${color}}${s}{/}`
const link = (url: string, text = url) => `{link:${url}}${text}{/}`

export { CmdError, type Ctx } from './types'
import { CmdError, type Ctx } from './types'
import { BUILT, VERSION } from '../version'

type Out = string | void
type Command = { desc: string; usage?: string; hidden?: boolean; run: (ctx: Ctx) => Out | Promise<Out> }

const APPS: Record<string, AppId> = {
  terminal: 'terminal',
  files: 'files',
  nautilus: 'files',
  omafile: 'files',
  notes: 'notes',
  note: 'notes',
  sticky: 'notes',
  keys: 'keys',
  shortcuts: 'keys',
  projects: 'projects',
  recents: 'recents',
  activity: 'recents',
  cv: 'cv',
  resume: 'cv',
  about: 'cv',
  contact: 'contact',
  mail: 'contact',
  games: 'games',
  arcade: 'games',
  zed: 'zed',
  editor: 'zed',
  trash: 'trash',
  notebook: 'notebook',
  settings: 'settings',
  mcserver: 'mcserver',
}

const APP_NAMES: Record<AppId, string> = {
  terminal: 'terminal',
  files: 'files',
  viewer: 'viewer',
  notes: 'sticky-notes',
  keys: 'shortcuts-note',
  projects: 'files',
  recents: 'activity',
  cv: 'cv-viewer',
  contact: 'mail',
  games: 'arcade',
  zed: 'zed',
  trash: 'trash',
  notebook: 'notebook',
  widget: 'widget',
  settings: 'settings',
  mcserver: 'mc-status',
  linkforge: 'link-forge',
  calendar: 'calendar',
}

/** What `man <name>` shows, and `<name> --help` / `<name> -h` for commands without their own. */
function manPage(name: string) {
  const cmd = commands[name]
  return `${c('bold', name.toUpperCase())}\n  ${name} - ${cmd.desc}\n\n${c('bold', 'USAGE')}\n  ${cmd.usage ?? name}`
}

/** Commands that print their own help for --help and -h. */
const OWN_HELP = new Set(['curl', 'git', 'pepper'])
/** Commands where -h means something else (human-readable sizes); --help still works. */
const H_IS_A_FLAG = new Set(['df', 'free'])

const asksHelp = (name: string, args: string[]) => !OWN_HELP.has(name) && (args[0] === '--help' || (args[0] === '-h' && !H_IS_A_FLAG.has(name)))

// Scratch space: the only writable part of the filesystem, so `echo hi > /tmp/x` works.
const tmp = () => lookup('/tmp') as DirNode

function flags(args: string[]) {
  const set = new Set<string>()
  const rest: string[] = []
  for (const a of args) {
    if (/^-[a-zA-Z]+$/.test(a)) for (const ch of a.slice(1)) set.add(ch)
    else rest.push(a)
  }
  return { has: (f: string) => set.has(f), rest }
}

function readFile(ctx: Ctx, path: string, cmd: string): string {
  const abs = resolvePath(ctx.cwd, path)
  const node = lookup(abs)
  if (!node) throw new CmdError(`${cmd}: ${path}: No such file or directory`)
  if (node.type === 'dir') throw new CmdError(`${cmd}: ${path}: Is a directory`)
  return node.content()
}

/** Input text for filters: stdin from a pipe, or the named files. */
function input(ctx: Ctx, files: string[], cmd: string): string {
  if (files.length) return files.map((f) => readFile(ctx, f, cmd)).join('\n')
  if (ctx.stdin !== null) return ctx.stdin
  throw new CmdError(`${cmd}: missing file operand`)
}

const lines = (s: string) => (s === '' ? [] : s.replace(/\n$/, '').split('\n'))

function colorName(node: Node) {
  if (node.type === 'dir') return c('blue', node.name + '/')
  if (node.name.endsWith('.url')) return c('cyan', node.name)
  if (node.name.startsWith('.')) return c('muted', node.name)
  return node.name
}

function treeLines(node: DirNode, prefix = ''): string[] {
  const kids = [...node.children.values()].filter((n) => !n.name.startsWith('.'))
  return kids.flatMap((k, i) => {
    const last = i === kids.length - 1
    const line = `${prefix}${last ? '└── ' : '├── '}${colorName(k)}`
    return k.type === 'dir' ? [line, ...treeLines(k, prefix + (last ? '    ' : '│   '))] : [line]
  })
}

function fmtUptime() {
  const { years, days } = age()
  return `${years} years, ${days} day${days === 1 ? '' : 's'}`
}

const LOGO = ['', '  __  __ ', ' |  \\/  |', ' | |\\/| |', ' | |  | |', ' |_|  |_|', '', '  MvL OS']

export function fastfetch(ctx: Pick<Ctx, 'windows'>) {
  const ua = navigator.userAgent
  const browser = /Firefox\/(\d+)/.exec(ua)?.[0].replace('/', ' ') ?? /Edg\/(\d+)/.exec(ua)?.[0].replace('Edg/', 'Edge ') ?? /Chrome\/(\d+)/.exec(ua)?.[0].replace('/', ' ') ?? /Version\/(\d+).*Safari/.exec(ua)?.[1].replace(/^/, 'Safari ') ?? 'a browser'
  const info = [
    `${c('accent', profile.handle)}@${c('accent', 'mvlos')}`,
    c('muted', '─'.repeat(16)),
    `${c('accent', 'OS')}        MvL OS ${VERSION} (${browser})`,
    `${c('accent', 'Host')}      ${location.host || 'localhost'}`,
    `${c('accent', 'Uptime')}    ${fmtUptime()}`,
    `${c('accent', 'Shell')}     msh 1.0`,
    `${c('accent', 'Display')}   ${window.innerWidth}x${window.innerHeight}`,
    `${c('accent', 'WM')}        react-wm (${ctx.windows.length} windows)`,
    `${c('accent', 'Role')}      ${profile.role} @ ${profile.company}`,
    `${c('accent', 'Langs')}     ${profile.favourites.languages.join(', ')}`,
    `${c('accent', 'Distro')}    ${profile.favourites.platform}`,
    '',
    ['red', 'yellow', 'green', 'cyan', 'blue', 'magenta'].map((k) => c(k, '███')).join(''),
  ]
  // Phones are ~40 columns wide: drop the logo column and the longest lines so nothing wraps.
  if (window.innerWidth < 720) return info.filter((_, i) => ![3, 4, 6].includes(i)).join('\n')
  return info.map((l, i) => c('accent', (LOGO[i] ?? ' '.repeat(16)).padEnd(17)) + l).join('\n')
}

const FORTUNES = [
  'It works on my machine. Ship the machine.',
  'There is no cloud, just someone else\'s computer.',
  'YAML is a configuration language in the same way a minefield is a park.',
  'The best time to write tests was before the outage. The second best time is now.',
  'A deterministic deploy is a boring deploy, and boring is the goal.',
  'rm -rf is a lifestyle choice, not a cleanup strategy.',
  'Every sufficiently old cron job becomes load-bearing.',
  'DNS. It was DNS.',
]

function cowsay(text: string) {
  const t = text || 'moo'
  const width = Math.min(40, Math.max(...t.split('\n').map((l) => l.length)))
  const wrapped = t.match(new RegExp(`.{1,${width}}(\\s|$)`, 'g'))?.map((s) => s.trim()) ?? [t]
  const w = Math.max(...wrapped.map((l) => l.length))
  const body = wrapped.length === 1 ? [`< ${wrapped[0]} >`] : wrapped.map((l, i) => `${i === 0 ? '/' : i === wrapped.length - 1 ? '\\' : '|'} ${l.padEnd(w)} ${i === 0 ? '\\' : i === wrapped.length - 1 ? '/' : '|'}`)
  return [` ${'_'.repeat(w + 2)}`, ...body, ` ${'-'.repeat(w + 2)}`, '        \\   ^__^', '         \\  (oo)\\_______', '            (__)\\       )\\/\\', '                ||----w |', '                ||     ||'].join('\n')
}

const KIND_ICON: Record<string, string> = { push: '↑', pr: '⇄', merge: '⑂', issue: '◎', release: '★', create: '+', star: '☆', comment: '…', fork: '⑂' }

export const commands: Record<string, Command> = {
  help: {
    desc: 'list commands',
    run: () => {
      const groups: [string, string[]][] = [
        ['Explore', ['ls', 'cd', 'pwd', 'cat', 'tree', 'find', 'open', 'go', 'files']],
        ['About me', ['whoami', 'cv', 'projects', 'pepper', 'contribs', 'recent', 'git', 'heatmap', 'stars', 'contact']],
        ['Text', ['grep', 'head', 'tail', 'wc', 'sort', 'uniq', 'echo', 'calc', 'jq', 'sha256sum', 'md5sum']],
        ['Network', ['curl', 'wget', 'whois', 'ping', 'dig', 'host', 'nslookup', 'minecraft']],
        ['Device', ['htop', 'df', 'free', 'nproc', 'lscpu', 'xrandr', 'ip', 'watch']],
        ['System', ['keys', 'ps', 'kill', 'uname', 'uptime', 'date', 'cal', 'history', 'env', 'export', 'theme', 'tty', 'reboot', 'shutdown', 'clear', 'exit']],
        ['Fun', ['games', 'fastfetch', 'fortune', 'cowsay', 'figlet', 'lolcat', 'cmatrix', 'sl', 'sudo']],
      ]
      return [
        ...groups.map(([g, cmds]) => `${c('accent', g.padEnd(9))} ${cmds.map((n) => c('green', n)).join('  ')}`),
        '',
        `Pipes work: ${c('cyan', 'cat cv.md | grep -i go')}   Writes go to /tmp: ${c('cyan', 'echo hi > /tmp/x')}`,
        `${c('muted', 'Tab completes, ↑/↓ walks history, Ctrl+L clears, `man <cmd>` explains one.')}`,
      ].join('\n')
    },
  },
  man: {
    desc: 'explain a command',
    usage: 'man <command>',
    run: ({ args }) => {
      if (!args[0]) throw new CmdError('What manual page do you want?')
      if (!commands[args[0]]) throw new CmdError(`No manual entry for ${args[0]}`)
      return manPage(args[0])
    },
  },
  ls: {
    desc: 'list directory contents',
    usage: 'ls [-a] [-l] [path]',
    run: (ctx) => {
      const f = flags(ctx.args)
      const target = f.rest[0] ?? '.'
      const abs = resolvePath(ctx.cwd, target)
      const node = lookup(abs)
      if (!node) throw new CmdError(`ls: cannot access '${target}': No such file or directory`)
      if (node.type === 'file') return colorName(node)
      const kids = [...node.children.values()].filter((n) => f.has('a') || !n.name.startsWith('.'))
      if (!f.has('l')) return kids.map(colorName).join('  ')
      return kids
        .map((k) => {
          const size = k.type === 'file' ? k.content().length : 4096
          return `${k.type === 'dir' ? 'dr-xr-xr-x' : '-r--r--r--'}  ${profile.handle}  ${String(size).padStart(5)}  ${colorName(k)}`
        })
        .join('\n')
    },
  },
  ll: { desc: 'alias for ls -la', hidden: true, run: (ctx) => commands.ls.run({ ...ctx, args: ['-la', ...ctx.args] }) },
  cd: {
    desc: 'change directory',
    usage: 'cd [path]',
    run: (ctx) => {
      const target = ctx.args[0] === '-' ? ctx.env.OLDPWD || HOME : ctx.args[0] ?? '~'
      const abs = resolvePath(ctx.cwd, target)
      const node = lookup(abs)
      if (!node) throw new CmdError(`cd: ${target}: No such file or directory`)
      if (node.type !== 'dir') throw new CmdError(`cd: ${target}: Not a directory`)
      ctx.env.OLDPWD = ctx.cwd
      ctx.setCwd(abs)
    },
  },
  pwd: { desc: 'print working directory', run: (ctx) => ctx.cwd },
  cat: {
    desc: 'print files',
    usage: 'cat <file>...',
    run: (ctx) => input(ctx, ctx.args, 'cat'),
  },
  less: { desc: 'alias for cat (no pager here)', hidden: true, run: (ctx) => commands.cat.run(ctx) },
  more: { desc: 'alias for cat', hidden: true, run: (ctx) => commands.cat.run(ctx) },
  bat: { desc: 'alias for cat', hidden: true, run: (ctx) => commands.cat.run(ctx) },
  head: {
    desc: 'first lines of input',
    usage: 'head [-n N] [file]',
    run: (ctx) => {
      let n = 10
      const files: string[] = []
      for (let i = 0; i < ctx.args.length; i++) {
        const a = ctx.args[i]
        if (a === '-n') n = parseInt(ctx.args[++i], 10)
        else if (/^-\d+$/.test(a)) n = parseInt(a.slice(1), 10)
        else files.push(a)
      }
      return lines(input(ctx, files, 'head')).slice(0, n).join('\n')
    },
  },
  tail: {
    desc: 'last lines of input',
    usage: 'tail [-n N] [file]',
    run: (ctx) => {
      let n = 10
      const files: string[] = []
      for (let i = 0; i < ctx.args.length; i++) {
        const a = ctx.args[i]
        if (a === '-n') n = parseInt(ctx.args[++i], 10)
        else if (/^-\d+$/.test(a)) n = parseInt(a.slice(1), 10)
        else files.push(a)
      }
      return lines(input(ctx, files, 'tail')).slice(-n).join('\n')
    },
  },
  wc: {
    desc: 'count lines, words, bytes',
    usage: 'wc [-l|-w|-c] [file]',
    run: (ctx) => {
      const f = flags(ctx.args)
      const text = input(ctx, f.rest, 'wc')
      const counts = { l: lines(text).length, w: text.split(/\s+/).filter(Boolean).length, c: new TextEncoder().encode(text).length }
      const picked = (['l', 'w', 'c'] as const).filter((k) => f.has(k))
      return (picked.length ? picked : (['l', 'w', 'c'] as const)).map((k) => String(counts[k]).padStart(6)).join(' ')
    },
  },
  grep: {
    desc: 'search text',
    usage: 'grep [-i] [-n] [-v] [-c] [-r] <pattern> [file|dir]',
    run: (ctx) => {
      const f = flags(ctx.args)
      const [pattern, ...files] = f.rest
      if (pattern === undefined) throw new CmdError('usage: grep [-i] [-n] [-v] [-r] <pattern> [file]')
      let re: RegExp
      try {
        re = new RegExp(pattern, f.has('i') ? 'i' : '')
      } catch {
        throw new CmdError(`grep: invalid pattern '${pattern}'`)
      }
      const hi = (l: string) => (f.has('v') ? l : l.replace(new RegExp(re.source, re.flags + 'g'), (m) => c('red', m)))
      const match = (l: string) => re.test(l) !== f.has('v')

      if (f.has('r') || files.some((p) => lookup(resolvePath(ctx.cwd, p))?.type === 'dir')) {
        const roots = files.length ? files : ['.']
        const out: string[] = []
        for (const r of roots) {
          for (const path of walk(resolvePath(ctx.cwd, r))) {
            const node = lookup(path)
            if (node?.type !== 'file') continue
            lines(node.content()).forEach((l, i) => {
              if (match(l)) out.push(`${c('magenta', prettyPath(path))}:${f.has('n') ? c('green', String(i + 1)) + ':' : ''}${hi(l)}`)
            })
          }
        }
        return out.join('\n')
      }
      const hits = lines(input(ctx, files, 'grep'))
        .map((l, i) => ({ l, i }))
        .filter(({ l }) => match(l))
      if (f.has('c')) return String(hits.length)
      return hits
        .map(({ l, i }) => (f.has('n') ? `${c('green', String(i + 1))}:` : '') + hi(l))
        .join('\n')
    },
  },
  sort: {
    desc: 'sort lines',
    usage: 'sort [-r] [-n] [file]',
    run: (ctx) => {
      const f = flags(ctx.args)
      const out = lines(input(ctx, f.rest, 'sort')).sort((a, b) => (f.has('n') ? parseFloat(a) - parseFloat(b) : a.localeCompare(b)))
      return (f.has('r') ? out.reverse() : out).join('\n')
    },
  },
  uniq: {
    desc: 'drop repeated adjacent lines',
    usage: 'uniq [-c] [file]',
    run: (ctx) => {
      const f = flags(ctx.args)
      const out: { l: string; n: number }[] = []
      for (const l of lines(input(ctx, f.rest, 'uniq'))) {
        if (out.length && out[out.length - 1].l === l) out[out.length - 1].n++
        else out.push({ l, n: 1 })
      }
      return out.map(({ l, n }) => (f.has('c') ? `${String(n).padStart(4)} ${l}` : l)).join('\n')
    },
  },
  tree: {
    desc: 'show directory tree',
    usage: 'tree [path]',
    run: (ctx) => {
      const abs = resolvePath(ctx.cwd, ctx.args[0] ?? '.')
      const node = lookup(abs)
      if (!node || node.type !== 'dir') throw new CmdError(`tree: ${ctx.args[0] ?? '.'}: not a directory`)
      return [c('blue', prettyPath(abs)), ...treeLines(node)].join('\n')
    },
  },
  find: {
    desc: 'find files by name',
    usage: 'find [path] [-name pattern]',
    run: (ctx) => {
      const nameIdx = ctx.args.indexOf('-name')
      const pattern = nameIdx >= 0 ? ctx.args[nameIdx + 1] : null
      const start = ctx.args.find((a, i) => !a.startsWith('-') && i !== nameIdx + 1) ?? '.'
      const abs = resolvePath(ctx.cwd, start)
      if (!lookup(abs)) throw new CmdError(`find: '${start}': No such file or directory`)
      const re = pattern ? new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$') : null
      return walk(abs)
        .filter((p) => !re || re.test(p.split('/').pop() ?? ''))
        .map((p) => (start.startsWith('/') ? p : './' + p.slice(abs.length + 1)).replace(/^\.\/$/, '.'))
        .join('\n')
    },
  },
  echo: { desc: 'print arguments', usage: 'echo [text]', run: ({ args }) => args.join(' ') },
  touch: {
    desc: 'create an empty file (in /tmp)',
    usage: 'touch /tmp/<name>',
    run: (ctx) => {
      for (const a of ctx.args) writeTmp(ctx.cwd, a, '', true)
    },
  },
  mkdir: {
    desc: 'not here',
    hidden: true,
    run: () => {
      throw new CmdError('mkdir: /tmp is flat on purpose; files only')
    },
  },
  rm: {
    desc: 'remove files (only in /tmp)',
    usage: 'rm /tmp/<name>',
    run: (ctx) => {
      const f = flags(ctx.args)
      if (f.has('r') && f.has('f')) return `${c('yellow', 'Nice try.')} The only thing getting deleted today is your expectations.`
      for (const a of f.rest) {
        const abs = resolvePath(ctx.cwd, a)
        if (!abs.startsWith('/tmp/')) throw new CmdError(`rm: cannot remove '${a}': Read-only file system`)
        if (!tmp().children.delete(abs.slice(5))) throw new CmdError(`rm: cannot remove '${a}': No such file or directory`)
      }
    },
  },
  whoami: {
    desc: 'who is this',
    run: () =>
      [
        c('accent', profile.name),
        `${profile.role} @ ${profile.company}`,
        '',
        profile.summary,
        '',
        `Run ${c('green', 'cv')} for the full picture or ${c('green', 'projects')} for the fun part.`,
      ].join('\n'),
  },
  id: { desc: 'user identity', hidden: true, run: () => `uid=1000(${profile.handle}) gid=1000(${profile.handle}) groups=1000(${profile.handle}),998(wheel),27(devops),42(omarchy)` },
  hostname: { desc: 'print hostname', hidden: true, run: () => 'mvlos' },
  uname: {
    desc: 'system info',
    usage: 'uname [-a]',
    run: ({ args }) => (args.includes('-a') ? `MvL OS mvlos ${VERSION}-menno #1 SMP PREEMPT_DYNAMIC ${new Date(BUILT).toUTCString()} wasm32 GNU/React` : 'MvL OS'),
  },
  date: { desc: 'current date and time', run: () => new Date().toString() },
  uptime: {
    desc: 'how long I have been running',
    run: () => `${new Date().toTimeString().slice(0, 8)} up ${fmtUptime()},  1 user,  load average: coffee, coffee, coffee`,
  },
  history: { desc: 'command history', run: ({ history }) => history.map((h, i) => `${String(i + 1).padStart(4)}  ${h}`).join('\n') },
  env: { desc: 'environment variables', run: ({ env }) => Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') },
  export: {
    desc: 'set an environment variable',
    usage: 'export NAME=value',
    run: (ctx) => {
      for (const a of ctx.args) {
        const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(a)
        if (!m) throw new CmdError(`export: '${a}': not a valid identifier`)
        ctx.env[m[1]] = m[2]
      }
    },
  },
  which: {
    desc: 'locate a command',
    usage: 'which <command>',
    run: ({ args }) => args.map((a) => (commands[a] ? `/bin/${a}` : `${a} not found`)).join('\n'),
  },
  clear: { desc: 'clear the screen', run: (ctx) => ctx.clear() },
  exit: { desc: 'close this terminal', run: (ctx) => void ctx.exit() },
  logout: { desc: 'alias for exit', hidden: true, run: (ctx) => void ctx.exit() },
  tty: { desc: 'print the terminal name', run: (ctx) => (ctx.console ? '/dev/tty1' : '/dev/pts/0') },
  startx: {
    desc: 'start the graphical session',
    hidden: true,
    run: (ctx) => {
      if (!ctx.startx) throw new CmdError('startx: a graphical session is already running on :0')
      ctx.startx()
    },
  },
  open: {
    desc: 'open an app, file or URL',
    usage: 'open [-n] <app|file|url>   (-n opens a new window)',
    run: (ctx) => {
      if (ctx.args[0] === '-n') {
        const app = APPS[ctx.args[1] ?? '']
        if (!app) throw new CmdError(`open: -n needs an app name: ${Object.keys(APPS).join(', ')}`)
        ctx.openNewApp(app)
        return
      }
      const target = ctx.args[0]
      if (!target) return `usage: open <app|file|url>\napps: ${Object.keys(APPS).filter((k, i, a) => a.findIndex((x) => APPS[x] === APPS[k]) === i).join(', ')}`
      if (/^https?:\/\//i.test(target)) {
        openLink(target)
        return `Opening ${link(target)}`
      }
      if (APPS[target]) {
        ctx.openApp(APPS[target])
        return
      }
      const slug = target.replace(/\/$/, '').split('/').pop() ?? ''
      const abs = resolvePath(ctx.cwd, target)
      const node = lookup(abs)
      if (node?.type === 'file' && node.open) {
        if (node.open.url) {
          openLink(node.open.url)
          return `Opening ${link(node.open.url)}`
        }
        if (node.open.app) ctx.openApp(node.open.app as AppId, node.open.props)
        return
      }
      if (node?.type === 'dir') {
        ctx.openNewApp('files', { path: abs })
        return
      }
      if ([...projects, ...contributions].some((p) => p.slug === slug)) {
        ctx.openApp('projects', { slug })
        return
      }
      if (node?.type === 'file') {
        if (fileKind(node) === 'markdown') ctx.openApp('zed', { path: abs, view: 'preview', t: String(Date.now()) })
        else ctx.openNewApp('viewer', { path: abs })
        return
      }
      // Last, so files like README.md still open as files.
      const url = asWebAddress(target)
      if (url) {
        openLink(url)
        return `Opening ${link(url)}`
      }
      throw new CmdError(`open: ${target}: no app, file or URL by that name`)
    },
  },
  'xdg-open': { desc: 'alias for open', hidden: true, run: (ctx) => commands.open.run(ctx) },
  go: {
    desc: 'follow a go link through your golinks account',
    usage: 'go <alias>   |   go set <search url | token>   |   go unset   (go -- set follows an alias named set; Tab after go lists your aliases)',
    run: ({ args }) => {
      const template = golinksTemplate()
      const where = signedIn() ? 'synced to your account' : 'saved in this browser'
      if (args[0] === 'set') {
        const next = parseGolinks(args.slice(1))
        if (!next)
          throw new CmdError('go set: expected your golinks search URL, e.g. https://mvl.sh/r/%s?token=… (or a site and a token, or just a token for mvl.sh)')
        setGolinks(next)
        return `${c('green', '✓')} golinks account ${where}: ${maskGolinks(next)}\nTry ${c('cyan', 'go <alias>')}.`
      }
      if (args[0] === 'unset') {
        if (!template) return 'No golinks account set.'
        setGolinks(null)
        return `${c('green', '✓')} golinks account removed.`
      }
      const alias = (args[0] === '--' ? args.slice(1) : args).join(' ').trim()
      if (!alias) {
        if (!template)
          return [
            `No golinks account set. Make a token on ${link('https://mvl.sh/tokens')} (or your own ${link('https://git.mvl.sh/vleeuwenmenno/golinks', 'golinks')}),`,
            `then paste its search URL: ${c('cyan', 'go set https://mvl.sh/r/%s?token=…')}`,
          ].join('\n')
        return [`Account: ${maskGolinks(template)} ${c('muted', `(${where})`)}`, `Aliases: ${link(`${golinksSite(template)}/aliases`)}`, `usage: ${commands.go.usage}`].join('\n')
      }
      if (!template) throw new CmdError('go: no golinks account set. Run `go` to see how.')
      const url = golinksUrl(template, alias)
      openLink(url)
      return `Opening ${link(url, `${golinksSite(template)}/r/${encodeURIComponent(alias)}`)}`
    },
  },
  cv: {
    desc: 'open my CV',
    run: (ctx) => {
      ctx.openApp('cv')
      return `Opened ${c('accent', 'cv-viewer')}. Prefer text? ${c('green', 'cat ~/cv.md')}`
    },
  },
  projects: {
    desc: 'list my projects',
    usage: 'projects [name]',
    run: (ctx) => {
      if (ctx.args[0]) return commands.open.run({ ...ctx, args: [ctx.args[0]] })
      return [
        ...projects.map((p) => `${c('accent', p.name.padEnd(12))} ${p.tagline}\n${' '.repeat(13)}${c('muted', p.stack.join(' · '))}  ${link(p.url ?? p.repo ?? '', (p.url ?? p.repo ?? '').replace(/^https:\/\//, ''))}`),
        '',
        c('muted', `open <name> for details, e.g. ${c('green', 'open boltwarden')}`),
      ].join('\n')
    },
  },
  contribs: {
    desc: 'open source I contribute to',
    run: () =>
      [
        ...contributions.map((x) => `${c('accent', `${x.owner}/${x.slug}`)}\n  ${x.description}\n${x.work.map((w) => `  ${c('green', '+')} ${w}`).join('\n')}\n  ${link(x.repo)}`),
      ].join('\n\n'),
  },
  contributions: { desc: 'alias for contribs', hidden: true, run: (ctx) => commands.contribs.run(ctx) },
  recent: {
    desc: 'latest activity from GitHub and git.mvl.sh',
    usage: 'recent [count] [repo-filter]',
    run: async (ctx) => {
      const n = parseInt(ctx.args.find((a) => /^\d+$/.test(a)) ?? '12', 10)
      const filter = ctx.args.find((a) => !/^\d+$/.test(a))?.toLowerCase()
      const s = await loadRecents()
      const items = s.items.filter((i) => !filter || i.repo.toLowerCase().includes(filter)).slice(0, n)
      if (!items.length) return s.status === 'error' ? c('red', `recent: could not reach GitHub (${s.error})`) : 'Nothing recent. Suspicious.'
      return items
        .map((i) => `${c('muted', timeAgo(i.date).padStart(8))}  ${c('yellow', KIND_ICON[i.kind] ?? '·')} ${c('cyan', i.repo.split('/')[1])}  ${link(i.url, i.title)}${i.detail ? c('muted', ` · ${i.detail}`) : ''}`)
        .join('\n')
    },
  },
  stars: {
    desc: 'live GitHub stars',
    run: async () => {
      const repos = [...projects.filter((p) => p.github).map((p) => p.github!), ...contributions.map((x) => x.github)]
      const counts = await Promise.all(repos.map(fetchStars))
      return repos.map((r, i) => `${c('yellow', '★')} ${String(counts[i] ?? '?').padStart(4)}  ${link(`https://github.com/${r}`, r)}`).join('\n')
    },
  },
  contact: {
    desc: 'how to reach me',
    run: (ctx) => {
      ctx.openApp('contact')
      const address = revealEmail()
      return [`${c('accent', 'email')}     ${link(`mailto:${address}`, address)}`, ...profile.links.map((l) => `${c('accent', l.label.toLowerCase().padEnd(10))}${link(l.url)}`)].join('\n')
    },
  },
  ps: {
    desc: 'running windows',
    run: ({ windows }) =>
      [
        c('muted', '  PID  STATE   TIME   COMMAND'),
        ...windows
          .slice()
          .sort((a, b) => a.pid - b.pid)
          .map((w) => {
            const secs = Math.floor((Date.now() - w.openedAt) / 1000)
            return `${String(w.pid).padStart(5)}  ${(w.minimized ? 'S' : 'R').padEnd(6)}  ${`${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`.padStart(5)}  ${APP_NAMES[w.app]}`
          }),
      ].join('\n'),
  },
  kill: {
    desc: 'close a window by pid',
    usage: 'kill <pid>',
    run: (ctx) => {
      const pids = ctx.args.filter((a) => !a.startsWith('-'))
      if (!pids.length) throw new CmdError('usage: kill <pid>  (see `ps`)')
      for (const p of pids) {
        const pid = parseInt(p, 10)
        if (pid === 1) throw new CmdError('kill: (1) - Operation not permitted. init is load-bearing.')
        if (!ctx.windows.some((w) => w.pid === pid)) throw new CmdError(`kill: (${p}) - No such process`)
        ctx.closeWindow(pid)
      }
    },
  },
  killall: { desc: 'kill everything', hidden: true, run: () => c('yellow', 'killall: refusing to end the world without a ticket.') },
  theme: {
    desc: 'Omarchy theme, day/night mode and accent',
    usage: 'theme [light|dark|auto] | theme list | theme <omarchy-theme> | theme accent <name|theme>',
    run: (ctx) => {
      const [a, b] = ctx.args
      const s = themeSettings()
      if (!a)
        return [
          `${c('accent', themeLabel(s.name))} ${c('muted', `(${s.mode} mode · day ${s.light} · night ${s.dark}${s.accent ? ` · accent ${s.accent}` : ''})`)}`,
          `usage: ${commands.theme.usage}`,
        ].join('\n')
      if (a === 'list')
        return Object.keys(OMARCHY_THEMES)
          .map((t) => `${t === s.name ? c('accent', '●') : ' '} ${t.padEnd(18)} ${c('muted', OMARCHY_THEMES[t].mode)}`)
          .join('\n')
      if (a === 'light' || a === 'dark' || a === 'auto') {
        setMode(a)
        return `Mode: ${c('accent', a)} (${themeLabel(themeSettings().name)})`
      }
      if (a === 'accent') {
        if (!b || !ctx.setAccent(b)) throw new CmdError(`theme: accent must be one of: theme, ${Object.keys(ACCENTS).join(', ')}`)
        return `Accent: ${c('accent', b)}`
      }
      if (OMARCHY_THEMES[a]) {
        setTheme(a)
        return `Theme: ${c('accent', themeLabel(a))}`
      }
      // Older habit: `theme pink` meant the accent.
      if (ACCENTS[a] && ctx.setAccent(a)) return `Accent: ${c('accent', a)}`
      throw new CmdError(`theme: unknown theme '${a}' (try \`theme list\`)`)
    },
  },
  fastfetch: { desc: 'system summary', run: (ctx) => fastfetch(ctx) },
  neofetch: { desc: 'alias for fastfetch', hidden: true, run: (ctx) => fastfetch(ctx) },
  fortune: { desc: 'ops wisdom', run: () => FORTUNES[Math.floor(Math.random() * FORTUNES.length)] },
  cowsay: { desc: 'a cow says things', usage: 'cowsay [text]', run: (ctx) => cowsay(ctx.args.length ? ctx.args.join(' ') : ctx.stdin?.trim() || FORTUNES[Math.floor(Math.random() * FORTUNES.length)]) },
  sl: {
    desc: 'you meant ls',
    // Rendered by SlTrain in the terminal; piping it gives nothing, like the real thing.
    run: () => '{anim:sl}{/}',
  },
  sudo: {
    desc: 'become root',
    run: ({ args }) => {
      if (args.join(' ').startsWith('rm')) return `${c('red', 'sudo:')} absolutely not.`
      if (args[0] === 'make' && args.slice(1).join(' ') === 'me a sandwich') return 'Okay.'
      return `[sudo] password for ${profile.handle}: \n${c('red', `${profile.handle} is not in the sudoers file. This incident will be reported.`)}`
    },
  },
  su: { desc: 'switch user', hidden: true, run: () => c('red', 'su: Authentication failure (there is no root here, only vibes)') },
  vim: { desc: 'editor', hidden: true, run: () => 'You are now trapped in vim. Just kidding: this filesystem is read-only. Type :q anyway, it helps.' },
  nvim: { desc: 'editor', hidden: true, run: (ctx) => commands.vim.run(ctx) },
  nano: { desc: 'editor', hidden: true, run: () => 'nano: read-only filesystem. Try `echo text > /tmp/notes`.' },
  emacs: { desc: 'operating system', hidden: true, run: () => 'emacs: you already have an operating system open.' },
  ':q': { desc: 'quit vim', hidden: true, run: () => 'Freedom.' },
  ssh: { desc: 'no', hidden: true, run: () => c('yellow', 'ssh: you are already inside the only machine here.') },
  ping: {
    desc: 'time HTTPS round trips to a host',
    usage: 'ping [-c count] <host>',
    run: (ctx) => ping(ctx),
  },
  dig: {
    desc: 'DNS lookup (over HTTPS)',
    usage: 'dig [@server] [type] <name> [+short]   (type and name in any order)',
    run: async (ctx) => {
      const short = ctx.args.includes('+short')
      const { name, type, server } = dnsArgs(ctx.args.filter((a) => a !== '+short'), 'dig')
      const prefer = server ? resolverFor(server) : null
      const r = await resolve(name, type, ctx.signal, prefer)
      if (short) return r.answers.filter((a) => a.type === type).map((a) => a.data).join('\n')
      return [
        c('muted', `; <<>> DiG over HTTPS <<>> ${server ? `@${server} ` : ''}${name} ${type}`),
        ...(server && !prefer ? [c('yellow', `;; a browser can only reach DNS-over-HTTPS resolvers, so ${server} was not asked`)] : []),
        `;; status: ${r.status === 'NOERROR' ? c('green', r.status) : c('red', r.status)}, via ${r.resolver} in ${r.ms.toFixed(0)} ms`,
        '',
        ';; ANSWER SECTION:',
        ...(r.answers.length ? r.answers.map((a) => `${(a.name + '.').padEnd(28)} ${String(a.ttl).padStart(6)}  IN  ${c('yellow', a.type.padEnd(5))} ${a.data}`) : [c('muted', ';; (no records)')]),
      ].join('\n')
    },
  },
  host: {
    desc: 'DNS lookup, short form',
    usage: 'host <name> [type]',
    run: async (ctx) => {
      const { name, type: explicit, typeGiven, server } = dnsArgs(ctx.args, 'host')
      const types = typeGiven ? [explicit] : ['A', 'AAAA', 'MX']
      const prefer = server ? resolverFor(server) : null
      const results = await Promise.all(types.map((t) => resolve(name, t, ctx.signal, prefer)))
      if (results[0].status === 'NXDOMAIN') throw new CmdError(`Host ${name} not found: 3(NXDOMAIN)`)
      const verb: Record<string, string> = { A: 'has address', AAAA: 'has IPv6 address', MX: 'mail is handled by', CNAME: 'is an alias for', NS: 'name server', TXT: 'descriptive text' }
      const out = results.flatMap((r, i) => r.answers.filter((a) => a.type === types[i] || a.type === 'CNAME').map((a) => `${a.name} ${verb[a.type] ?? `has ${a.type} record`} ${a.data}`))
      return [...new Set(out)].join('\n') || `${name} has no ${types.join('/')} record`
    },
  },
  nslookup: {
    desc: 'DNS lookup, nslookup style',
    usage: 'nslookup <name>',
    run: async (ctx) => {
      const { name } = dnsArgs(ctx.args, 'nslookup')
      const [a, aaaa] = await Promise.all([resolve(name, 'A', ctx.signal), resolve(name, 'AAAA', ctx.signal)])
      if (a.status === 'NXDOMAIN') throw new CmdError(`** server can't find ${name}: NXDOMAIN`)
      const addrs = [...a.answers, ...aaaa.answers].filter((x) => x.type === 'A' || x.type === 'AAAA')
      return [`Server:\t\t${a.resolver}`, '', 'Non-authoritative answer:', ...addrs.flatMap((x) => [`Name:\t${x.name}`, `Address: ${x.data}`])].join('\n')
    },
  },
  cal: {
    desc: 'show a calendar',
    usage: 'cal [month] [year]',
    run: ({ args }) => {
      const now = new Date()
      const month = args[0] ? parseInt(args[0], 10) - 1 : now.getMonth()
      const year = args[1] ? parseInt(args[1], 10) : now.getFullYear()
      if (!(month >= 0 && month < 12) || !(year > 0 && year < 10000)) throw new CmdError('cal: usage: cal [month 1-12] [year]')
      const first = new Date(year, month, 1)
      const days = new Date(year, month + 1, 0).getDate()
      const title = first.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
      const cells = [...Array((first.getDay() + 6) % 7).fill('  '), ...Array.from({ length: days }, (_, i) => {
        const d = String(i + 1).padStart(2)
        const isToday = year === now.getFullYear() && month === now.getMonth() && i + 1 === now.getDate()
        const isBday = month === 8 && i + 1 === 19
        return isToday ? `{c:accent}${d}{/}` : isBday ? `{c:magenta}${d}{/}` : d
      })]
      const rows: string[] = []
      for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7).join(' '))
      return [' '.repeat(Math.max(0, Math.floor((20 - title.length) / 2))) + title, c('muted', 'Mo Tu We Th Fr Sa Su'), ...rows].join('\n')
    },
  },
  minecraft: {
    desc: 'status of my Minecraft server',
    run: async () => {
      const { status, error } = await fetchMinecraft(true)
      if (!status) throw new CmdError(`minecraft: could not reach the status API (${error})`)
      if (!status.online) return `${c('red', '●')} ${MC_ADDRESS} is offline right now.`
      return [
        `${c('green', '●')} ${c('bold', status.motd || MC_ADDRESS)}`,
        `  address  ${c('green', MC_ADDRESS)}`,
        `  version  Java ${status.version ?? '?'}`,
        `  players  ${status.players.online}/${status.players.max}${status.players.list.length ? `: ${status.players.list.join(', ')}` : c('muted', ' (nobody mining right now)')}`,
        c('muted', `  history  open mcserver`),
      ].join('\n')
    },
  },
  mc: { desc: 'alias for minecraft', hidden: true, run: (ctx) => commands.minecraft.run(ctx) },
  heatmap: {
    desc: 'contribution graph, GitHub + git.mvl.sh',
    usage: 'heatmap [github|forgejo]',
    run: async ({ args }) => {
      const data = await loadContributions()
      if (!data?.days.length) throw new CmdError('heatmap: no contribution data (run `pnpm data` when building)')
      const source = args[0] === 'github' ? 'github' : args[0] === 'forgejo' || args[0] === 'gitea' ? 'forgejo' : 'all'
      const level = levels(data.days, source)
      // Fit the terminal: one column per week, newest on the right.
      const weeksWanted = Math.max(8, Math.min(53, Math.floor((window.innerWidth < 720 ? 300 : 640) / 9) - 5))
      const allWeeks: (typeof data.days)[] = []
      for (const d of data.days) {
        if (!allWeeks.length || new Date(`${d.date}T12:00:00`).getDay() === 0) allWeeks.push([])
        allWeeks[allWeeks.length - 1].push(d)
      }
      const weeks = allWeeks.slice(-weeksWanted)
      const days = weeks.flat()
      const shades = [c('muted', '·'), '{c:heat1}■{/}', '{c:heat2}■{/}', '{c:heat3}■{/}', '{c:heat4}■{/}']
      const labels = ['   ', 'Mon', '   ', 'Wed', '   ', 'Fri', '   ']
      const rows = labels.map((l, dow) => c('muted', l) + ' ' + weeks.map((w) => {
        const d = w.find((x) => new Date(`${x.date}T12:00:00`).getDay() === dow)
        return d ? shades[level(countFor(d, source))] : ' '
      }).join(''))
      const total = days.reduce((a, d) => a + countFor(d, source), 0)
      const name = source === 'github' ? 'GitHub' : source === 'forgejo' ? 'git.mvl.sh' : 'GitHub + git.mvl.sh'
      return [`${c('bold', total.toLocaleString('en-GB'))} contributions in the last ${weeks.length} weeks ${c('muted', `(${name})`)}`, '', ...rows, '', `${c('muted', 'Less')} ${shades.join(' ')} ${c('muted', 'More')}   ${c('muted', 'open activity for the full year')}`].join('\n')
    },
  },
  games: {
    desc: 'open the arcade',
    usage: 'games [tetris|pacman|minecraft|snake|minesweeper|pool|breakout]',
    run: (ctx) => {
      const game = ctx.args[0]
      if (game && !GAME_CATALOG.some((g) => g.id === game)) throw new CmdError(`games: no game called '${game}' (try ${GAME_CATALOG.map((g) => g.id).join(', ')})`)
      return launchGame(ctx, game)
    },
  },
  tetris: { desc: 'play tetris', hidden: true, run: (ctx) => commands.games.run({ ...ctx, args: ['tetris'] }) },
  pacman: { desc: 'play pac-man', hidden: true, run: (ctx) => commands.games.run({ ...ctx, args: ['pacman'] }) },
  snake: { desc: 'play snake', hidden: true, run: (ctx) => commands.games.run({ ...ctx, args: ['snake'] }) },
  minesweeper: { desc: 'play minesweeper', hidden: true, run: (ctx) => commands.games.run({ ...ctx, args: ['minesweeper'] }) },
  breakout: { desc: 'play breakout', hidden: true, run: (ctx) => commands.games.run({ ...ctx, args: ['breakout'] }) },
  pool: { desc: 'play 8-ball pool', hidden: true, run: (ctx) => commands.games.run({ ...ctx, args: ['pool'] }) },
  pepper: {
    desc: 'Pepper CLI against a simulated lab cluster',
    usage: "pepper [--local | TARGET] COMMAND   (try: pepper --help)",
    run: (ctx) => pepper(ctx),
  },
  files: {
    desc: 'open a folder in the Files app',
    usage: 'files [path]',
    run: (ctx) => {
      const abs = resolvePath(ctx.cwd, ctx.args[0] ?? '.')
      const node = lookup(abs)
      if (!node) throw new CmdError(`files: ${ctx.args[0]}: No such file or directory`)
      if (node.type === 'dir') ctx.openNewApp('files', { path: abs })
      else ctx.openNewApp('files', { path: abs.split('/').slice(0, -1).join('/') || '/', select: abs })
    },
  },
  nautilus: { desc: 'alias for files', hidden: true, run: (ctx) => commands.files.run(ctx) },
  calc: {
    desc: 'calculator with units and currencies',
    usage: "calc <expression>   e.g. calc 5 ft 11 in to cm · calc €20 + 15 USD in GBP · calc 1 TB in GiB",
    run: async ({ args, stdin }) => {
      const text = (args.length ? args.join(' ') : (stdin ?? '')).trim()
      if (!text) throw new CmdError(`usage: ${commands.calc.usage}`)
      let res = smartCalc(text)
      if (res?.kind === 'pending') res = smartCalc(text, await loadRates())
      if (!res || res.kind === 'pending') throw new CmdError(res ? 'calc: exchange rates are unavailable right now' : `calc: '${text}' is not something I can calculate`)
      if (res.kind === 'error') throw new CmdError(`calc: ${res.message}`)
      return [c('accent', res.value), ...res.alternatives.map((a) => c('muted', `= ${a}`)), ...(res.note ? [c('muted', res.note)] : [])].join('\n')
    },
  },
  units: { desc: 'alias for calc', hidden: true, run: (ctx) => commands.calc.run(ctx) },
  bc: { desc: 'alias for calc', hidden: true, run: (ctx) => commands.calc.run(ctx) },
  keys: {
    desc: 'every keyboard and mouse shortcut',
    run: (ctx) => {
      ctx.openApp('keys')
      return SHORTCUTS.map((g) => [c('accent', g.area), ...g.keys.map(([k, what]) => `  ${c('green', k.padEnd(20))} ${what}`)].join('\n')).join('\n\n')
    },
  },
  shortcuts: { desc: 'alias for keys', hidden: true, run: (ctx) => commands.keys.run(ctx) },
  shutdown: {
    desc: 'power off (-r to reboot)',
    usage: 'shutdown [-r|-h|-c] [now]',
    run: (ctx) => {
      if (ctx.args.includes('-c')) return 'No scheduled shutdown to cancel.'
      return power(ctx, ctx.args.includes('-r') ? 'reboot' : 'power off')
    },
  },
  poweroff: { desc: 'alias for shutdown', hidden: true, run: (ctx) => power(ctx, 'power off') },
  halt: { desc: 'alias for shutdown', hidden: true, run: (ctx) => power(ctx, 'power off') },
  reboot: { desc: 'restart MvL OS', run: (ctx) => power(ctx, 'reboot') },
  headlines: { desc: 'what the sticky note says', hidden: true, run: () => headlines.map((h) => `• ${h}`).join('\n') },
}

// The real-network and device tools live in extra.ts.
Object.assign(commands, extraCommands)

/** Shuts down or reboots the whole "machine" after the broadcast has had a moment on screen. */
function power(ctx: Ctx, what: 'reboot' | 'power off') {
  setTimeout(what === 'reboot' ? reboot : shutdown, 500)
  return `Broadcast message from ${profile.handle}@mvlos on ${ctx.console ? 'tty1' : 'pts/0'}:\n\nThe system will ${what} now!`
}

/**
 * Arguments the way dig, host and nslookup take them: the name and record type in either order,
 * `-t TYPE`, `-type=TYPE`, and a server as `@server` (dig) or a trailing address (host, nslookup).
 */
function dnsArgs(args: string[], cmd: string): { name: string; type: string; typeGiven: boolean; server?: string } {
  let type: string | undefined
  let server: string | undefined
  const names: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a.startsWith('@')) server = a.slice(1)
    else if (a === '-t' || a === '-q' || a === '-type') type = (args[++i] ?? '').toUpperCase()
    else if (/^-(type|query)=/i.test(a)) type = a.split('=')[1].toUpperCase()
    else if (a.startsWith('+') || a.startsWith('-')) continue
    else if (!type && a.toUpperCase() in RECORD_TYPES && !a.includes('.')) type = a.toUpperCase()
    else names.push(a)
  }
  if (type && !(type in RECORD_TYPES)) throw new CmdError(`${cmd}: unsupported record type '${type}' (try ${Object.keys(RECORD_TYPES).join(', ')})`)
  // host and nslookup take the server as a second name.
  if (cmd !== 'dig' && names.length > 1 && !server) server = names.pop()
  const name = names[0]?.replace(/^[a-z]+:\/\//i, '').replace(/[/?#:].*$/, '').replace(/\.$/, '').toLowerCase()
  if (!name) throw new CmdError(`usage: ${cmd} [@server] [type] <name>`)
  if (names.length > 1) throw new CmdError(`${cmd}: one name at a time (got ${names.join(', ')})`)
  if (!/^([a-z0-9_-]+\.)*[a-z0-9_-]+$/.test(name)) throw new CmdError(`${cmd}: '${names[0]}' is not a valid domain name`)
  return { name, type: type ?? 'A', typeGiven: !!type, server }
}

/** Resolves after `ms`, or immediately when the signal aborts (Ctrl+C). */
function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(t)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const t = setTimeout(done, ms)
    signal.addEventListener('abort', done)
  })
}

// Browsers cannot send ICMP, so ping times an HTTPS HEAD request instead. `no-cors` lets it
// reach any host: the response is opaque, but it only resolves once the server has answered.
async function ping(ctx: Ctx): Promise<string> {
  let count = 4
  let target = ''
  for (let i = 0; i < ctx.args.length; i++) {
    if (ctx.args[i] === '-c') count = parseInt(ctx.args[++i], 10)
    else target = ctx.args[i]
  }
  if (!target) throw new CmdError('usage: ping [-c count] <host>')
  if (!Number.isFinite(count) || count < 1) throw new CmdError('ping: invalid count')
  count = Math.min(count, 20)

  const host = target.replace(/^[a-z]+:\/\//i, '').replace(/[/?#].*$/, '').toLowerCase()
  if (!/^([a-z0-9-]+\.)*[a-z0-9-]+(:\d{1,5})?$/.test(host)) throw new CmdError(`ping: ${target}: Name or service not known`)
  const url = `https://${host}/`
  const hostname = host.replace(/:\d+$/, '')

  // Resolve first like real ping, so a typo fails with the real error and the header shows the IP.
  let address: string | null = /^\d+\.\d+\.\d+\.\d+$/.test(hostname) ? hostname : null
  if (!address) {
    try {
      const r = await lookupAddress(hostname, ctx.signal)
      if (!r.address) throw new CmdError(`ping: ${hostname}: ${r.status === 'NXDOMAIN' ? 'Name or service not known' : `no address (${r.status})`}`)
      address = r.address
    } catch (err) {
      if (err instanceof CmdError) throw err
      /* DNS-over-HTTPS unreachable: ping anyway and let the browser resolve */
    }
  }

  const lines: string[] = []
  const out = (l: string) => (ctx.tty ? ctx.print(l) : lines.push(l))
  const times: number[] = []
  let sent = 0
  let fastFails = 0

  out(`PING ${host}${address && address !== hostname ? ` (${address})` : ''} over HTTPS (browsers cannot send ICMP)`)
  for (let seq = 1; seq <= count && !ctx.signal.aborted; seq++) {
    sent++
    const timeout = new AbortController()
    const stop = () => timeout.abort()
    const timer = setTimeout(stop, 4000)
    ctx.signal.addEventListener('abort', stop)
    const t0 = performance.now()
    try {
      await fetch(url, { method: 'HEAD', mode: 'no-cors', cache: 'no-store', credentials: 'omit', signal: timeout.signal })
      const ms = performance.now() - t0
      times.push(ms)
      out(`reply from ${host}: seq=${seq} time=${ms.toFixed(1)} ms${seq === 1 ? c('muted', '  (includes DNS + TLS setup)') : ''}`)
    } catch {
      if (ctx.signal.aborted) break
      const ms = performance.now() - t0
      if (ms < 3990) fastFails++
      out(c('red', `no reply from ${host}: seq=${seq} ${ms >= 3990 ? 'timed out' : `connection failed after ${ms.toFixed(0)} ms`}`))
    } finally {
      clearTimeout(timer)
      ctx.signal.removeEventListener('abort', stop)
    }
    if (seq < count && !ctx.signal.aborted) await sleep(1000, ctx.signal)
  }

  if (ctx.signal.aborted) out('^C')
  const loss = sent ? Math.round(((sent - times.length) / sent) * 100) : 0
  out(`--- ${host} ping statistics ---`)
  out(`${sent} requests sent, ${times.length} replies, ${loss}% loss`)
  if (times.length) {
    const avg = times.reduce((a, b) => a + b, 0) / times.length
    out(`rtt min/avg/max = ${Math.min(...times).toFixed(1)}/${avg.toFixed(1)}/${Math.max(...times).toFixed(1)} ms`)
  }
  // A request that fails without timing out never left the browser: with a resolved address that
  // means a tracker blocker refused the host.
  if (!times.length && fastFails === sent && sent)
    out(
      c(
        'muted',
        address
          ? `${hostname} resolves to ${address}, but your browser refused every request. Tracking protection or an ad blocker is blocking it from other sites.`
          : `Every request was refused right away. Either ${host} does not exist, or your browser or an extension (tracking protection, an ad blocker) blocks it from other sites.`,
      ),
    )
  if (!times.length && sent) throw new CmdError(ctx.tty ? '' : lines.join('\n'))
  return lines.join('\n')
}

export function writeTmp(cwd: string, target: string, content: string, append: boolean) {
  const abs = resolvePath(cwd, target)
  if (!abs.startsWith('/tmp/') || abs.slice(5).includes('/')) throw new CmdError(`${target}: Read-only file system (only /tmp is writable)`)
  const name = abs.slice(5)
  const existing = tmp().children.get(name)
  const prev = existing?.type === 'file' ? existing.content() : ''
  const next = append && prev ? `${prev}\n${content}` : content
  tmp().children.set(name, { type: 'file', name, content: () => next })
}

// ---------------------------------------------------------------------------
// Parsing: quotes, $VARS, pipes, `;`/`&&`, and `>`/`>>` into /tmp.

function tokenize(line: string, env: Record<string, string>): string[] {
  const out: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  let has = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quote) {
      if (ch === quote) quote = null
      else if (ch === '$' && quote === '"') {
        const m = /^\$(\w+|\{\w+\})/.exec(line.slice(i))
        if (m) {
          cur += env[m[1].replace(/[{}]/g, '')] ?? ''
          i += m[0].length - 1
        } else cur += ch
      } else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      has = true
    } else if (/\s/.test(ch)) {
      if (cur || has) out.push(cur)
      cur = ''
      has = false
    } else if (ch === '$') {
      const m = /^\$(\w+|\{\w+\}|\?)/.exec(line.slice(i))
      if (m) {
        cur += env[m[1].replace(/[{}]/g, '')] ?? ''
        i += m[0].length - 1
        has = true
      } else cur += ch
    } else cur += ch
  }
  if (quote) throw new CmdError('msh: unterminated quote')
  if (cur || has) out.push(cur)
  return out
}

/** Splits on an unquoted separator. */
function splitTop(line: string, sep: RegExp, seps: string[] = []): string[] {
  const parts: string[] = []
  let cur = ''
  let quote: string | null = null
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quote) {
      if (ch === quote) quote = null
      cur += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      cur += ch
      continue
    }
    const m = sep.exec(line.slice(i))
    if (m && m.index === 0) {
      seps.push(m[0])
      parts.push(cur)
      cur = ''
      i += m[0].length - 1
      continue
    }
    cur += ch
  }
  parts.push(cur)
  return parts
}

export type RunResult = { output: string; ok: boolean }

type Base = Omit<Ctx, 'args' | 'stdin' | 'tty'>

export async function runLine(line: string, shell: Base): Promise<RunResult[]> {
  const results: RunResult[] = []
  // `cd a; ls` must list a, so later statements see the new cwd.
  const base: Base = {
    ...shell,
    setCwd: (p) => {
      base.cwd = p
      shell.setCwd(p)
    },
  }
  // `;` always continues, `&&` stops after a failure.
  const ops: string[] = []
  const sequence = splitTop(line, /^(;|&&)/, ops)
  for (let s = 0; s < sequence.length; s++) {
    const stmt = sequence[s].trim()
    if (!stmt) continue
    const res = await runPipeline(stmt, base)
    results.push(res)
    if (res.output) base.print(res.output)
    base.env['?'] = res.ok ? '0' : '1'
    if (!res.ok && ops[s] === '&&') break
  }
  return results
}

async function runPipeline(stmt: string, base: Base): Promise<RunResult> {
  let redirect: { target: string; append: boolean } | null = null
  const ops: string[] = []
  const redir = splitTop(stmt, /^>>?/, ops)
  if (redir.length > 1) {
    redirect = { target: redir[redir.length - 1].trim(), append: ops[ops.length - 1] === '>>' }
    stmt = redir[0]
    if (!redirect.target) return { output: c('red', 'msh: syntax error near `>`'), ok: false }
  }

  const stages = splitTop(stmt, /^\|/)
  let stdin: string | null = null
  let rendered = ''
  try {
    for (let i = 0; i < stages.length; i++) {
      const [name, ...args] = tokenize(stages[i].trim(), base.env)
      if (!name) throw new CmdError('msh: syntax error near `|`')
      const cmd = commands[name] ?? executable(name, base.cwd)
      if (!cmd) throw new CmdError(`msh: command not found: ${name}${name.length > 2 ? suggest(name) : ''}`)
      const tty = i === stages.length - 1 && !redirect
      const out = commands[name] && asksHelp(name, args) ? manPage(name) : ((await cmd.run({ ...base, args, stdin, tty })) ?? '')
      rendered = out
      stdin = strip(out)
    }
    if (redirect) {
      writeTmp(base.cwd, redirect.target, stdin ?? '', redirect.append)
      return { output: '', ok: true }
    }
    return { output: rendered, ok: true }
  } catch (err) {
    if (err instanceof CmdError && err.raw) return { output: err.message, ok: false }
    const msg = err instanceof CmdError ? err.message : `msh: ${(err as Error).message}`
    return { output: msg ? c('red', msg) : '', ok: false }
  }
}

/** Games run from the terminal; on the text console there is no display, so one gets started. */
function launchGame(ctx: Ctx, game?: string) {
  const props = game ? { game } : undefined
  if (!ctx.startx) return void ctx.openNewApp('games', props)
  const name = GAME_CATALOG.find((g) => g.id === game)?.name ?? 'the arcade'
  ctx.startx({ app: 'games', props })
  return `${c('yellow', 'No display on tty1.')} Starting a fresh graphical session for ${name}...`
}

/** `./tetris.game` (or just `tetris.game`) runs a game file; other files are not executable. */
function executable(name: string, cwd: string): Command | undefined {
  const local = name.includes('/')
  if (!local && !name.endsWith('.game')) return undefined
  const node = lookup(resolvePath(cwd, name))
  if (!node) return local ? { desc: '', run: () => { throw new CmdError(`msh: no such file or directory: ${name}`) } } : undefined
  if (node.type === 'dir') return { desc: '', run: () => { throw new CmdError(`msh: is a directory: ${name}`) } }
  const game = node.open?.app === 'games' ? node.open.props?.game : undefined
  if (game) return { desc: 'play a game', run: (ctx) => launchGame(ctx, game) }
  return { desc: '', run: () => { throw new CmdError(`msh: permission denied: ${name}`) } }
}

function suggest(name: string) {
  const near = Object.keys(commands).find((k) => !commands[k].hidden && levenshtein(k, name) <= 1)
  return near ? `. Did you mean '${near}'?` : ''
}

function levenshtein(a: string, b: string) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
  return d[a.length][b.length]
}

/** Tab completion: commands for the first word, paths (and app names after `open`) for the rest. */
export function complete(line: string, cwd: string): { line: string; options: string[] } {
  const m = /^(.*?)(\S*)$/.exec(line)!
  const [, before, word] = m
  const isFirst = !before.trim() || /(\||;|&&)\s*$/.test(before)
  let candidates: string[]
  if (isFirst && !word.includes('/')) {
    candidates = Object.keys(commands).filter((k) => !commands[k].hidden && k.startsWith(word))
  } else {
    const slash = word.lastIndexOf('/')
    const dirPart = slash >= 0 ? word.slice(0, slash + 1) : ''
    const namePart = word.slice(slash + 1)
    const dirNode = lookup(resolvePath(cwd, dirPart || '.'))
    candidates =
      dirNode?.type === 'dir'
        ? [...dirNode.children.values()]
            .filter((n) => n.name.startsWith(namePart) && (namePart.startsWith('.') || !n.name.startsWith('.')))
            // As a command (`./te<Tab>`), only folders and things that run.
            .filter((n) => !isFirst || n.type === 'dir' || n.name.endsWith('.game'))
            .map((n) => dirPart + n.name + (n.type === 'dir' ? '/' : ''))
        : []
    if (/^\s*open\s+$/.test(before) && !dirPart) candidates.push(...Object.keys(APPS).filter((a) => a.startsWith(word) && !candidates.includes(a)))
  }
  if (candidates.length === 1) {
    const done = candidates[0]
    return { line: before + done + (done.endsWith('/') ? '' : ' '), options: [] }
  }
  if (candidates.length > 1) {
    let prefix = candidates[0]
    for (const cand of candidates) while (!cand.startsWith(prefix)) prefix = prefix.slice(0, -1)
    return { line: before + (prefix.length > word.length ? prefix : word), options: candidates.map((x) => x.split('/').filter(Boolean).pop()! + (x.endsWith('/') ? '/' : '')) }
  }
  return { line, options: [] }
}
