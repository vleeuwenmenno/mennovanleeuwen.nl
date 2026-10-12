import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent } from 'react'
import {
  contactById,
  datesIn,
  deleteContact,
  displayName,
  exportVcf,
  fieldsOf,
  groupsOf,
  importVcf,
  loadContacts,
  moveContact,
  peekContactByEmail,
  bookForNew,
  updateContact,
  shrinkPhoto,
  matchScore,
  useContacts,
  type Book,
  type Contact,
  type ContactFields,
} from '../../data/contacts'
import { openMailto } from '../../data/links'
import { readBlob, uploadBlob } from '../../data/seafile'
import { signIn, useAccount } from '../../os/account'
import { openContextMenu, openMenuAt, type MenuItem } from '../../os/ContextMenu'
import { ask, choose, tell } from '../../os/Dialogs'
import { pickFiles, pickFolder } from '../../os/FolderPicker'
import { useWM, type WinState } from '../../os/wm'
import { ContactCard, UnknownCard, formatDate } from './ContactCard'
import { ContactEditor, type EditorTarget } from './ContactEditor'
import { Avatar } from './people'
import './contacts.css'

// The Contacts app: everyone in the address book on this site and the CardDAV ones (Fastmail,
// iCloud, Nextcloud...) in one list, with search, an A–Z strip, address books and groups in the
// sidebar, and a card to read and edit. Imports and exports .vcf files from the computer or Files,
// and finds people who are in it twice. Narrow windows (phones) show the list or the card.
//
// props.contact (an id) opens on that contact; props.email (and props.name) on whoever has that
// address, or a card to add them (src/data/contacts.ts: openContact).

type Filter = { kind: 'all' } | { kind: 'book'; id: string } | { kind: 'group'; name: string } | { kind: 'duplicates' }
type View = { kind: 'none' } | { kind: 'contact'; id: string } | { kind: 'unknown'; email: string; name?: string } | { kind: 'edit'; target: EditorTarget }

const LETTERS = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '#']
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '')
const letterOf = (c: Contact) => {
  const ch = fold(displayName(c)).charAt(0).toUpperCase()
  return ch >= 'A' && ch <= 'Z' ? ch : '#'
}
const byName = (a: Contact, b: Contact) => {
  const la = letterOf(a)
  const lb = letterOf(b)
  if (la !== lb) return la === '#' ? 1 : lb === '#' ? -1 : la.localeCompare(lb)
  return displayName(a).localeCompare(displayName(b), undefined, { sensitivity: 'base' })
}

/** Sets of contacts that look like the same person: the same email address, or the same name. */
function duplicates(contacts: Contact[]): Contact[][] {
  const parent = new Map<string, string>()
  const find = (x: string): string => (parent.get(x) === x ? x : find(parent.get(x)!))
  const join = (a: string, b: string) => parent.set(find(a), find(b))
  for (const c of contacts) parent.set(c.id, c.id)
  const seen = new Map<string, string>()
  for (const c of contacts) {
    const keys = [...c.emails.map((e) => `e:${e.value.trim().toLowerCase()}`), ...(displayName(c).includes(' ') ? [`n:${fold(displayName(c)).toLowerCase().replace(/\s+/g, ' ').trim()}`] : [])]
    for (const k of keys) {
      const other = seen.get(k)
      if (other) join(c.id, other)
      else seen.set(k, c.id)
    }
  }
  const sets = new Map<string, Contact[]>()
  for (const c of contacts) sets.set(find(c.id), [...(sets.get(find(c.id)) ?? []), c])
  return [...sets.values()].filter((s) => s.length > 1)
}

