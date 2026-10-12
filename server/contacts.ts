import { createHash, randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { User } from './auth.ts'
import { addCarddav, bookCards, carddavBooks, cardUrl, deleteCard, fetchPhoto, getCard, listCarddav, putCard, removeCarddav, reusableLogins, type AddressBook } from './carddav.ts'
import { database } from './db.ts'
import { HttpError, json, readJson, SECURITY, UNTRUSTED } from './http.ts'
import { applyFields, emptyFields, ensureUid, groupOf, newCard, newGroupCard, photoOf, printCards, readFields, setMembers, setPhoto, splitCards, uidOf, versionOf, type Card, type ContactFields } from './vcard.ts'

// The Contacts app's server side: one list of contacts from every address book the user has,
// the one kept on this site (in SQLite, for whoever has no CardDAV server) and the CardDAV ones
// (server/carddav.ts). Both keep whole vCards, so an edit only changes the fields that were
// changed, whichever book it is in, and importing and exporting hand over the cards as they are.
// Every route is the signed-in user's own: rows and caches are kept by user id.

/** An address book as the app lists it. "local" is the one on this site. */
export type Book = { id: string; name: string; source: string; writable: boolean; account?: number }
/** A contact: its fields, where it lives, the ETag it was read with, the group cards it is in, and its photo's address. */
export type Contact = ContactFields & { id: string; book: string; uid: string; etag: string; groups: string[]; photo: string | null }
/** A group card (Apple's and Fastmail's groups): its name and its members' UIDs. CATEGORIES are groups too, read from each contact. */
export type Group = { id: string; book: string; name: string; members: string[] }

const LOCAL: Book = { id: 'local', name: 'On this site', source: 'On this site', writable: true }

// ---------------------------------------------------------------------------------------------
// The address book on this site

let ready = false
function db() {
  const d = database()
  if (!ready) {
    d.exec(`CREATE TABLE IF NOT EXISTS contacts_local (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      uid TEXT NOT NULL,
      vcard TEXT NOT NULL,
      etag TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, uid)
    )`)
    ready = true
  }
  return d
}

/** At most this many contacts on this site per account (a CardDAV server has its own limits). */
const LOCAL_MAX = 5000

const etagOf = (text: string) => `"${createHash('sha256').update(text).digest('hex').slice(0, 20)}"`

type Stored = { book: Book; name: string; etag: string; card: Card; dav?: AddressBook }

function localCards(user: User): Stored[] {
  const rows = db().prepare('SELECT uid, vcard, etag FROM contacts_local WHERE user_id = ?').all(user.id) as { uid: string; vcard: string; etag: string }[]
  return rows.flatMap((r) => {
    const card = splitCards(r.vcard)[0]
    return card ? [{ book: LOCAL, name: r.uid, etag: r.etag, card }] : []
  })
}

function putLocal(user: User, uid: string, card: Card, etag: string | 'new'): Stored {
  const text = printCards([card])
  const next = etagOf(text)
  const row = db().prepare('SELECT etag FROM contacts_local WHERE user_id = ? AND uid = ?').get(user.id, uid) as { etag: string } | undefined
  if (etag === 'new' ? !!row : !row || (etag && row.etag !== etag)) throw new HttpError(409, row ? 'It changed somewhere else meanwhile; try again' : 'That contact is gone')
  if (!row) {
    const { n } = db().prepare('SELECT COUNT(*) AS n FROM contacts_local WHERE user_id = ?').get(user.id) as { n: number }
    if (n >= LOCAL_MAX) throw new HttpError(413, `The address book on this site holds at most ${LOCAL_MAX} contacts`)
  }
  db()
    .prepare('INSERT INTO contacts_local (user_id, uid, vcard, etag, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (user_id, uid) DO UPDATE SET vcard = excluded.vcard, etag = excluded.etag, updated_at = excluded.updated_at')
    .run(user.id, uid, text, next, Date.now())
  return { book: LOCAL, name: uid, etag: next, card }
}

// ---------------------------------------------------------------------------------------------
// Every book and every card

async function books(user: User): Promise<{ books: Book[]; dav: AddressBook[]; errors: string[] }> {
  const { books: dav, errors } = await carddavBooks(user)
  const labels = new Map(listCarddav(user).map((a) => [a.id, a.label]))
  return { books: [LOCAL, ...dav.map((b) => ({ id: b.id, name: b.name, source: labels.get(b.account) ?? 'CardDAV', writable: b.writable, account: b.account }))], dav, errors }
}

async function bookFor(user: User, id: string): Promise<{ book: Book; dav?: AddressBook }> {
  if (id === 'local') return { book: LOCAL }
  const all = await books(user)
  const dav = all.dav.find((b) => b.id === id)
  const book = all.books.find((b) => b.id === id)
  if (!dav || !book) throw new HttpError(404, 'That address book is not connected')
  return { book, dav }
}

async function allCards(user: User, maxAge?: number): Promise<{ books: Book[]; stored: Stored[]; errors: string[] }> {
  const all = await books(user)
  const errors = [...all.errors]
  const lists = await Promise.all(
    all.dav.map((dav) =>
      bookCards(user, dav, maxAge)
        .then((cards) => cards.map((c): Stored => ({ book: all.books.find((b) => b.id === dav.id)!, name: c.href.split('/').pop()!, etag: c.etag, card: c.card, dav })))
        .catch((e: Error) => (errors.push(`${dav.name}: ${e.message}`), [] as Stored[])),
    ),
  )
  return { books: all.books, stored: [...localCards(user), ...lists.flat()], errors }
}

const idOf = (s: Stored) => `${s.book.id}#${s.name}`

function splitId(id: unknown): { book: string; name: string } {
  const m = typeof id === 'string' ? /^(local|dav:\d+:https?:\/\/.+)#([^#/]+)$/.exec(id) : null
  if (!m) throw new HttpError(400, 'Not a contact id')
  return { book: m[1], name: m[2] }
}

/** The card behind an id as it is now (read again from the CardDAV server, for its latest ETag). */
async function current(user: User, id: unknown): Promise<Stored> {
  const { book: bookId, name } = splitId(id)
  const { book, dav } = await bookFor(user, bookId)
  if (!dav) {
    const row = db().prepare('SELECT vcard, etag FROM contacts_local WHERE user_id = ? AND uid = ?').get(user.id, name) as { vcard: string; etag: string } | undefined
    const card = row && splitCards(row.vcard)[0]
    if (!card) throw new HttpError(404, 'That contact is gone')
    return { book, name, etag: row.etag, card }
  }
  const got = await getCard(user, dav, cardUrl(dav, name))
  return { book, name, etag: got.etag, card: got.card, dav }
}

async function write(user: User, s: Stored, etag: string | 'new'): Promise<Stored> {
  if (!s.dav) return putLocal(user, s.name, s.card, etag)
  const got = await putCard(user, s.dav, cardUrl(s.dav, s.name), s.card, etag)
  return { ...s, etag: got.etag, card: got.card }
}

async function remove(user: User, s: Stored, etag?: string) {
  if (!s.dav) {
    db().prepare('DELETE FROM contacts_local WHERE user_id = ? AND uid = ?').run(user.id, s.name)
    return
  }
  await deleteCard(user, s.dav, cardUrl(s.dav, s.name), etag)
}

/** The photo's address: with a version, so the browser keeps it until the card changes. */
const photoUrl = (s: Stored) => {
  const p = photoOf(s.card)
  if (!p) return null
  const v = createHash('sha256').update(p.kind === 'inline' ? p.bytes : p.uri).digest('hex').slice(0, 12)
  return `/api/contacts/photo?id=${encodeURIComponent(idOf(s))}&v=${v}`
}

function toContact(s: Stored, groups: Group[]): Contact {
  const uid = uidOf(s.card) || s.name
  return {
    ...readFields(s.card),
    id: idOf(s),
    book: s.book.id,
    uid,
    etag: s.etag,
    groups: groups.filter((g) => g.book === s.book.id && g.members.includes(uid)).map((g) => g.name),
    photo: photoUrl(s),
  }
}

function groupsIn(stored: Stored[]): Group[] {
  return stored.flatMap((s) => {
    const g = groupOf(s.card)
    return g ? [{ id: idOf(s), book: s.book.id, name: readFields(s.card).fn || 'Group', members: g.members }] : []
  })
}

export async function listContacts(user: User, fresh: boolean): Promise<{ books: Book[]; contacts: Contact[]; groups: Group[]; errors: string[] }> {
  const { books: list, stored, errors } = await allCards(user, fresh ? 0 : undefined)
  const groups = groupsIn(stored)
  const contacts = stored.filter((s) => !groupOf(s.card)).map((s) => toContact(s, groups))
  return { books: list, contacts, groups, errors }
}

// ---------------------------------------------------------------------------------------------
// Changes

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '')
const list = <T>(v: unknown, each: (x: Record<string, unknown>) => T): T[] => (Array.isArray(v) ? v.slice(0, 50).filter((x) => x && typeof x === 'object').map((x) => each(x as Record<string, unknown>)) : [])
const labeled = (x: Record<string, unknown>) => ({ value: str(x.value, 500), ...(x.type ? { type: str(x.type, 40) } : {}), ...(x.pref ? { pref: true } : {}) })
const date = (v: unknown) => (typeof v === 'string' && /^(\d{4}|-)-\d{2}-\d{2}$/.test(v) ? v : '')

