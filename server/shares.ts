import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { User } from './auth.ts'
import { database } from './db.ts'
import { HttpError, publicOrigin, SECURITY } from './http.ts'
import { parseMarkdown, safeImage, type Block, type Inline } from '../src/data/markdown/parse.ts'
import { highlight, knownLanguage } from '../src/data/markdown/highlight.ts'
import { isVisualLang, visualBlockText } from '../src/data/visual/spec.ts'

// Shared links for the Agents app: a whole thread, or one answer with the message it answers, as
// a page anyone with the link can read (GET /s/<token>), without MvL OS and without an account.
//
// A share is a snapshot taken when it is made: later messages, a rewind or a retry don't change
// it. Deleting the thread or the account deletes its shares (ON DELETE CASCADE in server/db.ts).
// The token is the only way in: 144 random bits, never listed anywhere but to its owner.
//
// What goes in is deliberately little: the title, the model, your messages (their text, and
// attached files by name and size only) and the agent's answers. Tool calls become short labels
// that leave out what they were given ("Searched notes", never the query), except a web search's
// query and the site a page was read from; tool results, thinking, memories and the plan are
// never copied. Notes, calendar events and files can hold anything, so nothing a tool read is in
// the snapshot unless the agent wrote it into its answer.
//
// The page is rendered here, from Markdown parsed by the same parser as the app
// (src/data/markdown/parse.ts) into HTML in which every piece of text is escaped. It runs no
// script at all, and its Content-Security-Policy says so.

export type ShareKind = 'thread' | 'response'
export type ShareInfo = { token: string; url: string; kind: ShareKind; title: string; threadId: string; messageId: number | null; createdAt: number; expiresAt: number | null; views: number }

type Part = { step: string } | { text: string }
type FileInfo = { name: string; size: number; image: boolean }
type Item = { role: 'user'; text: string; files: FileInfo[]; at: number } | { role: 'assistant'; parts: Part[]; at: number }
/** What a share holds, as JSON in agent_shares.snapshot. */
type Snapshot = { v: 1; title: string; model: string; items: Item[] }

type ShareRow = { token: string; user_id: number; thread_id: string; kind: string; message_id: number | null; title: string; snapshot: string; created_at: number; expires_at: number | null; views: number }
type MessageRow = { id: number; role: string; content: string; tool_calls: string | null; attachments: string | null; created_at: number }

/** How long a link may live; "never" is the default. */
const EXPIRY: Record<string, number | null> = { never: null, '1h': 3600_000, '1d': 864e5, '7d': 7 * 864e5, '30d': 30 * 864e5 }
const MAX_SHARES = 500
/** A snapshot's text in all; a longer thread keeps its start and says the rest was left out. */
const MAX_TEXT = 1_500_000
const TOKEN = /^[A-Za-z0-9_-]{24}$/

/** Expired links are deleted whenever shares are touched, so none outlives its time by much. */
const prune = () => database().prepare('DELETE FROM agent_shares WHERE expires_at IS NOT NULL AND expires_at <= ?').run(Date.now())

const toInfo = (origin: string, r: ShareRow): ShareInfo => ({ token: r.token, url: `${origin}/s/${r.token}`, kind: r.kind === 'response' ? 'response' : 'thread', title: r.title, threadId: r.thread_id, messageId: r.message_id, createdAt: r.created_at, expiresAt: r.expires_at, views: r.views })

// --- what a step is called in a share ----------------------------------------------------------

const clipped = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/**
 * A tool call as one line for a share. Unlike the app's labels (src/data/agents.ts toolLabel), it
 * names nothing a tool was given, since a note's text, a calendar event's title, a file's path or a
 * command can be private; only a web search's query and the site a page was read from show.
 */
