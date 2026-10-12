import type { ReactNode } from 'react'
import { composeEvent } from '../../data/calendar'
import { openLink } from '../../data/links'
import { composeMail, useMailAccounts } from '../../data/mail'
import { datesIn, displayName, groupsOf, useContactSlot, type Address, type Book, type Contact, type ContactSlot } from '../../data/contacts'
import { hasCalendar, useAccount } from '../../os/account'
import { Avatar } from './people'

// One contact, to read: who they are, every way to reach them, their dates and groups, and the
// places other apps fill in (recent mail from Mail, upcoming events from Calendar). Email writes
// to them in Mail once a mail account is linked (the browser's mail program until then), and New
// event invites them in Calendar.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** "3 March 1980", or "3 March" without the year. */
export function formatDate(date: string): string {
  const m = /^(\d{4}|-)-(\d{2})-(\d{2})$/.exec(date)
  if (!m) return date
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? ''}${m[1] === '-' ? '' : ` ${m[1]}`}`
}

/** "in 12 days", "today", with the age they turn (or how many years it is). */
function nextTime(contact: Contact, kind: 'birthday' | 'anniversary', date: string): string | null {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const next = datesIn([{ ...contact, birthday: kind === 'birthday' ? date : '', anniversaries: kind === 'anniversary' ? [{ label: 'x', date }] : [] }], today, new Date(today.getTime() + 367 * 864e5))[0]
  if (!next) return null
  const days = Math.round((new Date(`${next.date}T00:00:00`).getTime() - today.getTime()) / 864e5)
  const when = days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`
  if (next.years === undefined) return when
  return kind === 'birthday' ? `turns ${next.years} ${when}` : `${next.years} years ${when}`
}

const addressLines = (a: Address) => [a.pobox && `PO Box ${a.pobox}`, a.ext, ...a.street.split('\n'), [a.postcode, a.locality].filter(Boolean).join(' '), a.region, a.country].filter(Boolean) as string[]

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="ct-row">
      <span className="ct-row-label">{label}</span>
      <span className="ct-row-value">{children}</span>
    </div>
  )
}

/** A slot another app fills: nothing at all until one registers (see registerContactSlot). */
function Slot({ slot, contact }: { slot: ContactSlot; contact: Contact }) {
  const render = useContactSlot(slot)
  const body = render?.(contact)
  if (!body) return null
  return (
    <section className="ct-section ct-slot" data-slot={slot}>
      {body}
    </section>
  )
}

