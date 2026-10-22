// One port in front of every running test server, so a single tunnel is enough.
//
//   pnpm dev:proxy                 # http://localhost:5200  (PORT=5201 pnpm dev:proxy for another)
//
// It finds the Vite dev servers on this machine (listening TCP ports 5170-5299 owned by this user and
// served by a node/vite process) and shows them at /__dev. Two ways to reach one:
//
//   http://<port>.localhost:5200/   its own origin (own localStorage and cookies); browsers resolve
//                                   *.localhost to loopback, so it goes through the same tunnel
//   http://localhost:5200/          pick one at /__dev: sets a `devtarget` cookie and every other
//                                   path is proxied to it (works on any allowed host name, e.g. the
//                                   machine's Tailscale name behind `tailscale serve`)
//
// Only discovered ports are ever proxied (never SSH, databases, ...), the listener is loopback only,
// request bodies are never logged, and responses (SSE included) stream through unbuffered.
// Extra Host names to accept (besides localhost, 127.0.0.1, [::1] and *.localhost): ALLOWED_HOSTS=a.b,c.d.
// This machine's Tailscale name (from `tailscale status`) is accepted too, when Tailscale runs, so a
// `tailscale serve --https=5200 http://127.0.0.1:5200` makes the proxy reachable on the tailnet.
import { execFile } from 'node:child_process'
import { readFileSync, readdirSync, readlinkSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { connect } from 'node:net'
import type { Duplex } from 'node:stream'

const PORT = Number(process.env.PORT) || 5200
const RANGE: [number, number] = [5170, 5299]
const COOKIE = 'devtarget'
const EXTRA_HOSTS = (process.env.ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)

/** Adds this machine's Tailscale DNS name to EXTRA_HOSTS, if Tailscale is installed and up. */
function allowTailscaleName() {
  execFile('tailscale', ['status', '--json', '--peers=false'], { timeout: 3000 }, (err, out) => {
    if (err) return
    try {
      const name = String(JSON.parse(out)?.Self?.DNSName ?? '').replace(/\.$/, '').toLowerCase()
      if (name && !EXTRA_HOSTS.includes(name)) {
        EXTRA_HOSTS.push(name)
        console.log(`also accepting https://${name}:${PORT}/__dev (with tailscale serve)`)
      }
    } catch {
      // Not JSON: an old or broken tailscale; only the usual names then.
    }
  })
}

type Server = {
  port: number
  host: string
  pid: number
  cwd: string
  worktree: string
  branch: string
  uptime: number
  up: boolean
}

// ---------------------------------------------------------------- discovery

/** /proc/net/tcp{,6} spellings of loopback and wildcard addresses. */
const LOCAL = new Set([
  '0100007F',
  '00000000',
  '0'.repeat(32),
  '00000000000000000000000001000000',
  '0000000000000000FFFF00000100007F',
  '0000000000000000FFFF000000000000',
])

/** Listening sockets in the range: port -> {inode, host to connect to}. */
function listening(): Map<number, { inode: string; host: string }> {
  const found = new Map<number, { inode: string; host: string }>()
  const uid = process.getuid?.() ?? -1
  for (const [file, host] of [['/proc/net/tcp', '127.0.0.1'], ['/proc/net/tcp6', '::1']] as const) {
    let text = ''
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n').slice(1)) {
      const f = line.trim().split(/\s+/)
      if (f.length < 10 || f[3] !== '0A') continue // 0A = LISTEN
      const [addr, hexPort] = f[1].split(':')
      const port = parseInt(hexPort, 16)
      if (port < RANGE[0] || port > RANGE[1] || port === PORT) continue
      if (Number(f[7]) !== uid) continue
      // Loopback or wildcard only: never something bound to another interface alone.
      const local = LOCAL.has(addr.toUpperCase())
      if (!local) continue
      if (!found.has(port) || host === '127.0.0.1') found.set(port, { inode: f[9], host })
    }
  }
  return found
}

/** socket inode -> pid, for processes of this user. */
function socketOwners(inodes: Set<string>): Map<string, number> {
  const owners = new Map<string, number>()
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    let fds: string[]
    try {
      fds = readdirSync(`/proc/${name}/fd`)
    } catch {
      continue
    }
    for (const fd of fds) {
      try {
        const link = readlinkSync(`/proc/${name}/fd/${fd}`)
        const m = /^socket:\[(\d+)\]$/.exec(link)
        if (m && inodes.has(m[1])) owners.set(m[1], Number(name))
      } catch {
        // fd closed meanwhile
      }
    }
  }
  return owners
}

function uptimeOf(pid: number): number {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    const start = Number(rest[19]) / 100 // field 22, clock ticks
    const boot = Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0])
    return Math.max(0, Math.round(boot - start))
  } catch {
    return 0
  }
}