export function stepLabel(name: string, args: Record<string, unknown>): string {
  const s = (k: string) => (typeof args[k] === 'string' ? (args[k] as string).replace(/\s+/g, ' ').trim() : '')
  switch (name) {
    case 'search_threads':
    case 'read_thread':
      return 'Looked through past threads'
    case 'web_search':
      return s('query') ? `Searched the web for “${clipped(s('query'), 120)}”` : 'Searched the web'
    case 'web_fetch': {
      let host = ''
      try {
        host = new URL(s('url')).hostname.replace(/^www\./, '')
      } catch {
        /* not an address: no site to name */
      }
      return host ? `Read a page on ${host}` : 'Read a web page'
    }
    case 'remember':
    case 'update_memory':
      return 'Updated its memory'
    case 'ask_user':
      return 'Asked a question'
    case 'list_projects':
    case 'create_project':
    case 'rename_project':
    case 'move_thread':
      return 'Organised projects'
    case 'update_todos':
      return 'Updated its plan'
    case 'search_notes':
      return 'Searched notes'
    case 'create_note':
    case 'update_note':
    case 'delete_note':
      return 'Changed a note'
    case 'calendar_list_calendars':
      return 'Looked at the calendars'
    case 'calendar_list_events':
      return 'Looked at the calendar'
    case 'calendar_create_event':
      return 'Added a calendar event'
    case 'calendar_update_event':
      return 'Changed a calendar event'
    case 'calendar_delete_event':
      return 'Deleted a calendar event'
    case 'mail_list_accounts':
    case 'mail_search':
      return 'Looked through mail'
    case 'mail_read':
      return 'Read an email'
    case 'mail_draft':
      return 'Drafted an email'
    case 'mail_send':
      return 'Sent an email'
    case 'mail_update':
      return 'Filed email'
    case 'search_code':
      return 'Searched code'
    case 'seafile_list':
    case 'list_dir':
    case 'glob':
      return 'Listed files'
    case 'seafile_search':
    case 'grep':
      return 'Searched files'
    case 'list_generated_images':
      return 'Listed generated images'
    case 'seafile_read':
    case 'read_file':
      return 'Read a file'
    case 'write_file':
    case 'edit_file':
    case 'multi_edit':
      return 'Edited a file'
    case 'seafile_mkdir':
    case 'save_generated_image':
    case 'seafile_write':
    case 'seafile_rename':
    case 'seafile_move':
    case 'seafile_delete':
    case 'make_dir':
    case 'move_path':
    case 'delete_path':
      return 'Changed files'
    case 'terminal':
      return 'Ran a command'
    case 'exit_plan_mode':
      return 'Presented a plan'
    case 'use_skill':
    case 'read_skill_file':
      return 'Read a skill'
    default:
      return 'Used a tool'
  }
}

// --- taking the snapshot -----------------------------------------------------------------------

/** Messages as they go into a share: no tool results, no thinking, files by name only. */
function itemsOf(rows: MessageRow[]): Item[] {
  const items: Item[] = []
  let budget = MAX_TEXT
  for (const r of rows) {
    if (budget <= 0) break
    if (r.role === 'user') {
      const files = r.attachments ? (JSON.parse(r.attachments) as { name?: string; size?: number; kind?: string; source?: string }[]) : []
      const text = r.content.slice(0, budget)
      budget -= text.length
      // A skill's instructions ride along as a file the server added: not something the user sent.
      items.push({ role: 'user', text, files: files.filter((f) => f.source !== 'skill').map((f) => ({ name: String(f.name ?? 'file').slice(0, 200), size: Number(f.size) || 0, image: f.kind === 'image' })), at: r.created_at })
      continue
    }
    if (r.role !== 'assistant') continue
    const calls = r.tool_calls ? (JSON.parse(r.tool_calls) as { name?: string; arguments?: Record<string, unknown> }[]) : []
    const text = r.content.trim().slice(0, budget)
    budget -= text.length
    const parts: Part[] = [...(text ? [{ text }] : []), ...calls.map((c) => ({ step: stepLabel(String(c.name ?? ''), c.arguments && typeof c.arguments === 'object' ? c.arguments : {}) }))]
    if (!parts.length) continue
    // One answer is the agent's messages between two of yours, its steps and text in order.
    const last = items[items.length - 1]
    if (last?.role === 'assistant') last.parts.push(...parts)
    else items.push({ role: 'assistant', parts, at: r.created_at })
  }
  if (budget <= 0) items.push({ role: 'assistant', parts: [{ text: '*The rest of this thread was too long to share.*' }], at: Date.now() })
  return items
}

/**
 * Shares a thread (`kind: 'thread'`) or one answer (`kind: 'response'`, `messageId` an assistant
 * message with text): that answer's turn, from the message it answers up to it. `expires` is
 * "never" (the default), "1h", "1d", "7d" or "30d".
 */
