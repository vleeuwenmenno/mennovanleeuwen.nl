// Checks the Mail app's server side: the HTML sanitiser against hostile mail (server/mailhtml.ts),
// searches and invitations, and then everything server/jmap.ts does against a stand-in JMAP server
// (scripts/mail-mock.ts) through the real site server (server/index.ts, on a free port with a
// scratch DATA_DIR and a signed-in admin, who may reach the stand-in on 127.0.0.1): linking with
// discovery, mailboxes, threads, conversations, search, flags and moves, permanent deletes,
// drafts, sending, blobs, recent correspondents, push (EventSource and polling) with
// notifications and live updates, and that one user never reaches another's account.
//
//   node scripts/mail-check.ts
//
// No real accounts or mail. Exits 1 on any failure.

import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sanitizeHtml } from '../server/mailhtml.ts'
import { parseInvite } from '../server/imip.ts'
import { HOSTILE_HTML, PNG, startMockJmap } from './mail-mock.ts'

type J = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

let failed = false
const check = (what: string, test: boolean, detail?: unknown) => {
  if (test) console.log('PASS', what)
  else {
    failed = true
    console.error('FAIL', what, detail === undefined ? '' : typeof detail === 'string' ? detail.slice(0, 600) : JSON.stringify(detail).slice(0, 600))
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function waitFor(what: string, test: () => boolean | Promise<boolean>, ms = 8000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await test()) return check(what, true)
    await sleep(100)
  }
  check(`${what} (timed out)`, false)
}

// --- The sanitiser -----------------------------------------------------------------------------------