function branchOf(cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 2000 }, (err, out) => resolve(err ? '' : out.trim()))
  })
}

function responds(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpRequest({ host, port, method: 'HEAD', path: '/', headers: { host: `localhost:${port}` }, timeout: 1500 }, (res) => {
      res.resume()
      resolve(true)
    })
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve(false))
    req.end()
  })
}

async function discover(): Promise<Server[]> {
  const sockets = listening()
  if (!sockets.size) return []
  const owners = socketOwners(new Set([...sockets.values()].map((s) => s.inode)))
  const servers = await Promise.all(
    [...sockets].map(async ([port, { inode, host }]): Promise<Server | null> => {
      const pid = owners.get(inode)
      if (!pid || pid === process.pid) return null
      let cmd = ''
      let cwd = ''
      try {
        cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ')
        cwd = readlinkSync(`/proc/${pid}/cwd`)
      } catch {
        return null
      }
      if (!/vite|node/i.test(cmd)) return null
      const wt = /\/\.claude\/worktrees\/([^/]+)/.exec(cwd)
      const [branch, up] = await Promise.all([branchOf(cwd), responds(host, port)])
      const worktree = wt ? wt[1] : branch ? 'main checkout' : cwd.split('/').pop() || cwd
      return { port, host, pid, cwd, worktree, branch, uptime: uptimeOf(pid), up }
    }),
  )
  return servers.filter((s): s is Server => s !== null).sort((a, b) => a.port - b.port)
}

// Routing looks ports up often (every Vite module request): reuse a recent scan, rescan on a miss.
let cache: { at: number; servers: Server[] } = { at: 0, servers: [] }
let scanning: Promise<Server[]> | null = null
async function servers(maxAge = 0): Promise<Server[]> {
  if (Date.now() - cache.at <= maxAge) return cache.servers
  scanning ??= discover()
    .then((s) => {
      cache = { at: Date.now(), servers: s }
      return s
    })
    .finally(() => {
      scanning = null
    })
  return scanning
}
async function target(port: number): Promise<Server | null> {
  const hit = (await servers(3000)).find((s) => s.port === port)
  if (hit) return hit
  return (await servers(500)).find((s) => s.port === port) ?? null
}

// ---------------------------------------------------------------- request routing

/** The test port a request is for: `<port>.localhost` subdomain, else the cookie, else null. */
function hostName(req: IncomingMessage): string {
  const h = (req.headers.host ?? '').toLowerCase()
  return h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.replace(/:\d+$/, '')
}
function hostAllowed(name: string): boolean {
  return name === 'localhost' || name === '127.0.0.1' || name === '[::1]' || name.endsWith('.localhost') || EXTRA_HOSTS.includes(name)
}
function subdomainPort(name: string): number | null {
  const m = /^(\d+)\.localhost$/.exec(name)
  return m ? Number(m[1]) : null
}
function cookieOf(header: string | undefined, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim()
  }
  return null
}
function withoutCookie(header: string): string {
  return header.split(';').filter((p) => p.split('=')[0].trim() !== COOKIE).join(';').trim()
}
const cookiePort = (req: IncomingMessage): number | null => {
  const v = cookieOf(req.headers.cookie, COOKIE)
  return v && /^\d+$/.test(v) ? Number(v) : null
}

/** Port a request should be proxied to, or null for the dashboard. */
function routePort(req: IncomingMessage, path: string): { port: number | null; via: 'subdomain' | 'cookie' | 'none' } {
  const sub = subdomainPort(hostName(req))
  if (sub !== null) return { port: sub, via: 'subdomain' }
  if (path === '/__dev' || path.startsWith('/__dev/')) return { port: null, via: 'none' }
  const c = cookiePort(req)
  if (c !== null) return { port: c, via: 'cookie' }
  return { port: null, via: 'none' }
}

/** Headers towards the target: Host and Origin/Referer look like a direct visit to localhost:<port>. */
function outgoingHeaders(req: IncomingMessage, t: Server): [string, string][] {
  const own = new RegExp(`^https?://[^/]*`, 'i')
  const direct = `http://localhost:${t.port}`
  const out: [string, string][] = []
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const k = req.rawHeaders[i]
    let v = req.rawHeaders[i + 1]
    switch (k.toLowerCase()) {
      case 'host':
        v = `localhost:${t.port}`
        break
      case 'origin':
        v = direct
        break
      case 'referer':
        v = v.replace(own, direct)
        break
      case 'cookie':
        v = withoutCookie(v)
        if (!v) continue
        break
      case 'x-forwarded-host':
      case 'x-forwarded-for':
      case 'x-forwarded-proto':
        continue
    }
    out.push([k, v])
  }
  return out
}

