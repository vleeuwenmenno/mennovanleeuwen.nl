import { useEffect, useState, useSyncExternalStore } from 'react'
import { api, subscribeAccount, getAccount } from '../os/account'
import type { MenuItem } from '../os/ContextMenu'
import { synced } from '../os/synced'

// Mail for the browser: the Mail app (src/apps/mail) reads and changes mail through the site's
// own API (server/jmap.ts holds the JMAP tokens and does the talking). Also the way in for other
// apps: composeMail() and openMail() start a message or show one, and the hooks below let
// Contacts, Calendar and Tasks plug in (who a person is, recipient suggestions, invitation
// answers, "Make task from this email" and the like) without Mail knowing them.

export type Address = { name: string | null; email: string }
export type MailAccount = { id: number; label: string; username: string; url: string }
export type Mailbox = { id: string; name: string; parentId: string | null; role: string | null; sortOrder: number; total: number; unread: number; totalThreads: number; unreadThreads: number }
export type Identity = { id: string; name: string; email: string; replyTo: Address[] | null; bcc: Address[] | null; textSignature: string }
export type Boot = { mailboxes: Mailbox[]; identities: Identity[]; maxSizeUpload: number; canSend: boolean; username: string }
export type ThreadRow = {
  id: string
  threadId: string
  mailboxIds: string[]
  from: Address[]
  to: Address[]
  subject: string
  preview: string
  receivedAt: string
  seen: boolean
  flagged: boolean
  answered: boolean
  draft: boolean
  hasAttachment: boolean
  count: number
}
export type Attachment = { blobId: string; name: string; type: string; size: number; cid: string | null }
export type Invite = {
  method: string
  uid: string | null
  title: string
  start: string | null
  end: string | null
  allDay: boolean
  location: string | null
  organizer: { name: string | null; email: string } | null
  replies: { email: string; name: string | null; status: string }[]
  attendees: number
}
export type Message = ThreadRow & {
  cc: Address[]
  bcc: Address[]
  replyTo: Address[]
  sentAt: string | null
  messageId: string[]
  inReplyTo: string[]
  references: string[]
  html: string | null
  text: string | null
  blocked: number
  trackers: number
  images: boolean
  truncated: boolean
  attachments: Attachment[]
  invite: Invite | null
}

// ---------------------------------------------------------------------------------------------
// Accounts

let accounts: MailAccount[] | null = null
let accountsError: string | null = null
const accountListeners = new Set<() => void>()
const emitAccounts = () => accountListeners.forEach((l) => l())

/** The linked mail accounts (Settings → Integrations → Mail), fetched once signed in. */
export async function loadMailAccounts(): Promise<void> {
  if (getAccount().status !== 'user') {
    accounts = []
    return emitAccounts()
  }
  try {
    accounts = (await api<{ accounts: MailAccount[] }>('/api/mail/accounts')).accounts
    accountsError = null
  } catch (e) {
    accountsError = (e as Error).message
    accounts = accounts ?? []
  }
  emitAccounts()
}

/** The linked accounts as known now (null before the first load): whether a mailto: can go to Mail. */
export const mailAccountsNow = () => accounts

let watching = false
export function useMailAccounts(): { accounts: MailAccount[] | null; error: string | null } {
  useEffect(() => {
    if (!watching) {
      watching = true
      subscribeAccount(() => void loadMailAccounts())
    }
    if (accounts === null) void loadMailAccounts()
  }, [])
  const list = useSyncExternalStore(
    (l) => {
      accountListeners.add(l)
      return () => accountListeners.delete(l)
    },
    () => accounts,
  )
  return { accounts: list, error: accountsError }
}

/** Links an account with its API token (checked by the server against the JMAP session first). */
export async function linkMailAccount(body: { url?: string; token: string; label?: string }): Promise<MailAccount> {
  const info = await api<MailAccount>('/api/mail/accounts', { method: 'POST', json: body })
  await loadMailAccounts()
  return info
}

export async function unlinkMailAccount(id: number) {
  await api(`/api/mail/accounts/${id}`, { method: 'DELETE' })
  await loadMailAccounts()
}

// ---------------------------------------------------------------------------------------------
// Reading and changing

const base = (account: number) => `/api/mail/${account}`

export const bootstrap = (account: number) => api<Boot>(`${base(account)}/bootstrap`)

export function fetchThreads(account: number, opts: { mailbox?: string | null; q?: string; position: number; limit?: number }) {
  const p = new URLSearchParams({ position: String(opts.position), limit: String(opts.limit ?? 50) })
  if (opts.mailbox) p.set('mailbox', opts.mailbox)
  if (opts.q) p.set('q', opts.q)
  return api<{ rows: ThreadRow[]; total: number | null; position: number }>(`${base(account)}/threads?${p}`)
}

