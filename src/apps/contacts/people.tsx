import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { addContact, displayName, initials, openContact, searchLoaded, useContactByEmail, useContacts, type Contact } from '../../data/contacts'
import './contacts.css'

// People, for any app: an avatar (the contact's photo, or initials), a chip with a person's name
// that opens their card, and a field to pick people with (Mail's To/Cc/Bcc, Calendar's guests).
//
//   <Avatar email="ann@example.com" name="Ann" size={28} />
//   <PersonChip email="ann@example.com" name="Ann (from the mail header)" />
//   <PeoplePicker value={people} onChange={setPeople} placeholder="Add guests" />
//
// A person is { email, name? }: a contact's name wins over the one given.

export type Person = { email: string; name?: string }

const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:".]{2,}$/
export const isEmail = (s: string) => EMAIL.test(s.trim())

/**
 * Addresses in pasted or typed text: "Ann <ann@example.com>", "\"Doe, Ann\" <ann@…>" and bare
 * addresses, separated by commas, semicolons or new lines.
 */
export function parseAddresses(text: string): Person[] {
  const out: Person[] = []
  const re = /(?:"([^"]*)"|([^,;<>\n"]*?))\s*<([^<>\s]+@[^<>\s]+)>|([^\s,;<>"]+@[^\s,;<>"]+)/g
  for (let m; (m = re.exec(text)); ) {
    const email = (m[3] ?? m[4]).replace(/^mailto:/i, '').trim()
    if (!isEmail(email)) continue
    const name = (m[1] ?? m[2] ?? '').trim()
    if (!out.some((p) => p.email.toLowerCase() === email.toLowerCase())) out.push(name ? { email, name } : { email })
  }
  return out
}

/** A steady colour per person, for initials. */
function hue(key: string): number {
  let h = 0
  for (const ch of key.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) % 360
  return h
}

/**
 * Logos that loaded (with how they fit) or failed this session: a row scrolled back into view
 * shows its logo at once, and a missing one is not asked for again.
 */
const logoLoaded = new Map<string, 'cover' | 'contain'>()
const logoFailed = new Set<string>()

/**
 * How a logo fills the circle: edge to edge (cover) when it is square and opaque at its corners,
 * like an app icon; otherwise whole, a little inset, on the theme's backing (a transparent or
 * wide one). Read from four corner pixels (the logo comes from this site, so the canvas may).
 */
function logoFit(img: HTMLImageElement): 'cover' | 'contain' {
  const w = img.naturalWidth
  const h = img.naturalHeight
  if (!w || !h || Math.max(w, h) > Math.min(w, h) * 1.1) return 'contain'
  try {
    const c = document.createElement('canvas')
    c.width = c.height = 16
    const g = c.getContext('2d', { willReadFrequently: true })
    if (!g) return 'contain'
    g.drawImage(img, 0, 0, 16, 16)
    const alpha = [g.getImageData(1, 1, 1, 1), g.getImageData(14, 1, 1, 1), g.getImageData(1, 14, 1, 1), g.getImageData(14, 14, 1, 1)].map((d) => d.data[3])
    return alpha.every((a) => a > 250) ? 'cover' : 'contain'
  } catch {
    return 'contain'
  }
}

/**
 * A round picture of a person: the contact's photo, else `logo` (a sender's brand icon, Mail's),
 * else their initials on a colour of their own. The initials stay underneath until the logo has
 * loaded, so nothing shifts, and stay for good when it fails.
 */
