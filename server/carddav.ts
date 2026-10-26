import { ownPrivateCache, canUsePrivateCache, bindPrivateAccess, requirePrivateRequest, withPrivateOperation, withProviderGuard } from './privateRequest.ts'
import type { User } from './auth.ts'
import { database, decrypt, encrypt, onUserGone } from './db.ts'
import { caldavAccounts } from './caldav.ts'
import { davAuthority, assertDavLogin, type DavAuthority, davRefused, davRequest, davXml, escapeXml, found, hrefIn, normalizeDavUrl, prop, resolveHref, responses, unescapeXml, type DavLogin } from './dav.ts'
import { guardedFetch, readCapped, rethrowEgress } from './egress.ts'
import { HttpError } from './http.ts'
import { printCard, splitCards, type Card } from './vcard.ts'

// CardDAV address books (Fastmail, Nextcloud, iCloud, Radicale...) for the Contacts app, next to
// the address book kept on this site (server/contacts.ts). An account is a server URL, a username
// and an app password (stored encrypted, like CalDAV's in server/caldav.ts). Address books are
// found the standard way (principal → addressbook-home-set → address books). Cards are listed by
// their ETags and only the changed ones fetched again (addressbook-multiget), and a change is
// written back with the ETag it was read with, so an edit made elsewhere meanwhile is never
// overwritten (412 → "it changed somewhere else").

export type CarddavInfo = { id: number; label: string; url: string; username: string }
type Account = CarddavInfo & DavLogin
export type AddressBook = { id: string; account: number; href: string; name: string; writable: boolean }
/** One card on the server: where it lives, its ETag, and its lines. */
export type DavCard = { href: string; etag: string; card: Card }

export const FASTMAIL_URL = 'https://carddav.fastmail.com/dav/'

// ---------------------------------------------------------------------------------------------
// Accounts

const versions = new Map<number, number>()
const changes = new Set<(id: number) => void>()
export const carddavLinkVersion = (user: User) => versions.get(user.id) ?? 0
function linkAuthority(user: User): DavAuthority {
  const generation = carddavLinkVersion(user)
  return {
    key: `carddav:${user.id}:${generation}`,
    check() { if (carddavLinkVersion(user) !== generation) throw new HttpError(409, 'CardDAV was reconnected or disconnected meanwhile: try again') },
    subscribe(end) {
      const changed = (id: number) => { if (id === user.id) end() }
      changes.add(changed)
      return () => { changes.delete(changed) }
    },
  }
}
export function bindCarddavRequest(user: User) {
  requirePrivateRequest(user)
  const a = linkAuthority(user)
  bindPrivateAccess(a.check, a.subscribe, a.key)
}
function changedLink(user: User | number) {
  const id = typeof user === 'number' ? user : user.id
  versions.set(id, (versions.get(id) ?? 0) + 1)
  clearCarddavCache(id)
  for (const changed of changes) changed(id)
}
// Credentials never appear in an AddressBook's enumerable/public representation.
const bookAccounts = new WeakMap<AddressBook, Account>()

let ready = false
/** The accounts table, made on first use (this module's own; it goes with the user's account). */
function db() {
  const d = database()
  if (!ready) {
    d.exec(`CREATE TABLE IF NOT EXISTS carddav (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      base_url TEXT NOT NULL,
      username TEXT NOT NULL,
      password TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`)
    ready = true
  }
  return d
}

type Row = { id: number; label: string; base_url: string; username: string; password: string }

export function listCarddav(user: User): CarddavInfo[] {
  const rows = db().prepare('SELECT id, label, base_url, username FROM carddav WHERE user_id = ? ORDER BY id').all(user.id) as unknown as Row[]
  return rows.map((r) => ({ id: r.id, label: r.label, url: r.base_url, username: r.username }))
}

function accounts(user: User): Account[] {
  const rows = db().prepare('SELECT id, label, base_url, username, password FROM carddav WHERE user_id = ? ORDER BY id').all(user.id) as unknown as Row[]
  return rows.map((r) => ({ id: r.id, label: r.label, url: r.base_url, username: r.username, password: decrypt(r.password), user, authority: davAuthority(user, 'carddav', r, linkAuthority(user)) }))
}