/** Fields from the browser, checked and capped. */
function cleanFields(v: unknown): ContactFields {
  const x = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const n = (x.n && typeof x.n === 'object' ? x.n : {}) as Record<string, unknown>
  return {
    ...emptyFields(),
    fn: str(x.fn, 300),
    n: { family: str(n.family, 200), given: str(n.given, 200), middle: str(n.middle, 200), prefix: str(n.prefix, 100), suffix: str(n.suffix, 100) },
    nickname: str(x.nickname, 200),
    org: str(x.org, 300),
    department: str(x.department, 300),
    title: str(x.title, 300),
    emails: list(x.emails, labeled),
    phones: list(x.phones, labeled),
    urls: list(x.urls, labeled),
    addresses: list(x.addresses, (a) => ({ ...(a.type ? { type: str(a.type, 40) } : {}), ...(a.pref ? { pref: true } : {}), pobox: str(a.pobox, 200), ext: str(a.ext, 200), street: str(a.street, 500), locality: str(a.locality, 200), region: str(a.region, 200), postcode: str(a.postcode, 50), country: str(a.country, 200) })),
    birthday: date(x.birthday),
    anniversaries: list(x.anniversaries, (d) => ({ label: str(d.label, 60) || 'anniversary', date: date(d.date) })).filter((d) => d.date),
    note: str(x.note, 20_000),
    categories: Array.isArray(x.categories) ? x.categories.slice(0, 50).map((c) => str(c, 100).trim()).filter(Boolean) : [],
  }
}

