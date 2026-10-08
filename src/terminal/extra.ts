import { contributions, profile, projects } from '../data/profile'
import { ansiToMarkup, plain, rainbow } from './ansi'
import { md5, sha } from './hash'
import { jq, JqError } from './jq'
import { CmdError, type Ctx } from './types'
import { age, lookup, resolvePath, walk } from './vfs'
import { runLine, writeTmp } from './commands'

// Real tools that work from the browser: curl/wget/whois against the live internet, git log on the
// real repos, htop and friends with real numbers from this device, jq, checksums, cmatrix, figlet.

type Command = { desc: string; usage?: string; hidden?: boolean; run: (ctx: Ctx) => string | void | Promise<string | void> }

const c = (color: string, s: string) => `{c:${color}}${s}{/}`
const link = (url: string, text = url) => `{link:${url}}${text}{/}`

/** Resolves after `ms`, or right away when the signal aborts. */
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true })
  })

function readText(ctx: Ctx, path: string, cmd: string) {
  const node = lookup(resolvePath(ctx.cwd, path))
  if (!node) throw new CmdError(`${cmd}: ${path}: No such file or directory`)
  if (node.type === 'dir') throw new CmdError(`${cmd}: ${path}: Is a directory`)
  return node.content()
}

const human = (bytes: number) => {
  const units = ['B', 'K', 'M', 'G', 'T']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return i === 0 ? `${v}B` : `${v < 10 ? v.toFixed(1) : Math.round(v)}${units[i]}`
}

// ---------------------------------------------------------------------------
// curl / wget

const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|.*\.lan|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|0\.0\.0\.0|\[?::1?\]?|\[?f[cd][0-9a-f:]*\]?)$/i