/** The CardDAV address for a provider's CalDAV one: Fastmail and iCloud use other hosts, the rest (Nextcloud, Radicale, Baïkal) the same URL. */
export function carddavUrlFor(caldavUrl: string): string {
  const u = new URL(caldavUrl)
  if (/(^|\.)caldav\.fastmail\.com$/i.test(u.hostname)) return FASTMAIL_URL
  if (/(^|\.)caldav\.icloud\.com$/i.test(u.hostname) || /^p\d+-caldav\.icloud\.com$/i.test(u.hostname)) return 'https://contacts.icloud.com/'
  return u.href
}

/**
 * CalDAV accounts whose login could be used for contacts too (Settings offers "Use your Fastmail
 * login"), without the ones already linked here. Only the label, address and username: the
 * password never leaves the server.
 */
export function reusableLogins(user: User): { caldav: number; label: string; url: string; username: string }[] {
  const linked = new Set(listCarddav(user).map((a) => `${a.url}|${a.username}`))
  const rows = database().prepare('SELECT id, label, base_url, username FROM caldav WHERE user_id = ? ORDER BY id').all(user.id) as unknown as Row[]
  return rows.map((r) => ({ caldav: r.id, label: r.label, url: carddavUrlFor(r.base_url), username: r.username })).filter((r) => !linked.has(`${r.url}|${r.username}`))
}

/**
 * Finds the account's address books (proving the URL and password work), then stores it. With
 * `caldav`, the username and app password of that CalDAV account of the user's are used.
 */
