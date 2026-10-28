// Checks the Agents app's mail tools (server/agentMail.ts) end to end, through the real site server
// (server/index.ts, on a free port with a scratch DATA_DIR and two signed-in admins, who may reach
// the stand-ins on 127.0.0.1), a stand-in JMAP server (scripts/mail-mock.ts) and a stand-in for
// Ollama that plays scripted tool calls (as in scripts/agents-permissions.ts). It goes through:
//
//   - no mail account: no mail tools offered, and the prompt says how to link one;
//   - the Mail group on by default, for new threads and for threads stored before it existed, and
//     the prompt naming the accounts and saying every call waits;
//   - every mail tool asking in Ask first, Auto, Edits allowed and Bypass, Plan offering only the
//     reads (which ask too), and Auto's safety check model never called;
//   - declined: nothing sent, drafted or changed; allowed: what goes out is exactly what the
//     card showed (To, Subject, body), replies threaded;
//   - made-up ids, another user's account and bad addresses refused before anyone is asked;
//   - "Allow mail reads for 15 min" (shortened here with MAIL_READ_GRANT_MS): only from a read's
//     card, it lets reads run without a card in that thread in every mode, Plan too, while drafts,
//     sends and changes still ask; other threads still ask; it ends when revoked or run out, and
//     can't be made from a write's card, a declined card, or by another user;
//   - mail reads always allowed (a per-user setting, Ask by default): on from a read's card or the
//     setting, reads run without a card in every thread and mode, while drafts, sends and changes
//     still ask; not from a write's card; per user; back to Ask brings the cards back.
//
//   node scripts/agents-mail-check.ts
//
// No real accounts or mail. Exits 1 on any failure.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { Server, check, finish, sleep } from './empires-harness.ts'
import { startMockJmap } from './mail-mock.ts'
import { asPage } from './as-page.ts'

type J = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

// --- The stand-in for Ollama: scripted turns ------------------------------------------------------
//
// The user's message is "SCENARIO <name> <arg>"; each round plays the next step, which may read the
// tool results so far. `arg` is split on | for steps that need more than one value.

const MODEL = 'main-model'
type Message = { role: string; content: string }
type ChatBody = { model: string; messages: Message[]; stream?: boolean; format?: { properties?: Record<string, unknown> }; tools?: { function: { name: string } }[] }
type Call = { name: string; arguments: J }
type Step = (results: J[], arg: string[]) => Call[] | null
const SEND = { to: ['Ann Example <ann@example.test>', 'bob@example.test'], subject: 'Plans for Friday', body: 'Hi Ann,\n\nShall we meet at 12:30 on Friday?\n\nCheers' }
const SCENARIOS: Record<string, Step[]> = {
  // Every mail tool in one reply (ids given in the message).
  all: [
    (_, [msg, thread]) => [
      { name: 'mail_list_accounts', arguments: {} },
      { name: 'mail_search', arguments: { query: 'lunch' } },
      { name: 'mail_read', arguments: { message_id: msg } },
      { name: 'mail_draft', arguments: { to: ['ann@example.test'], subject: 'A draft', body: 'Draft text' } },
      { name: 'mail_send', arguments: SEND },
      { name: 'mail_update', arguments: { action: 'archive', thread_ids: [thread] } },
    ],
  ],
  reads: [(_, [msg]) => [{ name: 'mail_search', arguments: { query: 'lunch' } }, { name: 'mail_read', arguments: { message_id: msg } }]],
  send: [() => [{ name: 'mail_send', arguments: SEND }]],
  // Search, then answer the first hit.
  reply: [() => [{ name: 'mail_search', arguments: { query: 'subject:"Lunch on Friday"' } }], (r) => [{ name: 'mail_send', arguments: { reply_to: r[0]?.results?.[0]?.conversations?.[0]?.message_id ?? 'none', body: 'Friday works for me.' } }]],
  read: [(_, [msg]) => [{ name: 'mail_read', arguments: { message_id: msg } }]],
  thread: [(_, [thread]) => [{ name: 'mail_read', arguments: { thread_id: thread } }]],
  update: [(_, [action, msg, mailbox]) => [{ name: 'mail_update', arguments: { action, message_ids: [msg], ...(mailbox ? { mailbox } : {}) } }]],
  badsend: [(_, [to]) => [{ name: 'mail_send', arguments: { to: [to], subject: 'x', body: 'y' } }]],
  draft: [() => [{ name: 'mail_draft', arguments: { to: ['ann@example.test'], subject: 'A draft', body: 'Draft text' } }]],
  none: [],
}
const mains: ChatBody[] = []
const checks: ChatBody[] = []