/** Parses and checks a URL for curl/wget: http(s) only, and not the visitor's own network. */
function targetUrl(raw: string, cmd: string): URL {
  let url: URL
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`)
  } catch {
    throw new CmdError(`${cmd}: (3) URL rejected: Malformed input to a URL function`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new CmdError(`${cmd}: (1) Protocol "${url.protocol.replace(':', '')}" not supported`)
  if (PRIVATE_HOST.test(url.hostname)) throw new CmdError(`${cmd}: (7) ${url.hostname} is on your own network; this terminal only talks to the public internet`)
  // Real curl gets wttr.in's terminal output because of its User-Agent; a browser can't send one, so ask for it.
  if (url.hostname === 'wttr.in' && !url.searchParams.has('format') && !/[?&](A|T)(&|$)/.test(url.search)) url.search += (url.search ? '&' : '?') + 'A'
  return url
}

/** wttr.in's full forecast is 125 columns; on a narrower terminal ask for its narrow layout. */
function fitWttr(url: URL, cols: number) {
  if (url.hostname === 'wttr.in' && cols < 125 && !url.searchParams.has('format') && !/[?&]n(&|$)/.test(url.search)) url.search += '&n'
}

const STATUS_TEXT: Record<number, string> = { 200: 'OK', 201: 'Created', 204: 'No Content', 301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 429: 'Too Many Requests', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable' }

function protocolOf(url: string) {
  const entry = performance.getEntriesByName(url).at(-1) as PerformanceResourceTiming | undefined
  const p = entry?.nextHopProtocol
  return p === 'h3' ? 'HTTP/3' : p === 'h2' ? 'HTTP/2' : p === 'http/1.1' ? 'HTTP/1.1' : 'HTTP/2'
}

const isBinary = (type: string) => /^(image|audio|video|font)\/|application\/(octet-stream|pdf|zip|gzip|x-tar|wasm)/.test(type) && !/svg/.test(type)

async function curl(ctx: Ctx): Promise<string> {
  const args = ctx.args
  let method: string | null = null
  const headers: [string, string][] = []
  let data: string | null = null
  let head = false
  let include = false
  let silent = false
  let showErrors = false
  let verbose = false
  let fail = false
  let output: string | null = null
  let remoteName = false
  let maxTime = 30
  let raw: string | null = null
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    const next = () => {
      const v = args[++i]
      if (v === undefined) throw new CmdError(`curl: option ${a}: requires parameter`)
      return v
    }
    if (a === '--head') head = true
    else if (a === '--include') include = true
    else if (a === '--silent') silent = true
    else if (a === '--show-error') showErrors = true
    else if (a === '--verbose') verbose = true
    else if (a === '--fail') fail = true
    else if (a === '--location' || a === '--insecure' || a === '--compressed') {
      /* fetch follows redirects and decompresses anyway */
    } else if (a === '--request') method = next().toUpperCase()
    else if (a === '--header') headers.push(splitHeader(next()))
    else if (a === '--data' || a === '--data-raw' || a === '--data-binary') data = next()
    else if (a === '--json') {
      data = next()
      headers.push(['Content-Type', 'application/json'], ['Accept', 'application/json'])
    } else if (a === '--output') output = next()
    else if (a === '--remote-name') remoteName = true
    else if (a === '--max-time') maxTime = Number(next()) || 30
    else if (a === '--user-agent') {
      next()
      if (!silent) ctx.print(c('muted', '* Browsers do not let pages set the User-Agent; sending the default one.'))
    } else if (a === '--help' || a === '-h') return curlHelp()
    else if (/^-[a-zA-Z]+$/.test(a)) {
      for (const ch of a.slice(1)) {
        if (ch === 'I') head = true
        else if (ch === 'i') include = true
        else if (ch === 's') silent = true
        else if (ch === 'S') showErrors = true
        else if (ch === 'v') verbose = true
        else if (ch === 'f') fail = true
        else if (ch === 'L' || ch === 'k') continue
        else if (ch === 'O') remoteName = true
        else if ('XHdoAm'.includes(ch)) {
          const v = next()
          if (ch === 'X') method = v.toUpperCase()
          else if (ch === 'H') headers.push(splitHeader(v))
          else if (ch === 'd') data = v
          else if (ch === 'o') output = v
          else if (ch === 'm') maxTime = Number(v) || 30
        } else throw new CmdError(`curl: option -${ch}: is unknown\ncurl: try 'curl --help' for more information`)
      }
    } else if (a.startsWith('-')) throw new CmdError(`curl: option ${a}: is unknown\ncurl: try 'curl --help' for more information`)
    else raw = a
  }
  if (!raw) throw new CmdError("curl: no URL specified\ncurl: try 'curl --help' for more information")

  const url = targetUrl(raw, 'curl')
  fitWttr(url, ctx.size.cols)
  const verb = method ?? (head ? 'HEAD' : data !== null ? 'POST' : 'GET')
  if (data !== null && !headers.some(([k]) => k.toLowerCase() === 'content-type')) headers.push(['Content-Type', 'application/x-www-form-urlencoded'])
  if (verbose) {
    ctx.print(c('muted', [`*   Trying ${url.hostname}:${url.port || (url.protocol === 'https:' ? 443 : 80)}...`, `> ${verb} ${url.pathname}${url.search} HTTP/2`, `> Host: ${url.host}`, ...headers.map(([k, v]) => `> ${k}: ${v}`), '>'].join('\n')))
  }

  const timeout = AbortSignal.timeout(maxTime * 1000)
  const signal = AbortSignal.any([ctx.signal, timeout])
  let res: Response
  try {
    res = await fetch(url, { method: verb, headers, body: data ?? undefined, credentials: 'omit', redirect: 'follow', signal })
  } catch (err) {
    if (ctx.signal.aborted) return ''
    if (timeout.aborted) throw new CmdError(`curl: (28) Operation timed out after ${maxTime * 1000} milliseconds`)
    // A failed fetch is usually CORS: the server answered, but not to web pages on other sites.
    throw new CmdError(
      silent && !showErrors
        ? ''
        : `curl: (7) Failed to connect to ${url.host}: ${(err as Error).message}\n${c('muted', '  Browsers only let a page read sites that allow it (CORS). Try one that does, like wttr.in, api.github.com or ifconfig.co/json.')}`,
      true,
    )
  }

  const status = `${protocolOf(res.url)} ${res.status}${STATUS_TEXT[res.status] ? ` ${STATUS_TEXT[res.status]}` : ''}`
  const headerBlock = [status, ...[...res.headers].map(([k, v]) => `${k}: ${v}`)].join('\n')
  if (verbose) ctx.print(c('muted', `< ${headerBlock.replace(/\n/g, '\n< ')}\n<\n* (a browser only shows the headers a site exposes to other sites)`))
  if (res.redirected && verbose) ctx.print(c('muted', `* Followed redirect to ${res.url}`))
  if (fail && res.status >= 400) throw new CmdError(silent && !showErrors ? '' : `curl: (22) The requested URL returned error: ${res.status}`, true)
  if (head || verb === 'HEAD') return headerBlock + '\n'

  const type = res.headers.get('content-type') ?? ''
  const file = output ?? (remoteName ? url.pathname.split('/').filter(Boolean).pop() || 'index.html' : null)
  if (file) {
    const body = await res.text()
    writeTmp(ctx.cwd, file.includes('/') ? file : `/tmp/${file}`, body, false)
    return silent ? '' : c('muted', `  % Total    % Received  Xferd\n100 ${human(body.length).padStart(6)}  100 ${human(body.length).padStart(6)}   saved to ${file.includes('/') ? file : `/tmp/${file}`}`)
  }
  if (isBinary(type)) {
    return `Warning: Binary output can mess up your terminal. Use "--output -" to tell curl to output it to your terminal anyway, or consider "--output <FILE>" to save to a file.`
  }
  const body = await res.text()
  const rendered = ctx.tty ? (body.includes('\x1b[') ? ansiToMarkup(body) : plain(body)) : body.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  return (include ? headerBlock + '\n\n' : '') + rendered
}

function splitHeader(h: string): [string, string] {
  const i = h.indexOf(':')
  if (i < 1) throw new CmdError(`curl: bad header '${h}' (use "Name: value")`)
  return [h.slice(0, i).trim(), h.slice(i + 1).trim()]
}

function curlHelp() {
  return [
    'Usage: curl [options...] <url>',
    ' -d, --data <data>        HTTP POST data',
    ' -f, --fail               Fail fast with no output on HTTP errors',
    ' -H, --header <header>    Pass custom header(s) to server',
    ' -I, --head               Show document info only',
    ' -i, --include            Include response headers in output',
    '     --json <data>        HTTP POST JSON',
    ' -L, --location           Follow redirects (always on in a browser)',
    ' -m, --max-time <secs>    Maximum time allowed for transfer',
    ' -o, --output <file>      Write to file (only /tmp is writable)',
    ' -O, --remote-name        Write output to /tmp named as remote file',
    ' -s, --silent             Silent mode',
    ' -v, --verbose            Make the operation more talkative',
    ' -X, --request <method>   Specify request method to use',
    '',
    c('muted', 'Runs in your browser: sites must allow cross-origin requests. Try:'),
    c('muted', '  curl wttr.in/Amsterdam · curl -s api.github.com/users/vleeuwenmenno | jq .name · curl ifconfig.co/json'),
  ].join('\n')
}

async function wget(ctx: Ctx): Promise<string> {
  const quiet = ctx.args.includes('-q')
  const toStdout = ctx.args.includes('-O-') || ctx.args.join(' ').includes('-O -')
  const raw = ctx.args.filter((a) => !a.startsWith('-') && a !== '-').pop()
  if (!raw) throw new CmdError("wget: missing URL\nUsage: wget [OPTION]... [URL]...")
  const url = targetUrl(raw, 'wget')
  const when = new Date().toISOString().replace('T', ' ').slice(0, 19)
  if (!quiet && !toStdout) ctx.print(`--${when}--  ${url.href}\nResolving ${url.hostname}... done.\nConnecting to ${url.hostname}|${url.hostname}|:${url.port || 443}... connected.\nHTTP request sent, awaiting response... `)
  let res: Response
  try {
    res = await fetch(url, { credentials: 'omit', signal: ctx.signal })
  } catch (err) {
    if (ctx.signal.aborted) return ''
    throw new CmdError(`failed: ${(err as Error).message}.\n${c('muted', '  The site does not allow requests from web pages (CORS).')}`, true)
  }
  const body = await res.text()
  if (toStdout) return ctx.tty ? (body.includes('\x1b[') ? ansiToMarkup(body) : plain(body)) : body
  const name = url.pathname.split('/').filter(Boolean).pop() || 'index.html'
  writeTmp(ctx.cwd, `/tmp/${name}`, body, false)
  if (quiet) return ''
  return `${res.status} ${STATUS_TEXT[res.status] ?? ''}\nLength: ${body.length} (${human(body.length)}) [${res.headers.get('content-type') ?? 'text/plain'}]\nSaving to: ‘/tmp/${name}’\n\n/tmp/${name}       100%[===================>]  ${human(body.length).padStart(6)}  --.-KB/s    in 0s\n\n${when} - ‘/tmp/${name}’ saved [${body.length}/${body.length}]`
}

// ---------------------------------------------------------------------------
// whois (over RDAP, which allows browsers)

async function whois(ctx: Ctx): Promise<string> {
  const q = ctx.args.find((a) => !a.startsWith('-'))?.replace(/^[a-z]+:\/\//i, '').replace(/[/?#].*$/, '').toLowerCase()
  if (!q) throw new CmdError('Usage: whois <domain or IP address>')
  const isIp = /^\d+\.\d+\.\d+\.\d+$/.test(q) || q.includes(':')
  if (!isIp && !/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(q)) throw new CmdError(`whois: '${q}' is not a domain name or IP address`)
  let res: Response
  try {
    res = await fetch(`https://rdap.org/${isIp ? 'ip' : 'domain'}/${encodeURIComponent(q)}`, { signal: ctx.signal, credentials: 'omit' })
  } catch (err) {
    if (ctx.signal.aborted) return ''
    throw new CmdError(`whois: the registry for ${q} did not answer a browser request (${(err as Error).message})`)
  }
  if (res.status === 404) return `No match for "${q.toUpperCase()}".`
  if (!res.ok) throw new CmdError(`whois: registry answered ${res.status}`)
  const r = await res.json()
  const date = (action: string) => r.events?.find((e: { eventAction: string }) => e.eventAction === action)?.eventDate
  const entity = (role: string) => {
    const e = r.entities?.find((x: { roles?: string[] }) => x.roles?.includes(role))
    const fn = e?.vcardArray?.[1]?.find((v: unknown[]) => v[0] === 'fn')?.[3]
    return fn || e?.handle
  }
  const row = (k: string, v: unknown) => (v ? `${c('cyan', (k + ':').padEnd(22))} ${v}` : null)
  if (isIp) {
    return [
      row('NetRange', r.startAddress && `${r.startAddress} - ${r.endAddress}`),
      row('CIDR', r.cidr0_cidrs?.map((x: { v4prefix?: string; v6prefix?: string; length: number }) => `${x.v4prefix ?? x.v6prefix}/${x.length}`).join(', ')),
      row('NetName', r.name),
      row('Handle', r.handle),
      row('Country', r.country),
      row('Organization', entity('registrant') ?? entity('administrative')),
      row('Abuse', entity('abuse')),
      row('Registration Date', date('registration')),
      row('Updated', date('last changed')),
    ]
      .filter(Boolean)
      .join('\n')
  }
  return [
    row('Domain Name', (r.ldhName ?? q).toUpperCase()),
    row('Registry Domain ID', r.handle),
    row('Registrar', entity('registrar')),
    row('Creation Date', date('registration')),
    row('Updated Date', date('last changed')),
    row('Registry Expiry Date', date('expiration')),
    ...(r.status ?? []).map((s: string) => row('Domain Status', s)),
    ...(r.nameservers ?? []).map((n: { ldhName: string }) => row('Name Server', n.ldhName?.toUpperCase())),
    row('DNSSEC', r.secureDNS ? (r.secureDNS.delegationSigned ? 'signedDelegation' : 'unsigned') : null),
    '',
    c('muted', `>>> Data from RDAP via rdap.org, ${new Date().toUTCString()} <<<`),
  ]
    .filter((x) => x !== null)
    .join('\n')
}