/** A photo from the editor (a data: URL the browser made small), or null to remove it. */
function cleanPhoto(v: unknown): { type: string; bytes: Buffer } | null | undefined {
  if (v === undefined) return undefined
  if (v === null) return null
  const m = typeof v === 'string' ? /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(v) : null
  if (!m) throw new HttpError(400, 'That photo is not a picture')
  const bytes = Buffer.from(m[2], 'base64')
  if (bytes.length > 1024 * 1024) throw new HttpError(413, 'That photo is too big')
  return { type: m[1], bytes }
}

type Body = { id?: string; book?: string; base?: unknown; fields?: unknown; groups?: unknown; photo?: unknown; etag?: string }

/**
 * Group membership as the editor has it (one list of names): names of the book's group cards
 * change those cards' members; the rest are CATEGORIES on the contact. A new name becomes a
 * group card in a book that keeps its groups that way (Fastmail, iCloud), a category otherwise.
 */
async function applyGroups(user: User, book: Book, dav: AddressBook | undefined, uid: string, fields: ContactFields, wanted: string[]) {
  const stored = book.id === 'local' ? localCards(user) : (await allCards(user)).stored.filter((s) => s.book.id === book.id)
  const cards = stored.filter((s) => groupOf(s.card))
  const byName = new Map(cards.map((s) => [readFields(s.card).fn.toLowerCase(), s]))
  const names = [...new Set(wanted.map((g) => g.trim()).filter(Boolean))]
  fields.categories = names.filter((n) => !byName.has(n.toLowerCase()) && (!cards.length || fields.categories.some((c) => c.toLowerCase() === n.toLowerCase())))
  const fresh = cards.length ? names.filter((n) => !byName.has(n.toLowerCase()) && !fields.categories.includes(n)) : []
  for (const s of cards) {
    const members = groupOf(s.card)!.members
    const should = names.some((n) => n.toLowerCase() === readFields(s.card).fn.toLowerCase())
    if (should === members.includes(uid)) continue
    const now = await current(user, idOf(s))
    const was = groupOf(now.card)?.members ?? []
    setMembers(now.card, should ? [...was, uid] : was.filter((m) => m !== uid))
    await write(user, now, now.etag)
  }
  for (const name of fresh) {
    const gid = randomUUID()
    const card = newGroupCard(gid, name, cards[0] ? (versionOf(cards[0].card) === '4.0' ? '4.0' : '3.0') : '3.0')
    setMembers(card, [uid])
    await write(user, { book, name: dav ? `${gid}.vcf` : gid, etag: '', card, dav }, 'new')
  }
}