/** What must never come out of the sanitiser, whatever went in. */
function dangerous(html: string): string[] {
  const found: string[] = []
  const tests: [string, RegExp][] = [
    ['script', /<script/i],
    ['event handler', /\son[a-z]+\s*=/i],
    ['javascript: URL', /javascript:/i],
    ['vbscript: URL', /vbscript:/i],
    ['CSS expression', /expression\s*\(/i],
    ['form', /<form|<input|<button|<textarea|<select/i],
    ['meta', /<meta/i],
    ['base', /<base/i],
    ['link element', /<link/i],
    ['frame', /<i?frame/i],
    ['object or embed', /<object|<embed|<applet/i],
    ['SVG', /<svg|xlink:/i],
    ['MathML', /<math/i],
    ['srcset', /srcset/i],
    ['@import', /@import/i],
    ['@font-face', /@font-face/i],
    ['binding', /-moz-binding|behavior\s*:/i],
  ]
  for (const [name, re] of tests) if (re.test(html)) found.push(name)
  // A stylesheet holds no markup at all (nothing can end it early).
  for (const m of html.matchAll(/<style>([^]*?)<\/style>/gi)) if (m[1].includes('<')) found.push('markup inside a stylesheet')
  return found
}

/** Tags opened and closed in pairs: nothing the page puts after the mail can be swallowed by it. */
function balanced(html: string): boolean {
  const VOID = new Set(['br', 'hr', 'img', 'wbr', 'col'])
  const stack: string[] = []
  for (const m of html.matchAll(/<(\/?)([a-z0-9]+)[^>]*>/gi)) {
    const [, end, name] = m
    const n = name.toLowerCase()
    if (VOID.has(n)) continue
    if (!end) stack.push(n)
    else if (stack.pop() !== n) return false
  }
  return stack.length === 0
}

function sanitiserChecks() {
  const cid = (id: string) => (id === 'logo@x' ? '/api/mail/inline/TOKEN' : null)
  const off = sanitizeHtml(HOSTILE_HTML, { images: false, cid })
  check('hostile mail: nothing dangerous comes through', dangerous(off.html).length === 0, dangerous(off.html))
  check('hostile mail: no remote address left with images off', !/https?:\/\/(shop|tracker|evil)\.example\/[^"]*\.(png|jpg|gif|woff|css)/i.test(off.html.replace(/href="[^"]*"/g, '')), off.html)
  check('hostile mail: remote images counted as blocked', off.blocked >= 3, off.blocked)
  check('hostile mail: tracking pixels counted', off.trackers >= 1, off.trackers)
  check('hostile mail: output is balanced', balanced(off.html), off.html)
  check('hostile mail: the words survive', off.html.includes('Autumn sale!') && off.html.includes('best</b> deals') && off.html.includes('Big autumn banner'))
  check('hostile mail: body colour kept on a wrapper', /<div class="mail-body" style="background-color: #fff8f0/.test(off.html))
  check('hostile mail: safe CSS kept', off.html.includes('font-family: Georgia, serif') && off.html.includes('color: #8a2be2') && !off.html.includes('width: expression'))
  check('links: new tab, no opener or referrer, real address as tooltip', /<a href="https:\/\/shop\.example\/deals\?id=42&amp;ref=mail" target="_blank" rel="noopener noreferrer" title="https:\/\/shop\.example\/deals\?id=42&amp;ref=mail">/.test(off.html), off.html)
  check('links: a lookalike shows where it really goes', off.html.includes('title="https://evil.example/login">https://bank.example/login</a>'))
  check('links: javascript: (also with an entity tab) loses its address', /<a>Unsubscribe<\/a>/.test(off.html) && /<a>Settings<\/a>/.test(off.html))

  const on = sanitizeHtml(HOSTILE_HTML, { images: true, cid })
  check('images on: remote pictures load', on.html.includes('src="https://shop.example/banner.jpg"') && on.html.includes('url("https://shop.example/bg.png")'))
  check('images on: tracking pixels stay out', !on.html.includes('tracker.example/open.gif') && !on.html.includes('tracker.example/hidden.png') && on.trackers >= 2, on.html)
  check('images on: still nothing dangerous', dangerous(on.html).length === 0, dangerous(on.html))
  check('images on: pictures load lazily, without a referrer', /<img src="https:\/\/shop\.example\/banner\.jpg" loading="lazy" referrerpolicy="no-referrer"/.test(on.html))

  const cases: [string, string, (h: string) => boolean][] = [
    ['script in attributes', `<img src="x" onerror="alert(1)"><a href="#" onmouseover=alert(1)>x</a><div/onclick=alert(1)>y</div>`, (h) => !/on\w+=/.test(h)],
    ['javascript: hidden by entities, case and whitespace', `<a href="&#106;avascript:alert(1)">a</a><a href="JaVaScRiPt:alert(1)">b</a><a href="  javascript:alert(1)">c</a><a href="jav&#x0A;ascript:alert(1)">d</a><a href="javascript&colon;alert(1)">e</a>`, (h) => !/href/.test(h)],
    ['data: and vbscript: links', `<a href="data:text/html,<script>alert(1)</script>">a</a><a href="vbscript:msgbox(1)">b</a>`, (h) => !/href/.test(h)],
    ['CSS expression and escapes', `<p style="x:expression(alert(1))">a</p><p style="background:url(&quot;javascript:alert(1)&quot;)">b</p><p style="color:\\72 ed">c</p><p style="-moz-binding:url(x)">d</p>`, (h) => !/style=/.test(h)],
    ['CSS image-set and @import', `<style>@import 'https://evil.example/a.css'; a { background-image: image-set("https://t.example/x.png" 1x) } b{color:red}</style>`, (h) => !h.includes('image-set') && !h.includes('@import') && h.includes('b{color: red}')],
    ['style breaking out of style', `<style>a{color:red}</style><img src=x onerror=alert(1)><style>b{font-family:"</style><script>alert(1)</script>"}</style>`, (h) => dangerous(h).length === 0],
    ['srcset and background trackers', `<img srcset="https://t.example/a.png 1x"><table background="https://t.example/bg.png"><tr><td background="https://t.example/td.png">x</td></tr></table>`, (h) => !h.includes('t.example')],
    ['forms and buttons', `<form action="https://evil.example"><input type=password name=p><button formaction="https://evil.example">Go</button><textarea>secret</textarea><select><option>1</option></select></form>`, (h) => !/<form|<input|<button|textarea|<select|secret/.test(h) && h.includes('Go')],
    ['meta refresh and base', `<meta http-equiv="refresh" content="0;url=https://evil.example"><base href="https://evil.example/"><link rel=stylesheet href="https://evil.example/x.css">`, (h) => h === ''],
    ['SVG tricks', `<svg><a xlink:href="javascript:alert(1)"><text>x</text></a><animate attributeName="href" to="javascript:alert(1)"/><foreignObject><img src=x onerror=alert(1)></foreignObject></svg><svg/onload=alert(1)>`, (h) => h === ''],
    ['MathML and noscript confusion', `<math><mtext><table><mglyph><style><img src=x onerror=alert(1)></style></mglyph></table></mtext></math><noscript><p title="</noscript><img src=x onerror=alert(1)>"></p></noscript>`, (h) => dangerous(h).length === 0],
    ['comments and CDATA', `<!--><img src=x onerror=alert(1)>--><![CDATA[<script>alert(1)</script>]]><!-- a --!><b>ok</b>`, (h) => dangerous(h).length === 0],
    ['unclosed and stray tags stay balanced', `<div><table><tr><td><b>a</div></div></body></html><i>b`, (h) => balanced(h)],
    ['frames and objects', `<iframe src="https://evil.example"></iframe><frameset><frame src=x></frameset><object data=x><embed src=x></object><applet code=x></applet>`, (h) => h === ''],
    ['cid: pictures point at the message part', `<img src="cid:logo@x"><img src="cid:other@x">`, (h) => h.includes('src="/api/mail/inline/TOKEN"') && !h.includes('cid:')],
    ['data: pictures stay, other data: does not', `<img src="data:image/png;base64,iVBORw0KGgo="><img src="data:image/svg+xml;base64,PHN2Zz4=">`, (h) => h.includes('data:image/png') && !h.includes('svg')],
    ['quoted text is folded after the reply', `<p>Thanks!</p><blockquote type="cite"><p>Old words</p></blockquote>`, (h) => /<p>Thanks!<\/p><details class="mail-quote"><summary>Show quoted text<\/summary><blockquote type="cite">/.test(h) && balanced(h)],
    ['a forward (nothing before the quote) is not folded', `<div class="gmail_quote">---------- Forwarded message ---------<br>Hello</div>`, (h) => !h.includes('<details')],
    ['Outlook quotes fold to the end of their parent', `<div><p>Reply</p><div id="divRplyFwdMsg">From: x</div><p>old</p></div><p>after</p>`, (h) => /<details class="mail-quote">.*old<\/p><\/details><\/div><p>after/.test(h) && balanced(h)],
    ['text escapes stay escaped', `&lt;script&gt;alert(1)&lt;/script&gt; & <b>x</b> 5 < 6`, (h) => !h.includes('<script') && h.includes('&amp; ') && h.includes('5 &lt; 6')],
    ['deep nesting is cut off', '<div>'.repeat(5000) + 'x', (h) => (h.match(/<div>/g) ?? []).length <= 200 && balanced(h)],
  ]
  for (const [name, input, test] of cases) {
    const r = sanitizeHtml(input, { images: false, cid })
    check(`sanitiser: ${name}`, test(r.html) && dangerous(r.html).length === 0, r.html)
  }
}

function inviteChecks() {
  const ics = 'BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:x1\r\nSUMMARY:Board\\, quarterly\r\nDTSTART;TZID=Europe/Amsterdam:20260115T100000\r\nDTEND;TZID=Europe/Amsterdam:20260115T113000\r\nORGANIZER;CN="Doe, Jane":mailto:Jane@Example.test\r\nLOCATION:Room\r\n 1\r\nBEGIN:VALARM\r\nSUMMARY:not this\r\nEND:VALARM\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n'
  const inv = parseInvite(ics)
  check('invite: method, title, organiser', inv?.method === 'REQUEST' && inv.title === 'Board, quarterly' && inv.organizer?.email === 'jane@example.test' && inv.organizer?.name === 'Doe, Jane', inv)
  check('invite: a TZID time in UTC (winter, +01:00)', inv?.start === '2026-01-15T09:00:00.000Z' && inv?.end === '2026-01-15T10:30:00.000Z', inv)
  check('invite: folded lines unfolded', inv?.location === 'Room1', inv)
  const reply = parseInvite('BEGIN:VCALENDAR\nMETHOD:REPLY\nBEGIN:VEVENT\nDTSTART;VALUE=DATE:20260704\nATTENDEE;PARTSTAT=DECLINED;CN=Al:mailto:al@x.test\nEND:VEVENT\nEND:VCALENDAR')
  check('invite: a REPLY says who answered how, all-day dates', reply?.method === 'REPLY' && reply.allDay && reply.start === '2026-07-04' && reply.replies[0]?.status === 'DECLINED', reply)
  check('invite: no METHOD is not an invitation', parseInvite('BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:x\nEND:VEVENT\nEND:VCALENDAR') === null)
}

// --- The server ------------------------------------------------------------------------------------------

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, () => {
      const p = (s.address() as { port: number }).port
      s.close(() => resolve(p))
    })
  })
}