/** One contact out of several: the first one's fields, filled in and added to from the others. */
function merged(keep: Contact, others: Contact[]): ContactFields {
  const f = structuredClone(fieldsOf(keep))
  const union = <T,>(list: T[], more: T[], key: (x: T) => string) => [...list, ...more.filter((x) => !list.some((y) => key(y) === key(x)))]
  for (const o of others) {
    for (const k of ['fn', 'nickname', 'org', 'department', 'title', 'birthday'] as const) if (!f[k]) f[k] = o[k]
    for (const k of ['given', 'family', 'middle', 'prefix', 'suffix'] as const) if (!f.n[k]) f.n[k] = o.n[k]
    f.emails = union(f.emails, o.emails, (e) => e.value.trim().toLowerCase())
    f.phones = union(f.phones, o.phones, (p) => p.value.replace(/[^\d+]/g, ''))
    f.urls = union(f.urls, o.urls, (u) => u.value.trim())
    f.addresses = union(f.addresses, o.addresses, (a) => `${a.street}|${a.postcode}|${a.locality}`.toLowerCase())
    f.anniversaries = union(f.anniversaries, o.anniversaries, (d) => `${d.label}|${d.date}`)
    if (o.note && !f.note.includes(o.note)) f.note = f.note ? `${f.note}\n\n${o.note}` : o.note
  }
  return f
}

const download = (text: string, name: string) => {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/vcard' }))
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
}

const fileName = (name: string) => `${name.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'contacts'}.vcf`