async function created(user: User, s: Stored): Promise<Contact> {
  const { stored } = await allCards(user)
  const groups = groupsIn(stored)
  return toContact(stored.find((x) => idOf(x) === idOf(s)) ?? s, groups)
}

export async function createContact(user: User, body: Body): Promise<Contact> {
  const { book, dav } = await bookFor(user, String(body.book ?? 'local'))
  if (!book.writable) throw new HttpError(403, `${book.name} is read-only`)
  const uid = randomUUID()
  const fields = cleanFields(body.fields)
  const card = newCard(uid)
  if (Array.isArray(body.groups)) await applyGroups(user, book, dav, uid, fields, body.groups.map((g) => str(g, 100)))
  applyFields(card, emptyFields(), fields)
  const photo = cleanPhoto(body.photo)
  if (photo) setPhoto(card, photo)
  const s = await write(user, { book, name: dav ? `${uid}.vcf` : uid, etag: '', card, dav }, 'new')
  return created(user, s)
}

/** Changes what the editor changed (`base` → `fields`) in the card as it is now, written back with its ETag. */
export async function updateContact(user: User, body: Body): Promise<Contact> {
  const s = await current(user, body.id)
  if (!s.book.writable) throw new HttpError(403, `${s.book.name} is read-only`)
  const base = cleanFields(body.base)
  const fields = cleanFields(body.fields)
  if (Array.isArray(body.groups)) {
    // Categories that were not in the editor's list stay as they are now on the card.
    fields.categories = readFields(s.card).categories
    await applyGroups(user, s.book, s.dav, uidOf(s.card) || s.name, fields, body.groups.map((g) => str(g, 100)))
    base.categories = readFields(s.card).categories
  }
  applyFields(s.card, base, fields)
  const photo = cleanPhoto(body.photo)
  if (photo !== undefined) setPhoto(s.card, photo)
  return created(user, await write(user, s, s.etag))
}

export async function deleteContact(user: User, body: Body) {
  const s = await current(user, body.id)
  if (!s.book.writable) throw new HttpError(403, `${s.book.name} is read-only`)
  if (body.etag && s.etag && body.etag !== s.etag && !s.dav) throw new HttpError(409, 'It changed somewhere else meanwhile; try again')
  await remove(user, s, s.etag || undefined)
}

/** Moves a contact's whole card to another address book (any account), then takes it out of the first. */
export async function moveContact(user: User, body: Body): Promise<Contact> {
  const s = await current(user, body.id)
  const { book, dav } = await bookFor(user, String(body.book))
  if (book.id === s.book.id) return created(user, s)
  if (!book.writable) throw new HttpError(403, `${book.name} is read-only`)
  const uid = uidOf(s.card) || randomUUID()
  const moved = await write(user, { book, name: dav ? `${uid}.vcf` : uid, etag: '', card: s.card, dav }, 'new')
  await remove(user, s, s.etag || undefined)
  return created(user, moved)
}

/**
 * Cards from a .vcf into a book: one with a UID the book already has replaces that card, the rest
 * are added. Group cards come along. Four at a time to a CardDAV server.
 */
export async function importCards(user: User, body: { book?: string; text?: string }): Promise<{ added: number; updated: number; failed: string[] }> {
  const { book, dav } = await bookFor(user, String(body.book ?? 'local'))
  if (!book.writable) throw new HttpError(403, `${book.name} is read-only`)
  const cards = splitCards(String(body.text ?? ''))
  if (!cards.length) throw new HttpError(400, 'No contacts in that file')
  if (cards.length > 5000) throw new HttpError(413, 'At most 5000 contacts at a time')
  const existing = new Map((book.id === 'local' ? localCards(user) : (await allCards(user, 0)).stored.filter((s) => s.book.id === book.id)).map((s) => [uidOf(s.card) || s.name, s]))
  const out = { added: 0, updated: 0, failed: [] as string[] }
  const queue = [...cards]
  const worker = async () => {
    for (let card = queue.shift(); card; card = queue.shift()) {
      const uid = ensureUid(card, randomUUID)
      const fields = readFields(card)
      // FN (and 3.0's N) filled in when the card lacks them; nothing else is touched.
      applyFields(card, fields, fields)
      const had = existing.get(uid)
      try {
        if (had) {
          await write(user, { ...had, card }, had.etag)
          out.updated++
        } else {
          const safe = /^[\w.@-]{1,120}$/.test(uid) ? uid : randomUUID()
          await write(user, { book, name: dav ? `${safe}.vcf` : uid, etag: '', card, dav }, 'new')
          out.added++
        }
      } catch (e) {
        out.failed.push(`${fields.fn || uid}: ${(e as Error).message}`)
      }
    }
  }
  await Promise.all(Array.from({ length: dav ? 4 : 1 }, worker))
  return out
}