export function createShare(req: IncomingMessage, user: User, threadId: string, body: { kind?: unknown; messageId?: unknown; expires?: unknown }): ShareInfo {
  prune()
  const db = database()
  // The Image Studio's hidden thread (quick = 2) is not a chat, so it is not shared.
  const thread = db.prepare('SELECT id, title, model FROM agent_threads WHERE id = ? AND user_id = ? AND quick != 2').get(threadId, user.id) as { id: string; title: string; model: string } | undefined
  if (!thread) throw new HttpError(404, 'No such thread')
  if (body.kind !== undefined && body.kind !== 'thread' && body.kind !== 'response') throw new HttpError(400, 'kind is "thread" or "response"')
  const kind: ShareKind = body.kind === 'response' ? 'response' : 'thread'
  const expiresKey = body.expires === undefined || body.expires === null ? 'never' : String(body.expires)
  if (!(expiresKey in EXPIRY)) throw new HttpError(400, 'expires is never, 1h, 1d, 7d or 30d')
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM agent_shares WHERE user_id = ?').get(user.id) as { n: number }
  if (n >= MAX_SHARES) throw new HttpError(409, `You have ${MAX_SHARES} shared links already: stop sharing some first (Settings → Agents → Shared links)`)

  let rows = db.prepare('SELECT id, role, content, tool_calls, attachments, created_at FROM agent_messages WHERE thread_id = ? ORDER BY id').all(thread.id) as MessageRow[]
  let messageId: number | null = null
  if (kind === 'response') {
    messageId = Number(body.messageId)
    const at = rows.findIndex((r) => r.id === messageId && r.role === 'assistant' && r.content.trim())
    if (at < 0) throw new HttpError(404, 'That answer is not in this thread any more')
    let from = at
    while (from > 0 && rows[from].role !== 'user') from--
    rows = rows.slice(from, at + 1)
  }
  const items = itemsOf(rows)
  if (!items.some((i) => i.role === 'assistant')) throw new HttpError(400, 'There is no answer to share yet')
  const snapshot: Snapshot = { v: 1, title: thread.title, model: thread.model, items }
  const token = randomBytes(18).toString('base64url')
  const now = Date.now()
  const ttl = EXPIRY[expiresKey]
  db.prepare('INSERT INTO agent_shares (token, user_id, thread_id, kind, message_id, title, snapshot, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(token, user.id, thread.id, kind, messageId, thread.title, JSON.stringify(snapshot), now, ttl === null ? null : now + ttl)
  return toInfo(publicOrigin(req), db.prepare('SELECT * FROM agent_shares WHERE token = ?').get(token) as ShareRow)
}

/** The user's shared links, newest first; `threadId` narrows them to one thread's. */
export function listShares(req: IncomingMessage, user: User, threadId: string | null): ShareInfo[] {
  prune()
  const origin = publicOrigin(req)
  const rows = threadId
    ? (database().prepare('SELECT * FROM agent_shares WHERE user_id = ? AND thread_id = ? ORDER BY created_at DESC').all(user.id, threadId) as ShareRow[])
    : (database().prepare('SELECT * FROM agent_shares WHERE user_id = ? ORDER BY created_at DESC').all(user.id) as ShareRow[])
  return rows.map((r) => toInfo(origin, r))
}

/** Stop sharing: the snapshot is deleted and the link answers 404 from now on. */
export function deleteShare(user: User, token: string) {
  const r = database().prepare('DELETE FROM agent_shares WHERE token = ? AND user_id = ?').run(token, user.id)
  if (!r.changes) throw new HttpError(404, 'No such shared link')
}

// --- the page ----------------------------------------------------------------------------------

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
/** Links on the page go to the web or to mail only (a relative link would point into the site). */
const linkable = (href: string) => /^(https?:|mailto:)/i.test(href.trim())

function inlineHtml(nodes: Inline[], breaks: boolean): string {
  return nodes
    .map((n) => {
      switch (n.type) {
        case 'text':
          return esc(n.text)
        case 'soft':
          return breaks ? '\n' : ' '
        case 'br':
          return '<br>'
        case 'code':
          return `<code>${esc(n.text)}</code>`
        case 'ruby':
          return `<ruby>${esc(n.base)}<rp>(</rp><rt>${esc(n.reading)}</rt><rp>)</rp></ruby>`
        case 'em':
        case 'strong':
        case 'del':
          return `<${n.type}>${inlineHtml(n.children, breaks)}</${n.type}>`
        case 'link': {
          const inner = inlineHtml(n.children, breaks)
          if (!linkable(n.href)) return inner
          return `<a href="${esc(n.href.trim())}"${n.title ? ` title="${esc(n.title)}"` : ''} rel="noopener noreferrer nofollow" target="_blank">${inner}</a>`
        }
        case 'image':
          // The parser only makes pictures of https and data: images; anything else became a link.
          if (!safeImage(n.src)) return esc(n.alt)
          return `<img src="${esc(n.src)}" alt="${esc(n.alt)}"${n.title ? ` title="${esc(n.title)}"` : ''} loading="lazy" referrerpolicy="no-referrer">`
      }
    })
    .join('')
}

const ALIGN = { left: ' class="al-left"', center: ' class="al-center"', right: ' class="al-right"' }

function blockHtml(nodes: Block[], breaks: boolean, tight = false): string {
  return nodes
    .map((b) => {
      switch (b.type) {
        case 'paragraph':
          return tight ? inlineHtml(b.children, breaks) : `<p${breaks ? ' class="breaks"' : ''}>${inlineHtml(b.children, breaks)}</p>`
        case 'heading':
          return `<h${b.level}>${inlineHtml(b.children, breaks)}</h${b.level}>`
        case 'hr':
          return '<hr>'
        case 'code': {
          // A visual block (src/data/visual/) as its text version; the page runs no script to draw it.
          const visual = isVisualLang(b.lang) ? visualBlockText(b.text) : null
          if (visual) return `<pre data-lang="visual"><code>${esc(visual.join('\n'))}</code></pre>`
          const lang = knownLanguage(b.lang) ? b.lang.toLowerCase() : ''
          const code = highlight(b.text, b.lang)
            .map((t) => (t.cls && /^[a-z]+$/.test(t.cls) ? `<span class="hl-${t.cls}">${esc(t.text)}</span>` : esc(t.text)))
            .join('')
          return `<pre${lang ? ` data-lang="${esc(lang)}"` : ''}><code>${code}</code></pre>`
        }
        case 'quote':
          return `<blockquote>${blockHtml(b.children, breaks)}</blockquote>`
        case 'list': {
          const items = b.items
            .map((item) => {
              const box = item.checked === null ? '' : `<input type="checkbox" disabled${item.checked ? ' checked' : ''}> `
              const [first, ...rest] = item.children
              // The checkbox sits on the first paragraph's line.
              if (box && first?.type === 'paragraph') {
                const lead = b.tight ? box + inlineHtml(first.children, breaks) : `<p>${box}${inlineHtml(first.children, breaks)}</p>`
                return `<li class="task">${lead}${blockHtml(rest, breaks, b.tight)}</li>`
              }
              return `<li${box ? ' class="task"' : ''}>${box}${blockHtml(item.children, breaks, b.tight)}</li>`
            })
            .join('')
          return b.ordered ? `<ol${b.start !== 1 ? ` start="${b.start}"` : ''}>${items}</ol>` : `<ul>${items}</ul>`
        }
        case 'table': {
          const cell = (tag: 'th' | 'td', c: Inline[], j: number) => `<${tag}${b.align[j] ? ALIGN[b.align[j]!] : ''}>${inlineHtml(c, breaks)}</${tag}>`
          const head = `<tr>${b.head.map((c, j) => cell('th', c, j)).join('')}</tr>`
          const rows = b.rows.map((r) => `<tr>${r.map((c, j) => cell('td', c, j)).join('')}</tr>`).join('')
          return `<div class="table"><table><thead>${head}</thead><tbody>${rows}</tbody></table></div>`
        }
      }
    })
    .join('')
}

/** Markdown as escaped HTML for the shared page. `breaks` keeps a message's line breaks, as the app shows yours. */
export const markdownHtml = (text: string, breaks = false) => blockHtml(parseMarkdown(text), breaks)

const day = (t: number) => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
const moment = (t: number) => `${day(t)}, ${new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' })} UTC`
const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)