// ---------------------------------------------------------------------------
// git (the real repos, through the GitHub API)

/** The GitHub repo for the current directory: a project or contribution folder, or this site. */
function repoFor(cwd: string): { repo: string | null; name: string; web?: string } {
  const m = /\/(projects|contributions)\/([^/]+)/.exec(cwd)
  if (m) {
    const item = m[1] === 'projects' ? projects.find((p) => p.slug === m[2]) : contributions.find((x) => x.slug === m[2])
    if (item) {
      const gh = 'github' in item ? (item.github as string | undefined) : undefined
      return { repo: gh ?? null, name: m[2], web: (item as { repo?: string }).repo }
    }
  }
  return { repo: `${profile.github}/mennovanleeuwen.nl`, name: 'mennovanleeuwen.nl' }
}

/** GitHub's commit API, through the site's cached /api/git when it is there, else directly. */
const ghApi = async (path: string, signal: AbortSignal) => {
  const viaSite = await fetch(`/api/git/${path.replace(/^\/repos\//, '')}`, { signal }).catch(() => null)
  const res =
    viaSite && viaSite.headers.get('content-type')?.includes('json') && viaSite.status !== 502
      ? viaSite
      : await fetch(`https://api.github.com${path}`, { headers: { Accept: 'application/vnd.github+json' }, signal })
  if (res.status === 403 || res.status === 429) throw new CmdError('fatal: GitHub rate limit reached for this network; try again in a bit')
  if (res.status === 404 || res.status === 422) throw new CmdError(`fatal: bad revision '${path.split('/').pop()}'`)
  if (!res.ok) throw new CmdError(`fatal: GitHub answered ${res.status}`)
  return res.json()
}

type GhCommit = { sha: string; commit: { message: string; author: { name: string; date: string } }; stats?: { additions: number; deletions: number }; files?: { filename: string; additions: number; deletions: number; patch?: string; status: string }[] }

const gitDate = (iso: string) => {
  const d = new Date(iso)
  const off = -d.getTimezoneOffset()
  const tz = `${off >= 0 ? '+' : '-'}${String(Math.floor(Math.abs(off) / 60)).padStart(2, '0')}${String(Math.abs(off) % 60).padStart(2, '0')}`
  return `${d.toDateString().replace(/ 0(\d) /, ' $1 ')} ${d.toTimeString().slice(0, 8)} ${tz}`
}