function proxyHttp(req: IncomingMessage, res: ServerResponse, t: Server) {
  const headers: Record<string, string | string[]> = {}
  for (const [k, v] of outgoingHeaders(req, t)) {
    if (k.toLowerCase() === 'connection') continue
    const cur = headers[k]
    headers[k] = cur === undefined ? v : Array.isArray(cur) ? [...cur, v] : [cur, v]
  }
  const up = httpRequest({ host: t.host, port: t.port, method: req.method, path: req.url, headers }, (ures) => {
    const out: Record<string, string | string[]> = {}
    for (let i = 0; i < ures.rawHeaders.length; i += 2) {
      const k = ures.rawHeaders[i]
      let v = ures.rawHeaders[i + 1]
      if (k.toLowerCase() === 'location') v = v.replace(new RegExp(`^https?://(localhost|127\\.0\\.0\\.1|\\[::1\\]):${t.port}(?=/|$)`, 'i'), '') || '/'
      const cur = out[k]
      out[k] = cur === undefined ? v : Array.isArray(cur) ? [...cur, v] : [cur, v]
    }
    res.writeHead(ures.statusCode ?? 502, ures.statusMessage, out)
    ures.pipe(res) // streams: chunked bodies and server-sent events are never buffered
    ures.on('error', () => res.destroy())
  })
  up.on('error', () => {
    if (!res.headersSent) errorPage(req, res, t.port, 'It stopped answering.')
    else res.destroy()
  })
  res.on('close', () => up.destroy())
  req.pipe(up)
}

function proxyUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, t: Server) {
  const up = connect({ host: t.host, port: t.port })
  up.setNoDelay(true)
  up.on('connect', () => {
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`]
    for (const [k, v] of outgoingHeaders(req, t)) lines.push(`${k}: ${v}`)
    up.write(lines.join('\r\n') + '\r\n\r\n')
    if (head.length) up.write(head)
    socket.pipe(up)
    up.pipe(socket)
  })
  const close = () => {
    up.destroy()
    socket.destroy()
  }
  up.on('error', close)
  socket.on('error', close)
  up.on('close', () => socket.destroy())
  socket.on('close', () => up.destroy())
}

// ---------------------------------------------------------------- pages

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

const STYLE = `
:root{color-scheme:dark;--bg:#14161a;--panel:#1d2026;--line:#2c313a;--fg:#e6e8eb;--dim:#8d96a3;--acc:#6aa8ff;--ok:#4cc38a;--bad:#ef6a6a}
*{box-sizing:border-box}body{margin:0;padding:20px 16px;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,sans-serif}
main{max-width:980px;margin:0 auto}h1{font-size:20px;margin:0 0 4px}p{color:var(--dim);margin:0 0 16px}
a{color:var(--acc);text-decoration:none}a:hover{text-decoration:underline}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:0 0 10px}
.card.on{border-color:var(--acc)}
.top{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}.port{font-size:18px;font-weight:600}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:var(--bad)}.dot.up{background:var(--ok)}
.meta{color:var(--dim);font-size:13px;margin:4px 0 8px;word-break:break-word}.meta b{color:var(--fg);font-weight:500}
.links{display:flex;gap:8px 14px;flex-wrap:wrap;font-size:14px}
.btn{background:#26406b;color:#fff;padding:5px 12px;border-radius:6px}.btn:hover{text-decoration:none;background:#2f4f84}
.empty{padding:28px 0;text-align:center;color:var(--dim)}small{color:var(--dim)}
`

function page(title: string, body: string, status = 200): { status: number; html: string } {
  return { status, html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>` }
}

function dashboard(list: Server[], current: number | null) {
  const data = JSON.stringify({ servers: list, current }).replace(/</g, '\\u003c')
  return page(
    'Dev proxy',
    `<h1>Dev proxy</h1><p>Test servers on this machine. <span id="how"></span></p>
<div id="list"></div><p><small>Refreshes every 3 s. The pick for this address is a cookie: <a href="/__dev/clear">clear it</a>.</small></p>
<script>
let state=${data};
const list=document.getElementById('list');
const e=(s)=>String(s).replace(/[&<>"']/g,(c)=>'&#'+c.charCodeAt(0)+';');
const dur=(s)=>s<60?s+' s':s<3600?Math.floor(s/60)+' min':s<86400?Math.floor(s/3600)+' h '+Math.floor(s%3600/60)+' min':Math.floor(s/86400)+' d '+Math.floor(s%86400/3600)+' h';
const sub=(p)=>location.protocol+'//'+p+'.localhost'+(location.port?':'+location.port:'');
// <port>.localhost only resolves on the machine itself (or through a tunnel to it); on any other name
// (a Tailscale one, say) the only way in is picking a server for this address.
const h=location.hostname;
const local=h==='localhost'||h==='127.0.0.1'||h==='[::1]'||h.endsWith('.localhost');
document.getElementById('how').innerHTML=local?'Open one on its own address (best: separate storage), or pick one for plain <b>'+e(location.host)+'</b>.':'Pick one to use on <b>'+e(location.host)+'</b>.';
function draw(){
  if(!state.servers.length){list.innerHTML='<div class="empty">No test servers running</div>';return}
  list.innerHTML=state.servers.map((s)=>{
    const on=state.current===s.port;
    const pick=(to)=>'/__dev/select?port='+s.port+'&to='+encodeURIComponent(to);
    return '<div class="card'+(on?' on':'')+'"><div class="top"><span class="dot'+(s.up?' up':'')+'" title="'+(s.up?'responds':'not responding')+'"></span><span class="port">'+s.port+'</span><b>'+e(s.worktree)+'</b><span>'+(s.branch?e(s.branch):'')+'</span>'+(on?'<small>selected here</small>':'')+'</div>'
    +'<div class="meta">up '+dur(s.uptime)+' · '+(s.up?'responds':'not responding')+' · <span title="'+e(s.cwd)+'">'+e(s.cwd)+'</span></div>'
    +'<div class="links">'+(local?'<a class="btn" href="'+sub(s.port)+'/">open '+s.port+'.localhost</a><a href="'+sub(s.port)+'/play/empires">/play/empires</a>':'')
    +'<a'+(local?'':' class="btn"')+' href="'+pick('/')+'">use here: /</a><a href="'+pick('/play/empires')+'">/play/empires</a></div></div>';
  }).join('');
}
draw();
setInterval(()=>fetch('/__dev/api/servers',{cache:'no-store'}).then((r)=>r.json()).then((d)=>{state=d;draw()}).catch(()=>{}),3000);
</script>`,
  )
}

function errorPage(req: IncomingMessage, res: ServerResponse, port: number, why: string) {
  const p = page(
    'No test server',
    `<h1>Nothing on port ${port}</h1><p>${esc(why)} The test server may have been stopped or replaced.</p><p><a class="btn" href="/__dev">Back to the dev proxy</a></p>`,
    502,
  )
  send(res, p.status, p.html)
}

function send(res: ServerResponse, status: number, html: string) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(html)
}

