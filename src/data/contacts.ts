import { useEffect, useSyncExternalStore, type ReactNode } from 'react'
import { api, getAccount, subscribeAccount } from '../os/account'
import { synced } from '../os/synced'

// Your contacts, for the Contacts app and every other app that deals with people (Mail's
// recipients, Calendar's guests and birthdays). The server (server/contacts.ts) gathers them from
// the address book on this site and the CardDAV ones linked in Settings; this keeps one copy in
// the page, loaded once and shared by every caller, with an index by email address.
//
// The contract for other apps:
//
//   searchContacts(q)            contacts matching a name, email, phone or organisation, best first
//   contactByEmail(email)        the contact with that address, or null
//   contactsByEmails(emails)     a Map from (lower-case) address to contact, for a list at once
//   peekContactByEmail(email)    the same without waiting: null until the contacts have loaded
//   useContactByEmail(email)     a hook: the contact, re-rendering once they load or change
//   openContact(idOrEmail, name?) the Contacts app on that person; an unknown address offers "Add to contacts"
//   addContact(partial)          a new contact (in the default address book), answers it
//   birthdays(from, to)          birthdays and anniversaries in a date range, for a Birthdays calendar
//   registerContactSlot(slot, render)  fills the contact card's "Recent mail" or "Upcoming events"
//
// The components: <PeoplePicker> (a recipient or guest field) and <PersonChip>/<Avatar>, in
// src/apps/contacts/people.tsx.

export type Labeled = { value: string; type?: string; pref?: boolean }
export type Address = { type?: string; pref?: boolean; pobox: string; ext: string; street: string; locality: string; region: string; postcode: string; country: string }
/** A date of the person's: "YYYY-MM-DD", or "--MM-DD" without the year. */
export type Dated = { label: string; date: string }
export type Name = { family: string; given: string; middle: string; prefix: string; suffix: string }
export type ContactFields = {
  fn: string
  n: Name
  nickname: string
  org: string
  department: string
  title: string
  emails: Labeled[]
  phones: Labeled[]
  urls: Labeled[]
  addresses: Address[]
  /** "YYYY-MM-DD", "--MM-DD" without a year, or "" */
  birthday: string
  anniversaries: Dated[]
  note: string
  /** The card's CATEGORIES (one kind of group; `groups` below is the other) */
  categories: string[]
}
/** A contact: its fields, which address book it is in, its UID and ETag, the group cards it is in, and its photo's address (or null). */
export type Contact = ContactFields & { id: string; book: string; uid: string; etag: string; groups: string[]; photo: string | null }
/** An address book: "local" is the one on this site, the rest are CardDAV ones ("dav:<account>:<url>"). */
export type Book = { id: string; name: string; source: string; writable: boolean; account?: number }
/** A group card (Fastmail's and Apple's groups) with its members' UIDs. */
export type Group = { id: string; book: string; name: string; members: string[] }

export const emptyFields = (): ContactFields => ({
  fn: '',
  n: { family: '', given: '', middle: '', prefix: '', suffix: '' },
  nickname: '',
  org: '',
  department: '',
  title: '',
  emails: [],
  phones: [],
  urls: [],
  addresses: [],
  birthday: '',
  anniversaries: [],
  note: '',
  categories: [],
})

/** Just the fields of a contact (what the editor changes and the server compares). */
export function fieldsOf(c: Contact): ContactFields {
  const { fn, n, nickname, org, department, title, emails, phones, urls, addresses, birthday, anniversaries, note, categories } = c
  return { fn, n, nickname, org, department, title, emails, phones, urls, addresses, birthday, anniversaries, note, categories }
}

/** Every group a contact is in: its group cards' and its categories, once each. */
export const groupsOf = (c: Contact) => [...new Set([...c.groups, ...c.categories])]

// ---------------------------------------------------------------------------------------------
// The shared copy