const json = (res: ServerResponse, body: unknown) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
const reply = (res: ServerResponse, msg: { content?: string; tool_calls?: unknown[] }) => {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
  res.write(`${JSON.stringify({ model: MODEL, message: { role: 'assistant', content: '', ...msg }, done: false })}\n`)
  res.end(`${JSON.stringify({ model: MODEL, message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 100, eval_count: 10 })}\n`)
}
function chat(body: ChatBody, res: ServerResponse) {
  // The safety check model (Auto's web address check): structured output with a verdict.
  if (body.format?.properties?.verdict) {
    checks.push(body)
    return json(res, { model: body.model, message: { role: 'assistant', content: JSON.stringify({ verdict: 'safe', reason: 'ok' }) }, done: true })
  }
  if (body.stream === false) return json(res, { model: body.model, message: { role: 'assistant', content: '{"title":"Mail check"}' }, done: true })
  mains.push(body)
  const at = body.messages.map((m) => m.role === 'user' && m.content.startsWith('SCENARIO ')).lastIndexOf(true)
  const [, name, arg = ''] = (body.messages[at]?.content ?? '').split(' ')
  const after = body.messages.slice(at + 1)
  const round = after.filter((m) => m.role === 'assistant').length
  const results = after.filter((m) => m.role === 'tool').map((m) => {
    try {
      return JSON.parse(m.content) as J
    } catch {
      return {}
    }
  })
  const calls = SCENARIOS[name]?.[round]?.(results, arg.split('|'))
  if (calls) return reply(res, { tool_calls: calls.map((c) => ({ function: c })) })
  return reply(res, { content: `FINAL ${name}` })
}
const ollama = createServer((req: IncomingMessage, res: ServerResponse) => {
  let raw = ''
  req.on('data', (d) => (raw += d))
  req.on('end', () => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    if (path === '/api/tags') return void json(res, { models: [{ name: MODEL }] })
    if (path === '/api/show') return void json(res, { capabilities: ['completion', 'tools'], model_info: { 'x.context_length': 131072 } })
    if (path === '/api/chat') return chat(JSON.parse(raw) as ChatBody, res)
    res.writeHead(404).end()
  })
})
await new Promise<void>((r) => ollama.listen(0, '127.0.0.1', r))

// --- Stand-ins and the site -------------------------------------------------------------------------

const mock = await startMockJmap({ fill: 5, eventSource: false })
const GRANT_MS = 8000
const LOGIN = 'mail-agent-check'
const OTHER = 'mail-agent-other'
const server = new Server({
  GITHUB_CLIENT_ID: 'x',
  GITHUB_CLIENT_SECRET: 'x',
  ADMIN_GITHUB_IDS: '1,2',
  NOTIFY_WATCH: 'off',
  MAIL_POLL_MS: '600000',
  OLLAMA_URL: `http://127.0.0.1:${(ollama.address() as { port: number }).port}`,
  OLLAMA_API_KEY: 'fake-key',
  // Mail reads allowed "for 15 minutes" last this long here, so running out can be checked.
  MAIL_READ_GRANT_MS: String(GRANT_MS),
})
process.env.DATA_DIR = server.data
const { database, encrypt, sha256 } = await import('../server/db.ts')
const now = Date.now()
const sid = randomBytes(24).toString('hex')
const otherSid = randomBytes(24).toString('hex')
database().prepare('INSERT INTO users (id, github_id, login, github_token, created_at, updated_at) VALUES (1, 1, ?, ?, ?, ?)').run(LOGIN, encrypt('none'), now, now)
database().prepare('INSERT INTO users (id, github_id, login, github_token, created_at, updated_at) VALUES (2, 2, ?, ?, ?, ?)').run(OTHER, encrypt('none'), now, now)
database().prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, 1, ?, ?)').run(sha256(sid), now, now + 86400_000)
database().prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, 2, ?, ?)').run(sha256(otherSid), now, now + 86400_000)
await server.start()