async function addCarddavOperation(user: User, body: { url?: string; username?: string; password?: string; label?: string; caldav?: number }): Promise<CarddavInfo> {
  requirePrivateRequest(user)
  const epoch = linkAuthority(user)
  const source = body.caldav === undefined ? undefined : caldavAccounts(user).find((a) => a.id === Number(body.caldav))
  let url: string
  let username: string | undefined
  let password: string | undefined
  if (body.caldav !== undefined) {
    if (!source) throw new HttpError(404, 'That calendar account is not linked')
    url = normalizeDavUrl(body.url || carddavUrlFor(source.url))
    username = source.username
    password = source.password
  } else {
    url = normalizeDavUrl(body.url || FASTMAIL_URL)
    username = body.username?.trim()
    password = body.password?.trim()
  }
  if (!username || !password) throw new HttpError(400, 'Username and app password are required')
  const authority = davAuthority(user, 'carddav', undefined, epoch)
  const account: Account = { id: 0, label: '', url, username, password, user, authority: { ...authority, check() { authority.check(); source?.authority.check() }, subscribe(end) { const off = authority.subscribe(end), sourceOff = source?.authority.subscribe(end); return () => { off(); sourceOff?.() } } } }
  const books = await discover(account).catch((e: Error) => {
    if (body.caldav !== undefined && /refused/.test(e.message)) throw new HttpError(400, `${e.message}. That app password may only be for calendars: make one that can read contacts too.`)
    throw new HttpError(400, e.message)
  })
  if (!books.length) throw new HttpError(400, 'Signed in, but found no address books there')
  const host = new URL(url).hostname
  const label = (body.label?.trim() || (host.includes('fastmail') ? 'Fastmail' : host.includes('icloud') ? 'iCloud' : host)).slice(0, 40)
  // The same account again (a new app password, read-write this time): keep it, and its books' ids.
  assertDavLogin(account)
  const existing = db().prepare('SELECT id FROM carddav WHERE user_id = ? AND base_url = ? AND username = ?').get(user.id, url, username) as { id: number } | undefined
  if (existing) {
    db().prepare('UPDATE carddav SET label = ?, password = ? WHERE id = ?').run(label, encrypt(password), existing.id)
    changedLink(user)
    return { id: existing.id, label, url, username }
  }
  const r = db().prepare('INSERT INTO carddav (user_id, label, base_url, username, password, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(user.id, label, url, username, encrypt(password), Date.now())
  changedLink(user)
  return { id: Number(r.lastInsertRowid), label, url, username }
}

export function removeCarddav(user: User, id: number) {
  requirePrivateRequest(user)
  changedLink(user)
  db().prepare('DELETE FROM carddav WHERE user_id = ? AND id = ?').run(user.id, id)
  clearCarddavCache(user)
}

// ---------------------------------------------------------------------------------------------
// Discovery

const NS = 'xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav"'

async function discover(account: Account): Promise<{ href: string; name: string; writable: boolean }[]> {
  // The principal, from the URL given or from /.well-known/carddav.
  let principal: string | null = null
  for (const start of [account.url, new URL('/.well-known/carddav', account.url).href]) {
    const xml = await davXml(account, 'PROPFIND', start, '0', `<d:propfind ${NS}><d:prop><d:current-user-principal/></d:prop></d:propfind>`).catch((e: Error) => {
      if (/refused/.test(e.message)) throw e
      rethrowEgress(e)
      return null
    })
    const href = xml && hrefIn(xml, 'current-user-principal')
    if (href) {
      principal = resolveHref(start, href)
      break
    }
  }
  if (!principal) throw new Error('No CardDAV account found at that URL')
  const homeXml = await davXml(account, 'PROPFIND', principal, '0', `<d:propfind ${NS}><d:prop><card:addressbook-home-set/></d:prop></d:propfind>`)
  const homeHref = hrefIn(homeXml, 'addressbook-home-set')
  if (!homeHref) throw new Error('That account has no address books')
  const home = resolveHref(principal, homeHref)
  const list = await davXml(account, 'PROPFIND', home, '1', `<d:propfind ${NS}><d:prop><d:resourcetype/><d:displayname/><d:current-user-privilege-set/></d:prop></d:propfind>`)
  return responses(list)
    .filter((r) => /<(?:[\w-]+:)?addressbook\b/.test(prop(r.body, 'resourcetype') ?? ''))
    .map((r) => {
      // Servers that don't say are assumed writable; a refusal still shows when saving.
      const privileges = found(r.body, 'current-user-privilege-set') ? prop(r.body, 'current-user-privilege-set') : null
      return {
        href: resolveHref(home, r.href),
        name: unescapeXml(prop(r.body, 'displayname')?.trim() || decodeURIComponent(r.href.split('/').filter(Boolean).pop() ?? 'Contacts')),
        writable: !privileges || /<(?:[\w-]+:)?(?:write|write-content|all)\b/.test(privileges),
      }
    })
}

// ---------------------------------------------------------------------------------------------
// Caches: the address books of each account (ten minutes), and each book's cards by their ETags.

const bookCache = new Map<string, { at: number; value: Promise<unknown> }>()
type CardSet = { at: number; cards: Map<string, DavCard>; syncing: Promise<void> | null }
const cardCache = new Map<string, CardSet>()

function cached<T>(key: string, ms: number, load: () => Promise<T>): Promise<T> {
  const hit = bookCache.get(key)
  if (hit && Date.now() - hit.at < ms && canUsePrivateCache(hit.value)) return hit.value as Promise<T>
  const value = ownPrivateCache(load())
  bookCache.set(key, { at: Date.now(), value })
  value.catch(() => { if (bookCache.get(key)?.value === value) bookCache.delete(key) })
  return value
}

export const clearCarddavCache = (user: User | number) => {
  const id = typeof user === 'number' ? user : user.id
  for (const k of bookCache.keys()) if (k.startsWith(`${id}|`)) bookCache.delete(k)
  for (const k of cardCache.keys()) if (k.startsWith(`${id}|`)) cardCache.delete(k)
}

onUserGone((id) => changedLink(id))

// Cards of address books nobody looked at for half an hour are let go (photos make them big).
setInterval(() => {
  for (const [k, v] of cardCache) if (Date.now() - v.at > 30 * 60_000 && !v.syncing) cardCache.delete(k)
}, 5 * 60_000).unref()

/** Every address book of every CardDAV account (ids are "dav:<account>:<href>"), and what went wrong per account. */
async function carddavBooksOperation(user: User): Promise<{ books: AddressBook[]; errors: string[] }> {
  bindCarddavRequest(user)
  const errors: string[] = []
  const lists = await Promise.all(
    accounts(user).map((a) =>
      cached(`${user.id}|books|${a.authority.key}`, 10 * 60_000, () => discover(a))
        .then((books) => {
          assertDavLogin(a)
          return books.map((b) => {
            const book = { id: `dav:${a.id}:${b.href}`, account: a.id, href: b.href, name: b.name, writable: b.writable }
            bookAccounts.set(book, a)
            return book
          })
        })
        .catch((e: Error) => (errors.push(`${a.label}: ${e.message}`), [] as AddressBook[])),
    ),
  )
  return { books: lists.flat(), errors }
}

function loginFor(user: User, book: AddressBook): Account {
  const account = bookAccounts.get(book)
  if (!account || account.user.id !== user.id) throw new HttpError(404, 'That address book is not connected')
  assertDavLogin(account)
  return account
}

const isCard = (book: AddressBook, href: string) => href !== book.href && !href.endsWith('/')

/**
 * The book's cards, up to date within `maxAge`: the ETags are listed, and only cards that are new
 * or changed are fetched (in batches, with addressbook-multiget).
 */
async function bookCardsOperation(user: User, book: AddressBook, maxAge = 60_000): Promise<DavCard[]> {
  const key = `${user.id}|cards|${loginFor(user, book).authority.key}|${book.id}`
  let set = cardCache.get(key)
  if (set?.syncing && !canUsePrivateCache(set.syncing)) set = undefined
  if (!set) cardCache.set(key, (set = { at: 0, cards: new Map(), syncing: null }))
  const s = set
  if (Date.now() - s.at > maxAge && !s.syncing) {
    s.syncing = ownPrivateCache(sync(loginFor(user, book), book, s.cards)
      .then(() => void (s.at = Date.now()))
      .finally(() => (s.syncing = null)))
  }
  if (s.syncing) await s.syncing
  return [...s.cards.values()]
}

async function sync(login: DavLogin, book: AddressBook, cards: Map<string, DavCard>) {
  const xml = await davXml(login, 'PROPFIND', book.href, '1', `<d:propfind ${NS}><d:prop><d:getetag/><d:resourcetype/></d:prop></d:propfind>`)
  const now = new Map<string, string>()
  for (const r of responses(xml)) {
    const href = resolveHref(book.href, r.href)
    if (!isCard(book, href) || /<(?:[\w-]+:)?collection\b/.test(prop(r.body, 'resourcetype') ?? '')) continue
    now.set(href, unescapeXml(prop(r.body, 'getetag')?.trim() ?? ''))
  }
  for (const href of cards.keys()) if (!now.has(href)) cards.delete(href)
  const wanted = [...now].filter(([href, etag]) => !etag || cards.get(href)?.etag !== etag).map(([href]) => href)
  for (let i = 0; i < wanted.length; i += 100) {
    const batch = wanted.slice(i, i + 100)
    const hrefs = batch.map((h) => `<d:href>${escapeXml(new URL(h).pathname)}</d:href>`).join('')
    const got = await davXml(login, 'REPORT', book.href, '1', `<card:addressbook-multiget ${NS}><d:prop><d:getetag/><card:address-data/></d:prop>${hrefs}</card:addressbook-multiget>`)
    for (const r of responses(got)) {
      const href = resolveHref(book.href, r.href)
      const data = prop(r.body, 'address-data')
      const card = data ? splitCards(unescapeXml(data))[0] : undefined
      if (card) cards.set(href, { href, etag: unescapeXml(prop(r.body, 'getetag')?.trim() ?? '') || now.get(href) || '', card })
    }
  }
}

/** A card's address, only if it is inside that book (ids come back from the browser). */
export function cardUrl(book: AddressBook, name: string): string {
  if (!name || name.includes('/') || name === '.' || name === '..') throw new HttpError(400, 'That contact is not in that address book')
  const base = new URL(book.href.endsWith('/') ? book.href : `${book.href}/`)
  const url = new URL(name, base)
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) throw new HttpError(400, 'That contact is not in that address book')
  return url.href
}