type State = { status: 'idle' | 'loading' | 'ready' | 'error'; books: Book[]; contacts: Contact[]; groups: Group[]; errors: string[]; at: number }
let state: State = { status: 'idle', books: [], contacts: [], groups: [], errors: [], at: 0 }
let inflight: Promise<void> | null = null
let byEmail = new Map<string, Contact>()
let forUser: number | null = null
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

function set(next: Partial<State>) {
  state = { ...state, ...next }
  if (next.contacts) {
    byEmail = new Map()
    // The first contact with an address wins; one in this site's own book comes after CardDAV's.
    for (const c of [...state.contacts].sort((a, b) => Number(a.book === 'local') - Number(b.book === 'local'))) for (const e of c.emails) if (!byEmail.has(e.value.toLowerCase())) byEmail.set(e.value.toLowerCase(), c)
  }
  emit()
}

// Signed out, or someone else signed in: nothing of the last account's stays.
subscribeAccount(() => {
  const id = getAccount().user?.id ?? null
  if (id === forUser) return
  forUser = id
  inflight = null
  set({ status: 'idle', books: [], contacts: [], groups: [], errors: [], at: 0 })
})

/** Loads (or with `fresh`, reloads past the server's cache of CardDAV books) every contact. */
export function loadContacts(fresh = false): Promise<void> {
  if (getAccount().status !== 'user') return Promise.resolve()
  if (inflight && !fresh) return inflight
  if (state.status !== 'ready') set({ status: 'loading' })
  const user = getAccount().user?.id
  const p = api<{ books: Book[]; contacts: Contact[]; groups: Group[]; errors: string[] }>(`/api/contacts${fresh ? '?fresh=1' : ''}`)
    .then((r) => {
      if (getAccount().user?.id !== user) return
      set({ status: 'ready', books: r.books, contacts: r.contacts, groups: r.groups, errors: r.errors, at: Date.now() })
    })
    .catch((e: Error) => set({ status: state.contacts.length ? 'ready' : 'error', errors: [e.message] }))
    .finally(() => {
      if (inflight === p) inflight = null
    })
  inflight = p
  return p
}

/** Loaded within the last five minutes (loading now if not). */
function ensure(): Promise<void> {
  if (state.status === 'ready' && Date.now() - state.at < 5 * 60_000) return Promise.resolve()
  return loadContacts()
}

export const getContacts = () => state
export const subscribeContacts = (l: () => void) => (listeners.add(l), () => void listeners.delete(l))

/** Every contact, book and group; starts loading on first use and keeps up every five minutes while shown. */
export function useContacts(): State {
  const s = useSyncExternalStore(subscribeContacts, getContacts)
  const signedIn = useSyncExternalStore(subscribeAccount, () => getAccount().status === 'user')
  useEffect(() => {
    if (!signedIn) return
    void ensure()
    const again = () => document.visibilityState === 'visible' && void ensure()
    const t = setInterval(again, 5 * 60_000)
    document.addEventListener('visibilitychange', again)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', again)
    }
  }, [signedIn])
  return s
}

// ---------------------------------------------------------------------------------------------
// Looking people up

/** The name to show: FN, else the name parts, the organisation, an address. */
export const displayName = (c: Pick<ContactFields, 'fn' | 'n' | 'org' | 'emails'>) => c.fn || [c.n.given, c.n.family].filter(Boolean).join(' ') || c.org || c.emails[0]?.value || 'No name'