export function ContactCard({ contact, book, onEdit, onMenu, onBack }: { contact: Contact; book: Book | undefined; onEdit: (() => void) | null; onMenu: (e: React.MouseEvent) => void; onBack?: () => void }) {
  const c = contact
  const name = displayName(c)
  const work = [c.title, c.department, c.org].filter(Boolean).join(' · ')
  const groups = groupsOf(c)
  const firstEmail = c.emails.find((e) => e.pref) ?? c.emails[0]
  const firstPhone = c.phones.find((p) => p.pref) ?? c.phones[0]
  const mail = !!useMailAccounts().accounts?.length
  const calendar = hasCalendar(useAccount())
  return (
    <article className="ct-card" onContextMenu={(e) => !(e.target as Element).closest('a, input, textarea') && onMenu(e)}>
      <header className="ct-card-head">
        {onBack && (
          <button className="ct-back" onClick={onBack} aria-label="Back to the list">
            ‹ Contacts
          </button>
        )}
        <Avatar contact={c} size={84} />
        <h2 className="ct-name">{name}</h2>
        {c.nickname && <p className="ct-sub">“{c.nickname}”</p>}
        {work && <p className="ct-sub">{work}</p>}
        <div className="ct-actions">
          {firstEmail &&
            (mail ? (
              <button className="btn btn-small" onClick={() => composeMail({ to: [{ name, email: firstEmail.value }] })} title={`Write to ${firstEmail.value} in Mail`}>
                Email
              </button>
            ) : (
              <a className="btn btn-small" href={`mailto:${encodeURIComponent(firstEmail.value).replace(/%40/g, '@')}`}>
                Email
              </a>
            ))}
          {firstEmail && calendar && (
            <button className="btn btn-small" onClick={() => composeEvent({ guests: [firstEmail.value.toLowerCase()] })} title={`A new event with ${name} as a guest`}>
              New event
            </button>
          )}
          {firstPhone && (
            <a className="btn btn-small" href={`tel:${firstPhone.value.replace(/[^\d+*#]/g, '')}`}>
              Call
            </a>
          )}
          {onEdit && (
            <button className="btn btn-small btn-primary" onClick={onEdit} title="Edit (E)">
              Edit
            </button>
          )}
          <button className="btn btn-small" onClick={(e) => onMenu(e)} aria-label="More" title="More">
            ⋯
          </button>
        </div>
      </header>

      <section className="ct-section">
        {c.emails.map((e, i) => (
          <Row key={`e${i}`} label={e.type ?? 'email'}>
            <a href={`mailto:${e.value}`}>{e.value}</a>
            {e.pref && c.emails.length > 1 && <span className="ct-pref">preferred</span>}
          </Row>
        ))}
        {c.phones.map((p, i) => (
          <Row key={`p${i}`} label={p.type ?? 'phone'}>
            <a href={`tel:${p.value.replace(/[^\d+*#]/g, '')}`}>{p.value}</a>
          </Row>
        ))}
        {c.urls.map((u, i) => (
          <Row key={`u${i}`} label={u.type ?? 'web'}>
            <button className="link-btn ct-link" onClick={() => openLink(/^[a-z][\w+.-]*:/i.test(u.value) ? u.value : `https://${u.value}`)}>
              {u.value.replace(/^https?:\/\//, '')}
            </button>
          </Row>
        ))}
        {c.addresses.map((a, i) => (
          <Row key={`a${i}`} label={a.type ?? 'address'}>
            <span className="ct-address">{addressLines(a).join('\n')}</span>
            <button className="link-btn ct-map" onClick={() => openLink(`https://www.openstreetmap.org/search?query=${encodeURIComponent(addressLines(a).join(', '))}`)}>
              Map
            </button>
          </Row>
        ))}
      </section>

      {(c.birthday || c.anniversaries.length > 0) && (
        <section className="ct-section">
          {c.birthday && (
            <Row label="birthday">
              {formatDate(c.birthday)}
              {nextTime(c, 'birthday', c.birthday) && <span className="ct-when"> · {nextTime(c, 'birthday', c.birthday)}</span>}
            </Row>
          )}
          {c.anniversaries.map((d, i) => (
            <Row key={i} label={d.label}>
              {formatDate(d.date)}
              {nextTime(c, 'anniversary', d.date) && <span className="ct-when"> · {nextTime(c, 'anniversary', d.date)}</span>}
            </Row>
          ))}
        </section>
      )}

      {groups.length > 0 && (
        <section className="ct-section">
          <Row label="groups">
            <span className="ct-tags">
              {groups.map((g) => (
                <span key={g} className="ct-tag">
                  {g}
                </span>
              ))}
            </span>
          </Row>
        </section>
      )}

      {c.note && (
        <section className="ct-section">
          <Row label="note">
            <span className="ct-note">{c.note}</span>
          </Row>
        </section>
      )}

      {/* Filled in by Mail and Calendar (registerContactSlot in src/data/contacts.ts); empty until then. */}
      <Slot slot="recent-mail" contact={c} />
      <Slot slot="upcoming-events" contact={c} />

      <p className="ct-book muted">
        {book ? (book.id === 'local' ? 'In the address book on this site' : `In ${book.name} · ${book.source}`) : ''}
        {book && !book.writable && ' · read-only'}
      </p>
    </article>
  )
}

/** Someone who is not in your contacts (opened from a mail's address): who, and Add to contacts. */
export function UnknownCard({ email, name, onAdd, onBack }: { email: string; name?: string; onAdd: () => void; onBack?: () => void }) {
  const calendar = hasCalendar(useAccount())
  return (
    <article className="ct-card">
      <header className="ct-card-head">
        {onBack && (
          <button className="ct-back" onClick={onBack} aria-label="Back to the list">
            ‹ Contacts
          </button>
        )}
        <Avatar email={email} name={name} size={84} />
        <h2 className="ct-name">{name || email}</h2>
        <p className="ct-sub">Not in your contacts</p>
        <div className="ct-actions">
          <button className="btn btn-small btn-primary" onClick={onAdd}>
            Add to contacts
          </button>
          <a className="btn btn-small" href={`mailto:${email}`}>
            Email
          </a>
          {calendar && (
            <button className="btn btn-small" onClick={() => composeEvent({ guests: [email.toLowerCase()] })}>
              New event
            </button>
          )}
        </div>
      </header>
      <section className="ct-section">
        <Row label="email">
          <a href={`mailto:${email}`}>{email}</a>
        </Row>
      </section>
    </article>
  )
}