export function Avatar({ contact, email, name, size = 32, logo }: { contact?: Contact | null; email?: string; name?: string; size?: number; logo?: string | null }) {
  const found = useContactByEmail(contact ? null : email)
  const c = contact ?? found
  const label = c ? displayName(c) : name || email || '?'
  const [broken, setBroken] = useState(false)
  const [, setLogoState] = useState(0)
  useEffect(() => {
    setBroken(false)
  }, [c?.photo])
  const style = { width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.4)) }
  if (c?.photo && !broken) return <img className="pp-avatar" src={c.photo} alt="" style={style} onError={() => setBroken(true)} draggable={false} />
  const showLogo = !!logo && !logoFailed.has(logo)
  return (
    <span className={`pp-avatar is-initials ${showLogo ? 'has-logo' : ''}`} style={{ ...style, ['--pp-hue' as string]: hue(c?.uid ?? email ?? label) }} aria-hidden>
      {initials(label)}
      {showLogo && (
        <img
          className={`pp-avatar-logo ${logoLoaded.has(logo) ? `is-loaded is-${logoLoaded.get(logo)}` : ''}`}
          src={logo}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onLoad={(e) => {
            const fit = logoLoaded.get(logo) ?? logoFit(e.currentTarget)
            logoLoaded.set(logo, fit)
            e.currentTarget.classList.add('is-loaded', `is-${fit}`)
          }}
          onError={() => {
            logoFailed.add(logo)
            setLogoState((n) => n + 1)
          }}
        />
      )}
    </span>
  )
}

/**
 * A person as a small chip: their avatar and name (the contact's, else the name given, else the
 * address). Hovering shows who it is; clicking opens their card in Contacts (or offers to add
 * them). `onRemove` adds a × (a picked recipient), `badge` goes before the name (a guest's
 * answer), `onMenu` takes the right-click.
 */
export function PersonChip({ email, name, onRemove, invalid, compact, badge, title, onMenu }: { email: string; name?: string; onRemove?: () => void; invalid?: boolean; compact?: boolean; badge?: ReactNode; title?: string; onMenu?: (e: React.MouseEvent) => void }) {
  const c = useContactByEmail(email)
  const label = c ? displayName(c) : name || email
  const ref = useRef<HTMLSpanElement>(null)
  const [hover, setHover] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  return (
    <span
      ref={ref}
      className={`pp-chip ${invalid ? 'is-invalid' : ''} ${c ? 'is-known' : ''} ${compact ? 'is-compact' : ''}`}
      title={invalid ? `${email} is not an email address` : title}
      onContextMenu={onMenu}
      onMouseEnter={() => (clearTimeout(timer.current), (timer.current = setTimeout(() => setHover(true), 450)))}
      onMouseLeave={() => (clearTimeout(timer.current), (timer.current = setTimeout(() => setHover(false), 150)))}
    >
      <button type="button" className="pp-chip-main" onClick={() => openContact(c?.id ?? email, name)} aria-label={`${label} <${email}>: open in Contacts`}>
        <Avatar contact={c} email={email} name={name} size={compact ? 16 : 18} />
        {badge}
        <span className="pp-chip-name">{label}</span>
      </button>
      {onRemove && (
        <button type="button" className="pp-chip-x" onClick={onRemove} aria-label={`Remove ${label}`} tabIndex={-1}>
          ×
        </button>
      )}
      {hover && ref.current && <HoverCard anchor={ref.current} email={email} name={name} contact={c} onEnter={() => clearTimeout(timer.current)} onLeave={() => setHover(false)} />}
    </span>
  )
}

/** Who a chip is: photo, name, organisation and address, with Open or Add to contacts. */
function HoverCard({ anchor, email, name, contact, onEnter, onLeave }: { anchor: HTMLElement; email: string; name?: string; contact: Contact | null; onEnter: () => void; onLeave: () => void }) {
  const r = anchor.getBoundingClientRect()
  const below = r.bottom + 160 < window.innerHeight
  const [busy, setBusy] = useState(false)
  return createPortal(
    <div className="pp-hover" style={{ left: Math.max(8, Math.min(r.left, window.innerWidth - 268)), ...(below ? { top: r.bottom + 6 } : { bottom: window.innerHeight - r.top + 6 }) }} onMouseEnter={onEnter} onMouseLeave={onLeave}>
      <Avatar contact={contact} email={email} name={name} size={44} />
      <div className="pp-hover-text">
        <strong>{contact ? displayName(contact) : name || email}</strong>
        {contact && (contact.title || contact.org) && <span className="muted">{[contact.title, contact.org].filter(Boolean).join(' · ')}</span>}
        <span className="muted">{email}</span>
        <span className="pp-hover-actions">
          {contact ? (
            <button type="button" className="link-btn" onClick={() => openContact(contact.id)}>
              Open contact
            </button>
          ) : (
            <button
              type="button"
              className="link-btn"
              disabled={busy}
              onClick={() => {
                setBusy(true)
                addContact({ email, name }).then((c) => openContact(c.id), () => openContact(email, name))
              }}
            >
              {busy ? 'Adding…' : 'Add to contacts'}
            </button>
          )}
        </span>
      </div>
    </div>,
    document.body,
  )
}

