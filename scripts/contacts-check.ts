// Checks the Contacts app's server side (server/contacts.ts, server/carddav.ts, server/vcard.ts)
// against a stand-in CardDAV server, the way Fastmail, Nextcloud and Radicale answer. It starts
// the real server (server/index.ts) on a free port with a scratch DATA_DIR, a signed-in admin (the
// stand-in is on 127.0.0.1, which only admins may reach) and a second, ordinary user, then:
//
//   - links the account (a wrong password is refused; an ordinary user may not use a private address),
//   - finds the address books (principal → addressbook-home-set → books, a read-only one too),
//   - lists the cards: 3.0 and 4.0, folded lines, Apple's item groups and labels, a group card,
//     a birthday without a year, anniversaries, inline photos,
//   - edits one: only what changed is rewritten, unknown properties and labels stay, lines are
//     folded at 75 octets, it is written with If-Match, and an edit made elsewhere meanwhile stays,
//   - a 412 from the server comes back as 409 ("changed somewhere else"),
//   - creates one (If-None-Match: *), group membership in a group card, deletes one,
//   - lists again fetching only the changed cards (addressbook-multiget by ETag),
//   - the address book on this site: create, edit, import a .vcf (2.1 quoted-printable too),
//     export, move a contact to the CardDAV book,
//   - reuses a CalDAV account's login, and keeps every user's contacts to themselves.
//
//   node scripts/contacts-check.ts
//
// Exits 1 on any failure. Never touches a real account.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { Server, check, finish } from './empires-harness.ts'

// --- The stand-in CardDAV server ------------------------------------------------------------------

const USER = 'check@example.com'
const PASS = 'app-password'
const HOME = '/dav/addressbooks/user/check@example.com/'
const BOOK = `${HOME}Default/`
const SHARED = `${HOME}Shared/`

const PHOTO = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/', 'base64')

/** href → card text; the ETag is a hash of the text. */
const store = new Map<string, string>()
const etag = (text: string) => `"${createHash('md5').update(text).digest('hex').slice(0, 12)}"`

const fold = (line: string) => line.match(/.{1,70}/g)!.join('\r\n ')
const crlf = (lines: string[]) => `${lines.join('\r\n')}\r\n`

store.set(
  `${BOOK}jane.vcf`,
  crlf([
    'BEGIN:VCARD',
    'VERSION:3.0',
    'PRODID:-//Apple Inc.//iOS 17//EN',
    'UID:jane-uid',
    'N:Doe;Jane;;;',
    'FN:Jane Doe',
    'ORG:Acme;Research',
    'TITLE:Chemist',
    'item1.EMAIL;type=INTERNET;type=pref:jane@example.com',
    'item1.X-ABLabel:_$!<Other>!$_',
    'EMAIL;TYPE=INTERNET,WORK:jane.doe@acme.example',
    'TEL;TYPE=CELL,VOICE:+31 6 12345678',
    'item2.TEL:+31 20 555 0000',
    'item2.X-ABLabel:Boat',
    fold('NOTE:This note is long enough that the server folded it over more than one line\\, with an escaped comma and a newline\\nhere.'),
    'X-SOCIALPROFILE;type=mastodon:https://social.example/@jane',
    'X-UNKNOWN-THING;X-PARAM=keep:keep me exactly',
    'BDAY;X-APPLE-OMIT-YEAR=1604:1604-03-04',
    'item3.X-ABDATE:2015-06-07',
    'item3.X-ABLabel:_$!<Anniversary>!$_',
    fold(`PHOTO;ENCODING=b;TYPE=JPEG:${PHOTO.toString('base64')}`),
    'CATEGORIES:Work,Chemistry',
    'END:VCARD',
  ]),
)
store.set(
  `${BOOK}bob.vcf`,
  crlf([
    'BEGIN:VCARD',
    'VERSION:4.0',
    'UID:urn:uuid:bob-uid',
    'FN:Bob Builder',
    'N:Builder;Bob;;;',
    'EMAIL;TYPE=home;PREF=1:bob@example.com',
    'ADR;TYPE=home:;;1 Main Street;Springfield;;12345;USA',
    'BDAY:--1225',
    'ANNIVERSARY:20100506',
    `PHOTO:data:image/jpeg;base64,${PHOTO.toString('base64')}`,
    'X-VENDOR-4:still here',
    'END:VCARD',
  ]),
)
store.set(`${BOOK}friends.vcf`, crlf(['BEGIN:VCARD', 'VERSION:3.0', 'UID:friends-uid', 'FN:Friends', 'N:Friends;;;;', 'X-ADDRESSBOOKSERVER-KIND:group', 'X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:bob-uid', 'END:VCARD']))
store.set(`${SHARED}carol.vcf`, crlf(['BEGIN:VCARD', 'VERSION:3.0', 'UID:carol-uid', 'FN:Carol Shared', 'EMAIL:carol@example.com', 'END:VCARD']))