const STYLE = `
:root{color-scheme:light dark;--bg:#fbfaf8;--fg:#24231f;--muted:#6e6a62;--line:#e4e0d8;--bubble:#efece6;--code:#f2efe9;--link:#2b62c4;--accent:#c2552d;
--hl-com:#8a867d;--hl-str:#3f7d2c;--hl-num:#a3502a;--hl-kw:#8a3fb0;--hl-fn:#2459b3;--hl-type:#9a6a00;--hl-attr:#b0461f;--hl-tag:#2a7f86;--hl-add:#3f7d2c;--hl-del:#b33a3a}
@media (prefers-color-scheme:dark){:root{--bg:#18181a;--fg:#e4e2dd;--muted:#9a978f;--line:#303033;--bubble:#26262a;--code:#202024;--link:#7fb0ff;--accent:#ef8a5a;
--hl-com:#7c7a75;--hl-str:#9ccc7a;--hl-num:#e8a774;--hl-kw:#c99bf0;--hl-fn:#7fb0ff;--hl-type:#e8c46a;--hl-attr:#f0a07a;--hl-tag:#72c9cf;--hl-add:#9ccc7a;--hl-del:#f08a8a}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.65 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;overflow-wrap:break-word}
main{max-width:46rem;margin:0 auto;padding:40px 16px 64px}
header{margin-bottom:32px;padding-bottom:20px;border-bottom:1px solid var(--line)}
h1.title{margin:0 0 6px;font-size:1.7rem;line-height:1.25}
.meta{margin:0;color:var(--muted);font-size:.875rem}
.you{margin:28px 0 12px;display:flex;flex-direction:column;align-items:flex-end}
.bubble{max-width:min(85%,36rem);padding:10px 14px;border-radius:14px;background:var(--bubble)}
.bubble>:first-child{margin-top:0}.bubble>:last-child{margin-bottom:0}
.files{margin:6px 0 0;padding:0;list-style:none;color:var(--muted);font-size:.8125rem;text-align:right}
.answer{margin:12px 0 28px}
.answer>:first-child{margin-top:0}
.steps{margin:0 0 12px;padding:0;list-style:none;color:var(--muted);font-size:.8125rem}
.steps li::before{content:"↳ ";opacity:.7}
.answer .text+.steps{margin-top:12px}
.breaks{white-space:pre-wrap}
a{color:var(--link)}
h1,h2,h3,h4,h5,h6{line-height:1.3;margin:1.4em 0 .5em}
h1{font-size:1.45rem}h2{font-size:1.25rem}h3{font-size:1.1rem}h4,h5,h6{font-size:1rem}
p,ul,ol,blockquote,pre,.table{margin:0 0 .9em}
ul,ol{padding-left:1.5em}li>p{margin:.25em 0}
li.task{list-style:none;margin-left:-1.3em}li.task input{margin:0 .35em 0 0;vertical-align:-.1em}
blockquote{padding:0 0 0 14px;border-left:3px solid var(--line);color:var(--muted)}
hr{border:0;border-top:1px solid var(--line);margin:1.5em 0}
code{font:.875em/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--code);padding:.1em .3em;border-radius:4px}
pre{background:var(--code);padding:12px 14px;border-radius:8px;overflow-x:auto}
pre code{background:none;padding:0;font-size:.8125rem}
.table{overflow-x:auto}
table{border-collapse:collapse;font-size:.9375rem}
th,td{border:1px solid var(--line);padding:5px 10px;text-align:left;vertical-align:top}
th{background:var(--code)}
.al-center{text-align:center}.al-right{text-align:right}
img{max-width:100%;height:auto;border-radius:6px}
footer{margin-top:40px;padding-top:16px;border-top:1px solid var(--line);color:var(--muted);font-size:.8125rem}
.hl-com{color:var(--hl-com);font-style:italic}.hl-str{color:var(--hl-str)}.hl-num,.hl-lit{color:var(--hl-num)}.hl-kw{color:var(--hl-kw)}
.hl-fn{color:var(--hl-fn)}.hl-type{color:var(--hl-type)}.hl-attr,.hl-var{color:var(--hl-attr)}.hl-tag{color:var(--hl-tag)}.hl-meta{color:var(--hl-com)}
.hl-add{color:var(--hl-add)}.hl-del{color:var(--hl-del)}
.gone{text-align:center;padding-top:20vh}
`