async function endToEnd() {
  const mock = await startMockJmap({ fill: 120 })
  const quiet = await startMockJmap({ fill: 0, eventSource: false })
  const data = mkdtempSync(join(tmpdir(), 'mail-check-'))
  const port = await freePort()
  const origin = `http://localhost:${port}`
  const LOGIN = 'mail-check'
  process.env.DATA_DIR = data
  const { database, encrypt, sha256 } = await import('../server/db.ts')
  const now = Date.now()
  const sid = randomBytes(24).toString('hex')
  const other = randomBytes(24).toString('hex')
  database().prepare('INSERT INTO users (id, github_id, login, github_token, created_at, updated_at) VALUES (1, 1, ?, ?, ?, ?)').run(LOGIN, encrypt('none'), now, now)
  database().prepare('INSERT INTO users (id, github_id, login, github_token, created_at, updated_at) VALUES (2, 2, ?, ?, ?, ?)').run('someone-else', encrypt('none'), now, now)
  database().prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, 1, ?, ?)').run(sha256(sid), now, now + 86400_000)
  database().prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, 2, ?, ?)').run(sha256(other), now, now + 86400_000)

  let log = ''
  const child: ChildProcess = spawn(process.execPath, ['server/index.ts'], {
    env: { ...process.env, PORT: String(port), DATA_DIR: data, MC_WATCH: 'off', NODE_ENV: 'test', GITHUB_CLIENT_ID: 'x', GITHUB_CLIENT_SECRET: 'x', ADMIN_USERS: LOGIN, MAIL_WATCH_MS: '1000', MAIL_POLL_MS: '1000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout!.on('data', (d) => (log += d))
  child.stderr!.on('data', (d) => (log += d))
  const end = Date.now() + 15_000
  while (!log.includes(`on :${port}`)) {
    if (Date.now() > end || child.exitCode !== null) throw new Error(`the server didn't start:\n${log}`)
    await sleep(50)
  }

  const call = async (method: string, path: string, body?: unknown, who = sid, headers: Record<string, string> = {}) => {
    const res = await fetch(`${origin}${path}`, { method, headers: { Cookie: `mvlos_sid=${who}`, ...(body !== undefined && !(body instanceof Uint8Array) ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body) })
    const text = await res.text()
    let json: J = {}
    try {
      json = JSON.parse(text)
    } catch {
      /* not JSON */
    }
    return { status: res.status, json, text, headers: res.headers }
  }

  try {
    // Linking: a wrong token is refused; a bare host finds the session through /.well-known/jmap.
    const bad = await call('POST', '/api/mail/accounts', { url: mock.origin, token: 'wrong' })
    check('linking: a wrong token is refused', bad.status === 400 && /refused the token/.test(bad.json.error), bad.json)
    check("linking: the server's own reason comes with a refusal", /refused the token: Bad token$/.test(bad.json.error), bad.json)
    // Fastmail's own address (the default when none is given): a token without fmu1- is refused before anything is sent.
    const notFastmail = await call('POST', '/api/mail/accounts', { token: 'hunter2-saved-password' })
    check('linking: a Fastmail token must start with fmu1-', notFastmail.status === 400 && /isn't a Fastmail API token: they start with fmu1-/.test(notFastmail.json.error) && /Manage API tokens/.test(notFastmail.json.error), notFastmail.json)
    const notFastmailUrl = await call('POST', '/api/mail/accounts', { url: 'https://api.fastmail.com/jmap/session', token: 'wrong' })
    check('linking: the same with Fastmail typed out', notFastmailUrl.status === 400 && /fmu1-/.test(notFastmailUrl.json.error), notFastmailUrl.json)
    const linkedNow = await call('POST', '/api/mail/accounts', { url: mock.origin, token: mock.token, label: 'Mock' })
    check('linking: found through /.well-known/jmap and stored', linkedNow.status === 200 && linkedNow.json.username === 'me@example.test' && linkedNow.json.url.endsWith('/jmap/session'), linkedNow.json)
    const acc = linkedNow.json.id as number
    const row = database().prepare('SELECT token FROM jmap_accounts WHERE id = ?').get(acc) as { token: string }
    check('linking: the token is stored encrypted', !!row && !row.token.includes(mock.token) && row.token.startsWith('v1.'))
    const list = await call('GET', '/api/mail/accounts')
    check('accounts: listed without the token', list.json.accounts?.length === 1 && !list.text.includes(mock.token), list.json)

    // Someone else can't reach it.
    const theirs = await call('GET', `/api/mail/${acc}/bootstrap`, undefined, other)
    check('another user gets nothing of this account', theirs.status === 404, theirs.json)
    const anon = await call('GET', `/api/mail/${acc}/bootstrap`, undefined, 'nobody')
    check('signed out gets nothing', anon.status === 401)

    const boot = await call('GET', `/api/mail/${acc}/bootstrap`)
    const boxes = boot.json.mailboxes as J[]
    const box = (role: string) => boxes.find((b) => b.role === role)?.id as string
    check('bootstrap: mailboxes with roles and unread counts', ['inbox', 'drafts', 'sent', 'archive', 'junk', 'trash'].every((r) => box(r)) && boxes.find((b) => b.role === 'inbox')!.unread > 0, boxes)
    check('bootstrap: identities and sending', boot.json.identities?.[0]?.email === 'me@example.test' && boot.json.canSend === true, boot.json.identities)

    // Threads: collapsed, newest first, paged.
    const page = await call('GET', `/api/mail/${acc}/threads?mailbox=${box('inbox')}&position=0&limit=50`)
    const rows = page.json.rows as J[]
    check('threads: a page of 50 with the total', rows.length === 50 && page.json.total === 125, { n: rows.length, total: page.json.total })
    check('threads: newest first', rows.every((r, i) => i === 0 || rows[i - 1].receivedAt >= r.receivedAt))
    const chapter = rows.find((r) => r.subject === 'Re: Draft chapter')
    check('threads: a conversation is one row, with its size', !!chapter && chapter.count === 3 && rows.filter((r) => r.threadId === chapter.threadId).length === 1, chapter)
    const next = await call('GET', `/api/mail/${acc}/threads?mailbox=${box('inbox')}&position=100&limit=50`)
    check('threads: the last page', next.json.rows.length === 25 && next.json.position === 100, next.json.position)

    // A conversation.
    const thread = await call('GET', `/api/mail/${acc}/thread/${chapter.threadId}`)
    const msgs = thread.json.messages as J[]
    check('thread: all three messages, oldest first, Sent included', msgs.length === 3 && msgs[1].mailboxIds.includes(box('sent')) && msgs[0].receivedAt < msgs[2].receivedAt, msgs?.map((m) => m.subject))
    check('thread: plain text stays text, HTML is made safe', typeof msgs[0].text === 'string' && msgs[0].html === null && msgs[2].html.includes('<details class="mail-quote">'), msgs[2]?.html)
    check('thread: reply headers come along', msgs[2].inReplyTo[0] === 'chapter-2@example.test' && msgs[0].messageId[0] === 'chapter-1@example.test')

    const shop = rows.find((r) => r.subject.startsWith('Autumn sale'))
    const hostile = (await call('GET', `/api/mail/${acc}/thread/${shop.threadId}`)).json.messages[0]
    check('hostile mail: served safe, images blocked, trackers counted', dangerous(hostile.html).length === 0 && hostile.blocked >= 3 && hostile.trackers >= 1 && hostile.images === false, { d: dangerous(hostile.html), b: hostile.blocked, t: hostile.trackers })
    const loaded = (await call('GET', `/api/mail/${acc}/message/${shop.id}?images=1`)).json
    check('Load images: remote pictures in, trackers still out', loaded.images === true && loaded.html.includes('https://shop.example/banner.jpg') && !loaded.html.includes('open.gif'), loaded.html)
    // Always for this sender: the synced choice the server reads.
    await call('PUT', '/api/state/mail', { value: { imageSenders: ['news@shop.example'] } })
    const always = (await call('GET', `/api/mail/${acc}/thread/${shop.threadId}`)).json.messages[0]
    check('Always for this sender: images load for them', always.images === true && always.html.includes('banner.jpg'))

    const invite = rows.find((r) => r.subject.startsWith('Invitation'))
    const inv = (await call('GET', `/api/mail/${acc}/thread/${invite.threadId}`)).json.messages[0]
    check('invite: read from the text/calendar part', inv.invite?.method === 'REQUEST' && inv.invite.title === 'Planning meeting, Q4' && inv.invite.start === '2026-10-20T08:00:00.000Z' && inv.invite.organizer.email === 'bob@example.test' && inv.invite.location === 'Room 4, second floor', inv.invite)

    const logos = rows.find((r) => r.subject === 'The logo files')
    const logo = (await call('GET', `/api/mail/${acc}/thread/${logos.threadId}`)).json.messages[0]
    check('cid: a small inline picture goes into the HTML as a data: URI', logo.html.includes(`src="data:image/png;base64,${PNG.toString('base64')}"`), logo.html.slice(0, 400))
    const src = /src="(\/api\/mail\/inline\/[^"]+)"/.exec(logo.html)?.[1]
    check('cid: a big one points at a sealed link', !!src, logo.html.slice(0, 400))
    check('cid: inline parts are not listed again as attachments', logo.attachments.length === 2 && logo.attachments.every((a: J) => a.name !== 'logo-small.png' && a.name !== 'poster.png'), logo.attachments)
    if (src) {
      const img = await fetch(`${origin}${src}`) // no cookie: the message frame sends none
      const bytes = Buffer.from(await img.arrayBuffer())
      check('cid: the sealed link serves the picture without a session', img.status === 200 && img.headers.get('content-type') === 'image/png' && bytes.subarray(0, PNG.length).equals(PNG) && bytes.length === PNG.length + 1_600_000 && /sandbox/.test(img.headers.get('content-security-policy') ?? ''))
      const forged = await fetch(`${origin}${src.slice(0, -6)}AAAAAA`)
      check('cid: a tampered link is refused', forged.status === 404)
    }
    const pdf = logo.attachments.find((a: J) => a.name === 'brief.pdf')
    const dl = await fetch(`${origin}/api/mail/${acc}/blob/${pdf.blobId}?name=brief.pdf&type=application/pdf`, { headers: { Cookie: `mvlos_sid=${sid}` } })
    check('attachments: downloaded through the server, as a download', dl.status === 200 && (await dl.text()) === '%PDF-1.4 mock' && /^attachment/.test(dl.headers.get('content-disposition') ?? '') && dl.headers.get('content-type') === 'application/octet-stream')
    const theirBlob = await fetch(`${origin}/api/mail/${acc}/blob/${pdf.blobId}?name=x`, { headers: { Cookie: `mvlos_sid=${other}` } })
    check('attachments: not for another user', theirBlob.status === 404)

    // Search.
    const from = await call('GET', `/api/mail/${acc}/threads?q=${encodeURIComponent('from:alice')}`)
    check('search: from:', from.json.rows.length === 1 && from.json.rows[0].subject === 'Lunch on Friday?', from.json.rows?.map((r: J) => r.subject))
    const att = await call('GET', `/api/mail/${acc}/threads?q=${encodeURIComponent('has:attachment')}`)
    check('search: has:attachment', att.json.rows.some((r: J) => r.subject === 'The logo files') && att.json.rows.every((r: J) => r.hasAttachment), att.json.rows?.map((r: J) => r.subject))
    const words = await call('GET', `/api/mail/${acc}/threads?q=${encodeURIComponent('"number 118" is:unread')}`)
    const readOne = await call('GET', `/api/mail/${acc}/threads?q=${encodeURIComponent('"number 119" is:unread')}`)
    check('search: words and is:unread', words.json.rows.length === 1 && words.json.rows[0].subject === 'Update number 118' && readOne.json.rows.length === 0, words.json.rows?.map((r: J) => r.subject))
    const spam = await call('GET', `/api/mail/${acc}/threads?q=${encodeURIComponent('prize')}`)
    check('search: Junk and Trash left out', spam.json.rows.length === 0)

    // Flags and moves.
    const lunch = rows.find((r) => r.subject === 'Lunch on Friday?')
    await call('POST', `/api/mail/${acc}/act`, { op: 'seen', threadIds: [lunch.threadId] })
    await call('POST', `/api/mail/${acc}/act`, { op: 'flag', emailIds: [lunch.id] })
    check('flags: read and flagged', !!mock.emails.get(lunch.id)!.keywords.$seen && !!mock.emails.get(lunch.id)!.keywords.$flagged)
    await call('POST', `/api/mail/${acc}/act`, { op: 'archive', threadIds: [chapter.threadId], from: box('inbox') })
    const ch = [...mock.emails.values()].filter((e) => e.threadId === chapter.threadId)
    check('archive: the conversation leaves the Inbox, its Sent reply stays', ch.filter((e) => e.mailboxIds[box('archive')]).length === 2 && ch.some((e) => e.mailboxIds[box('sent')] && !e.mailboxIds[box('archive')]) && !ch.some((e) => e.mailboxIds[box('inbox')]))
    const projects = boxes.find((b) => b.name === 'Projects').id
    await call('POST', `/api/mail/${acc}/act`, { op: 'move', threadIds: [lunch.threadId], from: box('inbox'), to: projects })
    check('move: into a folder', !!mock.emails.get(lunch.id)!.mailboxIds[projects] && !mock.emails.get(lunch.id)!.mailboxIds[box('inbox')])
    const update1 = rows.find((r) => r.subject === 'Update number 1')
    await call('POST', `/api/mail/${acc}/act`, { op: 'junk', threadIds: [update1.threadId], from: box('inbox') })
    check('junk: moved to Junk with $junk', !!mock.emails.get(update1.id)!.mailboxIds[box('junk')] && !!mock.emails.get(update1.id)!.keywords.$junk)
    const early = await call('POST', `/api/mail/${acc}/act`, { op: 'destroy', emailIds: [update1.id] })
    check('delete for good: refused outside Trash', early.status === 400 && mock.emails.has(update1.id), early.json)
    await call('POST', `/api/mail/${acc}/act`, { op: 'trash', threadIds: [update1.threadId], from: box('junk') })
    check('trash: moved to Trash', !!mock.emails.get(update1.id)!.mailboxIds[box('trash')])
    const gone = await call('POST', `/api/mail/${acc}/act`, { op: 'destroy', threadIds: [update1.threadId], from: box('trash') })
    check('delete for good: from Trash', gone.status === 200 && !mock.emails.has(update1.id), gone.json)
    const badMove = await call('POST', `/api/mail/${acc}/act`, { op: 'move', emailIds: [lunch.id], to: 'nope' })
    check('move: an unknown mailbox is refused', badMove.status === 400)

    // Blobs: upload needs the custom header.
    const bytes = new Uint8Array(Buffer.from('attachment body'))
    const noHeader = await call('POST', `/api/mail/${acc}/upload?type=text/plain`, bytes)
    check('upload: refused without X-Mail-Upload', noHeader.status === 400)
    const up = await call('POST', `/api/mail/${acc}/upload?type=text/plain`, bytes, sid, { 'X-Mail-Upload': '1', 'Content-Type': 'application/octet-stream' })
    check('upload: into the blob store', up.status === 200 && mock.blobs.get(up.json.blobId)?.data.toString() === 'attachment body', up.json)

    // Drafts: saved, replaced, discarded.
    const draft = { identityId: 'id1', to: [{ name: 'Carol Writer', email: 'carol@example.test' }], subject: 'Notes', text: 'First go', attachments: [{ blobId: up.json.blobId, type: 'text/plain', name: 'notes.txt' }] }
    const d1 = await call('POST', `/api/mail/${acc}/draft`, draft)
    const e1 = mock.emails.get(d1.json.id)
    check('draft: saved in Drafts with $draft', !!e1?.mailboxIds[box('drafts')] && !!e1.keywords.$draft && e1.attachments.length === 1, d1.json)
    const d2 = await call('POST', `/api/mail/${acc}/draft`, { ...draft, id: d1.json.id, text: 'Second go' })
    check('draft: a new save replaces the old one', !mock.emails.has(d1.json.id) && mock.emails.has(d2.json.id))
    const notDraft = await call('POST', `/api/mail/${acc}/draft`, { ...draft, id: logos.id })
    check('draft: a received message is never replaced by a save', mock.emails.has(logos.id) && notDraft.status === 200)
    await call('DELETE', `/api/mail/${acc}/draft/${notDraft.json.id}`)
    check('draft: discarded', !mock.emails.has(notDraft.json.id))
    const badAddress = await call('POST', `/api/mail/${acc}/draft`, { ...draft, to: [{ email: 'not an address' }] })
    check('draft: bad addresses refused', badAddress.status === 400)

    // Sending a reply: submitted, into Sent, the draft gone, the original answered.
    const sent = await call('POST', `/api/mail/${acc}/send`, { ...draft, id: d2.json.id, subject: 'Re: Draft chapter', text: 'Sending now', replyOf: msgs[2].id, inReplyTo: msgs[2].messageId, references: [...msgs[2].references, ...msgs[2].messageId] })
    const out = mock.emails.get(sent.json.id)
    check('send: submitted with the identity', sent.status === 200 && mock.submissions.length === 1 && mock.submissions[0].identityId === 'id1' && mock.submissions[0].to[0].email === 'carol@example.test', sent.json)
    check('send: moved to Sent, no longer a draft', !!out?.mailboxIds[box('sent')] && !out.mailboxIds[box('drafts')] && !out.keywords.$draft, out?.mailboxIds)
    check('send: the draft it came from is gone', !mock.emails.has(d2.json.id))
    check('send: the original is marked answered', !!mock.emails.get(msgs[2].id)?.keywords.$answered)
    check('send: one request for create + submit (back-reference)', mock.calls.join(',').includes('Email/set,EmailSubmission/set'))
    const nobody = await call('POST', `/api/mail/${acc}/send`, { ...draft, to: [] })
    check('send: refused without recipients', nobody.status === 400 && mock.submissions.length === 1)

    // Recent correspondents.
    const sug = await call('GET', `/api/mail/${acc}/suggest?q=car`)
    check('suggest: recent correspondents', sug.json.people?.[0]?.email === 'carol@example.test', sug.json)
    const own = await call('GET', `/api/mail/${acc}/suggest?q=me@`)
    check('suggest: not your own address', !own.json.people.some((p: J) => p.email === 'me@example.test'), own.json)

    // Push: the EventSource is open; new mail becomes a notification and pages hear of it.
    await waitFor('push: the EventSource is open', () => mock.streams() >= 1, 10_000)
    const stream = await fetch(`${origin}/api/notifications/stream?page=mail-check-page`, { headers: { Cookie: `mvlos_sid=${sid}` } })
    const reader = stream.body!.pipeThrough(new TextDecoderStream()).getReader()
    let heard = ''
    void (async () => {
      for (;;) {
        const { done, value } = await reader.read().catch(() => ({ done: true, value: '' }))
        if (done) break
        heard += value
      }
    })()
    // Out of view, so the hub would push rather than pop up.
    await call('POST', '/api/notifications/presence', { page: 'mail-check-page', visible: false })
    const fresh = mock.deliver({ from: [{ name: 'Erin Sender', email: 'erin@example.test' }], subject: 'Hello from push', text: 'This just arrived.' })
    await waitFor('push: a notification for the new mail', async () => ((await call('GET', '/api/notifications')).json.entries as J[]).some((e) => e.source === 'mail.new' && e.title === 'Erin Sender' && /Hello from push/.test(e.body) && e.action?.props?.email === fresh.id))
    await waitFor('push: open pages are told (event: mail)', () => /event: mail\ndata: \{"account":\d+\}/.test(heard))
    // The same message once only, even after a restart of the line.
    mock.deliver({ subject: 'Seen already', seen: true })
    await sleep(1500)
    const entries = (await call('GET', '/api/notifications')).json.entries as J[]
    check('push: read mail and repeats do not notify', entries.filter((e) => e.source === 'mail.new').length === 1, entries.map((e) => e.title))
    // Switched off in Settings → Notifications: no more.
    await call('PUT', '/api/state/notify', { value: { off: ['mail'] } })
    mock.deliver({ subject: 'Muted' })
    await sleep(1500)
    check('push: switched off, nothing', ((await call('GET', '/api/notifications')).json.entries as J[]).filter((e) => e.source === 'mail.new').length === 1)
    await call('PUT', '/api/state/notify', { value: { off: [] } })

    // Polling: a server without an EventSource.
    const polled = await call('POST', '/api/mail/accounts', { url: quiet.sessionUrl, token: quiet.token, label: 'Quiet' })
    check('polling: a second account linked', polled.status === 200, polled.json)
    await sleep(2500) // its first look sets where things stand
    quiet.deliver({ from: [{ name: 'Polly Poll', email: 'polly@example.test' }], subject: 'Found by polling' })
    await waitFor('polling: new mail found without push', async () => ((await call('GET', '/api/notifications')).json.entries as J[]).some((e) => e.title === 'Polly Poll'), 10_000)
    check('polling: no EventSource was opened there', quiet.streams() === 0)

    // Unlinking.
    const del = await call('DELETE', `/api/mail/accounts/${acc}`)
    const after = await call('GET', `/api/mail/${acc}/bootstrap`)
    check('unlink: the account is gone', del.status === 200 && after.status === 404)
    await waitFor('unlink: its push line closes', () => mock.streams() === 0, 5000)
    reader.cancel().catch(() => {})
  } finally {
    child.kill('SIGTERM')
    await new Promise((r) => child.once('exit', r))
    await mock.close()
    await quiet.close()
    rmSync(data, { recursive: true, force: true })
  }
  if (/Something went wrong|TypeError|ReferenceError/.test(log)) check('the server logged no errors', false, log)
}

sanitiserChecks()
inviteChecks()
await endToEnd()
console.log(failed ? 'FAILED' : 'all passed')
process.exit(failed ? 1 : 0)
