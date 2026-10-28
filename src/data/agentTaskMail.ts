// The new-mail trigger of agent tasks (server/agentTasks.ts): a task that runs when mail arrives
// instead of on a schedule. It is a kind of Schedule (src/data/agentTaskSchedule.ts), so a task
// has one "when". Shared by the browser (the editor and its plain-words summary) and the server,
// which matches every new message of the watched account against it. No DOM or Node APIs here.
//
// - Filters are ANDed: the account (required), the mailbox (the Inbox when none is picked), from
//   (an address, or a domain: "@steampowered.com" also matches its subdomains), to or cc contains,
//   subject contains (case-insensitive), and has an attachment (yes, no, or either). Within one
//   list, any entry matching is enough.
// - Never a trigger, whatever the filters say: mail a task sent (its reports, a run's mail_send:
//   it carries TASK_HEADER, honoured only from the user's own addresses), replies to such mail (by
//   In-Reply-To or References), automatic mail (Auto-Submitted other than "no", delivery reports,
//   MAILER-DAEMON and postmaster), drafts, and mail in Sent, Drafts, Trash or Junk (by role).
// - Mail that matches is collected for `windowMs` from the first one; then one run gets the batch.
//   At most `maxPerHour` runs an hour; mail beyond that joins the next run's batch.

export type MailTrigger = {
  kind: 'mail'
  /** The linked mail account (its id in Settings → Integrations → Mail) */
  account: number
  /** Its label when it was saved, for showing */
  accountLabel: string
  /** A mailbox id of that account; null: its Inbox */
  mailbox: string | null
  /** The mailbox's name when it was saved, for showing */
  mailboxName: string
  /** Addresses or domains ("@example.org", "example.org"); empty: anyone */
  from: string[]
  /** Text in To or Cc (names or addresses); empty: any */
  to: string[]
  /** Text in the subject; empty: any */
  subject: string[]
  attachment: 'any' | 'yes' | 'no'
  /** How long mail is collected, from the first one, before a run starts */
  windowMs: number
  /** Runs an hour at most */
  maxPerHour: number
}

/** The header a task's own mail carries (reports, and mail a run sends): never a trigger. */
export const TASK_HEADER = 'X-MvLOS-Task'
export const DEFAULT_WINDOW_MS = 2 * 60_000
export const MAX_WINDOW_MS = 60 * 60_000
export const DEFAULT_MAX_PER_HOUR = 20
export const MAX_PER_HOUR = 60
/** Mailbox roles whose mail never starts a task. */
export const NEVER_ROLES = ['sent', 'drafts', 'trash', 'junk']
/** A new mail task's token limit per run (lower than a scheduled task's: mail can come often). */
export const MAIL_TASK_TOKENS = 100_000
/** Per account, for all its mail-started runs together (Settings → Apps → Agents → Tasks). */
export const MAIL_BUDGET_RUNS = [10, 20, 30, 60, 120, 240]
export const MAIL_BUDGET_TOKENS = [250_000, 500_000, 1_000_000, 2_000_000, 5_000_000, 10_000_000]
export const DEFAULT_BUDGET_RUNS = 60
export const DEFAULT_BUDGET_TOKENS = 2_000_000
/** At its hourly cap this many hours in a row, a mail task pauses itself. */
export const CAPPED_HOURS = 3
/** At most this many mails are listed in a run's prompt (the newest); the rest by id only. */
export const PROMPT_MAILS = 30

/** A new-mail trigger with the defaults, for an account. */
export function blankMailTrigger(account: { id: number; label: string }): MailTrigger {
  return { kind: 'mail', account: account.id, accountLabel: account.label, mailbox: null, mailboxName: 'Inbox', from: [], to: [], subject: [], attachment: 'any', windowMs: DEFAULT_WINDOW_MS, maxPerHour: DEFAULT_MAX_PER_HOUR }
}