/** Requests the stand-in saw, for checking what was asked. */
const seen: { method: string; path: string; headers: IncomingMessage['headers']; body: string }[] = []
/** The next PUT answers 412, as if someone else changed the card in between. */
let fail412 = false
/** Fastmail's way: the server changes the card it stores and sends no ETag back. */
let rewriteOnPut = false

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const multistatus = (parts: string[]) => `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav" xmlns:cs="http://calendarserver.org/ns/">${parts.join('')}</d:multistatus>`
const response = (href: string, props: string, missing = '') =>
  `<d:response><d:href>${esc(href)}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>${missing ? `<d:propstat><d:prop>${missing}</d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>` : ''}</d:response>`

const dav = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  const body = Buffer.concat(chunks).toString('utf8')
  const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
  seen.push({ method: req.method ?? '', path, headers: req.headers, body })
  const auth = Buffer.from((req.headers.authorization ?? '').replace(/^Basic /, ''), 'base64').toString()
  if (auth !== `${USER}:${PASS}`) return void res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="dav"' }).end()
  const xml = (parts: string[]) => void res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' }).end(multistatus(parts))

  if (req.method === 'PROPFIND') {
    if (path === '/dav/' || path === '/.well-known/carddav') return xml([response(path, '<d:current-user-principal><d:href>/dav/principals/user/check@example.com/</d:href></d:current-user-principal>')])
    if (path === '/dav/principals/user/check@example.com/') return xml([response(path, `<card:addressbook-home-set><d:href>${HOME}</d:href></card:addressbook-home-set>`)])
    if (path === HOME)
      return xml([
        response(HOME, '<d:resourcetype><d:collection/></d:resourcetype>'),
        response(BOOK, '<d:resourcetype><d:collection/><card:addressbook/></d:resourcetype><d:displayname>Personal</d:displayname><d:current-user-privilege-set><d:privilege><d:read/></d:privilege><d:privilege><d:write/></d:privilege></d:current-user-privilege-set>'),
        response(SHARED, '<d:resourcetype><d:collection/><card:addressbook/></d:resourcetype><d:displayname>Shared with me</d:displayname><d:current-user-privilege-set><d:privilege><d:read/></d:privilege></d:current-user-privilege-set>'),
        response(`${HOME}calendar/`, '<d:resourcetype><d:collection/></d:resourcetype><d:displayname>Not a book</d:displayname>'),
      ])
    if (path === BOOK || path === SHARED)
      return xml([response(path, '<d:resourcetype><d:collection/><card:addressbook/></d:resourcetype>'), ...[...store].filter(([h]) => h.startsWith(path) && h !== path).map(([h, t]) => response(h, `<d:getetag>${esc(etag(t))}</d:getetag><d:resourcetype/>`))])
    return void res.writeHead(404).end()
  }
  if (req.method === 'REPORT' && /addressbook-multiget/.test(body)) {
    const hrefs = [...body.matchAll(/<d:href>([^<]*)<\/d:href>/g)].map((m) => decodeURIComponent(m[1]))
    return xml(hrefs.map((h) => (store.has(h) ? response(h, `<d:getetag>${esc(etag(store.get(h)!))}</d:getetag><card:address-data>${esc(store.get(h)!)}</card:address-data>`) : `<d:response><d:href>${esc(h)}</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>`)))
  }
  if (req.method === 'GET') {
    const text = store.get(path)
    if (!text) return void res.writeHead(404).end()
    return void res.writeHead(200, { 'Content-Type': 'text/vcard; charset=utf-8', ETag: etag(text) }).end(text)
  }
  if (req.method === 'PUT') {
    if (path.startsWith(SHARED)) return void res.writeHead(403).end()
    const had = store.get(path)
    const ifMatch = req.headers['if-match']
    if (fail412 || (req.headers['if-none-match'] === '*' && had) || (ifMatch && (!had || ifMatch !== etag(had)))) {
      fail412 = false
      return void res.writeHead(412).end()
    }
    const text = rewriteOnPut ? body.replace('END:VCARD', 'X-SERVER-ADDED:yes\r\nEND:VCARD') : body
    store.set(path, text)
    return void res.writeHead(had ? 204 : 201, rewriteOnPut ? {} : { ETag: etag(text) }).end()
  }
  if (req.method === 'DELETE') {
    const had = store.get(path)
    if (!had) return void res.writeHead(404).end()
    if (req.headers['if-match'] && req.headers['if-match'] !== etag(had)) return void res.writeHead(412).end()
    store.delete(path)
    return void res.writeHead(204).end()
  }
  res.writeHead(405).end()
})
await new Promise<void>((r) => dav.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${(dav.address() as { port: number }).port}`

// --- The site, with a signed-in admin and an ordinary user ------------------------------------------

const ADMIN = 'contacts-check'
const server = new Server({ GITHUB_CLIENT_ID: 'x', GITHUB_CLIENT_SECRET: 'x', ADMIN_USERS: ADMIN })
process.env.DATA_DIR = server.data
const { database, encrypt, sha256 } = await import('../server/db.ts')
const now = Date.now()
const sids = [randomBytes(24).toString('hex'), randomBytes(24).toString('hex')]
database().prepare('INSERT INTO users (id, github_id, login, github_token, created_at, updated_at) VALUES (1, 1, ?, ?, ?, ?), (2, 2, ?, ?, ?, ?)').run(ADMIN, encrypt('none'), now, now, 'someone-else', encrypt('none'), now, now)
for (const [i, sid] of sids.entries()) database().prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(sid), i + 1, now, now + 86400_000)
// A CalDAV account on the same server, whose login Settings offers to use for contacts too.
database().prepare('INSERT INTO caldav (user_id, label, base_url, username, password, created_at) VALUES (1, ?, ?, ?, ?, ?)').run('Stand-in', `${base}/dav/`, USER, encrypt(PASS), now)
await server.start()

type Contact = Record<string, any> & { id: string; book: string; uid: string; etag: string; fn: string }
const call = async (path: string, init: { method?: string; body?: unknown; as?: 0 | 1 } = {}) => {
  const res = await fetch(`${server.origin}${path}`, {
    method: init.method ?? 'GET',
    headers: { Cookie: `mvlos_sid=${sids[init.as ?? 0]}`, Origin: server.origin, ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  })
  const text = await res.text()
  let json: any = null
  try {
    json = JSON.parse(text)
  } catch {
    /* a .vcf or a photo */
  }
  return { status: res.status, json, text, type: res.headers.get('content-type') }
}
const list = async (fresh = false, as: 0 | 1 = 0) => (await call(`/api/contacts${fresh ? '?fresh=1' : ''}`, { as })).json as { books: any[]; contacts: Contact[]; groups: any[]; errors: string[] }
const fieldsOf = (c: Contact) => {
  const { id, book, uid, etag, groups, photo, ...fields } = c
  return fields
}

try {
  // --- Linking ---
  let r = await call('/api/contacts/accounts', { method: 'POST', body: { url: `${base}/dav/`, username: USER, password: 'wrong' } })
  check('a wrong app password is refused', r.status === 400 && /refused/.test(r.json?.error))
  r = await call('/api/contacts/accounts', { method: 'POST', body: { url: `${base}/dav/`, username: USER, password: PASS }, as: 1 })
  check('an ordinary user may not link a private address', r.status === 400 && /not a public address/.test(r.json?.error))
  r = await call('/api/contacts/accounts')
  check('the CalDAV login on the same server is offered for contacts', r.json?.reusable?.length === 1 && r.json.reusable[0].username === USER && !JSON.stringify(r.json).includes(PASS))
  r = await call('/api/contacts/accounts', { method: 'POST', body: { caldav: r.json.reusable[0].caldav, label: 'Stand-in' } })
  check('linking with the CalDAV login finds the address books', r.status === 200 && r.json?.id > 0)
  const accountId = r.json.id
  r = await call('/api/contacts/accounts')
  check('a linked login is no longer offered', r.json?.accounts?.length === 1 && r.json.reusable.length === 0)

  // --- Discovery and listing ---
  let all = await list()
  const personal = all.books.find((b) => b.name === 'Personal')
  const shared = all.books.find((b) => b.name === 'Shared with me')
  check('books: this site, Personal and Shared (not the calendar)', all.books.length === 3 && all.books[0].id === 'local' && !!personal && !!shared)
  check('the read-only book says so', personal?.writable === true && shared?.writable === false)
  check('discovery went principal → home → books', seen.some((s) => s.method === 'PROPFIND' && s.path === '/dav/principals/user/check@example.com/') && seen.some((s) => s.method === 'PROPFIND' && s.path === HOME))
  check('every contact is listed, the group card as a group', all.contacts.length === 3 && all.groups.length === 1 && all.groups[0].name === 'Friends')
  const jane = all.contacts.find((c) => c.uid === 'jane-uid')!
  const bob = all.contacts.find((c) => c.uid === 'bob-uid')!
  check('3.0: name, organisation and title', jane.fn === 'Jane Doe' && jane.n.given === 'Jane' && jane.org === 'Acme' && jane.department === 'Research' && jane.title === 'Chemist')
  check('3.0: Apple labels and TYPEs', jane.emails[0].value === 'jane@example.com' && jane.emails[0].type === 'other' && jane.emails[0].pref === true && jane.emails[1].type === 'work' && jane.phones[0].type === 'mobile' && jane.phones[1].type === 'Boat')
  check('3.0: a folded note with escapes', jane.note === 'This note is long enough that the server folded it over more than one line, with an escaped comma and a newline\nhere.')
  check('3.0: a birthday without a year (Apple 1604) and an Apple anniversary', jane.birthday === '--03-04' && jane.anniversaries[0]?.label === 'anniversary' && jane.anniversaries[0]?.date === '2015-06-07')
  check('3.0: categories', JSON.stringify(jane.categories) === '["Work","Chemistry"]')
  check('4.0: email with PREF, address, --MMDD birthday, ANNIVERSARY', bob.emails[0].pref === true && bob.addresses[0].locality === 'Springfield' && bob.birthday === '--12-25' && bob.anniversaries[0]?.date === '2010-05-06')
  check('group card membership', JSON.stringify(bob.groups) === '["Friends"]' && jane.groups.length === 0)
  for (const c of [jane, bob]) {
    const p = await call(c.photo!)
    check(`photo of ${c.fn} (${c.uid === 'bob-uid' ? '4.0 data: URI' : '3.0 ENCODING=b'})`, p.status === 200 && p.type === 'image/jpeg')
  }

  // --- Editing ---
  seen.length = 0
  const before = etag(store.get(`${BOOK}jane.vcf`)!)
  const edited = { ...fieldsOf(jane), title: 'Head chemist', phones: [jane.phones[1], { value: '+31 6 99999999', type: 'mobile' }] }
  r = await call('/api/contacts/card', { method: 'PATCH', body: { id: jane.id, base: fieldsOf(jane), fields: edited } })
  const put = seen.find((s) => s.method === 'PUT')
  const text = store.get(`${BOOK}jane.vcf`)!
  check('the edit is written with If-Match', r.status === 200 && put?.headers['if-match'] === before)
  check('unknown properties stay exactly', text.includes('X-UNKNOWN-THING;X-PARAM=keep:keep me exactly') && text.includes('X-SOCIALPROFILE;type=mastodon:https://social.example/@jane') && text.includes('PRODID:-//Apple Inc.//iOS 17//EN'))
  check('an unchanged labelled phone keeps its item group and label', /item2\.TEL:\+31 20 555 0000\r\nitem2\.X-ABLabel:Boat/.test(text))
  check('the removed phone is gone, the new one is there', !text.includes('+31 6 12345678') && /TEL;TYPE=CELL,VOICE:\+31 6 99999999/.test(text))
  check('unchanged fields are not rewritten (the email lines, the photo)', text.includes('item1.EMAIL;type=INTERNET;type=pref:jane@example.com') && text.includes('PHOTO;ENCODING=b;TYPE=JPEG:'))
  check('lines are folded at 75 octets with CRLF', text.split('\r\n').every((l) => Buffer.byteLength(l) <= 75) && !/[^\r]\n/.test(text))
  check('the answer is the contact as stored', r.json?.title === 'Head chemist' && r.json.etag === etag(text))

  // Someone else changes the note meanwhile; an edit from an older copy keeps their note.
  store.set(`${BOOK}jane.vcf`, text.replace(/NOTE:[^\r]*(\r\n [^\r]*)*/, 'NOTE:Changed on the phone'))
  r = await call('/api/contacts/card', { method: 'PATCH', body: { id: jane.id, base: fieldsOf(jane), fields: { ...fieldsOf(jane), nickname: 'JD' } } })
  check('an edit from an older copy keeps what was changed elsewhere', r.status === 200 && r.json?.note === 'Changed on the phone' && r.json.nickname === 'JD' && r.json.title === 'Head chemist')

  fail412 = true
  r = await call('/api/contacts/card', { method: 'PATCH', body: { id: jane.id, base: fieldsOf(jane), fields: { ...fieldsOf(jane), title: 'Lost' } } })
  check('a 412 from the server is a 409 "changed somewhere else"', r.status === 409 && /changed somewhere else/.test(r.json?.error))

  r = await call('/api/contacts/card', { method: 'PATCH', body: { id: all.contacts.find((c) => c.uid === 'carol-uid')!.id, base: {}, fields: { fn: 'Nope' } } })
  check('a read-only book refuses edits', r.status === 403)

  // --- Creating, groups, Fastmail's rewriting, deleting ---
  seen.length = 0
  rewriteOnPut = true
  r = await call('/api/contacts/card', { method: 'POST', body: { book: personal.id, fields: { fn: 'Dana New', emails: [{ value: 'dana@example.com', type: 'Gym' }], birthday: '1990-02-03' }, groups: ['Friends'] } })
  rewriteOnPut = false
  const dana = r.json as Contact
  const created = seen.find((s) => s.method === 'PUT' && s.path.includes(dana?.uid ?? '?'))
  check('a new card is put with If-None-Match: *', r.status === 200 && created?.headers['if-none-match'] === '*')
  check('a new card is vCard 3.0 with its UID, FN, N, and a custom label', !!created && /VERSION:3\.0/.test(created.body) && created.body.includes(`UID:${dana.uid}`) && /\r\nFN:Dana New\r\n/.test(created.body) && /\r\nN:;;;;\r\n/.test(created.body) && /item1\.EMAIL;TYPE=INTERNET:dana@example\.com\r\nitem1\.X-ABLabel:Gym/.test(created.body))
  check('a server that rewrites the card (no ETag back) is read again', dana.etag === etag(store.get(`${BOOK}${dana.uid}.vcf`)!) && store.get(`${BOOK}${dana.uid}.vcf`)!.includes('X-SERVER-ADDED:yes'))
  check('the group card gained the new member', store.get(`${BOOK}friends.vcf`)!.includes(`X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:${dana.uid}`) && JSON.stringify(dana.groups) === '["Friends"]')
  r = await call('/api/contacts/card', { method: 'PATCH', body: { id: dana.id, base: fieldsOf(dana), fields: fieldsOf(dana), groups: [] } })
  check('leaving the group takes the member off the group card', r.status === 200 && !store.get(`${BOOK}friends.vcf`)!.includes(dana.uid) && store.get(`${BOOK}friends.vcf`)!.includes('urn:uuid:bob-uid'))

  // --- Listing again fetches only what changed ---
  seen.length = 0
  all = await list(true)
  const multiget = seen.filter((s) => s.method === 'REPORT')
  const asked = multiget.flatMap((s) => [...s.body.matchAll(/<d:href>([^<]*)<\/d:href>/g)].map((m) => m[1]))
  check('a fresh listing asks only for changed cards', asked.length === 0 && seen.some((s) => s.method === 'PROPFIND' && s.path === BOOK))
  store.set(`${BOOK}bob.vcf`, store.get(`${BOOK}bob.vcf`)!.replace('FN:Bob Builder', 'FN:Robert Builder'))
  seen.length = 0
  all = await list(true)
  const asked2 = seen.filter((s) => s.method === 'REPORT').flatMap((s) => [...s.body.matchAll(/<d:href>([^<]*)<\/d:href>/g)].map((m) => m[1]))
  check('…and fetches a card changed elsewhere (only that one)', asked2.length === 1 && asked2[0].endsWith('bob.vcf') && all.contacts.some((c) => c.fn === 'Robert Builder'))

  seen.length = 0
  r = await call('/api/contacts/card', { method: 'DELETE', body: { id: dana.id } })
  const del = seen.find((s) => s.method === 'DELETE')
  check('deleting sends If-Match and removes the card', r.status === 200 && !!del?.headers['if-match'] && !store.has(`${BOOK}${dana.uid}.vcf`))

  // --- The address book on this site ---
  r = await call('/api/contacts/card', { method: 'POST', body: { book: 'local', fields: { fn: 'Local Larry', emails: [{ value: 'larry@example.com' }], categories: [] }, groups: ['Neighbours'] } })
  const larry = r.json as Contact
  check('a contact on this site, a group as a category', r.status === 200 && larry.book === 'local' && JSON.stringify(larry.categories) === '["Neighbours"]')
  r = await call('/api/contacts/card', { method: 'PATCH', body: { id: larry.id, base: fieldsOf(larry), fields: { ...fieldsOf(larry), phones: [{ value: '123', type: 'work' }] } } })
  check('edited on this site', r.status === 200 && r.json.phones[0].value === '123' && r.json.etag !== larry.etag)
  r = await call('/api/contacts/card', { method: 'DELETE', body: { id: larry.id, etag: larry.etag } })
  check('a stale delete on this site is refused', r.status === 409)

  const vcf = crlf([
    'BEGIN:VCARD',
    'VERSION:2.1',
    'N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:M=C3=BCller;J=',
    '=C3=B6rg;;;',
    'TEL;WORK;VOICE:+49 30 1234',
    'X-OLD-PHONE:keep',
    'END:VCARD',
    'BEGIN:VCARD',
    'VERSION:4.0',
    'FN:Without Uid',
    'EMAIL:nouid@example.com',
    'END:VCARD',
  ])
  r = await call('/api/contacts/import', { method: 'POST', body: { book: 'local', text: vcf } })
  check('import: two added', r.status === 200 && r.json.added === 2 && r.json.failed.length === 0)
  all = await list()
  const jorg = all.contacts.find((c) => c.n?.family === 'Müller')
  check('import: 2.1 quoted-printable in UTF-8, bare TYPEs', jorg?.fn === 'Jörg Müller' && jorg.phones[0].type === 'work')
  check('import: a card without UID got one', all.contacts.some((c) => c.fn === 'Without Uid' && c.uid.length > 10))
  r = await call('/api/contacts/import', { method: 'POST', body: { book: 'local', text: vcf.replace('X-OLD-PHONE:keep', `UID:${jorg!.uid}\r\nX-OLD-PHONE:again`) } })
  check('import again: the same UID replaces the card', r.json?.updated === 1 && r.json.added === 1)
  r = await call('/api/contacts/export?book=local')
  check('export: a .vcf with every card of the book, unknown properties kept', r.status === 200 && /text\/vcard/.test(r.type ?? '') && (r.text.match(/BEGIN:VCARD/g) ?? []).length === 4 && r.text.includes('X-OLD-PHONE:again'))
  r = await call(`/api/contacts/export?ids=${encodeURIComponent(jane.id)}`)
  check('export: one CardDAV contact as stored', (r.text.match(/BEGIN:VCARD/g) ?? []).length === 1 && r.text.includes('X-UNKNOWN-THING'))

  r = await call('/api/contacts/move', { method: 'POST', body: { id: larry.id, book: personal.id } })
  check('move: from this site to the CardDAV book', r.status === 200 && r.json.book === personal.id && store.has(`${BOOK}${larry.uid}.vcf`) && !(await list()).contacts.some((c) => c.id === larry.id))

  // --- Every user's own ---
  const other = await list(false, 1)
  check("another user sees only this site's empty book", other.books.length === 1 && other.contacts.length === 0)
  r = await call(jane.photo!, { as: 1 })
  check("another user can't load the photo", r.status === 404)
  r = await call('/api/contacts/card', { method: 'PATCH', body: { id: jane.id, base: {}, fields: { fn: 'x' } }, as: 1 })
  check("another user can't edit the contact", r.status === 404)

  r = await call(`/api/contacts/accounts/${accountId}`, { method: 'DELETE' })
  all = await list()
  check('removing the account removes its books', r.status === 200 && all.books.length === 1)
} catch (e) {
  check(`no exception (${(e as Error).stack})`, false)
} finally {
  await server.dispose()
  dav.close()
}
finish()