/** One card as it is on the server now, with its ETag (and the cache told). */
async function getCardOperation(user: User, book: AddressBook, url: string): Promise<DavCard> {
  const res = await davRequest(loginFor(user, book), 'GET', url, { headers: { Accept: 'text/vcard' } })
  if (!res.ok) davRefused(res, url, 'contact')
  const card = splitCards((await readCapped(res, 8 * 1024 * 1024)).toString('utf8'))[0]
  if (!card) throw new HttpError(502, 'That contact could not be read')
  const got = { href: url, etag: res.headers.get('etag') ?? '', card }
  cardCache.get(`${user.id}|cards|${loginFor(user, book).authority.key}|${book.id}`)?.cards.set(url, got)
  return got
}

/** Writes a card: with the `etag` it must still have, or 'new' for one that must not exist yet. Answers it as stored. */
async function putCardOperation(user: User, book: AddressBook, url: string, card: Card, etag: string | 'new'): Promise<DavCard> {
  const headers: Record<string, string> = { 'Content-Type': 'text/vcard; charset=utf-8' }
  if (etag === 'new') headers['If-None-Match'] = '*'
  else if (etag) headers['If-Match'] = etag
  const res = await davRequest(loginFor(user, book), 'PUT', url, { headers, body: printCard(card) })
  if (!res.ok) davRefused(res, url, 'contact')
  await res.body?.cancel().catch(() => {})
  // Servers that change what they store (Fastmail, iCloud) send no ETag back: read it again.
  const newEtag = res.headers.get('etag')
  if (!newEtag || /^W\//.test(newEtag)) return getCard(user, book, url)
  const stored = { href: url, etag: newEtag, card }
  cardCache.get(`${user.id}|cards|${loginFor(user, book).authority.key}|${book.id}`)?.cards.set(url, stored)
  return stored
}

async function deleteCardOperation(user: User, book: AddressBook, url: string, etag?: string) {
  const res = await davRequest(loginFor(user, book), 'DELETE', url, { headers: etag ? { 'If-Match': etag } : {} })
  if (!res.ok && res.status !== 404) davRefused(res, url, 'contact')
  await res.body?.cancel().catch(() => {})
  cardCache.get(`${user.id}|cards|${loginFor(user, book).authority.key}|${book.id}`)?.cards.delete(url)
}

/** A PHOTO given as an address on the account's own server: fetched with its login. */
async function fetchPhotoOperation(user: User, book: AddressBook, uri: string): Promise<{ type: string; bytes: Buffer }> {
  const account = loginFor(user, book)
  // The login only goes to the account's own server; a photo elsewhere is fetched without it.
  const res =
    new URL(uri).origin === new URL(book.href).origin
      ? await davRequest(account, 'GET', uri)
      : await withProviderGuard(account.authority.check, () => guardedFetch(user, uri, { headers: { 'User-Agent': 'mvlos' }, signal: AbortSignal.timeout(15_000) })).catch((e) => (rethrowEgress(e), null))
  if (!res?.ok) throw new HttpError(404, 'No photo')
  const bytes = await readCapped(res, 5 * 1024 * 1024)
  assertDavLogin(account)
  return { type: res.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? 'image/jpeg', bytes }
}

export const addCarddav = (...args: Parameters<typeof addCarddavOperation>) => withPrivateOperation(() => addCarddavOperation(...args))

export const carddavBooks = (...args: Parameters<typeof carddavBooksOperation>) => withPrivateOperation(() => carddavBooksOperation(...args))

export const bookCards = (...args: Parameters<typeof bookCardsOperation>) => withPrivateOperation(() => bookCardsOperation(...args))

export const getCard = (...args: Parameters<typeof getCardOperation>) => withPrivateOperation(() => getCardOperation(...args))

export const putCard = (...args: Parameters<typeof putCardOperation>) => withPrivateOperation(() => putCardOperation(...args))

export const deleteCard = (...args: Parameters<typeof deleteCardOperation>) => withPrivateOperation(() => deleteCardOperation(...args))

export const fetchPhoto = (...args: Parameters<typeof fetchPhotoOperation>) => withPrivateOperation(() => fetchPhotoOperation(...args))