/** Up to two initials, for an avatar without a photo. */
export function initials(name: string): string {
  const words = name.replace(/[<>"@].*$/, '').trim().split(/\s+/).filter((w) => /\p{L}|\p{N}/u.test(w))
  if (!words.length) return name.trim().charAt(0).toUpperCase() || '?'
  return (words.length > 1 ? words[0][0] + words[words.length - 1][0] : words[0].slice(0, 2)).toUpperCase()
}

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

/** How well a contact matches what was typed: 0 is not at all; a name that starts with it beats one that only contains it. */
export function matchScore(c: Contact, q: string): number {
  const t = fold(q.trim())
  if (!t) return 1
  const digits = t.replace(/[^\d+]/g, '')
  const words = [c.fn, c.n.given, c.n.family, c.nickname].map(fold)
  let best = 0
  for (const w of words) for (const part of w.split(/\s+/)) if (part.startsWith(t)) best = Math.max(best, w.startsWith(t) ? 100 : 80)
  if (!best && t.length > 1 && fold(c.fn).includes(t)) best = 50
  for (const e of c.emails) if (fold(e.value).startsWith(t)) best = Math.max(best, 70)
  // One letter only matches the start of something; inside a word it would match nearly everyone.
  else if (t.length > 1 && fold(e.value).includes(t)) best = Math.max(best, 30)
  if (t.length > 1 && fold(c.org).includes(t)) best = Math.max(best, 25)
  else if (fold(c.org).startsWith(t)) best = Math.max(best, 25)
  if (digits.length >= 3 && c.phones.some((p) => p.value.replace(/[^\d+]/g, '').includes(digits))) best = Math.max(best, 40)
  return best
}

/** Contacts matching `q` (a name, an address, part of a phone number, an organisation), best first. */
export async function searchContacts(q: string, limit = 20): Promise<Contact[]> {
  await ensure()
  return searchLoaded(q, limit)
}

/** The same over what is loaded already, without waiting (for typing in a field). */
export function searchLoaded(q: string, limit = 20): Contact[] {
  return state.contacts
    .map((c) => ({ c, s: matchScore(c, q) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || displayName(a.c).localeCompare(displayName(b.c)))
    .slice(0, limit)
    .map((x) => x.c)
}

/** The contact with this email address, or null. */
export async function contactByEmail(email: string): Promise<Contact | null> {
  await ensure()
  return peekContactByEmail(email)
}

/**
 * Contacts for many addresses at once (a mail thread's people, an event's guests): a Map from the
 * lower-case address to its contact; addresses of nobody you know are left out. Callers in the
 * same moment share one load.
 */
export async function contactsByEmails(emails: string[]): Promise<Map<string, Contact>> {
  await ensure()
  const out = new Map<string, Contact>()
  for (const e of emails) {
    const c = byEmail.get(e.trim().toLowerCase())
    if (c) out.set(e.trim().toLowerCase(), c)
  }
  return out
}

/** What is loaded already: the contact with this address, or null (also while still loading). */
export const peekContactByEmail = (email: string): Contact | null => byEmail.get(email.trim().toLowerCase()) ?? null

/** A hook: the contact with this address, or null; loads the contacts if nobody has yet. */
export function useContactByEmail(email: string | null | undefined): Contact | null {
  useSyncExternalStore(subscribeContacts, getContacts)
  const signedIn = useSyncExternalStore(subscribeAccount, () => getAccount().status === 'user')
  useEffect(() => {
    if (signedIn && email) void ensure()
  }, [signedIn, email])
  return email ? peekContactByEmail(email) : null
}

export const contactById = (id: string) => state.contacts.find((c) => c.id === id) ?? null

/**
 * Opens the Contacts app on a person: a contact id, or an email address (the contact with it, or a
 * card offering "Add to contacts" with `name` filled in when nobody has it).
 */
export function openContact(idOrEmail: string, name?: string) {
  const props: Record<string, string> = { t: String(Date.now()) }
  if (idOrEmail.includes('@') && !idOrEmail.includes('#')) {
    const c = peekContactByEmail(idOrEmail)
    if (c) props.contact = c.id
    else {
      props.email = idOrEmail.trim()
      if (name) props.name = name
    }
  } else props.contact = idOrEmail
  window.dispatchEvent(new CustomEvent('mvlos:open', { detail: { app: 'contacts', props } }))
}

// ---------------------------------------------------------------------------------------------
// Birthdays and anniversaries

export type PersonDate = {
  contact: Contact
  kind: 'birthday' | 'anniversary'
  /** "Birthday", "Anniversary", or the date's own label */
  label: string
  /** The day it falls on in the range, "YYYY-MM-DD" */
  date: string
  /** The year it started, when the card says (for "turns 40") */
  since?: number
  /** Years since then on that day */
  years?: number
}

const pad = (n: number) => String(n).padStart(2, '0')
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** Birthdays and anniversaries that fall between `from` and `to` (a 29 February one on 28 February in other years), for a Birthdays calendar. */
export async function birthdays(from: Date, to: Date): Promise<PersonDate[]> {
  await ensure()
  return datesIn(state.contacts, from, to)
}

export function datesIn(contacts: Contact[], from: Date, to: Date): PersonDate[] {
  const out: PersonDate[] = []
  const lo = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime()
  const hi = to.getTime()
  for (const c of contacts) {
    const dates: { kind: PersonDate['kind']; label: string; date: string }[] = [
      ...(c.birthday ? [{ kind: 'birthday' as const, label: 'Birthday', date: c.birthday }] : []),
      ...c.anniversaries.map((a) => ({ kind: 'anniversary' as const, label: capital(a.label), date: a.date })),
    ]
    for (const d of dates) {
      const m = /^(\d{4}|-)-(\d{2})-(\d{2})$/.exec(d.date)
      if (!m) continue
      const since = m[1] === '-' ? undefined : Number(m[1])
      const month = Number(m[2]) - 1
      const day = Number(m[3])
      for (let year = from.getFullYear(); year <= to.getFullYear(); year++) {
        // 29 February outside a leap year: the 28th.
        const leap = new Date(year, 1, 29).getMonth() === 1
        const at = new Date(year, month, month === 1 && day === 29 && !leap ? 28 : day)
        if (at.getTime() < lo || at.getTime() >= hi) continue
        out.push({ contact: c, kind: d.kind, label: d.label, date: `${year}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`, ...(since && since <= year ? { since, years: year - since } : {}) })
      }
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || displayName(a.contact).localeCompare(displayName(b.contact)))
}

// ---------------------------------------------------------------------------------------------
// Changes

/** Where new contacts go unless asked otherwise (Settings → Apps → Contacts); synced with the account. */
export const defaultBook = synced<string>('contacts-book', 'local', { normalize: (v) => (typeof v === 'string' && v ? v : 'local') })

/** The default book if it is still there and can be written, else the one on this site. */
export const bookForNew = () => state.books.find((b) => b.id === defaultBook.get() && b.writable)?.id ?? 'local'

function upsert(c: Contact, replaces?: string) {
  set({ contacts: [...state.contacts.filter((x) => x.id !== c.id && x.id !== replaces), c] })
}

/** A new contact. `photo` is a data: URL (see shrinkPhoto). Group names that are group cards in that book join them; the rest are categories. */
export async function createContact(book: string, fields: ContactFields, opts: { groups?: string[]; photo?: string | null } = {}): Promise<Contact> {
  const c = await api<Contact>('/api/contacts/card', { method: 'POST', json: { book, fields, groups: opts.groups, photo: opts.photo ?? undefined } })
  upsert(c)
  if (opts.groups?.length) void loadContacts(true)
  return c
}

/** Saves what changed from `contact` (as it was loaded) to `fields`; the server writes only that, with the card's ETag. `photo`: a data: URL, null to remove it, undefined to keep it. */
export async function updateContact(contact: Contact, fields: ContactFields, opts: { groups?: string[]; photo?: string | null } = {}): Promise<Contact> {
  const c = await api<Contact>('/api/contacts/card', { method: 'PATCH', json: { id: contact.id, base: fieldsOf(contact), fields, groups: opts.groups, photo: opts.photo } })
  upsert(c, contact.id)
  if (opts.groups) void loadContacts(true)
  return c
}

export async function deleteContact(contact: Contact) {
  await api('/api/contacts/card', { method: 'DELETE', json: { id: contact.id, etag: contact.etag } })
  set({ contacts: state.contacts.filter((c) => c.id !== contact.id) })
}

export async function moveContact(contact: Contact, book: string): Promise<Contact> {
  const c = await api<Contact>('/api/contacts/move', { method: 'POST', json: { id: contact.id, book } })
  upsert(c, contact.id)
  return c
}

/**
 * A new contact from what another app knows (a mail's sender: `{ fn, emails: [{ value }] }`), in
 * the default address book. `email` and `name` are shorthands.
 */
export async function addContact(partial: Partial<ContactFields> & { email?: string; name?: string }, opts: { book?: string; groups?: string[] } = {}): Promise<Contact> {
  await ensure()
  const { email, name, ...rest } = partial
  const fields: ContactFields = { ...emptyFields(), ...rest, ...(name && !rest.fn ? { fn: name } : {}), ...(email && !rest.emails?.length ? { emails: [{ value: email }] } : {}) }
  return createContact(opts.book ?? bookForNew(), fields, { groups: opts.groups })
}

/** Cards from a .vcf (its text) into a book. */
export async function importVcf(book: string, text: string): Promise<{ added: number; updated: number; failed: string[] }> {
  const r = await api<{ added: number; updated: number; failed: string[] }>('/api/contacts/import', { method: 'POST', json: { book, text } })
  await loadContacts(true)
  return r
}

/** A .vcf of a whole book, or of some contacts, with every card as stored. */
export async function exportVcf(which: { book?: string; ids?: string[] }): Promise<string> {
  const q = which.ids ? `ids=${encodeURIComponent(which.ids.join(','))}` : `book=${encodeURIComponent(which.book ?? '')}`
  const res = await fetch(`/api/contacts/export?${q}`, { credentials: 'same-origin' })
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `Export failed (${res.status})`)
  return res.text()
}

/** A picture made small for a contact photo: a square JPEG of at most 256 pixels, as a data: URL. */
export async function shrinkPhoto(file: Blob): Promise<string> {
  const bitmap = await createImageBitmap(file)
  const side = Math.min(bitmap.width, bitmap.height)
  const size = Math.min(256, side)
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  canvas.getContext('2d')!.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size)
  bitmap.close()
  return canvas.toDataURL('image/jpeg', 0.85)
}

// ---------------------------------------------------------------------------------------------
// CardDAV accounts (Settings)

export type CarddavInfo = { id: number; label: string; url: string; username: string }
/** A CalDAV account whose login can be used for contacts too; never its password. */
export type ReusableLogin = { caldav: number; label: string; url: string; username: string }

export const listAccounts = () => api<{ accounts: CarddavInfo[]; reusable: ReusableLogin[] }>('/api/contacts/accounts')

export async function addAccount(input: { url?: string; username?: string; password?: string; label?: string; caldav?: number }): Promise<CarddavInfo> {
  const a = await api<CarddavInfo>('/api/contacts/accounts', { method: 'POST', json: input })
  void loadContacts(true)
  return a
}

export async function removeAccount(id: number) {
  await api(`/api/contacts/accounts/${id}`, { method: 'DELETE' })
  await loadContacts(true)
}

// ---------------------------------------------------------------------------------------------
// The contact card's slots for other apps

/**
 * The contact card has a place for "Recent mail" and one for "Upcoming events". They show
 * nothing until an app registers what goes there (Mail and Calendar), from anywhere at start:
 *
 *   registerContactSlot('recent-mail', (contact) => <RecentMail emails={contact.emails} />)
 *
 * The render gets the contact and returns its section (or null for nothing).
 */
export type ContactSlot = 'recent-mail' | 'upcoming-events'
const slots = new Map<ContactSlot, (c: Contact) => ReactNode>()
const slotListeners = new Set<() => void>()

export function registerContactSlot(slot: ContactSlot, render: (c: Contact) => ReactNode): () => void {
  slots.set(slot, render)
  slotListeners.forEach((l) => l())
  return () => {
    if (slots.get(slot) === render) slots.delete(slot)
    slotListeners.forEach((l) => l())
  }
}

export function useContactSlot(slot: ContactSlot): ((c: Contact) => ReactNode) | null {
  return useSyncExternalStore(
    (l) => (slotListeners.add(l), () => void slotListeners.delete(l)),
    () => slots.get(slot) ?? null,
  )
}