const list = (v: unknown, max: number, len: number): string[] => {
  const items = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,\n]/) : []
  return [...new Set(items.filter((x): x is string => typeof x === 'string').map((x) => x.trim().replace(/[\r\n]+/g, ' ').slice(0, len)).filter(Boolean))].slice(0, max)
}
const intIn = (v: unknown, lo: number, hi: number, fallback: number) => {
  const n = Math.round(Number(v))
  return v === null || v === undefined || v === '' || !Number.isFinite(n) ? fallback : Math.min(hi, Math.max(lo, n))
}

/** A trigger as sent, checked (or an error to show). Whether the account is the user's is the server's to check. */
export function cleanMailTrigger(v: unknown): MailTrigger {
  const s = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const account = Number(s.account)
  if (!Number.isInteger(account) || account <= 0) throw new Error('Pick the mail account it watches')
  const mailbox = typeof s.mailbox === 'string' && /^[A-Za-z0-9_-]{1,255}$/.test(s.mailbox) ? s.mailbox : null
  const from = list(s.from, 30, 254).map((x) => x.toLowerCase().replace(/^mailto:/, ''))
  const bad = from.find((x) => !/^@?[^\s@<>]+$/.test(x) && !/^[^\s@<>]+@[^\s@<>]+$/.test(x))
  if (bad) throw new Error(`“${bad}” is not an address or a domain`)
  return {
    kind: 'mail',
    account,
    accountLabel: typeof s.accountLabel === 'string' ? s.accountLabel.trim().slice(0, 120) : '',
    mailbox,
    mailboxName: mailbox && typeof s.mailboxName === 'string' && s.mailboxName.trim() ? s.mailboxName.trim().slice(0, 200) : 'Inbox',
    from,
    to: list(s.to, 30, 254),
    subject: list(s.subject, 30, 200),
    attachment: s.attachment === 'yes' || s.attachment === 'no' ? s.attachment : 'any',
    windowMs: intIn(s.windowMs, 0, MAX_WINDOW_MS, DEFAULT_WINDOW_MS),
    maxPerHour: intIn(s.maxPerHour, 1, MAX_PER_HOUR, DEFAULT_MAX_PER_HOUR),
  }
}

/** A new message, as much as the filters need. Addresses as the message has them. */
export type ArrivedMail = {
  id: string
  mailboxIds: string[]
  from: { name: string | null; email: string }[]
  to: { name: string | null; email: string }[]
  cc: { name: string | null; email: string }[]
  subject: string
  hasAttachment: boolean
  /** ms */
  receivedAt: number
  draft: boolean
  /** A task sent it: TASK_HEADER verified for one of the user's tasks, from one of the user's own addresses */
  fromTask: boolean
  /** It answers mail a task sent (In-Reply-To or References name one) */
  replyToTask: boolean
  /** The Auto-Submitted header (null: none) */
  autoSubmitted: string | null
  /** The top-level Content-Type, lower case, without parameters ("" when unknown) */
  contentType: string
}

/** Whether "from" entry matches an address: the address itself, or its domain (and the domain's subdomains). */
export function fromMatches(entry: string, email: string): boolean {
  const e = entry.toLowerCase()
  const a = email.trim().toLowerCase()
  if (e.includes('@') && !e.startsWith('@')) return a === e
  const domain = e.replace(/^@/, '').replace(/\.$/, '')
  const at = a.lastIndexOf('@')
  if (at < 0 || !domain) return false
  const host = a.slice(at + 1)
  return host === domain || host.endsWith(`.${domain}`)
}

/** Senders that are mail systems, not people, at any domain. */
const SYSTEM_SENDER = /^(mailer-daemon|postmaster)@/i