/** The headers of every shared page and its 404: not indexed, no referrer, no script, not framed. */
function pageHeaders(nonce: string, cache: string): Record<string, string> {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': cache,
    'X-Robots-Tag': 'noindex, nofollow',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Strict-Transport-Security': SECURITY['Strict-Transport-Security'],
    'Content-Security-Policy': `default-src 'none'; style-src 'nonce-${nonce}'; img-src https: data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  }
}

const page = (nonce: string, title: string, body: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<link rel="icon" href="data:,">
<title>${esc(title)}</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`

function sharePage(nonce: string, row: ShareRow): string {
  const snap = JSON.parse(row.snapshot) as Snapshot
  const out: string[] = []
  for (const item of snap.items) {
    if (item.role === 'user') {
      const files = item.files.length ? `<ul class="files">${item.files.map((f) => `<li>${f.image ? 'Picture' : 'File'}: ${esc(f.name)} (${size(f.size)})</li>`).join('')}</ul>` : ''
      out.push(`<section class="you" aria-label="Question">${item.text.trim() ? `<div class="bubble">${markdownHtml(item.text, true)}</div>` : ''}${files}</section>`)
      continue
    }
    // Steps in a row are one small list; repeats of the same step are counted.
    const html: string[] = []
    let steps: string[] = []
    const flush = () => {
      if (!steps.length) return
      const counted: [string, number][] = []
      for (const s of steps) counted.length && counted[counted.length - 1][0] === s ? counted[counted.length - 1][1]++ : counted.push([s, 1])
      html.push(`<ul class="steps">${counted.map(([s, n]) => `<li>${esc(s)}${n > 1 ? ` (×${n})` : ''}</li>`).join('')}</ul>`)
      steps = []
    }
    for (const p of item.parts) {
      if ('step' in p) steps.push(p.step)
      else {
        flush()
        html.push(`<div class="text">${markdownHtml(p.text)}</div>`)
      }
    }
    flush()
    out.push(`<section class="answer" aria-label="Answer">${html.join('')}</section>`)
  }
  const what = row.kind === 'response' ? 'An answer shared' : 'Shared'
  const meta = [`${what} from MvL OS Agents · ${day(row.created_at)}`, `Model: ${snap.model}`, row.expires_at ? `Expires ${moment(row.expires_at)}` : ''].filter(Boolean)
  return page(
    nonce,
    `${snap.title} · MvL OS Agents`,
    `<header><h1 class="title">${esc(snap.title)}</h1><p class="meta">${meta.map(esc).join(' · ')}</p></header>
${out.join('\n')}
<footer>A snapshot taken when it was shared. Tool results, files, memories and the model's thinking are not included.</footer>`,
  )
}

const goneBody = `<div class="gone"><h1 class="title">Nothing here</h1><p class="meta">This link does not exist, has expired, or is no longer shared.</p></div>`

/**
 * GET or HEAD /s/<token>: the shared page, or the same 404 for a link that never existed, expired
 * or was revoked. Everything under /s/ is answered here (a mangled link gets this 404, not the
 * desktop). Resolves false for any other path. Needs no cookies and reads none.
 */
export function serveShare(req: IncomingMessage, res: ServerResponse, path: string): boolean {
  const m = /^\/s\/(.*?)\/?$/.exec(path)
  if (!m) return false
  const method = req.method ?? 'GET'
  const nonce = randomBytes(16).toString('base64')
  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD', ...pageHeaders(nonce, 'no-store') }).end()
    return true
  }
  prune()
  const row = TOKEN.test(m[1]) ? (database().prepare('SELECT * FROM agent_shares WHERE token = ? AND (expires_at IS NULL OR expires_at > ?)').get(m[1], Date.now()) as ShareRow | undefined) : undefined
  if (!row) {
    const body = page(nonce, 'Not found · MvL OS Agents', goneBody)
    res.writeHead(404, pageHeaders(nonce, 'no-store')).end(method === 'HEAD' ? undefined : body)
    return true
  }
  if (method === 'GET') database().prepare('UPDATE agent_shares SET views = views + 1 WHERE token = ?').run(row.token)
  const body = sharePage(nonce, row)
  res.writeHead(200, { ...pageHeaders(nonce, 'private, max-age=60'), 'Content-Length': String(Buffer.byteLength(body)) }).end(method === 'HEAD' ? undefined : body)
  return true
}

export const isShareToken = (v: string) => TOKEN.test(v)