export const fetchThread = (account: number, threadId: string, images: string[] = []) => api<{ id: string; messages: Message[] }>(`${base(account)}/thread/${encodeURIComponent(threadId)}${images.length ? `?images=${images.map(encodeURIComponent).join(',')}` : ''}`)
export const fetchMessage = (account: number, id: string, images: boolean) => api<Message>(`${base(account)}/message/${encodeURIComponent(id)}${images ? '?images=1' : ''}`)

export type Op = 'seen' | 'unseen' | 'flag' | 'unflag' | 'move' | 'archive' | 'trash' | 'junk' | 'notjunk' | 'destroy'
export async function act(account: number, op: Op, target: { emailIds?: string[]; threadIds?: string[]; to?: string; from?: string | null }) {
  const r = await api<{ changed: number }>(`${base(account)}/act`, { method: 'POST', json: { op, ...target, from: target.from ?? undefined } })
  mailChanged(account)
  return r
}

export type DraftBody = {
  id?: string | null
  identityId: string
  to: Address[]
  cc: Address[]
  bcc: Address[]
  subject: string
  text: string
  attachments: { blobId: string; type: string; name: string; size: number }[]
  inReplyTo?: string[]
  references?: string[]
  replyOf?: string | null
  forwardOf?: string | null
}
export const saveDraft = (account: number, d: DraftBody) => api<{ id: string }>(`${base(account)}/draft`, { method: 'POST', json: d })
export const discardDraft = (account: number, id: string) => api(`${base(account)}/draft/${encodeURIComponent(id)}`, { method: 'DELETE' })
export async function sendMail(account: number, d: DraftBody) {
  const r = await api<{ id: string }>(`${base(account)}/send`, { method: 'POST', json: d })
  mailChanged(account)
  return r
}

