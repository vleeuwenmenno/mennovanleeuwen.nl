import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { openContextMenu, openMenuAt, type MenuItem } from '../../os/ContextMenu'
import { notify } from '../../os/notify'
import { composeMail, inviteHandlerOf, personHandlerOf, suggestPeople, type Address, type Invite, type InviteAnswer, type MessageRef, type Person } from '../../data/mail'

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

/** HTML mail: a sandboxed frame (no scripts, no same-origin), as tall as the reading pane allows. */
export function MessageFrame({ html, images, tall }: { html: string; images: boolean; tall: boolean }) {
  const doc = useMemo(() => frameDoc(html, images), [html, images])
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
  if (handler) return handler(person, { x: e.clientX, y: e.clientY, anchor: e.currentTarget as Element })
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

/** A calendar invitation in a message: what, when, where and from whom, with answers once Calendar takes them. */
export function InviteCard({ invite, message }: { invite: Invite; message: MessageRef }) {
  const handler = inviteHandlerOf()
  const [busy, setBusy] = useState<InviteAnswer | null>(null)
  const [done, setDone] = useState<InviteAnswer | null>(null)
  const label = invite.method === 'REQUEST' ? 'Invitation' : invite.method === 'CANCEL' ? 'Cancelled' : invite.method === 'REPLY' ? 'Reply' : invite.method === 'COUNTER' ? 'New time proposed' : invite.method.toLowerCase()
  const answer = async (a: InviteAnswer) => {
    if (!handler) return
    setBusy(a)
    try {
      await handler.answer(invite, a, message)
      setDone(a)
    } catch (e) {
      notify({ title: 'Could not answer', body: (e as Error).message, transient: true })
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className={`ml-invite ${invite.method === 'CANCEL' ? 'is-cancelled' : ''}`}>
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
          invite.replies.map((r) => (
            <span key={r.email}>
              {r.name || r.email} {STATUS[r.status] ?? 'answered'} this.
            </span>
          ))}
        {invite.method === 'REQUEST' && (
          <div className="ml-invite-actions">
            {(['accepted', 'tentative', 'declined'] as InviteAnswer[]).map((a) => (
              <button key={a} className={`btn btn-small ${done === a ? 'btn-primary' : ''}`} disabled={!handler || !!busy} title={handler ? undefined : 'Coming soon'} onClick={() => void answer(a)}>
                {busy === a ? '…' : a === 'accepted' ? 'Accept' : a === 'tentative' ? 'Maybe' : 'Decline'}
              </button>
            ))}
            {!handler && <span className="ml-soon">Coming soon</span>}
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Recipient fields

const ADDRESS = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/

/** "Name <a@b.c>", "a@b.c" or several of them, as addresses (whatever is not one is left out). */
export function parseAddresses(text: string): Address[] {
  const out: Address[] = []
  for (const part of text.split(/[,;\n]+/)) {
    const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(part) ?? null
    const email = (m ? m[2] : part).trim()
    if (ADDRESS.test(email)) out.push({ name: m?.[1].trim() || null, email })
  }
  return out
}

/**
 * To, Cc and Bcc: addresses as chips, typed or picked from `suggest` (recent correspondents now;
 * Contacts' people once it plugs in through setSuggestProvider).
 */
export function RecipientField({ label, value, onChange, account, autoFocus, suggest = suggestPeople }: { label: string; value: Address[]; onChange: (v: Address[]) => void; account: number; autoFocus?: boolean; suggest?: (q: string, account: number | null) => Promise<Person[]> }) {
  const [text, setText] = useState('')
  const [options, setOptions] = useState<Person[]>([])
  const [active, setActive] = useState(0)
  const [focused, setFocused] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const q = text.trim()
    if (!focused || q.length < 1) return setOptions([])
    let live = true
    const t = setTimeout(() => {
      suggest(q, account)
        .then((list) => live && (setOptions(list.filter((p) => !value.some((v) => v.email.toLowerCase() === p.email.toLowerCase())).slice(0, 8)), setActive(0)))
        .catch(() => live && setOptions([]))
    }, 150)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [text, focused, account]) // eslint-disable-line react-hooks/exhaustive-deps
  const add = (list: Address[]) => {
    const fresh = list.filter((a) => !value.some((v) => v.email.toLowerCase() === a.email.toLowerCase()))
    if (fresh.length) onChange([...value, ...fresh])
    setText('')
    setOptions([])
  }
  const commit = () => {
    const parsed = parseAddresses(text)
    if (parsed.length) add(parsed)
    return parsed.length > 0
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' && options.length) return e.preventDefault(), setActive((a) => (a + 1) % options.length)
    if (e.key === 'ArrowUp' && options.length) return e.preventDefault(), setActive((a) => (a - 1 + options.length) % options.length)
    if ((e.key === 'Enter' || e.key === 'Tab') && options.length && text.trim()) {
      e.preventDefault()
      const p = options[active]
      return add([{ name: p.name ?? null, email: p.email }])
    }
    if (e.key === 'Enter' || e.key === ',' || e.key === ';') {
      if (text.trim()) {
        e.preventDefault()
        commit()
      }
      return
    }
    if (e.key === 'Escape' && options.length) return e.stopPropagation(), setOptions([])
    if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1))
  }
  return (
    <div className="ml-field ml-recipients" onClick={() => input.current?.focus()}>
      <span className="ml-field-label">{label}</span>
      <div className="ml-chips">
        {value.map((a) => (
          <span key={a.email} className={`ml-chip ${ADDRESS.test(a.email) ? '' : 'is-bad'}`} title={a.name ? `${a.name} <${a.email}>` : a.email}>
            {a.name || a.email}
            <button type="button" aria-label={`Remove ${a.email}`} onClick={(e) => (e.stopPropagation(), onChange(value.filter((v) => v !== a)))}>
              ×
            </button>
          </span>
        ))}
        <input
          ref={input}
          value={text}
          autoFocus={autoFocus}
          onChange={(e) => {
            const v = e.target.value
            // A pasted list: the complete addresses in it become chips at once.
            if (/[,;\n]/.test(v) && parseAddresses(v).length) {
              const rest = v.split(/[,;\n]/).pop() ?? ''
              add(parseAddresses(v.slice(0, v.length - rest.length)))
              setText(rest)
            } else setText(v)
          }}
          onKeyDown={onKey}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false)
            commit()
          }}
          aria-label={label}
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      {options.length > 0 && (
        <ul className="ml-suggest" role="listbox">
          {options.map((p, i) => (
            <li key={p.email} role="option" aria-selected={i === active} className={i === active ? 'is-on' : ''} onMouseDown={(e) => (e.preventDefault(), add([{ name: p.name ?? null, email: p.email }]))}>
              <strong>{p.name || p.email}</strong>
              {p.name && <span className="muted">{p.email}</span>}
            </li>
          ))}
        </ul>
      )}
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

/** A coloured circle with someone's initial. */
export function Avatar({ person, size = 32 }: { person: Address | undefined; size?: number }) {
  const key = (person?.email ?? '?').toLowerCase()
  let h = 0
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) % 360
  const letter = (person?.name || person?.email || '?').replace(/^["'\s]+/, '').charAt(0).toUpperCase()
  return (
    <span className="ml-avatar" style={{ width: size, height: size, background: `hsl(${h} 45% 45%)`, fontSize: size * 0.45 }} aria-hidden>
      {letter}
    </span>
  )
}
