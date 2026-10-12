import { useEffect, useState } from 'react'
import { calendarChangedElsewhere, calendarList, composeEvent, lastCalendarId, openEventByUid, type CalendarEvent } from '../data/calendar'
import { addContact, displayName, openContact, peekContactByEmail, registerContactSlot, searchLoaded, type Contact } from '../data/contacts'
import { registerLinkHandler } from '../data/links'
import {
  composeMail,
  fromMailto,
  loadMailAccounts,
  mailAccountsNow,
  openMail,
  openMailByMessageId,
  recentPeople,
  registerMessageAction,
  setInviteHandler,
  setPersonHandler,
  setSuggestProvider,
  useMailAccounts,
  type Invite,
  type InviteStatus,
  type MessageRef,
  type Person,
} from '../data/mail'
import { eventsWith, inviteAction, inviteState, mailLink, mailWith, messageIdOf, taskFromMail, type InviteState } from '../data/pim'
import { openTask, reloadTasks } from '../data/tasks'
import { getAccount, hasCalendar, subscribeAccount, useAccount } from './account'
import { openContextMenu, openMenuAt, type MenuItem } from './ContextMenu'
import { choose } from './Dialogs'
import { notify } from './notify'

// How Mail, Contacts, Calendar and Tasks work together. Each app has hooks the others plug into
// (src/data/mail.ts, contacts.ts, calendar.ts, tasks.ts); this is where they are plugged in, once
// for the page, so no app has to know the others:
//
//   - Mail's recipient fields suggest your contacts first, then recent correspondents
//     (setSuggestProvider); a click on a person opens or adds the contact (setPersonHandler).
//   - Invitations in Mail are answered where the event lives (setInviteHandler, server/pim.ts),
//     and open in Calendar.
//   - Mail's message menu makes a task or an event from a message (registerMessageAction).
//   - The contact card shows recent mail and upcoming events with that person (registerContactSlot).
//   - mailto: links anywhere open Mail's composer once Mail is linked, and links back to a message
//     (a task's message: URL, an event's notes) open it in Mail (registerLinkHandler).

let started = false

export function startPimLinks() {
  if (started) return
  started = true

  // Which mail accounts are linked decides where mailto: links go: known once signed in.
  const accounts = () => (getAccount().status === 'user' ? void loadMailAccounts() : undefined)
  subscribeAccount(accounts)
  accounts()
  const mailLinked = () => getAccount().status === 'user' && !!mailAccountsNow()?.length

  setSuggestProvider(suggest)
  setPersonHandler(personMenu)
  setInviteHandler({ status: (_, m) => inviteState(m.account, m.id).then(toStatus), answer, remove: (_, m) => act(m, 'remove'), apply: (_, m) => act(m, 'apply'), open: openInvite })
  registerMessageAction({ id: 'task', label: 'Make task from this email', run: (m) => void makeTask(m) })
  registerMessageAction({ id: 'event', label: 'Create event from this email', run: (m) => void makeEvent(m) })
  registerContactSlot('recent-mail', (c) => <RecentMail contact={c} />)
  registerContactSlot('upcoming-events', (c) => <UpcomingEvents contact={c} />)

  registerLinkHandler((url) => {
    if (!mailLinked()) return false
    if (/^mailto:/i.test(url)) {
      const req = fromMailto(url)
      if (!req) return false
      composeMail(req)
      return true
    }
    const mid = messageIdOf(url)
    if (mid) return openMailByMessageId(mid), true
    // This site's address of a message in an account (a task made from a message without a Message-ID).
    try {
      const u = new URL(url)
      if (u.origin === location.origin && u.searchParams.get('open') === 'mail' && u.searchParams.get('email')) {
        openMail(u.searchParams.get('email')!, { account: Number(u.searchParams.get('account')) || undefined })
        return true
      }
    } catch {
      /* not an address */
    }
    return false
  })
}

// ---------------------------------------------------------------------------------------------
// People in Mail

/** Recipient suggestions: your contacts (every address of each) first, then recent correspondents. */
async function suggest(q: string, account: number | null): Promise<Person[]> {
  const people: Person[] = searchLoaded(q, 8).flatMap((c) => c.emails.map((e) => ({ name: displayName(c), email: e.value })))
  const recent = await recentPeople(q, account).catch(() => [] as Person[])
  const seen = new Set<string>()
  return [...people, ...recent].filter((p) => !seen.has(p.email.toLowerCase()) && !!seen.add(p.email.toLowerCase())).slice(0, 12)
}