type Suggestion =
  | { kind: 'email'; contact: Contact; email: string; type?: string }
  | { kind: 'contact'; contact: Contact }
  | { kind: 'group'; name: string; people: Person[] }
  | { kind: 'typed'; email: string }
  | { kind: 'more'; email: string; name?: string }

/**
 * A field to pick people: chips for those picked, suggestions from your contacts while typing
 * (arrow keys and Enter or Tab; a contact with several addresses opens them to choose from, a
 * group adds everyone in it), any valid address as it is (Enter, comma or leaving the field), and
 * several at once by pasting. Backspace in the empty field takes the last one off. `more` adds
 * suggestions after your contacts' (Mail's recent correspondents), `badge` marks a chip.
 */
export function PeoplePicker({
  value,
  onChange,
  placeholder,
  autoFocus,
  disabled,
  label,
  exclude = [],
  more,
  moreLabel = 'Recent',
  badge,
}: {
  value: Person[]
  onChange: (next: Person[]) => void
  placeholder?: string
  autoFocus?: boolean
  disabled?: boolean
  label?: string
  exclude?: string[]
  more?: (q: string) => Promise<Person[]>
  moreLabel?: string
  badge?: (p: Person) => ReactNode
}) {
  const { contacts, groups } = useContacts()
  const [text, setText] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [expanded, setExpanded] = useState<Contact | null>(null)
  const [invalid, setInvalid] = useState(false)
  const field = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const listId = useMemo(() => `pp-list-${Math.random().toString(36).slice(2)}`, [])
  const taken = new Set([...value.map((p) => p.email.toLowerCase()), ...exclude.map((e) => e.toLowerCase())])

  const add = (people: Person[]) => {
    const fresh = people.filter((p, i) => !taken.has(p.email.toLowerCase()) && people.findIndex((q) => q.email.toLowerCase() === p.email.toLowerCase()) === i)
    if (fresh.length) onChange([...value, ...fresh])
    setText('')
    setExpanded(null)
    setActive(0)
    setInvalid(false)
  }

  const q = text.trim()
  // The other suggestions (`more`), asked for a moment after typing stops.
  const [extra, setExtra] = useState<Person[]>([])
  useEffect(() => {
    if (!more || !q || !open) return setExtra([])
    let live = true
    const t = setTimeout(() => void more(q).then((l) => live && setExtra(l), () => live && setExtra([])), 150)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [q, open]) // eslint-disable-line react-hooks/exhaustive-deps
  const suggestions: Suggestion[] = useMemo(() => {
    if (expanded) return expanded.emails.filter((e) => !taken.has(e.value.toLowerCase())).map((e) => ({ kind: 'email' as const, contact: expanded, email: e.value, type: e.type }))
    if (!q) return []
    const out: Suggestion[] = []
    const fold = q.toLowerCase()
    // Groups: by name, with everyone in them who has an address.
    const names = new Set([...groups.map((g) => g.name), ...contacts.flatMap((c) => c.categories)])
    for (const name of names) {
      if (!name.toLowerCase().startsWith(fold)) continue
      const people = contacts.filter((c) => (c.groups.includes(name) || c.categories.includes(name)) && c.emails.length).map((c) => ({ email: (c.emails.find((e) => e.pref) ?? c.emails[0]).value, name: displayName(c) }))
      if (people.length) out.push({ kind: 'group', name, people })
    }
    for (const c of searchLoaded(q, 8)) {
      const free = c.emails.filter((e) => !taken.has(e.value.toLowerCase()))
      if (!free.length) continue
      // A contact whose address matched what was typed goes straight to that address.
      const typedAddress = free.find((e) => e.value.toLowerCase().startsWith(fold))
      if (free.length === 1 || typedAddress) out.push({ kind: 'email', contact: c, email: (typedAddress ?? free[0]).value, type: (typedAddress ?? free[0]).type })
      else out.push({ kind: 'contact', contact: c })
    }
    // Then the others (recent correspondents), leaving out whoever is already there.
    const shown = (e: string) => out.some((s) => (s.kind === 'email' || s.kind === 'more' || s.kind === 'typed' ? s.email.toLowerCase() === e : s.kind === 'contact' && s.contact.emails.some((x) => x.value.toLowerCase() === e)))
    for (const p of extra) if (!taken.has(p.email.toLowerCase()) && !shown(p.email.toLowerCase()) && out.length < 10) out.push({ kind: 'more', email: p.email, name: p.name || undefined })
    if (isEmail(q) && !out.some((s) => (s.kind === 'email' || s.kind === 'more') && s.email.toLowerCase() === fold)) out.push({ kind: 'typed', email: q })
    return out.slice(0, 11)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, expanded, contacts, groups, value, extra])

  useEffect(() => {
    setActive(0)
  }, [q, expanded])

  const pick = (s: Suggestion) => {
    if (s.kind === 'contact') {
      setExpanded(s.contact)
      input.current?.focus()
      return
    }
    if (s.kind === 'group') return add(s.people)
    if (s.kind === 'typed') return add(parseAddresses(s.email))
    if (s.kind === 'more') return add([s.name ? { email: s.email, name: s.name } : { email: s.email }])
    add([{ email: s.email, name: displayName(s.contact) }])
  }

  /** What is typed, as people (one address, or "Name <address>"); false when it is not one. */
  const commitTyped = () => {
    if (!q) return true
    const people = parseAddresses(q)
    if (!people.length) {
      setInvalid(true)
      return false
    }
    add(people)
    return true
  }

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    const shown = open && suggestions.length > 0
    if (e.key === 'ArrowDown' && shown) {
      e.preventDefault()
      setActive((a) => (a + 1) % suggestions.length)
    } else if (e.key === 'ArrowUp' && shown) {
      e.preventDefault()
      setActive((a) => (a - 1 + suggestions.length) % suggestions.length)
    } else if ((e.key === 'Enter' || (e.key === 'Tab' && !e.shiftKey && q)) && shown) {
      e.preventDefault()
      pick(suggestions[Math.min(active, suggestions.length - 1)])
    } else if (e.key === 'Enter' || e.key === ',' || e.key === ';') {
      if (q || e.key !== 'Enter') e.preventDefault()
      commitTyped()
    } else if (e.key === 'Escape' && (expanded || shown)) {
      e.preventDefault()
      e.stopPropagation()
      if (expanded) setExpanded(null)
      else setOpen(false)
    } else if (e.key === 'ArrowLeft' && expanded && !q) {
      e.preventDefault()
      setExpanded(null)
    } else if (e.key === 'Backspace' && !text && value.length) {
      e.preventDefault()
      onChange(value.slice(0, -1))
    }
  }

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData('text')
    const people = parseAddresses(pasted)
    // Several addresses, or one with a name: chips straight away. A plain word pastes as text.
    if (people.length > 1 || (people.length === 1 && /[<,;\n]/.test(pasted))) {
      e.preventDefault()
      add(people)
    }
  }

  return (
    <div
      ref={field}
      className={`pp-field ${invalid ? 'is-invalid' : ''} ${disabled ? 'is-disabled' : ''}`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          e.preventDefault()
          input.current?.focus()
        }
      }}
    >
      {value.map((p, i) => (
        <PersonChip key={p.email} email={p.email} name={p.name} invalid={!isEmail(p.email)} badge={badge?.(p)} onRemove={disabled ? undefined : () => onChange(value.filter((_, j) => j !== i))} />
      ))}
      <input
        ref={input}
        className="pp-input"
        value={text}
        disabled={disabled}
        autoFocus={autoFocus}
        placeholder={value.length ? '' : placeholder}
        aria-label={label ?? placeholder ?? 'People'}
        role="combobox"
        aria-expanded={open && suggestions.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => {
          // A comma or semicolon after an address makes it a chip (phone keyboards send no key for it).
          const typed = e.target.value
          if (/[,;]\s*$/.test(typed) && parseAddresses(typed).length && !typed.slice(0, -1).includes('"')) return add(parseAddresses(typed))
          setText(typed)
          setInvalid(false)
          setOpen(true)
          if (expanded) setExpanded(null)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          // A click on a suggestion keeps the focus (mousedown is prevented there).
          setOpen(false)
          setExpanded(null)
          if (q && isEmail(q)) commitTyped()
        }}
        onKeyDown={onKey}
        onPaste={onPaste}
      />
      {open && suggestions.length > 0 && field.current && (
        <Suggestions anchor={field.current} id={listId} items={suggestions} active={active} expanded={expanded} moreLabel={moreLabel} onHover={setActive} onPick={pick} onBack={() => setExpanded(null)} />
      )}
    </div>
  )
}