async function git(ctx: Ctx): Promise<string | void> {
  const [sub, ...rest] = ctx.args
  const { repo, name, web } = repoFor(ctx.cwd)
  const needRepo = () => {
    if (!repo) throw new CmdError(`fatal: ${name} lives on git.mvl.sh, which does not allow browser requests.${web ? ` Browse it at ${web}` : ''}`)
    return repo
  }
  if (sub === 'log') {
    const oneline = rest.includes('--oneline')
    const nArg = rest.find((a) => /^-\d+$/.test(a))
    const nIdx = rest.indexOf('-n')
    const n = Math.min(100, nArg ? -Number(nArg) : nIdx >= 0 ? Number(rest[nIdx + 1]) || 10 : oneline ? 20 : 10)
    const commits: GhCommit[] = await ghApi(`/repos/${needRepo()}/commits?per_page=${n}`, ctx.signal)
    const deco = c('yellow', '(') + c('cyan', 'HEAD -> ') + c('green', 'main') + c('yellow', ', ') + c('red', 'origin/main') + c('yellow', ')')
    if (oneline) return commits.map((x, i) => `${link(`https://github.com/${repo}/commit/${x.sha}`, c('yellow', x.sha.slice(0, 7)))}${i === 0 ? ` ${deco}` : ''} ${plain(x.commit.message.split('\n')[0])}`).join('\n')
    // Author names only: commit e-mail addresses stay out of the page.
    return commits
      .map((x, i) =>
        [
          `${c('yellow', `commit ${x.sha}`)}${i === 0 ? ` ${deco}` : ''}`,
          `Author: ${plain(x.commit.author.name)}`,
          `Date:   ${gitDate(x.commit.author.date)}`,
          '',
          ...plain(x.commit.message.trimEnd()).split('\n').map((l) => `    ${l}`),
        ].join('\n'),
      )
      .join('\n\n')
  }
  if (sub === 'show') {
    const ref = rest.find((a) => !a.startsWith('-')) ?? 'HEAD'
    const x: GhCommit = await ghApi(`/repos/${needRepo()}/commits/${encodeURIComponent(ref)}`, ctx.signal)
    const stat = rest.includes('--stat')
    const head = [`${c('yellow', `commit ${x.sha}`)}`, `Author: ${plain(x.commit.author.name)}`, `Date:   ${gitDate(x.commit.author.date)}`, '', ...plain(x.commit.message.trimEnd()).split('\n').map((l) => `    ${l}`), ''].join('\n')
    const files = x.files ?? []
    if (stat) {
      const w = Math.max(...files.map((f) => f.filename.length), 4)
      return `${head}\n${files.map((f) => ` ${f.filename.padEnd(w)} | ${String(f.additions + f.deletions).padStart(4)} ${c('green', '+'.repeat(Math.min(30, f.additions)))}${c('red', '-'.repeat(Math.min(30, f.deletions)))}`).join('\n')}\n ${files.length} files changed, ${x.stats?.additions ?? 0} insertions(+), ${x.stats?.deletions ?? 0} deletions(-)`
    }
    const diff = files
      .map((f) =>
        [
          c('bold', `diff --git a/${f.filename} b/${f.filename}`),
          c('bold', `--- a/${f.filename}`),
          c('bold', `+++ b/${f.filename}`),
          ...(f.patch ?? '(binary or too large to show)').split('\n').map((l) => (l.startsWith('@@') ? c('cyan', plain(l)) : l.startsWith('+') ? c('green', plain(l)) : l.startsWith('-') ? c('red', plain(l)) : plain(l))),
        ].join('\n'),
      )
      .join('\n')
    return `${head}\n${diff}`
  }
  if (sub === 'status') return `On branch main\nYour branch is up to date with 'origin/main'.\n\nnothing to commit, working tree clean (it is read-only)`
  if (sub === 'remote') return repo ? `origin\thttps://github.com/${repo}.git (fetch)\norigin\thttps://github.com/${repo}.git (push)` : `origin\t${web ?? 'https://git.mvl.sh'} (fetch)`
  if (sub === 'branch') return `* ${c('green', 'main')}`
  if (sub === 'push') return c('yellow', 'Everything is already pushed. That is the whole point of a CV.')
  if (sub === 'clone') return `Cloning into '${(rest[0] ?? 'repo').split('/').pop()?.replace(/\.git$/, '')}'...\n${c('red', 'fatal: this disk is read-only. Try `git log` or `git show` instead.')}`
  if (!sub || sub === 'help' || sub === '--help') return 'usage: git <command>\n\n   log [--oneline] [-n N]   show commit logs (real, from GitHub)\n   show [<commit>] [--stat] show a commit and its diff\n   status, branch, remote\n\nRuns against this site, or the project you are in (cd ~/projects/boltwarden).'
  throw new CmdError(`git: '${sub}' is not a git command here. See 'git help'.`)
}

// ---------------------------------------------------------------------------
// htop / top: live, with real numbers from this page and device

type MemoryInfo = { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number }
const heap = () => (performance as Performance & { memory?: MemoryInfo }).memory

const bar = (label: string, frac: number, text: string, width: number, color: string) => {
  const inner = Math.max(4, width - label.length - 2)
  const fill = Math.round(Math.min(1, Math.max(0, frac)) * Math.max(0, inner - text.length))
  return `${c('cyan', label)}${c('bold', '[')}${c(color, '|'.repeat(fill))}${' '.repeat(Math.max(0, inner - fill - text.length))}${c('muted', text)}${c('bold', ']')}`
}

const clock = (s: number) => `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(Math.floor(s) % 60).padStart(2, '0')}`

async function htop(ctx: Ctx, title = 'htop'): Promise<string> {
  if (!ctx.tty) throw new CmdError(`${title}: not a terminal`)
  let quit = false
  ctx.onKey((k) => {
    if (k === 'q' || k === 'Q' || k === 'F10' || k === 'Escape') quit = true
    return true
  })
  // Main-thread load: how late a 100 ms timer fires is time the page spent busy.
  let busy = 0
  let load1 = 0
  let load5 = 0
  let load15 = 0
  let lastTick = performance.now()
  const probe = setInterval(() => {
    const now = performance.now()
    const late = Math.max(0, now - lastTick - 100)
    lastTick = now
    const b = Math.min(1, late / 100)
    busy = busy * 0.7 + b * 0.3
    load1 += (busy - load1) * 0.02
    load5 += (busy - load5) * 0.004
    load15 += (busy - load15) * 0.0015
  }, 100)
  const cores = navigator.hardwareConcurrency || 1
  try {
    while (!quit && !ctx.signal.aborted) {
      const { cols, rows } = ctx.size
      const half = Math.floor(cols / 2) - 1
      const mem = heap()
      const left: string[] = []
      const shown = Math.min(cores, 8)
      for (let i = 0; i < shown; i++) {
        const f = i === 0 ? busy : 0
        left.push(bar(String(i + 1).padStart(3) + ' ', f, `${(f * 100).toFixed(1)}%`, half, f > 0.6 ? 'red' : 'green'))
      }
      left.push(mem ? bar('Mem ', mem.usedJSHeapSize / mem.jsHeapSizeLimit, `${human(mem.usedJSHeapSize)}/${human(mem.jsHeapSizeLimit)}`, half, 'green') : bar('Mem ', 0, 'n/a (Firefox/Safari)', half, 'green'))
      left.push(bar('Swp ', 0, '0K/0K', half, 'red'))
      const windows = ctx.windows
      const right = [
        `${c('cyan', 'Tasks:')} ${c('bold', String(windows.length + 4))}, ${cores} thr; ${c('green', '1')} running`,
        `${c('cyan', 'Load average:')} ${c('bold', (load1 * cores).toFixed(2))} ${(load5 * cores).toFixed(2)} ${(load15 * cores).toFixed(2)}`,
        `${c('cyan', 'Uptime:')} ${c('bold', `${age().years} years, ${age().days} days`)}`,
        `${c('cyan', 'CPUs:')} ${cores}${cores > shown ? ` (${shown} shown)` : ''}`,
        c('muted', 'CPU 1 = this page\'s main thread'),
      ]
      const header: string[] = []
      for (let i = 0; i < Math.max(left.length, right.length); i++) header.push(`${left[i] ?? ' '.repeat(half)}  ${right[i] ?? ''}`)

      const nodes = (pid: number) => document.querySelector(`.window[data-pid="${pid}"]`)?.getElementsByTagName('*').length ?? 0
      const now = Date.now()
      const page = performance.now() / 1000
      const procs: { pid: number; cmd: string; cpu: number; nodes: number; time: number; state: string }[] = [
        { pid: 1, cmd: '/sbin/init (react)', cpu: 0, nodes: document.getElementsByTagName('*').length, time: page, state: 'S' },
        { pid: 2, cmd: 'react-wm --compositor', cpu: busy * 100, nodes: 0, time: page, state: busy > 0.05 ? 'R' : 'S' },
        { pid: 3, cmd: 'mc-status --every 30s cloud.mvl.sh', cpu: 0, nodes: 0, time: page, state: 'S' },
        { pid: 4, cmd: 'activity-sync --every 3m', cpu: 0, nodes: 0, time: page, state: 'S' },
        ...windows.map((w) => ({ pid: w.pid, cmd: w.app + (w.props.game ? ` --${w.props.game}` : '') + (w.minimized ? '  (minimized)' : ''), cpu: 0, nodes: nodes(w.pid), time: (now - w.openedAt) / 1000, state: w.minimized ? 'T' : 'S' })),
      ]
      const head = `${'PID'.padStart(6)} ${'USER'.padEnd(8)} S ${'CPU%'.padStart(5)} ${'NODES'.padStart(6)} ${'TIME+'.padStart(9)}  Command`
      const list = procs.map((p) => `${String(p.pid).padStart(6)} ${profile.handle.slice(0, 8).padEnd(8)} ${p.state === 'R' ? c('green', 'R') : p.state} ${p.cpu.toFixed(1).padStart(5)} ${String(p.nodes || '-').padStart(6)} ${clock(p.time).padStart(9)}  ${p.pid <= 4 ? c('muted', p.cmd) : p.cmd}`)
      const footer = `${c('accent', 'q')}Quit  ${c('accent', 'F10')}Quit  ${c('muted', 'Ctrl+C')}Quit`
      const room = Math.max(1, rows - header.length - 4)
      ctx.live([...header, '', c('green', head.padEnd(cols)), ...list.slice(0, room), ...Array(Math.max(0, room - list.length)).fill(''), footer].join('\n'))
      // Redraw every second, but notice q sooner.
      for (let i = 0; i < 10 && !quit && !ctx.signal.aborted; i++) await sleep(100, ctx.signal)
    }
  } finally {
    clearInterval(probe)
    ctx.onKey(null)
    ctx.live(null)
  }
  return ''
}

// ---------------------------------------------------------------------------
// cmatrix

async function cmatrix(ctx: Ctx): Promise<string> {
  if (!ctx.tty) throw new CmdError('cmatrix: not a terminal')
  let quit = false
  ctx.onKey((k) => {
    if (k === 'q' || k === 'Q' || k === 'Escape') quit = true
    return true
  })
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@#$%&*+=<>?/\\|'
  const pick = () => chars[Math.floor(Math.random() * chars.length)]
  const { cols, rows } = ctx.size
  type Drop = { y: number; len: number; speed: number; tick: number }
  const grid: string[][] = Array.from({ length: rows }, () => Array(cols).fill(' '))
  const drops: (Drop | null)[] = Array(cols).fill(null)
  try {
    while (!quit && !ctx.signal.aborted) {
      for (let x = 0; x < cols; x += 1) {
        let d = drops[x]
        if (!d && Math.random() < 0.02) d = drops[x] = { y: 0, len: 4 + Math.floor(Math.random() * rows * 0.6), speed: 1 + Math.floor(Math.random() * 2), tick: 0 }
        if (!d) continue
        if (++d.tick % d.speed) continue
        if (d.y < rows) grid[d.y][x] = pick()
        const tail = d.y - d.len
        if (tail >= 0 && tail < rows) grid[tail][x] = ' '
        d.y++
        if (tail >= rows) drops[x] = null
      }
      const lines = grid.map((row, y) => {
        let out = ''
        let run = ''
        for (let x = 0; x < cols; x++) {
          const d = drops[x]
          const head = d && d.y - 1 === y
          if (head) {
            if (run) out += c('green', run)
            run = ''
            out += `{fg:#e8ffe8}${row[x]}{/}`
          } else run += row[x]
        }
        return out + (run.trim() ? c('green', run) : run)
      })
      ctx.live(lines.join('\n'))
      await sleep(60, ctx.signal)
    }
  } finally {
    ctx.onKey(null)
    ctx.live(null)
  }
  return ''
}

// ---------------------------------------------------------------------------
// watch

async function watch(ctx: Ctx): Promise<string> {
  let interval = 2
  const args = [...ctx.args]
  while (args[0]?.startsWith('-')) {
    const a = args.shift()!
    if (a === '-n' || a === '--interval') interval = Math.max(0.5, Number(args.shift()) || 2)
    else if (/^-n\d/.test(a)) interval = Math.max(0.5, Number(a.slice(2)) || 2)
  }
  const cmd = args.join(' ')
  if (!cmd) throw new CmdError('Usage: watch [-n seconds] <command>')
  if (/^(watch|htop|top|cmatrix|sl)\b/.test(cmd)) throw new CmdError(`watch: ${cmd.split(' ')[0]} already redraws itself`)
  let quit = false
  ctx.onKey((k) => {
    if (k === 'q' || k === 'Q') quit = true
    return true
  })
  try {
    while (!quit && !ctx.signal.aborted) {
      const results = await runLine(cmd, { ...ctx, print: () => {}, live: () => {}, onKey: () => {} })
      const header = `${c('muted', `Every ${interval.toFixed(1)}s: ${cmd}`)}${' '.repeat(Math.max(1, ctx.size.cols - cmd.length - 40))}${c('muted', `mvlos: ${new Date().toString().slice(0, 24)}`)}`
      ctx.live(`${header}\n\n${results.map((r) => r.output).join('\n')}`)
      await sleep(interval * 1000, ctx.signal)
    }
  } finally {
    ctx.onKey(null)
  }
  return ''
}

// ---------------------------------------------------------------------------
// The device: df, free, nproc, lscpu, xrandr, ip / ifconfig

async function df(ctx: Ctx): Promise<string> {
  const h = ctx.args.some((a) => /^-\w*h/.test(a))
  const fmt = (b: number) => (h ? human(b) : String(Math.ceil(b / 1024)))
  const size = (path: string) => walk(path).reduce((sum, p) => {
    const n = lookup(p)
    return sum + (n?.type === 'file' ? new Blob([n.content()]).size : 0)
  }, 0)
  const rootBytes = size('/')
  const tmpBytes = size('/tmp')
  const est = await navigator.storage?.estimate?.().catch(() => null)
  const rows: [string, number, number, string][] = [
    ['vfs', rootBytes, rootBytes, '/'],
    ['tmpfs', Math.max(tmpBytes, 1024 * 1024), tmpBytes, '/tmp'],
  ]
  if (est?.quota) rows.push(['browser-storage', est.quota, est.usage ?? 0, '/var/lib/browser'])
  const head = `Filesystem      ${h ? ' Size' : '1K-blocks'}  ${h ? ' Used' : '     Used'} ${h ? 'Avail' : 'Available'} Use% Mounted on`
  const body = rows.map(([fs, total, used, mount]) => `${fs.padEnd(15)} ${fmt(total).padStart(h ? 5 : 9)}  ${fmt(used).padStart(h ? 5 : 9)} ${fmt(Math.max(0, total - used)).padStart(h ? 5 : 9)} ${String(Math.round((used / total) * 100) || 0).padStart(3)}% ${mount}`)
  return [head, ...body, '', c('muted', est?.quota ? 'browser-storage is the real quota and usage this browser gives the site.' : 'This browser does not report its storage quota.')].join('\n')
}

function free(ctx: Ctx): string {
  const unit = ctx.args.includes('-g') ? 1024 ** 3 : ctx.args.includes('-m') ? 1024 ** 2 : ctx.args.includes('-b') ? 1 : 1024
  const h = ctx.args.includes('-h')
  const fmt = (b: number | null) => (b === null ? 'n/a' : h ? human(b).replace(/([KMGT])$/, '$1i') : String(Math.round(b / unit)))
  const device = (navigator as Navigator & { deviceMemory?: number }).deviceMemory
  const mem = heap()
  const total = device ? device * 1024 ** 3 : null
  const row = (label: string, cols: (number | null)[]) => `${label.padEnd(8)}${cols.map((v) => fmt(v).padStart(12)).join('')}`
  return [
    `${''.padEnd(8)}${['total', 'used', 'free', 'shared', 'buff/cache', 'available'].map((x) => x.padStart(12)).join('')}`,
    row('Mem:', [total, null, null, null, null, null]),
    row('Swap:', [0, 0, 0]),
    row('JS heap:', mem ? [mem.jsHeapSizeLimit, mem.usedJSHeapSize, mem.jsHeapSizeLimit - mem.usedJSHeapSize, null, mem.totalJSHeapSize - mem.usedJSHeapSize, mem.jsHeapSizeLimit - mem.usedJSHeapSize] : [null]),
    '',
    c('muted', [device ? `Mem total is the browser's rounded figure; used and free are not shared with web pages.` : 'This browser does not share how much memory the device has.', mem ? 'JS heap is the real memory of this page.' : 'JS heap figures are Chromium-only.'].join('\n')),
  ].join('\n')
}

type UAData = { platform?: string; mobile?: boolean; getHighEntropyValues?: (hints: string[]) => Promise<Record<string, string>> }

async function lscpu(): Promise<string> {
  const ua = (navigator as Navigator & { userAgentData?: UAData }).userAgentData
  const hi = (await ua?.getHighEntropyValues?.(['architecture', 'bitness', 'platformVersion', 'model']).catch(() => null)) ?? null
  const arch = hi?.architecture ? `${hi.architecture === 'arm' ? 'aarch' : 'x86_'}${hi.bitness || '64'}`.replace('x86_64', 'x86_64') : /arm|aarch/i.test(navigator.userAgent) ? 'aarch64' : 'x86_64'
  const cores = navigator.hardwareConcurrency || 1
  const little = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1
  const row = (k: string, v: string | number) => `${(k + ':').padEnd(24)}${v}`
  return [
    row('Architecture', arch),
    row('CPU op-mode(s)', arch.endsWith('64') ? '32-bit, 64-bit' : '32-bit'),
    row('Byte Order', little ? 'Little Endian' : 'Big Endian'),
    row('CPU(s)', cores),
    row('On-line CPU(s) list', `0-${cores - 1}`),
    row('Vendor ID', c('muted', 'not shared with web pages')),
    row('Model name', c('muted', 'not shared with web pages')),
    row('Platform', `${ua?.platform || navigator.platform}${hi?.platformVersion ? ` ${hi.platformVersion}` : ''}`),
    row('Mobile', ua?.mobile ? 'yes' : 'no'),
  ].join('\n')
}

/** Frames per second over about half a second, or null when frames are not running (hidden tab). */
function measureRefresh(signal: AbortSignal): Promise<number | null> {
  return new Promise((resolve) => {
    const times: number[] = []
    const done = setTimeout(() => resolve(null), 1500)
    const step = (t: number) => {
      times.push(t)
      if (signal.aborted) return resolve(null)
      if (times.length < 40) requestAnimationFrame(step)
      else {
        clearTimeout(done)
        const gaps = times.slice(1).map((x, i) => x - times[i]).sort((a, b) => a - b)
        resolve(1000 / gaps[Math.floor(gaps.length / 2)])
      }
    }
    requestAnimationFrame(step)
  })
}

async function xrandr(ctx: Ctx): Promise<string> {
  const dpr = window.devicePixelRatio || 1
  const w = Math.round(screen.width * dpr)
  const h = Math.round(screen.height * dpr)
  const hz = await measureRefresh(ctx.signal)
  const rate = hz ? `${hz.toFixed(2)}*+` : '60.00 (could not measure)'
  const orient = screen.orientation?.type?.startsWith('portrait') ? 'left' : 'normal'
  // Safe-area insets (phone notches, home indicator), read back through a probe element.
  const probe = document.createElement('div')
  probe.style.cssText = 'position:fixed;visibility:hidden;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)'
  document.body.append(probe)
  const cs = getComputedStyle(probe)
  const inset = `top ${cs.paddingTop} · bottom ${cs.paddingBottom} · left ${cs.paddingLeft} · right ${cs.paddingRight}`
  probe.remove()
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true || matchMedia('(display-mode: standalone)').matches
  const desk = document.querySelector('.desktop')?.getBoundingClientRect()
  return [
    `Screen 0: minimum 320 x 200, current ${w} x ${h}, maximum 16384 x 16384`,
    `${c('green', 'default')} connected primary ${w}x${h}+0+0 (${orient}) ${screen.colorDepth}-bit colour`,
    `   ${`${w}x${h}`.padEnd(14)}${c('bold', rate)}`,
    '',
    c('muted', `Scale ${dpr}x · browser window ${window.innerWidth}x${window.innerHeight} CSS px · refresh measured from animation frames`),
    c('muted', `Screen ${screen.width}x${screen.height} CSS px · visible ${Math.round(window.visualViewport?.width ?? 0)}x${Math.round(window.visualViewport?.height ?? 0)} · desktop ${Math.round(desk?.width ?? 0)}x${Math.round(desk?.height ?? 0)}`),
    c('muted', `Safe area: ${inset} · installed app: ${standalone ? 'yes' : 'no'}`),
  ].join('\n')
}

type NetInfo = { effectiveType?: string; downlink?: number; rtt?: number; saveData?: boolean; type?: string }

function ip(ctx: Ctx, style: 'ip' | 'ifconfig'): string {
  const sub = ctx.args[0] ?? 'a'
  if (style === 'ip' && !['a', 'addr', 'address', 'link', 'l', 'r', 'route'].includes(sub)) throw new CmdError(`Object "${sub}" is unknown, try "ip help".`)
  const net = (navigator as Navigator & { connection?: NetInfo }).connection
  const up = navigator.onLine
  const kind = net?.type === 'ethernet' ? 'eth0' : net?.type === 'cellular' ? 'wwan0' : 'wlan0'
  const conn = net ? `${net.effectiveType ?? '?'} class · ~${net.downlink ?? '?'} Mbit/s down · rtt ${net.rtt ?? '?'} ms${net.saveData ? ' · data saver on' : ''}` : 'speed not shared by this browser'
  if (style === 'ip' && (sub === 'r' || sub === 'route')) return up ? `default via ${c('muted', '(hidden by your browser)')} dev ${kind}` : ''
  if (style === 'ifconfig') {
    return [
      `${c('bold', 'lo')}: flags=73<UP,LOOPBACK,RUNNING>  mtu 65536`,
      '        inet 127.0.0.1  netmask 255.0.0.0',
      '',
      `${c('bold', kind)}: flags=${up ? '4163<UP,BROADCAST,RUNNING,MULTICAST>' : '4099<UP,BROADCAST,MULTICAST>'}  mtu 1500`,
      `        inet ${c('muted', '(hidden by your browser)')}`,
      `        ether ${c('muted', '(hidden by your browser)')}`,
      `        ${conn}`,
    ].join('\n')
  }
  return [
    `1: ${c('bold', 'lo')}: <LOOPBACK,UP,LOWER_UP> mtu 65536 state UNKNOWN`,
    '    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00',
    ...(sub.startsWith('l') ? [] : ['    inet 127.0.0.1/8 scope host lo']),
    `2: ${c('bold', kind)}: <BROADCAST,MULTICAST${up ? ',UP,LOWER_UP' : ''}> mtu 1500 state ${up ? c('green', 'UP') : c('red', 'DOWN')}`,
    `    link/ether ${c('muted', '(hidden by your browser)')}`,
    ...(sub.startsWith('l') ? [] : [`    inet ${c('muted', '(hidden by your browser)')} scope global ${kind}`]),
    `    ${c('muted', conn)}`,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// figlet

const FONTS: Record<string, string> = { standard: 'Standard', slant: 'Slant', small: 'Small', big: 'Big', shadow: 'Shadow', banner: 'Banner', 'ansi-shadow': 'ANSI Shadow' }
const FONT_LOADERS: Record<string, () => Promise<{ default: string }>> = {
  Standard: () => import('figlet/importable-fonts/Standard.js'),
  Slant: () => import('figlet/importable-fonts/Slant.js'),
  Small: () => import('figlet/importable-fonts/Small.js'),
  Big: () => import('figlet/importable-fonts/Big.js'),
  Shadow: () => import('figlet/importable-fonts/Shadow.js'),
  Banner: () => import('figlet/importable-fonts/Banner.js'),
  'ANSI Shadow': () => import('figlet/importable-fonts/ANSI Shadow.js'),
}

async function figletCmd(ctx: Ctx): Promise<string> {
  const args = [...ctx.args]
  let font = 'Standard'
  let width = ctx.size.cols
  const words: string[] = []
  while (args.length) {
    const a = args.shift()!
    if (a === '-f') {
      const name = (args.shift() ?? '').toLowerCase().replace(/\.flf$/, '').replace(' ', '-')
      if (!FONTS[name]) throw new CmdError(`figlet: ${name}: Unable to open font file\nFonts: ${Object.keys(FONTS).join(', ')}`)
      font = FONTS[name]
    } else if (a === '-w') width = Number(args.shift()) || width
    else if (a === '-l' || a === '--list') return Object.keys(FONTS).join('\n')
    else words.push(a)
  }
  const text = words.length ? words.join(' ') : (ctx.stdin ?? '').trim()
  if (!text) throw new CmdError('Usage: figlet [-f font] [-w width] <text>   (fonts: figlet -l)')
  const [{ default: figlet }, fontData] = await Promise.all([import('figlet'), FONT_LOADERS[font]()])
  figlet.parseFont(font as never, fontData.default)
  return figlet.textSync(text, { font: font as never, width, whitespaceBreak: true })
}

// ---------------------------------------------------------------------------
// Checksums

const sums = (algo: 'SHA-1' | 'SHA-256' | 'SHA-384' | 'SHA-512' | 'MD5', cmd: string): Command => ({
  desc: `${algo} checksums of files or input`,
  usage: `${cmd} [file]...`,
  run: async (ctx) => {
    const files = ctx.args.filter((a) => !a.startsWith('-'))
    const inputs: [string, string][] = files.length ? files.map((f) => [f, readText(ctx, f, cmd)]) : ctx.stdin !== null ? [['-', ctx.stdin]] : []
    if (!inputs.length) throw new CmdError(`${cmd}: missing file operand (or pipe something in: echo hi | ${cmd})`)
    const out = await Promise.all(inputs.map(async ([name, text]) => `${algo === 'MD5' ? md5(text) : await sha(algo, text)}  ${name}`))
    return out.join('\n')
  },
})

// ---------------------------------------------------------------------------

export const extraCommands: Record<string, Command> = {
  curl: { desc: 'transfer a URL (real requests from your browser)', usage: 'curl [-sILv] [-X METHOD] [-H header] [-d data] [-o file] <url>', run: curl },
  wget: { desc: 'download a URL into /tmp', usage: 'wget [-q] [-O -] <url>', run: wget },
  whois: { desc: 'who owns a domain or IP (RDAP)', usage: 'whois <domain|ip>', run: whois },
  git: { desc: 'real history: git log, git show', usage: 'git log [--oneline] [-n N] | git show [commit] [--stat]', run: git },
  htop: { desc: 'live processes and load', run: (ctx) => htop(ctx) },
  top: { desc: 'alias for htop', hidden: true, run: (ctx) => htop(ctx, 'top') },
  btop: { desc: 'alias for htop', hidden: true, run: (ctx) => htop(ctx, 'btop') },
  cmatrix: { desc: 'follow the white rabbit', run: cmatrix },
  watch: { desc: 'rerun a command every few seconds', usage: 'watch [-n secs] <command>', run: watch },
  df: { desc: 'disk usage, including your real browser storage', usage: 'df [-h]', run: df },
  free: { desc: 'memory: device and this page', usage: 'free [-h|-m|-g]', run: free },
  nproc: { desc: 'number of CPU cores', run: () => String(navigator.hardwareConcurrency || 1) },
  lscpu: { desc: 'CPU details your browser shares', run: lscpu },
  xrandr: { desc: 'screen resolution and measured refresh rate', run: xrandr },
  ip: { desc: 'network interfaces (what the browser shares)', usage: 'ip [a|link|route]', run: (ctx) => ip(ctx, 'ip') },
  ifconfig: { desc: 'network interfaces, old style', run: (ctx) => ip(ctx, 'ifconfig') },
  jq: {
    desc: 'slice and filter JSON',
    usage: "jq [-r] [-c] [-n] [-s] <filter> [file]   e.g. curl -s api.github.com/users/vleeuwenmenno | jq .name",
    run: (ctx) => {
      const opts = { raw: false, compact: false, nullInput: false, slurp: false }
      const rest: string[] = []
      for (const a of ctx.args) {
        if (/^-[rcnsM]+$/.test(a)) for (const ch of a.slice(1)) {
          if (ch === 'r') opts.raw = true
          if (ch === 'c') opts.compact = true
          if (ch === 'n') opts.nullInput = true
          if (ch === 's') opts.slurp = true
        }
        else if (a === '--raw-output') opts.raw = true
        else if (a === '--compact-output') opts.compact = true
        else rest.push(a)
      }
      const [filter = '.', file] = rest
      const text = file ? readText(ctx, file, 'jq') : ctx.stdin ?? (opts.nullInput ? '' : null)
      if (text === null) throw new CmdError("Usage: jq [OPTIONS] FILTER [FILE]\n  pipe JSON in: curl -s api.github.com/users/vleeuwenmenno | jq '.name, .public_repos'")
      try {
        return jq(filter, text, { ...opts, color: ctx.tty })
      } catch (err) {
        if (err instanceof JqError) throw new CmdError(`jq: error: ${err.message}`)
        throw new CmdError(`jq: error: ${(err as Error).message}`)
      }
    },
  },
  sha1sum: sums('SHA-1', 'sha1sum'),
  sha256sum: sums('SHA-256', 'sha256sum'),
  sha384sum: sums('SHA-384', 'sha384sum'),
  sha512sum: sums('SHA-512', 'sha512sum'),
  md5sum: sums('MD5', 'md5sum'),
  figlet: { desc: 'big ASCII letters', usage: 'figlet [-f font] <text>   (fonts: figlet -l)', run: figletCmd },
  lolcat: {
    desc: 'rainbows, for pipes',
    usage: 'figlet hello | lolcat',
    run: (ctx) => {
      const text = ctx.args.length ? ctx.args.map((f) => readText(ctx, f, 'lolcat')).join('\n') : ctx.stdin
      if (text === null) throw new CmdError('lolcat: pipe something in: figlet hi | lolcat')
      return ctx.tty ? rainbow(plain(text)) : text
    },
  },
}