/** A click on a person in Mail: open their contact (or add them), write to them, copy the address, and Mail's own items. */
function personMenu(person: Person, at: { x: number; y: number; anchor?: Element; menu?: boolean }, more: MenuItem[]) {
  const c = peekContactByEmail(person.email)
  const items: MenuItem[] = [
    c
      ? { label: 'Open contact', hint: displayName(c), onSelect: () => openContact(c.id) }
      : { label: 'Add to contacts', hint: person.name ? `${person.name} <${person.email}>` : person.email, onSelect: () => void addContact({ email: person.email, name: person.name ?? undefined }).then((n) => openContact(n.id), () => openContact(person.email, person.name ?? undefined)) },
    { label: 'New message', onSelect: () => composeMail({ to: [person] }) },
    { label: 'Copy address', onSelect: () => void navigator.clipboard?.writeText(person.email).then(() => notify({ title: 'Address copied', body: person.email, transient: true })).catch(() => {}) },
    ...(more.length ? [{ separator: true as const }, ...more] : []),
  ]
  if (at.anchor && !at.menu) openMenuAt(at.anchor, items)
  else openContextMenu({ clientX: at.x, clientY: at.y, preventDefault() {}, stopPropagation() {} }, items)
}

// ---------------------------------------------------------------------------------------------
// Invitations

function toStatus(s: InviteState): InviteStatus {
  return {
    answer: s.status,
    calendar: s.where?.calendar ?? null,
    cancelled: !!s.where?.cancelled,
    canAnswer: s.canAnswer,
    organiser: s.organiser,
    replies: s.replies.map((r) => ({ email: r.email, name: r.name, answer: r.status, inCalendar: r.current === null ? null : r.current === r.status, fromSender: r.fromSender })),
  }
}

/** The calendar a copy of an invitation goes in when no calendar has it: the one used last, or your main one. */
async function calendarForCopy(): Promise<string | undefined> {
  const account = getAccount()
  if (!hasCalendar(account)) return undefined
  const { calendars } = await calendarList(account).catch(() => ({ calendars: [] }))
  const writable = calendars.filter((c) => c.writable)
  return (writable.find((c) => c.id === lastCalendarId()) ?? writable.find((c) => c.primary) ?? writable[0])?.id
}

async function answer(_: Invite, a: 'accepted' | 'tentative' | 'declined', m: MessageRef): Promise<InviteStatus> {
  const r = await inviteAction({ account: m.account, email: m.id, action: 'answer', answer: a, calendar: await calendarForCopy() })
  calendarChangedElsewhere()
  if (r.via === 'email') notify({ title: 'Answer sent', body: r.added ? `By email to the organiser, and added to ${r.state.where?.calendar ?? 'your calendar'}` : 'By email to the organiser', transient: true })
  return toStatus(r.state)
}

async function act(m: MessageRef, action: 'remove' | 'apply'): Promise<InviteStatus> {
  const r = await inviteAction({ account: m.account, email: m.id, action })
  calendarChangedElsewhere()
  return toStatus(r.state)
}

function openInvite(inv: Invite) {
  const day = inv.start ? new Date(inv.allDay ? `${inv.start}T00:00:00` : inv.start) : new Date()
  if (inv.uid) openEventByUid(inv.uid, day)
  else window.dispatchEvent(new CustomEvent('mvlos:open', { detail: { app: 'calendar', props: { t: String(Date.now()) } } }))
}

// ---------------------------------------------------------------------------------------------
// Making a task or an event from a message

const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** When the task is due: asked in the desktop's own dialog. undefined: cancelled; null: no date. */
async function askDue(subject: string): Promise<string | null | undefined> {
  const today = new Date()
  const plus = (n: number) => dayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() + n))
  // Next Monday, as "next week" in Apple's Reminders.
  const nextWeek = plus(((8 - today.getDay()) % 7) || 7)
  let picked = plus(2)
  const id = await choose({
    title: 'Make a task from this email',
    body: (
      <div className="pim-due">
        <p className="pim-due-title">{subject || '(No subject)'}</p>
        <label className="pim-due-date">
          Due on
          <input type="date" defaultValue={picked} onChange={(e) => (picked = e.target.value)} aria-label="Due date" />
        </label>
      </div>
    ),
    buttons: [
      { id: 'cancel', label: 'Cancel' },
      { id: 'none', label: 'No date' },
      { id: 'today', label: 'Today' },
      { id: 'tomorrow', label: 'Tomorrow' },
      { id: 'week', label: 'Next week' },
      { id: 'date', label: 'On that date', primary: true },
    ],
  })
  if (!id || id === 'cancel') return undefined
  return id === 'none' ? null : id === 'today' ? plus(0) : id === 'tomorrow' ? plus(1) : id === 'week' ? nextWeek : /^\d{4}-\d{2}-\d{2}$/.test(picked) ? picked : null
}

async function makeTask(m: MessageRef) {
  const due = await askDue(m.subject)
  if (due === undefined) return
  try {
    const { task } = await taskFromMail(m.account, m.id, due)
    void reloadTasks()
    notify({ title: 'Task made', body: task.title, onClick: () => openTask(task.id), transient: true })
  } catch (e) {
    notify({ title: 'Could not make the task', body: (e as Error).message, transient: true })
  }
}