/** A .vcf of a book (with its group cards), or of some contacts: the cards as they are stored. */
export async function exportCards(user: User, book: string | null, ids: string[] | null): Promise<string> {
  const { stored } = await allCards(user)
  const pick = ids ? stored.filter((s) => ids.includes(idOf(s))) : stored.filter((s) => !book || s.book.id === book)
  return printCards(pick.map((s) => s.card))
}

export async function contactPhoto(user: User, id: string | null): Promise<{ type: string; bytes: Buffer }> {
  const { book: bookId } = splitId(id)
  const { stored } = await allCards(user)
  const s = stored.find((x) => idOf(x) === id && x.book.id === bookId)
  const p = s && photoOf(s.card)
  if (!s || !p) throw new HttpError(404, 'No photo')
  const got = p.kind === 'inline' ? p : s.dav ? await fetchPhoto(user, s.dav, p.uri) : null
  if (!got) throw new HttpError(404, 'No photo')
  // Only pictures a browser shows inline, never as a page of this site.
  return { type: /^image\/(jpeg|png|gif|webp)$/.test(got.type) ? got.type : 'application/octet-stream', bytes: got.bytes }
}

// ---------------------------------------------------------------------------------------------
// Routes, from server/api.ts: /api/contacts/...

export async function handleContactsApi(req: IncomingMessage, res: ServerResponse, url: URL, method: string, user: User): Promise<boolean> {
  const path = url.pathname
  const read = method === 'GET' || method === 'HEAD'
  if (path === '/api/contacts' && read) return json(res, 200, await listContacts(user, url.searchParams.get('fresh') === '1')), true
  if (path === '/api/contacts/accounts' && read) return json(res, 200, { accounts: listCarddav(user), reusable: reusableLogins(user) }), true
  if (path === '/api/contacts/accounts' && method === 'POST') return json(res, 200, await addCarddav(user, await readJson(req, 8 * 1024))), true
  const accountId = /^\/api\/contacts\/accounts\/(\d+)$/.exec(path)?.[1]
  if (accountId && method === 'DELETE') return removeCarddav(user, Number(accountId)), json(res, 200, { ok: true }), true
  if (path === '/api/contacts/card' && method === 'POST') return json(res, 200, await createContact(user, await readJson(req, 2 * 1024 * 1024))), true
  if (path === '/api/contacts/card' && method === 'PATCH') return json(res, 200, await updateContact(user, await readJson(req, 2 * 1024 * 1024))), true
  if (path === '/api/contacts/card' && method === 'DELETE') return await deleteContact(user, await readJson(req, 8 * 1024)), json(res, 200, { ok: true }), true
  if (path === '/api/contacts/move' && method === 'POST') return json(res, 200, await moveContact(user, await readJson(req, 8 * 1024))), true
  if (path === '/api/contacts/import' && method === 'POST') return json(res, 200, await importCards(user, await readJson(req, 16 * 1024 * 1024))), true
  if (path === '/api/contacts/export' && read) {
    const ids = url.searchParams.get('ids')
    const text = await exportCards(user, url.searchParams.get('book'), ids ? ids.split(',') : null)
    res.writeHead(200, { 'Content-Type': 'text/vcard; charset=utf-8', 'Content-Disposition': 'attachment; filename="contacts.vcf"', 'Cache-Control': 'no-store', ...SECURITY, ...UNTRUSTED }).end(method === 'HEAD' ? undefined : text)
    return true
  }
  if (path === '/api/contacts/photo' && read) {
    const p = await contactPhoto(user, url.searchParams.get('id'))
    res.writeHead(200, { 'Content-Type': p.type, 'Content-Length': String(p.bytes.length), 'Cache-Control': 'private, max-age=86400', ...SECURITY, ...UNTRUSTED }).end(method === 'HEAD' ? undefined : p.bytes)
    return true
  }
  return false
}