export function ContactsApp({ win }: { win: WinState }) {
  const account = useAccount()
  const wm = useWM()
  const { status, books, contacts, groups, errors } = useContacts()
  const [filter, setFilter] = useState<Filter>({ kind: 'all' })
  const [query, setQuery] = useState('')
  const [view, setView] = useState<View>({ kind: 'none' })
  const [narrow, setNarrow] = useState(false)
  const [sidebar, setSidebar] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const pcFile = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const el = root.current
    if (!el) return
    const ro = new ResizeObserver(() => setNarrow(el.clientWidth < 640))
    ro.observe(el)
    return () => ro.disconnect()
  }, [account.status])

  // Opened on someone (from Mail, a chip, Spotlight): show them.
  useEffect(() => {
    const p = win.props
    if (p.contact) setView({ kind: 'contact', id: p.contact })
    else if (p.email) {
      const c = peekContactByEmail(p.email)
      setView(c ? { kind: 'contact', id: c.id } : { kind: 'unknown', email: p.email, name: p.name })
    } else return
    setQuery('')
    setFilter({ kind: 'all' })
  }, [win.props.t]) // eslint-disable-line react-hooks/exhaustive-deps
  // Someone shown as unknown turns out to be a contact once the contacts are in.
  useEffect(() => {
    if (view.kind !== 'unknown') return
    const c = peekContactByEmail(view.email)
    if (c) setView({ kind: 'contact', id: c.id })
  }, [contacts, view])

  const bookById = useMemo(() => new Map(books.map((b) => [b.id, b])), [books])
  const allGroups = useMemo(() => [...new Set([...groups.map((g) => g.name), ...contacts.flatMap((c) => c.categories)])].sort((a, b) => a.localeCompare(b)), [groups, contacts])
  const dupSets = useMemo(() => (filter.kind === 'duplicates' ? duplicates(contacts) : []), [filter.kind, contacts])

  const shown = useMemo(() => {
    let list = contacts
    if (filter.kind === 'book') list = list.filter((c) => c.book === filter.id)
    else if (filter.kind === 'group') list = list.filter((c) => groupsOf(c).includes(filter.name))
    else if (filter.kind === 'duplicates') list = dupSets.flat()
    if (query.trim()) return list.map((c) => ({ c, s: matchScore(c, query) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s || byName(a.c, b.c)).map((x) => x.c)
    return filter.kind === 'duplicates' ? list : [...list].sort(byName)
  }, [contacts, filter, query, dupSets])

  const selected = view.kind === 'contact' ? (contactById(view.id) ?? null) : null
  const upcoming = useMemo(() => {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    return datesIn(contacts, today, new Date(today.getTime() + 30 * 864e5)).slice(0, 5)
  }, [contacts])

  const select = (c: Contact) => setView({ kind: 'contact', id: c.id })
  const newContact = (prefill: Partial<ContactFields> = {}) => setView({ kind: 'edit', target: { new: prefill, book: filter.kind === 'book' && bookById.get(filter.id)?.writable ? filter.id : bookForNew() } })
  const edit = (c: Contact) => bookById.get(c.book)?.writable !== false && setView({ kind: 'edit', target: { contact: c } })

  const run = async (what: () => Promise<unknown>) => {
    setError(null)
    try {
      await what()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const remove = async (c: Contact) => {
    const book = bookById.get(c.book)
    const ok = await ask({ title: `Delete ${displayName(c)}?`, body: book?.id === 'local' ? 'The contact is deleted from the address book on this site.' : `The contact is deleted from ${book?.name ?? 'the address book'} on ${book?.source ?? 'the server'}, and so from your other devices.`, confirm: 'Delete', danger: true })
    if (!ok) return
    const at = shown.indexOf(c)
    await run(async () => {
      await deleteContact(c)
      const next = shown[at + 1] ?? shown[at - 1]
      setView(next && next.id !== c.id && !narrow ? { kind: 'contact', id: next.id } : { kind: 'none' })
    })
  }

  /** Asks which writable address book, when there is more than one. */
  const pickBook = async (title: string): Promise<string | null> => {
    const writable = books.filter((b) => b.writable)
    if (writable.length <= 1) return writable[0]?.id ?? 'local'
    const preferred = filter.kind === 'book' && writable.some((b) => b.id === filter.id) ? filter.id : bookForNew()
    return choose({ title, buttons: [{ id: 'cancel', label: 'Cancel' }, ...writable.map((b) => ({ id: b.id, label: b.id === 'local' ? b.name : `${b.name} (${b.source})`, primary: b.id === preferred }))] }).then((id) => (id && id !== 'cancel' ? id : null))
  }

  const importText = async (text: string) => {
    const book = await pickBook('Import into which address book?')
    if (!book) return
    await run(async () => {
      const r = await importVcf(book, text)
      await tell({
        title: r.added + r.updated ? `Imported ${r.added + r.updated} contact${r.added + r.updated === 1 ? '' : 's'}` : 'Nothing imported',
        body: (
          <>
            {r.added} added, {r.updated} updated (the same contact was there already).
            {r.failed.length > 0 && <span className="ct-failed">{r.failed.slice(0, 5).join('\n')}{r.failed.length > 5 ? `\n…and ${r.failed.length - 5} more` : ''}</span>}
          </>
        ),
      })
    })
  }

  /** What an export takes: the address book or group in view, or everything. */
  const exportScope = (): { which: { book?: string; ids?: string[] }; name: string } => {
    if (filter.kind === 'book') return { which: { book: filter.id }, name: bookById.get(filter.id)?.name ?? 'contacts' }
    if (filter.kind === 'group') return { which: { ids: shown.map((c) => c.id) }, name: filter.name }
    return { which: {}, name: 'contacts' }
  }
  const exportTo = async (where: 'pc' | 'seafile', which = exportScope()) => {
    if (where === 'seafile') {
      const folder = await pickFolder({ title: `Save ${fileName(which.name)} in` })
      if (!folder) return
      await run(async () => {
        await uploadBlob(folder, fileName(which.name), new Blob([await exportVcf(which.which)], { type: 'text/vcard' }))
        await tell({ title: 'Exported', body: `${fileName(which.name)} is in Files.` })
      })
    } else await run(async () => download(await exportVcf(which.which), fileName(which.name)))
  }

  const mergeSet = async (set: Contact[]) => {
    const keep = [...set].sort((a, b) => Number(bookById.get(b.book)?.writable) - Number(bookById.get(a.book)?.writable) || JSON.stringify(b).length - JSON.stringify(a).length)[0]
    const others = set.filter((c) => c !== keep)
    const stuck = others.filter((c) => !bookById.get(c.book)?.writable)
    const ok = await ask({
      title: `Merge ${set.length} contacts into one?`,
      body: `Everything goes into ${displayName(keep)} (${bookById.get(keep.book)?.name}); ${stuck.length ? `the read-only ${stuck.length === 1 ? 'copy stays' : 'copies stay'}, the others are deleted.` : 'the others are deleted.'}`,
      confirm: 'Merge',
    })
    if (!ok) return
    await run(async () => {
      let photo: string | undefined
      const withPhoto = others.find((c) => c.photo)
      if (!keep.photo && withPhoto) photo = await fetch(withPhoto.photo!).then((r) => r.blob()).then(shrinkPhoto).catch(() => undefined)
      const groupsWanted = [...new Set(set.flatMap(groupsOf))]
      const saved = await updateContact(keep, merged(keep, others), { groups: groupsWanted, photo })
      for (const c of others) if (!stuck.includes(c)) await deleteContact(c)
      setView({ kind: 'contact', id: saved.id })
    })
  }

  const contactMenu = (c: Contact): MenuItem[] => {
    const book = bookById.get(c.book)
    const targets = books.filter((b) => b.writable && b.id !== c.book)
    return [
      { label: 'Open', onSelect: () => select(c) },
      ...(book?.writable ? [{ label: 'Edit', shortcut: 'E', onSelect: () => edit(c) }] : []),
      ...(c.emails[0] ? [{ label: `Email ${c.emails[0].value}`, onSelect: () => openMailto(`mailto:${c.emails[0].value}`) }] : []),
      ...(c.emails[0] ? [{ label: 'Copy email address', onSelect: () => void navigator.clipboard?.writeText(c.emails[0].value) }] : []),
      { separator: true },
      ...(targets.length && book?.writable ? [{ label: 'Move to', submenu: targets.map((b) => ({ label: b.id === 'local' ? b.name : `${b.name} · ${b.source}`, onSelect: () => void run(() => moveContact(c, b.id).then((m) => setView({ kind: 'contact', id: m.id }))) })) }] : []),
      { label: 'Export vCard', onSelect: () => void exportTo('pc', { which: { ids: [c.id] }, name: displayName(c) }) },
      { label: 'Export vCard to Files…', disabled: !account.seafile, onSelect: () => void exportTo('seafile', { which: { ids: [c.id] }, name: displayName(c) }) },
      ...(book?.writable ? [{ separator: true as const }, { label: 'Delete…', danger: true, shortcut: 'Del', onSelect: () => void remove(c) }] : []),
    ]
  }

  const appMenu = (anchor: Element) =>
    openMenuAt(anchor, [
      { label: 'New contact', shortcut: 'N', onSelect: () => newContact() },
      { separator: true },
      { label: 'Import from this computer…', onSelect: () => pcFile.current?.click() },
      {
        label: 'Import from Files…',
        disabled: !account.seafile,
        onSelect: () =>
          void pickFiles({ title: 'Import contacts (.vcf)' }).then((paths) => {
            if (paths?.length) void run(async () => importText((await Promise.all(paths.map((p) => readBlob(p).then((b) => b.text())))).join('\r\n')))
          }),
      },
      { label: `Export ${filter.kind === 'book' ? 'this address book' : filter.kind === 'group' ? 'this group' : 'everyone'}`, onSelect: () => void exportTo('pc') },
      { label: 'Export to Files…', disabled: !account.seafile, onSelect: () => void exportTo('seafile') },
      { separator: true },
      { label: 'Find duplicates', onSelect: () => setFilter({ kind: 'duplicates' }) },
      { label: 'Refresh', shortcut: 'R', onSelect: () => void refresh() },
      { label: 'Contacts settings…', onSelect: () => wm.open('settings', { section: 'contacts', t: String(Date.now()) }) },
    ])

  const refresh = async () => {
    setRefreshing(true)
    await loadContacts(true)
    setRefreshing(false)
  }

  const onKey = (e: KeyboardEvent) => {
    if (view.kind === 'edit' || e.metaKey || e.ctrlKey || e.altKey) return
    const typing = (e.target as HTMLElement).closest('input, textarea, select')
    if (typing && !(e.target === search.current && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter'))) return
    const at = selected ? shown.indexOf(selected) : -1
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const next = shown[Math.max(0, Math.min(shown.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))]
      if (next) {
        select(next)
        requestAnimationFrame(() => listRef.current?.querySelector('.is-selected')?.scrollIntoView({ block: 'nearest' }))
      }
    } else if (e.key === 'Enter' && e.target === search.current) {
      if (shown[0]) select(selected && shown.includes(selected) ? selected : shown[0])
    } else if (e.key === '/') search.current?.focus()
    else if (e.key === 'n') newContact()
    else if (e.key === 'r') void refresh()
    else if (e.key === 'e' && selected) edit(selected)
    else if ((e.key === 'Delete' || e.key === 'Backspace') && selected && bookById.get(selected.book)?.writable) void remove(selected)
    else return
    e.preventDefault()
  }

  // A–Z: jump to the first contact of a letter (or the next letter that has one); a finger can slide along it.
  const jump = (letter: string) => {
    const i = LETTERS.indexOf(letter)
    for (const l of LETTERS.slice(i)) {
      const el = listRef.current?.querySelector(`[data-letter="${l}"]`)
      if (el) return el.scrollIntoView({ block: 'start' })
    }
  }
  const slide = (e: PointerEvent) => {
    if (e.buttons !== 1 && e.pointerType === 'mouse') return
    const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null
    if (el?.dataset.jump) jump(el.dataset.jump)
  }

  if (account.status !== 'user')
    return (
      <div ref={root} className="ct ct-empty">
        <div className="ct-empty-box">
          <span className="ct-empty-glyph">👥</span>
          <h3>Contacts</h3>
          <p className="muted">Your contacts show here once you sign in: an address book on this site, and Fastmail, iCloud or any CardDAV one.</p>
          {account.status === 'anon' && (
            <button className="btn btn-primary" onClick={signIn}>
              Sign in with GitHub
            </button>
          )}
        </div>
      </div>
    )

  const letters = new Set(query || filter.kind === 'duplicates' ? [] : shown.map(letterOf))
  const problems = [error, ...errors].filter(Boolean)
  const showList = !narrow || view.kind === 'none'
  const showDetail = !narrow || view.kind !== 'none'
  const sourceOrder = [...new Set(books.map((b) => b.source))]
  const filterLabel = filter.kind === 'all' ? 'All contacts' : filter.kind === 'book' ? (bookById.get(filter.id)?.name ?? 'Address book') : filter.kind === 'group' ? filter.name : 'Duplicates'
  const back = narrow ? () => setView({ kind: 'none' }) : undefined

  const detail = () => {
    if (view.kind === 'edit')
      return (
        <ContactEditor
          key={'contact' in view.target ? view.target.contact.id : 'new'}
          target={view.target}
          books={books}
          allGroups={allGroups}
          onDone={(c) => setView({ kind: 'contact', id: c.id })}
          onCancel={() => setView('contact' in view.target ? { kind: 'contact', id: view.target.contact.id } : { kind: 'none' })}
        />
      )
    if (view.kind === 'unknown') return <UnknownCard email={view.email} name={view.name} onBack={back} onAdd={() => newContact({ fn: view.name ?? '', n: { given: view.name?.split(' ')[0] ?? '', family: view.name?.split(' ').slice(1).join(' ') ?? '', middle: '', prefix: '', suffix: '' }, emails: [{ value: view.email }] })} />
    if (selected) return <ContactCard contact={selected} book={bookById.get(selected.book)} onBack={back} onEdit={bookById.get(selected.book)?.writable ? () => edit(selected) : null} onMenu={(e) => (e.type === 'contextmenu' ? openContextMenu(e, contactMenu(selected)) : openMenuAt(e.currentTarget as Element, contactMenu(selected)))} />
    if (view.kind === 'contact' && status === 'ready')
      return (
        <div className="ct-none">
          <p className="muted">That contact is not here any more.</p>
        </div>
      )
    return (
      <div className="ct-none">
        <p className="muted">{status === 'loading' ? 'Loading your contacts…' : contacts.length ? 'Pick someone from the list.' : 'No contacts yet.'}</p>
        {status === 'ready' && !contacts.length && (
          <div className="ct-connect">
            <button className="btn btn-primary" onClick={() => newContact()}>
              New contact
            </button>
            <button className="btn" onClick={() => pcFile.current?.click()}>
              Import a .vcf…
            </button>
            <button className="btn" onClick={() => wm.open('settings', { section: 'contacts', t: String(Date.now()) })}>
              Fastmail / CardDAV…
            </button>
          </div>
        )}
      </div>
    )
  }

  return (
    <div ref={root} className={`ct ${narrow ? 'is-narrow' : ''}`} tabIndex={-1} onKeyDown={onKey}>
      <header className="ct-toolbar">
        {!narrow && (
          <button className={`ca-icon ${sidebar ? 'is-on' : ''}`} onClick={() => setSidebar((s) => !s)} aria-label="Show the sidebar" title="Sidebar">
            ☰
          </button>
        )}
        {(showList || !narrow) && (
          <input ref={search} className="ct-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Search ${filterLabel.toLowerCase() === 'all contacts' ? 'contacts' : filterLabel}`} aria-label="Search contacts" spellCheck={false} />
        )}
        {(refreshing || status === 'loading') && <span className="ca-spin" aria-label="Loading" />}
        <span className="nb-spacer" />
        <button className="btn btn-small btn-primary" onClick={() => newContact()} title="New contact (N)">
          + New
        </button>
        <button className="ca-icon" onClick={(e) => appMenu(e.currentTarget)} aria-label="More" title="Import, export, duplicates">
          ⋯
        </button>
      </header>
      {problems.length > 0 && (
        <p className="ca-problem">
          {problems.join(' · ')}
          {error && (
            <button className="ca-x" onClick={() => setError(null)} aria-label="Dismiss">
              ×
            </button>
          )}
        </p>
      )}
      <div className="ct-main">
        {sidebar && !narrow && (
          <aside className="ct-side">
            <button className={`ct-side-item ${filter.kind === 'all' ? 'is-on' : ''}`} onClick={() => setFilter({ kind: 'all' })}>
              <span>All contacts</span>
              <span className="ct-count">{contacts.length}</span>
            </button>
            {sourceOrder.map((source) => (
              <section key={source}>
                {/* The book on this site is its own heading. */}
                {!books.some((b) => b.source === source && b.id === 'local') && <h4>{source}</h4>}
                {books
                  .filter((b) => b.source === source)
                  .map((b) => (
                    <button key={b.id} className={`ct-side-item ${filter.kind === 'book' && filter.id === b.id ? 'is-on' : ''}`} onClick={() => setFilter({ kind: 'book', id: b.id })} title={b.writable ? b.name : `${b.name} (read-only)`}>
                      <span>{b.name}</span>
                      <span className="ct-count">{contacts.filter((c) => c.book === b.id).length}</span>
                    </button>
                  ))}
              </section>
            ))}
            {allGroups.length > 0 && (
              <section>
                <h4>Groups</h4>
                {allGroups.map((g) => (
                  <button key={g} className={`ct-side-item ${filter.kind === 'group' && filter.name === g ? 'is-on' : ''}`} onClick={() => setFilter({ kind: 'group', name: g })}>
                    <span>{g}</span>
                    <span className="ct-count">{contacts.filter((c) => groupsOf(c).includes(g)).length}</span>
                  </button>
                ))}
              </section>
            )}
            {upcoming.length > 0 && (
              <section>
                <h4>Coming up</h4>
                {upcoming.map((d) => (
                  <button key={`${d.contact.id}${d.label}${d.date}`} className="ct-side-item ct-upcoming" onClick={() => select(d.contact)} title={`${displayName(d.contact)}: ${d.label}`}>
                    <span>
                      {d.kind === 'birthday' ? '🎂' : '💍'} {displayName(d.contact)}
                    </span>
                    <span className="ct-count">{formatDate(`--${d.date.slice(5)}`)}</span>
                  </button>
                ))}
              </section>
            )}
            <button className="link-btn ca-settings" onClick={() => wm.open('settings', { section: 'contacts', t: String(Date.now()) })}>
              Contacts settings
            </button>
          </aside>
        )}
        {showList && (
          <div className="ct-listpane">
            {narrow && (
              <select className="ct-filter" value={filter.kind === 'book' ? `b:${filter.id}` : filter.kind === 'group' ? `g:${filter.name}` : filter.kind} onChange={(e) => {
                const v = e.target.value
                setFilter(v === 'all' ? { kind: 'all' } : v === 'duplicates' ? { kind: 'duplicates' } : v.startsWith('b:') ? { kind: 'book', id: v.slice(2) } : { kind: 'group', name: v.slice(2) })
              }} aria-label="Show">
                <option value="all">All contacts ({contacts.length})</option>
                {books.map((b) => (
                  <option key={b.id} value={`b:${b.id}`}>
                    {b.name}
                    {b.source !== b.name ? ` · ${b.source}` : ''}
                  </option>
                ))}
                {allGroups.map((g) => (
                  <option key={g} value={`g:${g}`}>
                    Group: {g}
                  </option>
                ))}
                <option value="duplicates">Duplicates</option>
              </select>
            )}
            {filter.kind === 'duplicates' && (
              <div className="ct-dups-head">
                <span>{dupSets.length ? `${dupSets.length} ${dupSets.length === 1 ? 'person is' : 'people are'} in here more than once` : 'No duplicates found'}</span>
                <button className="link-btn" onClick={() => setFilter({ kind: 'all' })}>
                  Done
                </button>
              </div>
            )}
            <div className="ct-list" ref={listRef} role="listbox" aria-label="Contacts">
              {filter.kind === 'duplicates' && !query
                ? dupSets.map((set) => (
                    <div key={set[0].id} className="ct-dup">
                      {set.map((c) => (
                        <ListRow key={c.id} c={c} book={bookById.get(c.book)} selected={selected?.id === c.id} showBook onSelect={() => select(c)} onMenu={(e) => openContextMenu(e, contactMenu(c))} />
                      ))}
                      <button className="btn btn-small ct-merge" onClick={() => void mergeSet(set)} disabled={!set.some((c) => bookById.get(c.book)?.writable)}>
                        Merge
                      </button>
                    </div>
                  ))
                : shown.map((c, i) => (
                    <div key={c.id}>
                      {!query && filter.kind !== 'duplicates' && (i === 0 || letterOf(shown[i - 1]) !== letterOf(c)) && (
                        <div className="ct-letter" data-letter={letterOf(c)}>
                          {letterOf(c)}
                        </div>
                      )}
                      <ListRow c={c} book={bookById.get(c.book)} selected={selected?.id === c.id} showBook={filter.kind === 'all' && books.length > 1} onSelect={() => select(c)} onMenu={(e) => openContextMenu(e, contactMenu(c))} />
                    </div>
                  ))}
              {status === 'ready' && shown.length === 0 && filter.kind !== 'duplicates' && <p className="muted ct-nothing">{query ? `Nobody matches “${query}”.` : 'Nobody here yet.'}</p>}
            </div>
            {letters.size > 0 && (
              <nav className="ct-az" aria-label="Jump to a letter" onPointerDown={(e) => (e.currentTarget.setPointerCapture(e.pointerId), slide(e))} onPointerMove={slide}>
                {LETTERS.map((l) => (
                  <button key={l} data-jump={l} className={letters.has(l) ? '' : 'is-empty'} onClick={() => jump(l)} tabIndex={-1} aria-label={`Jump to ${l}`}>
                    {l}
                  </button>
                ))}
              </nav>
            )}
          </div>
        )}
        {showDetail && <div className="ct-detail">{detail()}</div>}
      </div>
      <input
        ref={pcFile}
        type="file"
        accept=".vcf,.vcard,text/vcard,text/x-vcard"
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])]
          e.target.value = ''
          if (files.length) void run(async () => importText((await Promise.all(files.map((f) => f.text()))).join('\r\n')))
        }}
      />
    </div>
  )
}

function ListRow({ c, book, selected, showBook, onSelect, onMenu }: { c: Contact; book: Book | undefined; selected: boolean; showBook: boolean; onSelect: () => void; onMenu: (e: ReactMouseEvent) => void }) {
  const second = c.org || c.emails[0]?.value || c.phones[0]?.value || ''
  return (
    <button role="option" aria-selected={selected} className={`ct-row-item ${selected ? 'is-selected' : ''}`} onClick={onSelect} onContextMenu={onMenu}>
      <Avatar contact={c} size={30} />
      <span className="ct-row-text">
        <strong>{displayName(c)}</strong>
        {(second || showBook) && <span className="muted">{[second, showBook && book ? book.name : ''].filter(Boolean).join(' · ')}</span>}
      </span>
    </button>
  )
}