function makeEvent(m: MessageRef) {
  // Everyone on the message but you (the account's own address).
  const own = new Set((mailAccountsNow() ?? []).map((a) => a.username.toLowerCase()))
  const guests = [...new Set([...m.from, ...m.to, ...m.cc].map((a) => a.email.toLowerCase()))].filter((e) => !own.has(e))
  const link = m.messageId ? mailLink(m.messageId) : `${location.origin}/?open=mail&account=${m.account}&email=${encodeURIComponent(m.id)}`
  composeEvent({ title: m.subject.replace(/^((re|fwd?|aw|wg):\s*)+/i, ''), guests, description: `From the email “${m.subject || '(No subject)'}”:\n${link}` })
}

// ---------------------------------------------------------------------------------------------
// The contact card's sections

const when = (iso: string) => {
  const d = new Date(iso)
  const now = new Date()
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) })
}

function RecentMail({ contact }: { contact: Contact }) {
  const me = useAccount()
  const { accounts: mailAccounts } = useMailAccounts()
  const [state, setState] = useState<{ rows: Awaited<ReturnType<typeof mailWith>>['messages']; loading: boolean; error: string | null }>({ rows: [], loading: true, error: null })
  const emails = contact.emails.map((e) => e.value.toLowerCase())
  const key = emails.join(',')
  const linked = me.status === 'user' && !!mailAccounts?.length
  useEffect(() => {
    if (!linked || !emails.length) return
    let live = true
    setState((s) => ({ ...s, loading: true }))
    mailWith(emails, 5).then(
      (r) => live && setState({ rows: r.messages, loading: false, error: r.errors[0] ?? null }),
      (e: Error) => live && setState({ rows: [], loading: false, error: e.message }),
    )
    return () => {
      live = false
    }
  }, [key, linked]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!linked || !emails.length) return null
  return (
    <>
      <h3 className="ct-slot-head">
        Recent mail
        <button className="link-btn" onClick={() => composeMail({ to: [{ name: displayName(contact), email: contact.emails[0].value }] })}>
          Send email
        </button>
      </h3>
      {state.loading && !state.rows.length ? <p className="muted ct-slot-empty">Looking…</p> : !state.rows.length ? <p className="muted ct-slot-empty">{state.error ?? 'No mail with them yet.'}</p> : null}
      <ul className="ct-slot-list">
        {state.rows.map((r) => (
          <li key={`${r.account}-${r.id}`}>
            <button className="ct-slot-row" onClick={() => openMail(r.id, { account: r.account })} title="Open in Mail">
              <span className={`ct-slot-title ${r.seen ? '' : 'is-unread'}`}>{r.subject || '(No subject)'}</span>
              <span className="muted ct-slot-sub">
                {r.from[0] && emails.includes(r.from[0].email.toLowerCase()) ? 'From them' : 'To them'} · {when(r.receivedAt)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </>
  )
}

function UpcomingEvents({ contact }: { contact: Contact }) {
  const me = useAccount()
  const [state, setState] = useState<{ events: CalendarEvent[]; loading: boolean; error: string | null }>({ events: [], loading: true, error: null })
  const emails = contact.emails.map((e) => e.value.toLowerCase())
  const key = emails.join(',')
  const linked = me.status === 'user' && hasCalendar(me)
  useEffect(() => {
    if (!linked || !emails.length) return
    let live = true
    eventsWith(emails, 60).then(
      (r) => live && setState({ events: r.events, loading: false, error: r.errors[0] ?? null }),
      (e: Error) => live && setState({ events: [], loading: false, error: e.message }),
    )
    return () => {
      live = false
    }
  }, [key, linked]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!linked || !emails.length) return null
  const time = (e: CalendarEvent) => (e.allDay ? `${when(e.start)} · all day` : `${when(e.start)} · ${new Date(e.start).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}`)
  return (
    <>
      <h3 className="ct-slot-head">
        Upcoming events
        <button className="link-btn" onClick={() => composeEvent({ guests: [emails[0]] })}>
          New event with them
        </button>
      </h3>
      {state.loading && !state.events.length ? <p className="muted ct-slot-empty">Looking…</p> : !state.events.length ? <p className="muted ct-slot-empty">{state.error ?? 'Nothing planned with them in the next 60 days.'}</p> : null}
      <ul className="ct-slot-list">
        {state.events.map((e) => (
          <li key={e.id}>
            <button className="ct-slot-row" onClick={() => (e.uid ? openEventByUid(e.uid, new Date(e.allDay ? `${e.start}T00:00:00` : e.start)) : window.dispatchEvent(new CustomEvent('mvlos:open', { detail: { app: 'calendar', props: { date: e.start.slice(0, 10), t: String(Date.now()) } } })))} title="Open in Calendar">
              <span className="ct-slot-dot" style={{ background: e.color }} aria-hidden />
              <span className="ct-slot-title">{e.title}</span>
              <span className="muted ct-slot-sub">
                {time(e)} · {e.calendar}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </>
  )
}