function Suggestions({ anchor, id, items, active, expanded, moreLabel, onHover, onPick, onBack }: { anchor: HTMLElement; id: string; items: Suggestion[]; active: number; expanded: Contact | null; moreLabel: string; onHover: (i: number) => void; onPick: (s: Suggestion) => void; onBack: () => void }) {
  const [rect, setRect] = useState(() => anchor.getBoundingClientRect())
  useLayoutEffect(() => {
    const update = () => setRect(anchor.getBoundingClientRect())
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    const ro = new ResizeObserver(update)
    ro.observe(anchor)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
      ro.disconnect()
    }
  }, [anchor])
  const list = useRef<HTMLUListElement>(null)
  useEffect(() => {
    list.current?.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' })
  }, [active])
  // Below the field, or above it when there is no room.
  const room = window.innerHeight - rect.bottom
  const up = room < 220 && rect.top > room
  const row = (s: Suggestion): ReactNode => {
    if (s.kind === 'group')
      return (
        <>
          <span className="pp-avatar is-initials is-group" aria-hidden>
            {s.people.length}
          </span>
          <span className="pp-sug-text">
            <strong>{s.name}</strong>
            <span className="muted">Group · {s.people.length === 1 ? '1 person' : `${s.people.length} people`}</span>
          </span>
        </>
      )
    if (s.kind === 'more')
      return (
        <>
          <Avatar email={s.email} name={s.name} size={26} />
          <span className="pp-sug-text">
            <strong>{s.name || s.email}</strong>
            <span className="muted">{s.name ? `${s.email} · ${moreLabel}` : moreLabel}</span>
          </span>
        </>
      )
    if (s.kind === 'typed')
      return (
        <>
          <Avatar email={s.email} size={26} />
          <span className="pp-sug-text">
            <strong>{s.email}</strong>
            <span className="muted">Not in your contacts</span>
          </span>
        </>
      )
    return (
      <>
        <Avatar contact={s.contact} size={26} />
        <span className="pp-sug-text">
          <strong>{displayName(s.contact)}</strong>
          <span className="muted">{s.kind === 'email' ? `${s.email}${s.type ? ` · ${s.type}` : ''}` : `${s.contact.emails.length} addresses`}</span>
        </span>
        {s.kind === 'contact' && (
          <span className="pp-sug-more" aria-hidden>
            ›
          </span>
        )}
      </>
    )
  }
  return createPortal(
    <ul
      ref={list}
      id={id}
      role="listbox"
      className="pp-suggestions"
      style={{ left: rect.left, width: Math.max(rect.width, 260), ...(up ? { bottom: window.innerHeight - rect.top + 2 } : { top: rect.bottom + 2 }) }}
      onMouseDown={(e) => e.preventDefault()}
    >
      {expanded && (
        <li className="pp-sug-head">
          <button type="button" className="link-btn" onClick={onBack}>
            ‹ {displayName(expanded)}
          </button>
        </li>
      )}
      {items.map((s, i) => (
        <li key={i} role="option" aria-selected={i === active} className={`pp-sug ${i === active ? 'is-active' : ''}`} onMouseMove={() => onHover(i)} onClick={() => onPick(s)}>
          {row(s)}
        </li>
      ))}
    </ul>,
    document.body,
  )
}