const call = async <T = J>(who: string, method: string, path: string, body?: unknown): Promise<T> => {
  const res = await fetch(`${server.origin}${path}`, { method, headers: { Cookie: `mvlos_sid=${who}`, ...(await asPage(who)), 'Content-Type': 'application/json', Origin: server.origin }, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 400)}`)
  return (text ? JSON.parse(text) : {}) as T
}
const api = <T = J>(method: string, path: string, body?: unknown) => call<T>(sid, method, path, body)
const newThread = (permission: string, extra: J = {}) => api('POST', '/api/agents/threads', { model: MODEL, mode: 'quick', permission, ...extra })

/**
 * One turn, read as it streams; each approval answered by `allow` (an object: that answer as sent,
 * `always` and all). Answers the approvals asked and the turn's tool results.
 */
async function turn(id: string, text: string, allow: boolean | J | ((e: J) => boolean | J), who = sid) {
  const asked: J[] = []
  let granted = false
  const res = await fetch(`${server.origin}/api/agents/threads/${id}/messages`, { method: 'POST', headers: { Cookie: `mvlos_sid=${who}`, ...(await asPage(who)), 'Content-Type': 'application/json', Origin: server.origin }, body: JSON.stringify({ text, zone: 'Europe/Amsterdam' }) })
  if (!res.ok) throw new Error(`turn: ${res.status} ${await res.text()}`)
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let error: string | null = null
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let nl
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line) continue
      const e = JSON.parse(line) as J
      if (e.type === 'error') error = e.error
      if (e.type === 'approval') {
        asked.push(e)
        const given = typeof allow === 'function' ? allow(e) : allow
        // "Allow from now on" is offered nowhere for mail: even if asked for, it must not stick.
        const body = typeof given === 'object' ? given : { allow: given, ...(given ? { always: 'domain' } : {}) }
        if (body.always === 'mail_reads' || body.always === 'mail_reads_always') granted = true
        // Mail reads allowed answer the other reads waiting: those may be gone by the time they're answered.
        void call(who, 'POST', `/api/agents/threads/${id}/approve`, { callId: e.callId, ...body }).catch((err: Error) => check(`answering an approval worked (${err.message})`, granted && /404/.test(err.message)))
      }
    }
  }
  const t = await call(who, 'GET', `/api/agents/threads/${id}`)
  const last = (t.messages as J[]).map((m) => m.role).lastIndexOf('user')
  const tools = (t.messages as J[]).slice(last + 1).filter((m) => m.role === 'tool')
  const result = (name: string) => JSON.parse(tools.find((m) => m.toolName === name)?.content ?? '{}') as J
  return { asked, tools, result, error, thread: t.thread as J }
}
const names = (asked: J[]) => asked.map((a) => a.call?.name).sort().join(', ')
const MAIL = ['mail_draft', 'mail_list_accounts', 'mail_read', 'mail_search', 'mail_send', 'mail_update']
const sends = () => mock.methodCalls.filter(([m, a]) => m === 'Email/set' || m === 'EmailSubmission/set' || (m === 'Email/import' && a))
const lastPrompt = () => mains.at(-1)?.messages[0]?.content ?? ''
const lastOffered = () => (mains.at(-1)?.tools ?? []).map((t) => t.function.name)

try {
  // 1. No mail account yet: the group is on, but no mail tool is offered, and the prompt says how to link one.
  const bare = await newThread('default')
  check(`a new thread has the Mail group on (${bare.tools.join(', ')})`, bare.tools.includes('mail'))
  let t = await turn(bare.id, 'SCENARIO read 1.Mxyz', true)
  check(`no account: no mail tool is offered (${lastOffered().filter((n) => n.startsWith('mail_')).join(', ') || 'none'})`, !lastOffered().some((n) => n.startsWith('mail_')))
  check('no account: the prompt says to link one in Settings → Integrations → Mail', /no mail account is linked/i.test(lastPrompt()) && lastPrompt().includes('Settings → Integrations → Mail'))
  check(`no account: a mail call is refused without asking (${t.result('mail_read').error})`, !t.asked.length && /switched off/.test(t.result('mail_read').error ?? ''))

  // 2. Link the stand-in account (the user's), and another one for the other user.
  const linked = await api('POST', '/api/mail/accounts', { url: mock.sessionUrl, token: mock.token, label: 'Fastmail' })
  const theirs = await call(otherSid, 'POST', '/api/mail/accounts', { url: mock.sessionUrl, token: mock.token, label: 'Theirs' })
  check(`the accounts are linked (${linked.id}, ${theirs.id})`, typeof linked.id === 'number' && typeof theirs.id === 'number' && linked.id !== theirs.id)
  const lunch = [...mock.emails.values()].find((e) => e.subject === 'Lunch on Friday?')!
  const shop = [...mock.emails.values()].find((e) => e.subject.startsWith('Autumn sale'))!
  const chapter = [...mock.emails.values()].find((e) => e.subject === 'Draft chapter')!
  const MSG = `${linked.id}.${lunch.id}`
  const THREAD = `${linked.id}.${lunch.threadId}`

  // 3. Threads from before the Mail group: a bare stored list knew nothing of it, so it is on (as
  // are the groups added after it: images, gpt_images, threads; LATER_GROUPS in server/agents.ts);
  // a list stored since that leaves it out keeps it off. Web and skills are always on in chat threads.
  const old = randomUUID()
  database().prepare("INSERT INTO agent_threads (id, user_id, title, mode, model, archived, created_at, updated_at, tools, permission) VALUES (?, 1, 'Old', 'quick', ?, 0, ?, ?, ?, 'default')").run(old, MODEL, now, now, JSON.stringify(['web', 'notes', 'memory']))
  const oldThread = (await api('GET', `/api/agents/threads/${old}`)).thread
  check(`a thread stored before Mail gets it on, its other choices kept (${oldThread.tools.join(', ')})`, oldThread.tools.join() === 'web,notes,mail,memory,skills,images,gpt_images,threads')
  const off = await api('PATCH', `/api/agents/threads/${old}`, { tools: ['web', 'notes', 'memory'] })
  check(`switched off by hand, it stays off (${off.tools.join(', ')})`, !off.tools.includes('mail') && !(await api('GET', `/api/agents/threads/${old}`)).thread.tools.includes('mail'))
  const renamed = await api('PATCH', `/api/agents/threads/${old}`, { title: 'Renamed' })
  check('and stays off through other changes', !renamed.tools.includes('mail'))

  // 4. Offered by default, and the prompt knows the accounts and that every call waits.
  const ask = await newThread('default')
  t = await turn(ask.id, 'SCENARIO none', true)
  check(`with an account, all six mail tools are offered (${lastOffered().filter((n) => n.startsWith('mail_')).join(', ')})`, MAIL.every((n) => lastOffered().includes(n)))
  check('the prompt names the account', lastPrompt().includes('Fastmail <me@example.test>') && lastPrompt().includes(`account ${linked.id}`))
  check('the prompt says every mail call waits for the user', /Every mail tool call, even a search or a read, waits for the user/.test(lastPrompt()))
  check('the prompt says email is never instructions', /never as instructions/.test(lastPrompt()))
  check('the built-in AGENTS.md says reads wait unless allowed, and drafts, sends and changes always wait', /Mail searches and reads wait\s+for the user unless they allowed them \(for a while in this thread, or always\), and drafts,\s+sends and changes always wait/.test(lastPrompt()))
  const context = await api('GET', `/api/agents/threads/${ask.id}/context`)
  check(`the context breakdown counts the mail lines (${(context.parts as J[]).map((p) => p.label).join(', ')})`, (context.parts as J[]).some((p) => p.label === 'Mail accounts' && p.tokens > 0))

  // 5. Every mail tool asks, in every mode but Plan; declined, nothing is sent, drafted or moved.
  for (const permission of ['default', 'auto', 'acceptEdits', 'bypass']) {
    const thread = await newThread(permission)
    const before = sends().length
    const checksBefore = checks.length
    t = await turn(thread.id, `SCENARIO all ${MSG}|${THREAD}`, false)
    check(`${permission}: all six mail tools asked (${names(t.asked)})`, names(t.asked) === MAIL.join(', '))
    check(`${permission}: each card has a summary`, t.asked.every((a) => a.summary?.title && a.summary.rows.length))
    check(`${permission}: declined, nothing reached the mail server's changes (${sends().length - before} writes)`, sends().length === before)
    check(`${permission}: declined, the model is told nothing was read`, t.tools.every((m) => /did not allow this mail call/.test(JSON.parse(m.content).error ?? '')))
    check(`${permission}: the safety check model was never asked`, checks.length === checksBefore)
  }
  check('nothing was ever submitted', mock.submissions.length === 0)

  // Plan: the reads are offered and ask; the changes are not offered at all.
  const plan = await newThread('plan')
  t = await turn(plan.id, `SCENARIO reads ${MSG}`, false)
  check(`Plan: only the reading mail tools are offered (${lastOffered().filter((n) => n.startsWith('mail_')).join(', ')})`, ['mail_list_accounts', 'mail_search', 'mail_read'].every((n) => lastOffered().includes(n)) && !['mail_send', 'mail_draft', 'mail_update'].some((n) => lastOffered().includes(n)))
  check(`Plan: the reads ask (${names(t.asked)})`, names(t.asked) === 'mail_read, mail_search')
  t = await turn(plan.id, 'SCENARIO send', true)
  check(`Plan: a send is refused without asking (${JSON.stringify(t.result('mail_send')).slice(0, 80)})`, !t.asked.length && !!t.result('mail_send').error && mock.submissions.length === 0)

  // 6. Cards that read well: the search, the read, the send.
  const auto = await newThread('auto')
  t = await turn(auto.id, `SCENARIO all ${MSG}|${THREAD}`, false)
  const card = (name: string) => t.asked.find((a) => a.call?.name === name)?.summary as { title: string; rows: [string, string][]; body?: string }
  const row = (name: string, label: string) => card(name)?.rows.find(([l]) => l === label)?.[1] ?? ''
  check(`search card: the query and the account (${card('mail_search').title})`, card('mail_search').title.includes('lunch') && row('mail_search', 'Account').includes('me@example.test'))
  check(`read card: the subject and the sender (${card('mail_read').title} / ${row('mail_read', 'From')})`, card('mail_read').title.includes('Lunch on Friday?') && row('mail_read', 'From').includes('alice@example.test'))
  check(`send card: To, Subject and the whole body (${row('mail_send', 'To')})`, row('mail_send', 'To') === 'Ann Example <ann@example.test>, bob@example.test' && row('mail_send', 'Subject') === SEND.subject && card('mail_send').body === SEND.body && row('mail_send', 'From').includes('me@example.test'))
  check(`update card: which conversation (${row('mail_update', 'Mail')})`, card('mail_update').title.startsWith('Archive') && row('mail_update', 'Mail').includes('Lunch on Friday?'))

  // 7. Allowed: it sends exactly what the card showed.
  t = await turn(ask.id, 'SCENARIO send', true)
  const shown = t.asked[0]?.summary
  const made = mock.methodCalls.filter(([m, a]) => m === 'Email/set' && a.create?.draft).at(-1)?.[1]?.create?.draft as J | undefined
  check(`allowed: one submission (${mock.submissions.length})`, mock.submissions.length === 1)
  check(`allowed: To matches the card (${JSON.stringify(made?.to)})`, !!made && made.to.map((a: J) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(', ') === shown?.rows.find(([l]: string[]) => l === 'To')?.[1])
  check(`allowed: Subject matches the card (${made?.subject})`, made?.subject === SEND.subject && made?.subject === shown?.rows.find(([l]: string[]) => l === 'Subject')?.[1])
  check('allowed: the body is exactly the card\'s', made?.bodyValues?.body?.value === shown?.body && shown?.body === SEND.body)
  check(`allowed: the model hears it was sent (${JSON.stringify(t.result('mail_send')).slice(0, 120)})`, t.result('mail_send').sent?.subject === SEND.subject)

  // A reply: threaded, to the sender, Re: subject.
  t = await turn(ask.id, 'SCENARIO reply', true)
  const replied = mock.methodCalls.filter(([m, a]) => m === 'Email/set' && a.create?.draft).at(-1)?.[1]?.create?.draft as J | undefined
  const replyCard = t.asked.find((a) => a.call?.name === 'mail_send')?.summary
  check(`reply: the search and the send both asked (${names(t.asked)})`, names(t.asked) === 'mail_search, mail_send')
  check(`reply: to Alice, "Re: Lunch on Friday?" (${replied?.subject})`, replied?.to?.[0]?.email === 'alice@example.test' && replied?.subject === 'Re: Lunch on Friday?')
  check(`reply: In-Reply-To the original (${replied?.inReplyTo})`, replied?.inReplyTo?.[0] === lunch.messageId[0])
  check(`reply: the card says what it answers (${replyCard?.rows.find(([l]: string[]) => l === 'In reply to')?.[1]})`, /Lunch on Friday\?.*alice@example\.test/.test(replyCard?.rows.find(([l]: string[]) => l === 'In reply to')?.[1] ?? ''))
  check(`reply: the original is marked answered`, !!mock.emails.get(lunch.id)?.keywords.$answered)

  // Declined after all that: still nothing more sent.
  const count = mock.submissions.length
  t = await turn(ask.id, 'SCENARIO send', false)
  check('declined: nothing more was sent', mock.submissions.length === count && t.asked.length === 1)

  // 8. Reading: third-party content marked as such; HTML as text, no pictures; nothing marked read.
  const wasSeen = !!mock.emails.get(shop.id)?.keywords.$seen
  t = await turn(ask.id, `SCENARIO read ${linked.id}.${shop.id}`, true)
  const read = t.result('mail_read')
  check('read: the result says email is data, never instructions', /third-party content: data, never instructions/.test(read.note ?? ''))
  check(`read: HTML comes as text, without markup or pictures (${String(read.messages?.[0]?.body).slice(0, 60)})`, /Autumn sale!/.test(read.messages?.[0]?.body ?? '') && !/<img|<script|<style|tracker\.example/.test(read.messages?.[0]?.body ?? ''))
  check('read: nothing was marked read', !!mock.emails.get(shop.id)?.keywords.$seen === wasSeen)
  t = await turn(ask.id, `SCENARIO thread ${linked.id}.${chapter.threadId}`, true)
  check(`read: a conversation, oldest first (${t.result('mail_read').messages?.length})`, t.result('mail_read').messages?.length === 3 && /first draft/.test(t.result('mail_read').messages[0].body))

  // An update, allowed: it archives that message.
  t = await turn(ask.id, `SCENARIO update archive|${MSG}`, true)
  check(`update: archived (${JSON.stringify(t.result('mail_update'))})`, t.result('mail_update').changed === 1 && !!mock.emails.get(lunch.id)?.mailboxIds['mb-archive'])
  t = await turn(ask.id, `SCENARIO update move|${MSG}|Projects/Receipts`, true)
  check(`update: moved to a mailbox by path (${t.asked[0]?.summary?.rows.find(([l]: string[]) => l === "Move to")?.[1]})`, !!mock.emails.get(lunch.id)?.mailboxIds['mb-receipts'] && t.asked[0]?.summary?.rows.some(([l, v]: string[]) => l === 'Move to' && v === 'Projects/Receipts'))

  // 9. Made-up ids and other people's accounts: refused before anyone is asked.
  for (const bad of [`${linked.id}.Mnotreal`, '999.M1', 'not-an-id', `${theirs.id}.${lunch.id}`]) {
    t = await turn(ask.id, `SCENARIO read ${bad}`, true)
    check(`made-up id ${bad}: refused without asking (${t.result('mail_read').error})`, !t.asked.length && !!t.result('mail_read').error)
  }
  t = await turn(ask.id, `SCENARIO update trash|${linked.id}.Mnotreal`, true)
  check(`a made-up id to trash: refused without asking (${t.result('mail_update').error})`, !t.asked.length && /Not found/.test(t.result('mail_update').error ?? ''))
  t = await turn(ask.id, 'SCENARIO badsend not-an-address', true)
  check(`a bad address: refused without asking (${t.result('mail_send').error})`, !t.asked.length && /not an email address/.test(t.result('mail_send').error ?? ''))
  t = await turn(ask.id, `SCENARIO update move|${MSG}|Nowhere`, true)
  check(`an unknown mailbox: refused without asking (${t.result('mail_update').error?.slice(0, 60)})`, !t.asked.length && /no mailbox/.test(t.result('mail_update').error ?? ''))

  // 10. Mail reads for a while (GRANT_MS here, 15 minutes for real).
  const GRANT = { allow: true, always: 'mail_reads' }
  const ran = (r: Awaited<ReturnType<typeof turn>>, name: string) => r.tools.some((m) => m.toolName === name && !JSON.parse(m.content).error)
  const grantOf = async (id: string) => (await api('GET', `/api/agents/threads/${id}`)).thread.mailReadsUntil as number | null
  const g = await newThread('default')
  const h = await newThread('default')
  check('a new thread has no mail reads allowed', g.mailReadsUntil === null)
  // Given from a read's card: both reads of that reply run (the other card is answered with it).
  let at = Date.now()
  t = await turn(g.id, `SCENARIO reads ${MSG}`, (e) => (e.call?.name === 'mail_search' ? GRANT : true))
  let until = await grantOf(g.id)
  check(`given from a search card: the thread says until when (${until && until - at} ms)`, !!until && until >= at + GRANT_MS - 50 && until <= Date.now() + GRANT_MS + 50)
  check(`given: the search and the read both ran (${names(t.asked)})`, ran(t, 'mail_search') && ran(t, 'mail_read'))
  check('given: the window hears of it as it happens', t.thread.mailReadsUntil === until)
  // Every mode, Plan included: reads run without a card, and say why on their row.
  for (const permission of ['default', 'auto', 'acceptEdits', 'bypass', 'plan']) {
    await api('PATCH', `/api/agents/threads/${g.id}`, { permission })
    const checksBefore = checks.length
    t = await turn(g.id, `SCENARIO reads ${MSG}`, false)
    check(`given, ${permission}: reads ran without a card (${names(t.asked) || 'none asked'})`, !t.asked.length && ran(t, 'mail_search') && ran(t, 'mail_read'))
    check(`given, ${permission}: their rows say why`, t.tools.every((m) => /allowed mail reads/.test(m.checked ?? '')))
    check(`given, ${permission}: the prompt says reads run until then, and the rest still asks`, /allowed mail reads in this thread until [0-9]{2}:[0-9]{2}/.test(lastPrompt()) && /mail_draft, mail_send and mail_update still wait for the user/.test(lastPrompt()))
    check(`given, ${permission}: the safety check model was never asked`, checks.length === checksBefore)
  }
  // Drafts, sends and changes still ask, Bypass too.
  for (const permission of ['default', 'bypass']) {
    await api('PATCH', `/api/agents/threads/${g.id}`, { permission })
    const before = sends().length
    t = await turn(g.id, `SCENARIO all ${MSG}|${THREAD}`, false)
    check(`given, ${permission}: the writes still asked, the reads did not (${names(t.asked)})`, names(t.asked) === 'mail_draft, mail_send, mail_update' && ran(t, 'mail_read') && ran(t, 'mail_search') && ran(t, 'mail_list_accounts'))
    check(`given, ${permission}: declined, nothing written`, sends().length === before)
  }
  check(`given: all that within its time (${until! - Date.now()} ms left)`, until! > Date.now())
  // Other threads still ask.
  t = await turn(h.id, `SCENARIO read ${MSG}`, false)
  check(`another thread still asks (${names(t.asked)})`, names(t.asked) === 'mail_read')
  // Not from a write's card (allowed), a declined read card, a made-up card, or another user.
  t = await turn(h.id, 'SCENARIO draft', GRANT)
  check(`a write's card can't give it: the draft asked and was saved (${t.result('mail_draft').error ?? 'saved'}), nothing more`, names(t.asked) === 'mail_draft' && !t.result('mail_draft').error && (await grantOf(h.id)) === null)
  t = await turn(h.id, `SCENARIO read ${MSG}`, { allow: false, always: 'mail_reads' })
  check('a declined read card gives nothing', names(t.asked) === 'mail_read' && !!t.result('mail_read').error && (await grantOf(h.id)) === null)
  t = await turn(h.id, `SCENARIO read ${MSG}`, false)
  check(`so that thread still asks (${names(t.asked)})`, names(t.asked) === 'mail_read')
  const refused = (who: string, method: string, path: string, body?: unknown) => call(who, method, path, body).then(() => false, (e: Error) => /404/.test(e.message))
  check('a made-up card gives nothing', (await refused(sid, 'POST', `/api/agents/threads/${h.id}/approve`, { callId: randomUUID(), allow: true, always: 'mail_reads' })) && (await grantOf(h.id)) === null)
  check("another user can't answer cards in the thread", await refused(otherSid, 'POST', `/api/agents/threads/${h.id}/approve`, { callId: 'x', allow: true, always: 'mail_reads' }))
  check("another user can't end it", await refused(otherSid, 'DELETE', `/api/agents/threads/${g.id}/mail-reads`))
  check("another user can't see it", await refused(otherSid, 'GET', `/api/agents/threads/${g.id}`))
  check('the thread still has it after all that', (await grantOf(g.id)) === until)
  // Ended by hand: reads ask again, and the prompt says so.
  await api('PATCH', `/api/agents/threads/${g.id}`, { permission: 'default' })
  const ended = await api('DELETE', `/api/agents/threads/${g.id}/mail-reads`)
  check('ended by hand: the thread says so', ended.mailReadsUntil === null && (await grantOf(g.id)) === null)
  t = await turn(g.id, `SCENARIO read ${MSG}`, false)
  check(`ended by hand: reads ask again (${names(t.asked)})`, names(t.asked) === 'mail_read')
  check('ended by hand: the prompt says every mail call waits again', /Every mail tool call, even a search or a read, waits for the user/.test(lastPrompt()))
  // Run out: given again, then waited out.
  at = Date.now()
  t = await turn(g.id, `SCENARIO read ${MSG}`, GRANT)
  until = await grantOf(g.id)
  check(`given again from a read card (${until && until - at} ms)`, ran(t, 'mail_read') && !!until)
  t = await turn(g.id, `SCENARIO read ${MSG}`, false)
  check('given again: reads run without a card', !t.asked.length && ran(t, 'mail_read'))
  await sleep(Math.max(0, (until ?? 0) - Date.now()) + 300)
  check('run out: the thread no longer says so', (await grantOf(g.id)) === null)
  t = await turn(g.id, `SCENARIO reads ${MSG}`, false)
  check(`run out: reads ask again (${names(t.asked)})`, names(t.asked) === 'mail_read, mail_search')
  await api('PATCH', `/api/agents/threads/${g.id}`, { permission: 'plan' })
  t = await turn(g.id, `SCENARIO read ${MSG}`, false)
  check(`run out, Plan: reads ask again (${names(t.asked)})`, names(t.asked) === 'mail_read')

  // 11. Mail reads always allowed: a setting per user, Ask by default.
  const ALWAYS = { allow: true, always: 'mail_reads_always' }
  const setting = async (who = sid) => (await call(who, 'GET', '/api/agents/mail-reads')).mode as string
  check(`the setting is Ask by default (${await setting()})`, (await setting()) === 'ask' && (await setting(otherSid)) === 'ask')
  check('a thread says it is not on', (await newThread('default')).mailReadsAlways === false)
  // Not from a write's card, a declined read card or a made-up card.
  const k = await newThread('default')
  t = await turn(k.id, 'SCENARIO draft', ALWAYS)
  check(`a write's card can't turn it on (the draft asked: ${names(t.asked)})`, names(t.asked) === 'mail_draft' && (await setting()) === 'ask')
  t = await turn(k.id, `SCENARIO read ${MSG}`, { allow: false, always: 'mail_reads_always' })
  check('a declined read card can\'t turn it on', names(t.asked) === 'mail_read' && !!t.result('mail_read').error && (await setting()) === 'ask')
  check('a made-up card can\'t turn it on', (await refused(sid, 'POST', `/api/agents/threads/${k.id}/approve`, { callId: randomUUID(), allow: true, always: 'mail_reads_always' })) && (await setting()) === 'ask')
  check('a bad value is refused', await call(sid, 'PUT', '/api/agents/mail-reads', { mode: 'sometimes' }).then(() => false, (e: Error) => /400/.test(e.message)))
  // From a read's card: that call and the other read of the reply run, and the setting is on.
  t = await turn(k.id, `SCENARIO reads ${MSG}`, (e) => (e.call?.name === 'mail_search' ? ALWAYS : true))
  check(`turned on from a search card: both reads ran (${names(t.asked)})`, ran(t, 'mail_search') && ran(t, 'mail_read'))
  check(`turned on: the setting says always (${await setting()}), the thread too`, (await setting()) === 'always' && t.thread.mailReadsAlways === true)
  check(`turned on: the other user's setting is untouched (${await setting(otherSid)})`, (await setting(otherSid)) === 'ask')
  // Every mode, each in a thread of its own: reads run without a card.
  for (const permission of ['default', 'auto', 'acceptEdits', 'bypass', 'plan']) {
    const fresh = await newThread(permission)
    const checksBefore = checks.length
    t = await turn(fresh.id, `SCENARIO reads ${MSG}`, false)
    check(`always, ${permission}, a new thread: reads ran without a card (${names(t.asked) || 'none asked'})`, !t.asked.length && ran(t, 'mail_search') && ran(t, 'mail_read'))
    check(`always, ${permission}: their rows say why`, t.tools.every((m) => /always allow mail reads/.test(m.checked ?? '')))
    check(`always, ${permission}: the prompt says reads run, and the rest still asks`, /The user always allows mail reads/.test(lastPrompt()) && /mail_draft, mail_send and mail_update still wait for the user/.test(lastPrompt()))
    if (permission === 'bypass') check('always, bypass: the Bypass line says so too', /mail drafts, sends and changes, and writes to AGENTS\.md/.test(lastPrompt()) && /Mail searches and reads run without asking: the user always allows them/.test(lastPrompt()))
    check(`always, ${permission}: the safety check model was never asked`, checks.length === checksBefore)
  }
  // Drafts, sends and changes still ask, Bypass too.
  for (const permission of ['default', 'bypass']) {
    const fresh = await newThread(permission)
    const before = sends().length
    t = await turn(fresh.id, `SCENARIO all ${MSG}|${THREAD}`, false)
    check(`always, ${permission}: the writes still asked, the reads did not (${names(t.asked)})`, names(t.asked) === 'mail_draft, mail_send, mail_update' && ran(t, 'mail_read') && ran(t, 'mail_search') && ran(t, 'mail_list_accounts'))
    check(`always, ${permission}: declined, nothing written`, sends().length === before)
  }
  // The other user still asks, in their own thread on their own account.
  const theirThread = await call(otherSid, 'POST', '/api/agents/threads', { model: MODEL, mode: 'quick', permission: 'bypass' })
  check('the other user\'s thread says it is not on', theirThread.mailReadsAlways === false)
  t = await turn(theirThread.id, 'SCENARIO reads 0', false, otherSid)
  check(`the other user still asks (${names(t.asked)})`, names(t.asked) === 'mail_search')
  // The endpoint is per user: theirs on, ours off, and back.
  await call(sid, 'PUT', '/api/agents/mail-reads', { mode: 'ask' })
  await call(otherSid, 'PUT', '/api/agents/mail-reads', { mode: 'always' })
  check(`per user: theirs always, ours ask (${await setting(otherSid)}, ${await setting()})`, (await setting(otherSid)) === 'always' && (await setting()) === 'ask')
  t = await turn(k.id, `SCENARIO reads ${MSG}`, false)
  check(`switched back to Ask: reads ask again (${names(t.asked)})`, names(t.asked) === 'mail_read, mail_search' && t.thread.mailReadsAlways === false)
  check('switched back to Ask: the prompt says every mail call waits again', /Every mail tool call, even a search or a read, waits for the user/.test(lastPrompt()))
  t = await turn(theirThread.id, 'SCENARIO reads 0', false, otherSid)
  check(`theirs on: their reads run without a card (${names(t.asked) || 'none asked'})`, !t.asked.length && ran(t, 'mail_search'))
  await call(otherSid, 'PUT', '/api/agents/mail-reads', { mode: 'ask' })
  // Turned on in Settings (the same endpoint): reads run; off again: they ask.
  await call(sid, 'PUT', '/api/agents/mail-reads', { mode: 'always' })
  await api('PATCH', `/api/agents/threads/${k.id}`, { permission: 'plan' })
  t = await turn(k.id, `SCENARIO read ${MSG}`, false)
  check(`turned on in Settings, Plan: reads run without a card (${names(t.asked) || 'none asked'})`, !t.asked.length && ran(t, 'mail_read'))
  await call(sid, 'PUT', '/api/agents/mail-reads', { mode: 'ask' })
  t = await turn(k.id, `SCENARIO read ${MSG}`, false)
  check(`off again in Settings: reads ask (${names(t.asked)})`, names(t.asked) === 'mail_read')

  // 12. Unlinked again: no tools.
  await api('DELETE', `/api/mail/accounts/${linked.id}`)
  t = await turn(ask.id, `SCENARIO read ${MSG}`, true)
  check('unlinked: no mail tool is offered any more', !lastOffered().some((n) => n.startsWith('mail_')) && !t.asked.length)
  check('nothing was ever submitted for the other user', mock.submissions.length === count)
} catch (e) {
  check(`no errors (${(e as Error).message})`, false)
  console.error(server.log?.slice?.(-3000))
} finally {
  await server.dispose()
  await mock.close()
  ollama.close()
}
finish()
