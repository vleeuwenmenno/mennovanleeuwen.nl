import { useEffect, useMemo, useState, type MouseEvent, type ReactNode } from 'react'
import { openContextMenu, openMenuAt, type MenuItem } from '../../os/ContextMenu'
import { notify } from '../../os/notify'
import { Avatar as PersonAvatar, PeoplePicker, parseAddresses as parsePeople, type Person as PickedPerson } from '../contacts/people'
import { composeMail, inviteHandlerOf, personHandlerOf, suggestPeople, type Address, type Invite, type InviteAnswer, type InviteStatus, type MessageRef, type Person } from '../../data/mail'

// Pieces of the Mail app: the sandboxed frame HTML mail is shown in, plain text with its links
// and quotes, the invitation card, recipient fields and what a click on a person does.

// ---------------------------------------------------------------------------------------------
// HTML mail, in a frame of its own

/**
 * The frame's document around the already-sanitised HTML (server/mailhtml.ts). The frame is
 * sandboxed without scripts or same-origin, and the policy below lets in nothing but the
 * message's own inline pictures, data: pictures and its own styles, plus remote pictures once
 * images are on. Links open in a new tab (allow-popups), outside the sandbox.
 */
export function frameDoc(html: string, images: boolean): string {
  const self = `${location.origin}/api/mail/inline/`
  const csp = [`default-src 'none'`, `img-src data: ${self}${images ? ' https: http:' : ''}`, `style-src 'unsafe-inline'`, `font-src data:`, `form-action 'none'`, `base-uri 'none'`, `frame-src 'none'`, `media-src 'none'`].join('; ')
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"><meta name="color-scheme" content="light"><base target="_blank"><style>
html { background: #fff; color: #1f2328; }
body { margin: 0; padding: 14px 16px; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; overflow-wrap: anywhere; }
img { max-width: 100%; height: auto; }
pre { white-space: pre-wrap; }
blockquote[type=cite] { margin: 0 0 0 4px; padding-left: 10px; border-left: 3px solid #d0d7de; color: #57606a; }
details.mail-quote > summary { display: inline-block; margin: 6px 0; padding: 0 8px; border: 1px solid #d0d7de; border-radius: 3px; color: #57606a; font-size: 12px; cursor: pointer; list-style: none; }
details.mail-quote > summary::-webkit-details-marker { display: none; }
details.mail-quote[open] > summary { margin-bottom: 8px; }
.mail-blocked { display: inline-block; padding: 2px 6px; border: 1px dashed #d0d7de; color: #57606a; font-size: 12px; }
</style></head><body>${html}</body></html>`
}

/**
 * mailto: links in HTML mail go to Mail's composer: the frame runs no scripts, so they become this
 * site's /?mailto= address, which opens MvL OS (in a new tab, as every link in the frame does)
 * with the message ready to write.
 */
const composeLinks = (html: string) =>
  html.replace(/href="(mailto:[^"]*)"/gi, (_, href: string) => `href="${location.origin}/?mailto=${encodeURIComponent(href.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'))}"`)

/** HTML mail: a sandboxed frame (no scripts, no same-origin), as tall as the reading pane allows. */
export function MessageFrame({ html, images, tall }: { html: string; images: boolean; tall: boolean }) {
  const doc = useMemo(() => frameDoc(composeLinks(html), images), [html, images])
  return <iframe className={`ml-frame ${tall ? 'is-tall' : ''}`} sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={doc} title="Message" referrerPolicy="no-referrer" />
}

/** The text of HTML mail, for quoting it in a reply. Parsed in an inert document: nothing loads or runs. */
export function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  doc.querySelectorAll('style, details.mail-quote > summary').forEach((n) => n.remove())
  doc.querySelectorAll('br').forEach((n) => n.replaceWith('\n'))
  doc.querySelectorAll('p, div, li, tr, h1, h2, h3, h4, h5, h6, blockquote, pre, table').forEach((n) => n.append('\n'))
  return (doc.body.textContent ?? '').replace(/ /g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

// ---------------------------------------------------------------------------------------------
// Plain text

const LINK = /\b(https?:\/\/[^\s<>"')\]]+[^\s<>"')\].,;:!?]|www\.[^\s<>"')\]]+[^\s<>"')\].,;:!?])|([\w.+-]+@[\w-]+(?:\.[\w-]+)+)/g

/** A line with its web links and email addresses made clickable. */
function linked(line: string, key: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  for (const m of line.matchAll(LINK)) {
    if (m.index! > last) out.push(line.slice(last, m.index))
    if (m[1]) {
      const href = m[1].startsWith('www.') ? `https://${m[1]}` : m[1]
      out.push(
        <a key={`${key}-${m.index}`} href={href} target="_blank" rel="noopener noreferrer" title={href}>
          {m[1]}
        </a>,
      )
    } else {
      const email = m[2]
      out.push(
        <a
          key={`${key}-${m.index}`}
          href={`mailto:${email}`}
          title={email}
          onClick={(e) => {
            e.preventDefault()
            composeMail({ to: [email] })
          }}
        >
          {email}
        </a>,
      )
    }
    last = m.index! + m[0].length
  }
  if (last < line.length) out.push(line.slice(last))
  return out
}

/**
 * Plain-text mail: links found, quoted lines ("> ", with the "On … wrote:" before them) folded
 * away once the message has said something of its own.
 */
export function PlainText({ text }: { text: string }) {
  const blocks = useMemo(() => {
    const lines = text.replace(/\r\n/g, '\n').split('\n')
    const out: { quote: boolean; lines: string[] }[] = []
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const quoted = /^\s*>/.test(line)
      const intro = !quoted && /^(On |Op |Am |Le ).{0,200}(wrote|schreef|schrieb|a écrit)\s*:\s*$/i.test(line.trim()) && /^\s*>/.test(lines[i + 1] ?? (lines[i + 2] ?? ''))
      const quote = quoted || intro
      const lastBlock = out.at(-1)
      if (lastBlock && lastBlock.quote === quote) lastBlock.lines.push(line)
      else if (lastBlock?.quote && !quote && !line.trim()) lastBlock.lines.push(line)
      else out.push({ quote, lines: [line] })
    }
    return out
  }, [text])
  const own = blocks.some((b) => !b.quote && b.lines.some((l) => l.trim()))
  return (
    <div className="ml-text">
      {blocks.map((b, i) => {
        const body = b.lines.map((l, j) => (
          <span key={j}>
            {linked(l, `${i}-${j}`)}
            {'\n'}
          </span>
        ))
        return b.quote && own ? (
          <details key={i} className="ml-quote">
            <summary>Show quoted text</summary>
            {body}
          </details>
        ) : (
          <span key={i}>{body}</span>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// People

/** A click on a sender or recipient: Contacts' handler when it has one, otherwise copy or write. */
export function showPerson(person: Address, e: MouseEvent, more: MenuItem[] = []) {
  const handler = personHandlerOf()
  if (handler) {
    e.preventDefault()
    e.stopPropagation()
    return handler(person, { x: e.clientX, y: e.clientY, anchor: e.currentTarget as Element, menu: e.type === 'contextmenu' }, more)
  }
  const label = person.name ? `${person.name} <${person.email}>` : person.email
  const items: MenuItem[] = [
    { label: 'Copy address', hint: label, onSelect: () => void navigator.clipboard?.writeText(person.email).then(() => notify({ title: 'Address copied', body: person.email, transient: true })).catch(() => {}) },
    { label: 'New message', onSelect: () => composeMail({ to: [person as Person] }) },
    ...more,
  ]
  if (e.type === 'contextmenu') openContextMenu(e, items)
  else openMenuAt(e.currentTarget as Element, items)
}

/** A name that does what showPerson says. */
export function PersonName({ person, more, children }: { person: Address; more?: MenuItem[]; children?: ReactNode }) {
  return (
    <button
      type="button"
      className="ml-person"
      title={person.name ? `${person.name} <${person.email}>` : person.email}
      onClick={(e) => {
        e.stopPropagation()
        showPerson(person, e, more)
      }}
      onContextMenu={(e) => showPerson(person, e, more)}
    >
      {children ?? (person.name || person.email)}
    </button>
  )
}

// ---------------------------------------------------------------------------------------------
// Invitations

const STATUS: Record<string, string> = { ACCEPTED: 'accepted', DECLINED: 'declined', TENTATIVE: 'said maybe to', DELEGATED: 'delegated' }

function inviteWhen(inv: Invite): string {
  if (!inv.start) return 'No time given'
  if (inv.allDay) {
    const d = new Date(`${inv.start}T00:00:00`)
    return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  }
  // A time without a zone (an Outlook zone the server didn't know) is taken as local.
  const s = new Date(inv.start)
  const e = inv.end ? new Date(inv.end) : null
  const day = s.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  const t = (d: Date) => d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  const sameDay = e && e.toDateString() === s.toDateString()
  return `${day}, ${t(s)}${e ? ` – ${sameDay ? t(e) : `${e.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${t(e)}`}` : ''}`
}

const ANSWER_LABEL: Record<InviteAnswer, string> = { accepted: 'Accept', tentative: 'Maybe', declined: 'Decline' }
const ANSWERED: Record<string, string> = { accepted: 'You accepted', tentative: 'You said maybe', declined: 'You declined', 'needs-action': 'Not answered yet' }

/**
 * A calendar invitation in a message: what, when, where and from whom, with what Calendar says
 * about it once it plugs in (setInviteHandler): your answer and where the event is, Accept, Maybe
 * and Decline for an invitation, removing a cancelled event, and writing a guest's reply onto your
 * own event.
 */
export function InviteCard({ invite: given, message }: { invite: Invite; message: MessageRef }) {
  const handler = inviteHandlerOf()
  const [busy, setBusy] = useState<string | null>(null)
  const [status, setStatus] = useState<InviteStatus | null>(null)
  const label = given.method === 'REQUEST' ? 'Invitation' : given.method === 'CANCEL' ? 'Cancelled' : given.method === 'REPLY' ? 'Reply' : given.method === 'COUNTER' ? 'New time proposed' : given.method.toLowerCase()
  useEffect(() => {
    let live = true
    setStatus(null)
    handler?.status?.(given, message).then(
      (s) => live && setStatus(s),
      () => live && setStatus(null),
    )
    return () => {
      live = false
    }
  }, [message.id, message.account]) // eslint-disable-line react-hooks/exhaustive-deps
  const run = async (what: string, work: () => Promise<InviteStatus | void>) => {
    setBusy(what)
    try {
      const s = await work()
      if (s) setStatus(s)
    } catch (e) {
      notify({ title: 'Could not do that', body: (e as Error).message, transient: true })
    } finally {
      setBusy(null)
    }
  }
  // A reply often leaves out the title and time: the event in your calendar has them.
  const event = status?.event
  const invite = event && (!given.start || given.title === '(No title)') ? { ...given, title: given.title === '(No title)' ? event.title : given.title, start: given.start ?? event.start, allDay: given.start ? given.allDay : event.allDay } : given
  const answer = status?.answer ?? null
  const where = status?.calendar
  const replies = status?.replies.length ? status.replies : invite.replies.map((r) => ({ email: r.email, name: r.name, answer: r.status.toLowerCase(), inCalendar: null, fromSender: true }))
  return (
    <div className={`ml-invite ${invite.method === 'CANCEL' || status?.cancelled ? 'is-cancelled' : ''}`}>
      <div className="ml-invite-date" aria-hidden>
        {invite.start ? (
          <>
            <span>{new Date(invite.allDay ? `${invite.start}T00:00:00` : invite.start).toLocaleDateString(undefined, { month: 'short' })}</span>
            <strong>{new Date(invite.allDay ? `${invite.start}T00:00:00` : invite.start).getDate()}</strong>
          </>
        ) : (
          <strong>?</strong>
        )}
      </div>
      <div className="ml-invite-body">
        <span className="ml-invite-kind">{label}</span>
        <strong className="ml-invite-title">{invite.title}</strong>
        <span>{inviteWhen(invite)}</span>
        {invite.location && <span className="muted">{invite.location}</span>}
        {invite.organizer && (
          <span className="muted">
            Organiser: <PersonName person={{ name: invite.organizer.name, email: invite.organizer.email }} />
            {invite.attendees > 1 && ` · ${invite.attendees} guests`}
          </span>
        )}
        {invite.method === 'REPLY' &&
          replies.map((r) => (
            <span key={r.email} className="ml-invite-reply">
              {r.name || r.email} {STATUS[r.answer.toUpperCase()] ?? 'answered'} this.
              {r.inCalendar === true && <span className="muted"> Your event shows it.</span>}
              {status?.organiser && r.fromSender && r.inCalendar === false && handler?.apply && (
                <button className="btn btn-small" disabled={!!busy} onClick={() => void run('apply', () => handler.apply!(invite, message))}>
                  {busy === 'apply' ? '…' : 'Update your event'}
                </button>
              )}
            </span>
          ))}
        {invite.method === 'REQUEST' && (
          <>
            {status && (
              <span className="ml-invite-state">
                {[answer ? ANSWERED[answer] : null, where ? `In ${where}` : status.canAnswer ? 'Not in your calendars yet' : null].filter(Boolean).join(' · ')}
              </span>
            )}
            <div className="ml-invite-actions">
              {(['accepted', 'tentative', 'declined'] as InviteAnswer[]).map((a) => (
                <button
                  key={a}
                  className={`btn btn-small ${answer === a ? 'btn-primary' : ''}`}
                  aria-pressed={answer === a}
                  disabled={!handler || !!busy || (!!status && !status.canAnswer)}
                  title={handler ? undefined : 'Coming soon'}
                  onClick={() => void run(a, async () => (await handler!.answer(invite, a, message)) ?? undefined)}
                >
                  {busy === a ? '…' : ANSWER_LABEL[a]}
                </button>
              ))}
              {!handler && <span className="ml-soon">Coming soon</span>}
              {handler?.open && invite.start && (
                <button className="link-btn" onClick={() => handler.open!(invite, message)}>
                  Open in Calendar
                </button>
              )}
            </div>
          </>
        )}
        {invite.method === 'CANCEL' && status && (
          <div className="ml-invite-actions">
            {where && !status.cancelled ? (
              <>
                <span className="muted">Still in {where}.</span>
                {handler?.remove && (
                  <button className="btn btn-small" disabled={!!busy} onClick={() => void run('remove', () => handler.remove!(invite, message))}>
                    {busy === 'remove' ? '…' : 'Remove from calendar'}
                  </button>
                )}
              </>
            ) : (
              <span className="muted">Not in your calendars.</span>
            )}
          </div>
        )}
        {invite.method === 'REPLY' && where && handler?.open && (
          <div className="ml-invite-actions">
            <button className="link-btn" onClick={() => handler.open!(invite, message)}>
              Open in Calendar
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Recipient fields

/** "Name <a@b.c>", "a@b.c" or several of them, as addresses (whatever is not one is left out). */
export const parseAddresses = (text: string): Address[] => parsePeople(text).map((p) => ({ name: p.name ?? null, email: p.email }))

/**
 * To, Cc and Bcc: Contacts' people picker (your contacts as you type, groups, several pasted at
 * once), with what `suggest` says after them: Contacts plugs in through setSuggestProvider with
 * its people first and recent correspondents after; until then, recent correspondents.
 */
export function RecipientField({ label, value, onChange, account, autoFocus, suggest = suggestPeople }: { label: string; value: Address[]; onChange: (v: Address[]) => void; account: number; autoFocus?: boolean; suggest?: (q: string, account: number | null) => Promise<Person[]> }) {
  const people = useMemo<PickedPerson[]>(() => value.map((a) => (a.name ? { email: a.email, name: a.name } : { email: a.email })), [value])
  return (
    <div className="ml-field ml-recipients">
      <span className="ml-field-label">{label}</span>
      <PeoplePicker
        value={people}
        onChange={(next) => onChange(next.map((p) => ({ name: p.name ?? null, email: p.email })))}
        more={(q) => suggest(q, account).then((list) => list.map((p) => (p.name ? { email: p.email, name: p.name } : { email: p.email })))}
        label={label}
        autoFocus={autoFocus}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Little things

export const formatSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)

/** Today: the time; this year: day and month; otherwise the date. */
export function shortDate(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  if (now.getTime() - d.getTime() < 6 * 864e5 && d < now) return d.toLocaleDateString(undefined, { weekday: 'short' })
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

export const longDate = (iso: string) => {
  const d = new Date(iso)
  return isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** A person's picture: their contact's photo, or their initials on a colour of their own. */
export function Avatar({ person, size = 32 }: { person: Address | undefined; size?: number }) {
  return <PersonAvatar email={person?.email} name={person?.name || person?.email || '?'} size={size} />
}