// ---------------------------------------------------------------- server

const server = createServer(async (req, res) => {
  try {
    if (!hostAllowed(hostName(req))) {
      res.writeHead(421, { 'content-type': 'text/plain' }).end('Host not allowed')
      return
    }
    const url = new URL(req.url ?? '/', 'http://x')
    const route = routePort(req, url.pathname)

    if (route.via === 'subdomain' || route.port !== null) {
      const t = await target(route.port as number)
      if (!t) {
        if (route.via === 'cookie') {
          // A stale pick must not lock the visitor out of the dashboard.
          res.setHeader('set-cookie', `${COOKIE}=; Path=/; Max-Age=0`)
        }
        return errorPage(req, res, route.port as number, route.via === 'subdomain' ? 'No test server is running there.' : 'The server you picked is gone.')
      }
      return proxyHttp(req, res, t)
    }

    if (url.pathname === '/__dev/api/servers') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ servers: await servers(1000), current: cookiePort(req) }))
      return
    }
    if (url.pathname === '/__dev/select') {
      const port = Number(url.searchParams.get('port'))
      const to = url.searchParams.get('to') ?? '/'
      if (!(await target(port))) return errorPage(req, res, port, 'No test server is running there.')
      res.writeHead(302, { location: to.startsWith('/') && !to.startsWith('//') ? to : '/', 'set-cookie': `${COOKIE}=${port}; Path=/; SameSite=Lax`, 'cache-control': 'no-store' })
      res.end()
      return
    }
    if (url.pathname === '/__dev/clear') {
      res.writeHead(302, { location: '/__dev', 'set-cookie': `${COOKIE}=; Path=/; Max-Age=0` })
      res.end()
      return
    }
    if (url.pathname === '/' || url.pathname === '/__dev') {
      const d = dashboard(await servers(0), cookiePort(req))
      return send(res, d.status, d.html)
    }
    const p = page('Not found', `<h1>No test server selected</h1><p>Pick one on the dashboard first.</p><p><a class="btn" href="/__dev">Dev proxy</a></p>`, 404)
    send(res, p.status, p.html)
  } catch {
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' })
    res.end('Proxy error')
  }
})

server.on('upgrade', async (req, socket, head) => {
  socket.on('error', () => socket.destroy())
  try {
    if (!hostAllowed(hostName(req))) return socket.destroy()
    const route = routePort(req, new URL(req.url ?? '/', 'http://x').pathname)
    const t = route.port === null ? null : await target(route.port)
    if (!t) {
      socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
      return
    }
    proxyUpgrade(req, socket, head, t)
  } catch {
    socket.destroy()
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`dev proxy on http://localhost:${PORT}/__dev  (test servers: http://<port>.localhost:${PORT}/)`)
  allowTailscaleName()
})