/** A file into the account's blob store, for attaching. */
export async function uploadBlob(account: number, file: Blob, type: string): Promise<{ blobId: string; type: string; size: number }> {
  const res = await fetch(`${base(account)}/upload?type=${encodeURIComponent(type || 'application/octet-stream')}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Mail-Upload': '1' },
    body: file,
  })
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new Error(body?.error ?? `Upload failed (${res.status})`)
  return body
}

/** An attachment's address: a download, or (`inline`, pictures only) to show. */
export const blobUrl = (account: number, a: Pick<Attachment, 'blobId' | 'name' | 'type'>, inline = false) =>
  `${base(account)}/blob/${encodeURIComponent(a.blobId)}?name=${encodeURIComponent(a.name)}&type=${encodeURIComponent(a.type)}${inline ? '&inline=1' : ''}`

export async function blobFile(account: number, a: Pick<Attachment, 'blobId' | 'name' | 'type'>): Promise<File> {
  const res = await fetch(blobUrl(account, a), { credentials: 'same-origin' })
  if (!res.ok) throw new Error(`${a.name}: ${(await res.json().catch(() => null))?.error ?? res.status}`)
  return new File([await res.blob()], a.name, { type: a.type })
}

// ---------------------------------------------------------------------------------------------
// Live updates

let version = 0
const versionListeners = new Set<() => void>()
let bump: ReturnType<typeof setTimeout> | null = null
/**
 * Everyone showing mail asks again: once, a moment after the last word of a change (a change made
 * here is also told back by the server's stream, and its push line tells it again).
 */
function mailChanged(_account?: number) {
  if (bump) clearTimeout(bump)
  bump = setTimeout(() => {
    bump = null
    version++
    for (const l of versionListeners) l()
  }, 300)
}
/** New mail or a change elsewhere (another device, the server's push line), told by the live stream (src/os/notifyStream.ts). */
export const mailChangedElsewhere = (data?: { account?: number }) => mailChanged(data?.account)
export const useMailVersion = () =>
  useSyncExternalStore(
    (l) => {
      versionListeners.add(l)
      return () => versionListeners.delete(l)
    },
    () => version,
  )

// ---------------------------------------------------------------------------------------------
// Preferences (synced; the server reads imageSenders to load their pictures)

export type MailPrefs = { imageSenders: string[]; markRead: boolean }
const prefs = synced<MailPrefs>('mail', { imageSenders: [], markRead: true }, {
  normalize: (v) => {
    const o = (v && typeof v === 'object' ? v : {}) as Partial<MailPrefs>
    return { imageSenders: Array.isArray(o.imageSenders) ? o.imageSenders.filter((x): x is string => typeof x === 'string').slice(0, 2000) : [], markRead: o.markRead !== false }
  },
})
export const useMailPrefs = prefs.use
export const mailPrefs = prefs.get
export const setMailPrefs = (patch: Partial<MailPrefs>) => prefs.set((p) => ({ ...p, ...patch }))
export const allowImagesFrom = (email: string) => prefs.set((p) => (p.imageSenders.includes(email.toLowerCase()) ? p : { ...p, imageSenders: [...p.imageSenders, email.toLowerCase()] }))

// ---------------------------------------------------------------------------------------------
// Hooks for other apps

export type Person = { name?: string | null; email: string }

/**
 * Where recipient fields get their suggestions. Mail fills it with recent correspondents; Contacts
 * can take over with `setSuggestProvider()` (its people, recent ones mixed in as it likes).
 */
export type SuggestProvider = (q: string, account: number | null) => Promise<Person[]>
const recentCorrespondents: SuggestProvider = async (q, account) => (account ? (await api<{ people: Person[] }>(`${base(account)}/suggest?q=${encodeURIComponent(q)}`)).people : [])
let suggestProvider: SuggestProvider = recentCorrespondents
export const setSuggestProvider = (p: SuggestProvider | null) => void (suggestProvider = p ?? recentCorrespondents)
export const suggestPeople: SuggestProvider = (q, account) => suggestProvider(q, account)
/** Mail's own suggestions, for a provider that wants to mix them in. */
export const recentPeople = recentCorrespondents

/**
 * What a click on a sender's or recipient's name does. Mail's own: a menu to copy the address or
 * write to them. Contacts can take over with `setPersonHandler()` (show or add the contact);
 * `more` are Mail's own items for that person (Mail from them), to add to its menu.
 */
export type PersonHandler = (person: Person, at: { x: number; y: number; anchor?: Element; menu?: boolean }, more: MenuItem[]) => void
let personHandler: PersonHandler | null = null
export const setPersonHandler = (fn: PersonHandler | null) => void (personHandler = fn)
export const personHandlerOf = () => personHandler

/** A message as other apps see it, for actions on it (Make task, Create event). */
export type MessageRef = { account: number; id: string; threadId: string; subject: string; from: Address[]; to: Address[]; cc: Address[]; receivedAt: string; text: string; invite: Invite | null; messageId: string | null }
export type MessageAction = { id: string; label: string; run: (m: MessageRef) => void; hint?: string }
const actions = new Map<string, MessageAction>()
const actionListeners = new Set<() => void>()
/**
 * Adds an item to the message menu ("Make task from this email" is `task`, "Create event from
 * this email" is `event`: until something registers those, they show as coming soon). Answers a
 * function that takes it away again.
 */
export function registerMessageAction(a: MessageAction): () => void {
  actions.set(a.id, a)
  actionListeners.forEach((l) => l())
  return () => {
    if (actions.get(a.id) === a) actions.delete(a.id)
    actionListeners.forEach((l) => l())
  }
}
export const messageActions = () => [...actions.values()]

/**
 * Answering an invitation (Accept, Maybe, Decline): Calendar plugs in here. Until then the buttons
 * say "Coming soon". `status` says what the card shows (your answer so far, which calendar has
 * the event); `remove` takes a cancelled event out of the calendar and `apply` writes a guest's
 * reply onto your event. Each answers the card's new status.
 */
export type InviteAnswer = 'accepted' | 'tentative' | 'declined'
export type InviteStatus = {
  /** Your answer so far (from your calendar's copy when there is one). */
  answer: InviteAnswer | 'needs-action' | null
  /** The calendar the event is in, if any, what it is called and when it starts there (a reply often says neither), and whether it is cancelled there. */
  calendar: string | null
  event?: { title: string; start: string | null; allDay: boolean } | null
  cancelled: boolean
  /** It can be answered (an invitation that lists you). */
  canAnswer: boolean
  /** A reply: each guest's answer and whether your event shows it yet (null: not on it). */
  replies: { email: string; name: string | null; answer: string; inCalendar: boolean | null; fromSender: boolean }[]
  /** You organise the event (a reply can be written onto it). */
  organiser: boolean
}
export type InviteHandler = {
  answer: (invite: Invite, answer: InviteAnswer, message: MessageRef) => Promise<InviteStatus | void>
  open?: (invite: Invite, message: MessageRef) => void
  status?: (invite: Invite, message: MessageRef) => Promise<InviteStatus>
  remove?: (invite: Invite, message: MessageRef) => Promise<InviteStatus>
  apply?: (invite: Invite, message: MessageRef) => Promise<InviteStatus>
}
let inviteHandler: InviteHandler | null = null
export const setInviteHandler = (h: InviteHandler | null) => void (inviteHandler = h)
export const inviteHandlerOf = () => inviteHandler

// ---------------------------------------------------------------------------------------------
// Starting mail from anywhere

/** An attachment for composeMail: a file (or blob with a name), or a Seafile path. */
export type ComposeAttachment = File | { name: string; blob: Blob } | { seafile: string }
export type ComposeRequest = { to?: Person[] | string[]; cc?: Person[] | string[]; bcc?: Person[] | string[]; subject?: string; body?: string; attachments?: ComposeAttachment[]; account?: number }

const pending = new Map<string, ComposeRequest>()
/** The Mail app takes a request opened with composeMail (once). */
export function takeCompose(key: string | undefined): ComposeRequest | null {
  if (!key) return null
  const r = pending.get(key) ?? null
  pending.delete(key)
  return r
}

const open = (props: Record<string, string>) => window.dispatchEvent(new CustomEvent('mvlos:open', { detail: { app: 'mail', props: { ...props, t: String(Date.now()) } } }))

/** Opens Mail with a new message, filled in (Contacts' "Send email", Calendar's "Email guests"). */
export function composeMail(req: ComposeRequest = {}) {
  open({ compose: queueCompose(req), ...(req.account ? { account: String(req.account) } : {}) })
}

/** Keeps a message to write for the Mail app, which takes it by the key answered (props.compose). */
export function queueCompose(req: ComposeRequest): string {
  const key = crypto.randomUUID()
  pending.set(key, req)
  return key
}

/** Opens Mail on one message (its conversation), by its JMAP id; `account` when several are linked. */
export function openMail(id: string, opts: { account?: number } = {}) {
  open({ email: id, ...(opts.account ? { account: String(opts.account) } : {}) })
}

/** Opens Mail on the message with this Message-ID, in whichever linked account has it (a task's or an event's link back). */
export function openMailByMessageId(messageId: string) {
  open({ message: messageId })
}

/** A mailto: link as a compose request. */
export function fromMailto(href: string): ComposeRequest | null {
  if (!/^mailto:/i.test(href)) return null
  const [addr, query = ''] = href.slice(7).split('?')
  const q = new URLSearchParams(query)
  const list = (v: string | null) => (v ?? '').split(',').map((s) => decodeURIComponent(s.trim())).filter(Boolean)
  return { to: list(addr), cc: list(q.get('cc')), bcc: list(q.get('bcc')), subject: q.get('subject') ?? undefined, body: q.get('body') ?? undefined }
}

/** People given as addresses or as { name, email }, as addresses. */
export const toAddresses = (list: Person[] | string[] | undefined): Address[] => (list ?? []).map((p) => (typeof p === 'string' ? { name: null, email: p } : { name: p.name ?? null, email: p.email }))

/** The mailbox list in the sidebar's order: roles first (Inbox, Drafts, Sent, Archive, Junk, Trash), then folders by name, children under parents. */
const ROLE_ORDER = ['inbox', 'drafts', 'sent', 'archive', 'junk', 'trash']
export function orderMailboxes(list: Mailbox[]): { box: Mailbox; depth: number }[] {
  const children = new Map<string | null, Mailbox[]>()
  for (const b of list) children.set(b.parentId, [...(children.get(b.parentId) ?? []), b])
  const rank = (b: Mailbox) => (b.role && ROLE_ORDER.includes(b.role) ? ROLE_ORDER.indexOf(b.role) : 100)
  const sort = (l: Mailbox[]) => [...l].sort((a, b) => rank(a) - rank(b) || a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
  const out: { box: Mailbox; depth: number }[] = []
  const walk = (parent: string | null, depth: number) => {
    for (const b of sort(children.get(parent) ?? [])) {
      out.push({ box: b, depth })
      if (depth < 8) walk(b.id, depth + 1)
    }
  }
  walk(null, 0)
  // Orphans (a parent the token can't see) at the end.
  for (const b of list) if (!out.some((o) => o.box.id === b.id)) out.push({ box: b, depth: 0 })
  return out
}

/** A person's name or address, for lists. */
export const nameOf = (a: Address | undefined) => (a ? a.name || a.email : '')

/** Re-renders when the set of message actions changes. */
export function useMessageActions(): MessageAction[] {
  const [, setN] = useState(0)
  useEffect(() => {
    const l = () => setN((n) => n + 1)
    actionListeners.add(l)
    return () => void actionListeners.delete(l)
  }, [])
  return messageActions()
}