/** Why a message can never start a task (a task's own mail or a reply to it, automatic mail, a draft, Sent, Drafts, Trash or Junk), or null. */
export function neverTrigger(m: ArrivedMail, roleBoxes: Set<string>): string | null {
  if (m.fromTask) return 'sent by a task'
  if (m.replyToTask) return 'a reply to mail a task sent'
  const auto = (m.autoSubmitted ?? '').split(';')[0].trim().toLowerCase()
  if (m.autoSubmitted !== null && auto !== 'no') return 'sent automatically (Auto-Submitted)'
  if (m.contentType.split(';')[0].trim().toLowerCase() === 'multipart/report') return 'a delivery or read report'
  if (m.from.some((a) => SYSTEM_SENDER.test(a.email.trim()))) return 'from a mail system (MAILER-DAEMON, postmaster)'
  if (m.draft) return 'a draft'
  if (m.mailboxIds.some((b) => roleBoxes.has(b))) return 'in Sent, Drafts, Trash or Junk'
  return null
}

/** Whether a message matches a trigger's filters (all of them). `inbox`: the account's Inbox id, for a trigger without a mailbox. */
export function mailMatches(t: MailTrigger, m: ArrivedMail, inbox: string | null): boolean {
  const box = t.mailbox ?? inbox
  if (!box || !m.mailboxIds.includes(box)) return false
  if (t.from.length && !m.from.some((a) => t.from.some((f) => fromMatches(f, a.email)))) return false
  if (t.to.length) {
    const people = [...m.to, ...m.cc].map((a) => `${a.name ?? ''} <${a.email}>`.toLowerCase())
    if (!t.to.some((x) => people.some((p) => p.includes(x.toLowerCase())))) return false
  }
  if (t.subject.length && !t.subject.some((x) => m.subject.toLowerCase().includes(x.toLowerCase()))) return false
  if (t.attachment === 'yes' && !m.hasAttachment) return false
  if (t.attachment === 'no' && m.hasAttachment) return false
  return true
}

const join = (xs: string[], word: string) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} ${word} ${xs[xs.length - 1]}`)
const minutes = (ms: number) => (ms <= 0 ? 'right away' : ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`)

/** "Runs when mail from @steampowered.com arrives in Inbox (Personal); mails within 2 min are handled together." */
export function describeMailTrigger(t: MailTrigger): string {
  const parts: string[] = []
  if (t.from.length) parts.push(`from ${join(t.from, 'or')}`)
  if (t.to.length) parts.push(`to or cc ${join(t.to.map((x) => `“${x}”`), 'or')}`)
  if (t.subject.length) parts.push(`with ${join(t.subject.map((x) => `“${x}”`), 'or')} in the subject`)
  if (t.attachment === 'yes') parts.push('with an attachment')
  if (t.attachment === 'no') parts.push('without attachments')
  const where = `${t.mailboxName || 'Inbox'}${t.accountLabel ? ` (${t.accountLabel})` : ''}`
  const batch = t.windowMs <= 0 ? 'mail arriving together is handled together' : `mails within ${minutes(t.windowMs)} are handled together`
  return `Runs when ${parts.length ? `mail ${parts.join(', ')}` : 'any new mail'} arrives in ${where}; ${batch}, at most ${t.maxPerHour} ${t.maxPerHour === 1 ? 'run' : 'runs'} an hour`
}

/** Characters that hide, reorder or break text in a prompt line: controls, format characters (bidi included), line and paragraph separators, angle brackets of any width. */
const UNSAFE = /[\p{C}\u2028\u2029\u0085<>\uFF1C\uFF1E\u2039\u203A\u27E8\u27E9\u3008\u3009]/gu
/** Text from a mail, safe as one value in a prompt line. */
export const promptText = (s: string, n: number) => s.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim().slice(0, n)

/** A mail that started a run, as the run keeps it (for its prompt and its history). */
export type RunMailItem = { account: number; id: string; from: string; subject: string; receivedAt: number; mailbox: string }
/** The mail that started a run, and how many older ones were dropped before it (too many waiting, or too old). */
export type RunMail = { mails: RunMailItem[]; dropped: number }
