import { NOTE_STATE_KEY, NOTE_PENDING_PREFIX, hasNoteProjection, readNoteProjection, parseNoteMeta } from './notePersistence'
import { storageTransaction, WIDGET_STORAGE_KEY, WIDGET_JOURNAL_PREFIX } from './storageTransaction'
// Whose browser storage this tab uses, and the guard that keeps one account's state out of
// another's.
//
// Tabs of one browser share its storage and its sign-in cookie, so one tab can still hold account
// A's state while another tab signs out or in as B. The server sets a readable cookie next to the
// sign-in cookie, `mvlos_uid` (the account's id; none for a visitor; server/auth.ts), so a page
// knows at once, and in step with the sign-in cookie, which account the browser is signed in as.
//
// - Each tab takes that account as its own when it loads (TAB_UID), and keeps everything that
//   belongs to the account under a space of its own in localStorage: `mvlos.u.<id>.…`, or
//   `mvlos.visitor.…` (accountKey). A tab of A's only ever reads and writes A's space, which B's
//   pages never read.
// - accountGuard() checks the cookie still says this tab's account before every write to the
//   space and every request to the site's API (installApiGuard). When it doesn't, the tab freezes
//   (writes and sends nothing more) and reloads at once, as the account the browser has now.
// - Every API request says whose state its tab holds (`X-MvL-Account`); the server refuses one
//   that doesn't match the session (server/api.ts), and requires it where state is written.
// - The first time a space is used, what the release before spaces kept for that account in plain
//   keys moves into it, if the browser's old marker says it was this account's (and that is done
//   once: later writes to the old keys, by a tab still running the old release, are never read).
//   A visitor signing in brings their synced state along, once, into a new account space.
//
// What belongs to the browser rather than to an account (the theme, motion, sound, the dock's
// look, a game's settings, the browser's own location) stays in plain keys (src/os/localPref.ts).

const UID_COOKIE = /(?:^|;\s*)mvlos_uid=([^;]*)/

/** The account the browser's cookies are signed in as now (its id), or null for none. */
export function cookieUid(): string | null {
  if (typeof document === 'undefined') return null
  const m = UID_COOKIE.exec(document.cookie)
  const v = m?.[1] ? decodeURIComponent(m[1]) : ''
  return /^\d+$/.test(v) ? v : null
}

/** This tab's account, taken as it loads (null: a visitor). */
export const TAB_UID: string | null = cookieUid()
/** The header value saying whose state this tab holds. */
export const TAB_ACCOUNT = TAB_UID ?? 'visitor'
/** Where this tab's account keeps its things in localStorage. */
export const SPACE = TAB_UID ? `mvlos.u.${TAB_UID}.` : 'mvlos.visitor.'

/** The key in this tab's account space for an account-owned key, written as before spaces (`mvlos.history`). */
export const accountKey = (key: string) => SPACE + key.replace(/^mvlos\./, '')
export const WIDGET_NOTE_CACHE_KEY = 'mvlos.widget-cache:v2:notes'
const WIDGET_LEGACY = new Set(['mvlos.sync.widgets', 'mvlos.sync.widgets:placed', 'mvlos.sync.widgets:packages:v1', 'mvlos.sync.windows:desktop', 'mvlos.sync.windows:mobile', 'mvlos.sync.notes'])
const widgetStagePrefix = (key: string, space = SPACE) => `${space}widget-stage:v1:${encodeURIComponent(key)}:`
type StageOrigin = { owner: string | null; kind: 'plain' | 'visitor'; marker: string | null; older: string | null }
function validStage(record: any, key: string, owner: string | null): record is { key: string; source: string; origin: StageOrigin } {
  const origin = record?.origin
  return record?.key === key && typeof record.source === 'string' && origin?.owner === owner &&
    (origin.kind === 'plain' || origin.kind === 'visitor') &&
    (origin.marker === null || typeof origin.marker === 'string') && (origin.older === null || typeof origin.older === 'string') &&
    (origin.kind !== 'visitor' || (origin.marker === null && origin.older === null)) &&
    (origin.kind !== 'plain' || (owner === null ? origin.marker === null && origin.older === null : origin.marker === owner || (origin.marker === null && !!origin.older)))
}
/** A pre-provenance stage can be recovered only by matching the still-explicit owner and source,
 * or by a later bound plain snapshot of those same bytes. Its original record remains untouched. */
function recoveredStage(record: any, key: string, owner: string | null, space: string, allowExplicit: boolean): boolean {
  if (!owner || record?.origin !== undefined || record?.key !== key || typeof record.source !== 'string') return false
  const prefix = widgetStagePrefix(key, space)
  for (const name of Object.keys(localStorage)) if (name.startsWith(prefix)) {
    const candidate = JSON.parse(localStorage.getItem(name) ?? 'null')
    if (validStage(candidate, key, owner) && candidate.origin.kind === 'plain' && candidate.source === record.source) return true
  }
  return allowExplicit && space === SPACE && owner === TAB_UID && cookieUid() === owner &&
    localStorage.getItem('mvlos.account') === owner && localStorage.getItem(key) === record.source
}
/** Immutable account-scoped snapshots are inputs only while the ordinary account key is absent. */
function readWidgetLegacyStage(key: string, space: string, owner: string | null): string | null {
  if (!WIDGET_LEGACY.has(key)) return null
  try {
    const prefix = widgetStagePrefix(key, space), values: string[] = []
    for (const name of Object.keys(localStorage)) if (name.startsWith(prefix)) {
      const raw = localStorage.getItem(name)
      if (raw === null) throw new Error('Widget migration snapshot unavailable; original data retained')
      const record = JSON.parse(raw)
      if (!validStage(record, key, owner) && !recoveredStage(record, key, owner, space, true)) throw new Error('Widget migration snapshot provenance unavailable; original data retained')
      values.push(record.source)
      if (values.length > 256) throw new Error('Widget migration snapshot limit reached; original data retained')
    }
    if (values.some(value => value !== values[0])) throw new Error('Conflicting widget migration snapshots; original data retained')
    return values[0] ?? null
  } catch (error) { legacyMigrationUnresolved = true; throw new Error('Widget migration snapshot unavailable; original data retained', { cause: error }) }
}
export const widgetLegacyStage = (key: string): string | null => readWidgetLegacyStage(key, SPACE, TAB_UID)
function stageWidgetLegacy(key: string, source: string, origin: StageOrigin) {
  if (new TextEncoder().encode(source).length > 1024 * 1024) throw new Error('Widget migration snapshot limit reached; original data retained')
  // Older releases wrote this receipt before their target write. A different target could be
  // either an intentional newer edit or an automatic default after that write failed.
  const oldReceipt = localStorage.getItem(`${SPACE}legacy-copy:v2:${encodeURIComponent(key)}`)
  if (oldReceipt !== null) {
    const receipt = JSON.parse(oldReceipt), target = localStorage.getItem(accountKey(key))
    if (!receipt || receipt.source !== source) throw new Error('Legacy widget copy provenance unavailable; original data retained')
    if (target !== null && target !== source && !sameSyncedValue(key, source, target)) throw new Error('Legacy widget target is ambiguous; both versions retained')
  }
  const existing = widgetLegacyStage(key)
  if (existing !== null && existing !== source) throw new Error('Conflicting widget migration snapshots; original data retained')
  // An identical visitor snapshot does not prove ownership of a later plain account source.
  const names = Object.keys(localStorage).filter(name => name.startsWith(widgetStagePrefix(key)))
  const bound = names.some(name => {
    const record = JSON.parse(localStorage.getItem(name) ?? 'null')
    return validStage(record, key, TAB_UID) && JSON.stringify(record.origin) === JSON.stringify(origin)
  })
  if (!bound) {
    if (names.length >= 256) throw new Error('Widget migration snapshot limit reached; original data retained')
    localStorage.setItem(`${widgetStagePrefix(key)}${crypto.randomUUID()}`, JSON.stringify({ key, source, origin }))
  }
}
// A logout cleanup invalidates other still-open tabs even before their cookie-change event runs.
const REVOCATION_KEY = `${SPACE}revocation:v1`
const revocation = () => { try { return localStorage.getItem(REVOCATION_KEY) } catch { return null } }
export const TAB_REVOCATION = revocation()

let frozen = false
// Older-owner import must finish its origin-wide claim before account state can be used.
let legacyClaimPending = false
let legacyMigrationUnresolved = false
let legacyClaimSettled: Promise<void> = Promise.resolve()
/** Account discovery waits for the startup legacy claim rather than treating it as a sign-out. */
export const waitAccountSpace = () => legacyClaimSettled
/** Whether this tab stopped: the browser is signed in as another account now (or this one is being cleared). */
export const accountFrozen = () => frozen

/**
 * Stops this tab: nothing more is written or sent, and (unless `reload` is false: the account is
 * being cleared by this tab, which reloads itself) the page starts again at once, as the account
 * the browser has now, so nothing of this tab's account stays on screen either.
 */
export function freezeAccount(reload = true) {
  if (frozen) return
  frozen = true
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('mvlos:account-changed'))
  if (reload)
    try {
      location.reload()
    } catch {
      /* not in a page */
    }
}

/** Whether this tab may still write its account's state and talk to the API: the cookie still says its account. */
export function accountGuard(): boolean {
  if (frozen) return false
  if (legacyClaimPending) return false
  if (cookieUid() === TAB_UID && revocation() === TAB_REVOCATION) return true
  freezeAccount()
  return false
}

/** This tab's account space in localStorage: reads anywhere, writes only while accountGuard() holds. */
export const accountStorage = {
  /** Strict operations distinguish inaccessible storage from an absent key. */
  getStrict(key: string): string | null {
    try { return localStorage.getItem(accountKey(key)) } catch { throw new Error('Widget storage read unavailable; original data retained') }
  },
  keysStrict(prefix: string): string[] {
    try {
      const full = accountKey(prefix), keys: string[] = []
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)
        if (key?.startsWith(full)) keys.push(`mvlos.${key.slice(SPACE.length)}`)
      }
      return keys.sort()
    } catch { throw new Error('Widget storage read unavailable; original data retained') }
  },
  get(key: string): string | null {
    try {
      return localStorage.getItem(accountKey(key))
    } catch {
      return null
    }
  },
  /** Read only enumeration inside this tab's account space. */
  keys(prefix: string): string[] {
    try {
      const full = accountKey(prefix), keys: string[] = []
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)
        if (key?.startsWith(full)) keys.push(`mvlos.${key.slice(SPACE.length)}`)
      }
      return keys.sort()
    } catch { return [] }
  },
  /** False when it wasn't written (the guard failed, or storage refused it). */
  set(key: string, value: string): boolean {
    if (!accountGuard()) return false
    try {
      localStorage.setItem(accountKey(key), value)
      return true
    } catch {
      return false
    }
  },
  remove(key: string) {
    if (!accountGuard()) return
    try {
      localStorage.removeItem(accountKey(key))
    } catch {
      /* nothing kept */
    }
  },
}

/** Whether a storage event's key is this tab's `key` (written as before spaces). */
export const isAccountKey = (storageKey: string | null, key: string) => storageKey === accountKey(key)

/** Removes this tab's whole account space (signing out: the account's state leaves this browser). */
export function clearAccountSpace(): Promise<void> {
  const canonical = accountKey(WIDGET_STORAGE_KEY), journals = accountKey(WIDGET_JOURNAL_PREFIX)
  // Retain cutover and unfinished migration intents across logout: the plain legacy source is
  // intentionally retained and must not be imported again when this account signs back in.
  const migrationKeys = new Set([`${SPACE}moved`, `${SPACE}widget-move:plain:v2`, `${SPACE}widget-move:guest:v2`, `${SPACE}widget-move:plain:done:v2`, `${SPACE}legacy-copy:v1`])
  const widgetKey = (key: string) => key === accountKey(NOTE_STATE_KEY) || key.startsWith(accountKey(NOTE_PENDING_PREFIX)) || key === accountKey(WIDGET_NOTE_CACHE_KEY) || key === canonical || key === journals || key.startsWith(journals + ':')
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith(SPACE) && k !== REVOCATION_KEY && !migrationKeys.has(k) && !k.startsWith(`${SPACE}legacy-copy:v2:`) && !k.startsWith(`${SPACE}widget-stage:v1:`) && !widgetKey(k)) localStorage.removeItem(k)
  } catch { return Promise.reject(new Error('Account storage cleanup unavailable')) }
  // Logout is authorized cleanup after revocation, so it intentionally does not call accountGuard.
  // It follows any already-running writer, including a tab paused inside its native storage call.
  return storageTransaction(() => {
    localStorage.setItem(REVOCATION_KEY, crypto.randomUUID())
    for (const k of Object.keys(localStorage)) if (widgetKey(k)) localStorage.removeItem(k)
  })
}

// ---------------------------------------------------------------------------------------------
// Moving in, once per space: the release before spaces, and a visitor signing in

/** What the release before spaces kept per account, in plain keys. */
const LEGACY = [
  /^mvlos\.sync\./,
  /^mvlos\.notify\.(history|seen)$/,
  /^mvlos\.history$/,
  /^mvlos\.files\.v1$/,
  /^mvlos\.desktop\.v1$/,
  /^mvlos\.dock\.v1$/,
  /^mvlos\.agents\./,
  /^mvlos\.push$/,
  /^mvlos\.browser\./,
  /^mvlos\.git\.lastRepo$/,
  /^mvlos\.launchers\.files$/,
  // Games: what a game window keeps (by session), Empires' multiplayer player and battle, and the
  // high scores and Gladiator careers (synced, so the account's when signed in).
  /^mvlos\.gamewin\./,
  /^mvlos\.empires\.mp\.(last|battle)$/,
  /^mvlos\.highscores\.v1$/,
  /^mvlos\.gladiator\.v1$/,
]
/** The old marker of whose state the plain keys were, and the one from before sign-up was open. */
const OLD_MARKER = 'mvlos.account'
const OLDER_MARKER = 'mvlos.owner'
const OLDER_CLAIM = 'mvlos.legacy-owner-claim:v1'
type LegacySnapshot = { marker: string | null; older: string | null; values: Record<string, string> }
function snapshotLegacy(): LegacySnapshot {
  const marker = localStorage.getItem(OLD_MARKER), older = localStorage.getItem(OLDER_MARKER)
  const values: Record<string, string> = {}
  for (const key of Object.keys(localStorage)) if (LEGACY.some(rule => rule.test(key))) {
    const value = localStorage.getItem(key)
    if (value !== null) values[key] = value
  }
  if (marker !== localStorage.getItem(OLD_MARKER) || older !== localStorage.getItem(OLDER_MARKER)) throw new Error('Legacy ownership changed; sources retained')
  return { marker, older, values }
}
function sameOwnership(snapshot: LegacySnapshot): boolean {
  return snapshot.marker === localStorage.getItem(OLD_MARKER) && snapshot.older === localStorage.getItem(OLDER_MARKER)
}
/** Older partial migrations have no receipts. Identical synced values still prove a safe retry
 * even if server hydration changed envelope metadata. Other differences stay unresolved. */
function sameSyncedValue(key: string, source: string, target: string): boolean {
  if (!key.startsWith('mvlos.sync.')) return false
  try {
    const a = JSON.parse(source), b = JSON.parse(target)
    if (!a || !b || !Object.hasOwn(a, 'value') || !Object.hasOwn(b, 'value')) return false
    const stable = (v: unknown): string => {
      if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
      if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`
      return JSON.stringify(v) ?? 'null'
    }
    return stable(a.value) === stable(b.value)
  } catch { return false }
}
/** A retained plan means migration has not yet established canonical cutover. */
export function widgetMigrationUnresolved(): boolean {
  try { return legacyMigrationUnresolved || localStorage.getItem(`${SPACE}widget-move:guest:v2`) !== null || (localStorage.getItem(`${SPACE}widget-move:plain:v2`) !== null && localStorage.getItem(`${SPACE}widget-move:plain:done:v2`) === null) } catch { return true }
}

/** Called only under the origin-wide gate. Never reassign an older marker to another account. */
function claimOlder(older: string): boolean {
  if (!TAB_UID || !older || older.length > 512 || localStorage.getItem(OLD_MARKER) || localStorage.getItem(OLDER_MARKER) !== older) return false
  // Earlier unreleased versions left account-scoped receipts/intents but no global claim. A
  // conflicting or ambiguous prior owner must not be reassigned to the current account.
  const prior = new Set<string>()
  for (const key of Object.keys(localStorage)) {
    const visitorStage = /^mvlos\.visitor\.widget-stage:v1:([^:]+):/.exec(key)
    if (visitorStage) {
      try {
        const sourceKey = decodeURIComponent(visitorStage[1]), record = JSON.parse(localStorage.getItem(key) ?? 'null')
        if (!WIDGET_LEGACY.has(sourceKey) || !validStage(record, sourceKey, null)) return false
      } catch { return false }
    }
    const stage = /^mvlos\.u\.(\d+)\.widget-stage:v1:([^:]+):/.exec(key)
    if (stage) {
      try {
        const record = JSON.parse(localStorage.getItem(key) ?? 'null'), sourceKey = decodeURIComponent(stage[2])
        if (!WIDGET_LEGACY.has(sourceKey)) return false
        if (validStage(record, sourceKey, stage[1])) {
          // Even a changed older marker cannot prove that a retained plain source changed owner.
          if (record.origin.kind === 'plain') prior.add(stage[1])
        } else if (recoveredStage(record, sourceKey, stage[1], `mvlos.u.${stage[1]}.`, false)) prior.add(stage[1])
        else return false
      } catch { return false }
    }
  }
  // A global claim predates later explicit-owner migrations in another tab. It cannot bypass
  // their durable identity evidence, even if the older marker has not changed.
  if (prior.size > 1 || (prior.size === 1 && !prior.has(TAB_UID))) return false
  const raw = localStorage.getItem(OLDER_CLAIM)
  if (raw !== null) {
    if (raw.length > 1024) return false
    try { const claim = JSON.parse(raw); return claim?.owner === TAB_UID && claim?.marker === older } catch { return false }
  }
  for (const key of Object.keys(localStorage)) {
    const copy = /^mvlos\.u\.(\d+)\.legacy-copy:(?:v1|v2:.+)$/.exec(key)
    if (copy) {
      try { const receipt = JSON.parse(localStorage.getItem(key) ?? 'null'); if (!receipt || receipt.marker !== null || receipt.older !== older) return false }
      catch { return false }
      prior.add(copy[1])
    }
    const moved = /^mvlos\.u\.(\d+)\.moved$/.exec(key)
    if (moved) {
      const plan = localStorage.getItem(`mvlos.u.${moved[1]}.widget-move:plain:v2`)
      try { const p = JSON.parse(plan ?? 'null'); if (!p || p.marker !== null || p.older !== older || typeof p.source !== 'string') return false }
      catch { return false }
      prior.add(moved[1])
    }
    const match = /^mvlos\.u\.(\d+)\.widget-move:plain:(done:v2|v2)$/.exec(key)
    if (!match) continue
    if (match[2] === 'done:v2') prior.add(match[1])
    else {
      try { const plan = JSON.parse(localStorage.getItem(key) ?? 'null'); if (!plan || typeof plan !== 'object') return false; if (plan.marker === null && plan.older === older) prior.add(match[1]) }
      catch { return false }
    }
  }
  if ([...prior].some(owner => owner !== TAB_UID)) return false
  const value = JSON.stringify({ owner: TAB_UID, marker: older })
  localStorage.setItem(OLDER_CLAIM, value)
  return localStorage.getItem(OLDER_CLAIM) === value
}

/** Complete dependencies before clearing a visitor envelope intent, including retries of an
 * earlier partial transfer whose general `moved` marker was already written. */
function stageVisitorWidgets() {
  let copied = false
  // Earlier visitor migration may have staged inputs without creating ordinary visitor keys.
  // A note checkpoint wins over all older visitor inputs. Before cutover an ordinary visitor
  // value wins over an older snapshot, and existing account state wins over visitor inputs.
  if (TAB_UID) for (const key of WIDGET_LEGACY) {
    if (widgetLegacyStage(key) !== null) continue
    const legacySource = () => localStorage.getItem(`mvlos.visitor.${key.slice('mvlos.'.length)}`) ??
      (key === 'mvlos.sync.notes' ? localStorage.getItem(`mvlos.visitor.${WIDGET_NOTE_CACHE_KEY.slice('mvlos.'.length)}`) : null) ??
      readWidgetLegacyStage(key, 'mvlos.visitor.', null)
    let source: string | null
    if (key === 'mvlos.sync.notes') {
      const generation = localStorage.getItem('mvlos.visitor.revocation:v1')
      if (hasNoteProjection('mvlos.visitor.', generation)) {
        source = JSON.stringify(readNoteProjection('mvlos.visitor.', generation, () => {
          const fallback = legacySource()
          return fallback === null ? { value: [], base: 0, dirty: false } : parseNoteMeta(fallback)
        }))
      } else source = legacySource()
    } else source = legacySource()
    if (source !== null) {
      const m = JSON.parse(source)
      if (!m || !Object.hasOwn(m, 'value') || (key === 'mvlos.sync.notes' && !Array.isArray(m.value))) throw new Error('Visitor widget dependency unreadable; original data retained')
      stageWidgetLegacy(key, JSON.stringify({ value: m.value, base: 0, dirty: true }), { owner: TAB_UID, kind: 'visitor', marker: null, older: null })
      copied = true
    }
  }
  return copied
}

function hasVisitorState() {
  return Object.keys(localStorage).some(key => key.startsWith('mvlos.visitor.sync.') ||
    key.startsWith('mvlos.visitor.widget-stage:v1:') ||
    key === 'mvlos.visitor.' + NOTE_STATE_KEY.slice('mvlos.'.length) ||
    key.startsWith('mvlos.visitor.' + NOTE_PENDING_PREFIX.slice('mvlos.'.length)))
}

function moveIn(authorized?: LegacySnapshot, skipOlder = false) {
  // Fail closed even if the first read, snapshot, intent write, or ordinary copy fails.
  if (!authorized) legacyMigrationUnresolved = true
  try {
    if (typeof localStorage === 'undefined') return
    const underGate = !!authorized
    const older = localStorage.getItem(OLDER_MARKER)
    const needsMove = !localStorage.getItem(`${SPACE}moved`) || !!localStorage.getItem(`${SPACE}widget-move:plain:v2`) || !!localStorage.getItem(`${SPACE}widget-move:guest:v2`)
    if (!underGate && !skipOlder && needsMove && TAB_UID && !localStorage.getItem(OLD_MARKER) && older) {
      const snapshot = snapshotLegacy()
      legacyClaimPending = true
      legacyClaimSettled = storageTransaction(() => {
        if (frozen || cookieUid() !== TAB_UID || !sameOwnership(snapshot) || !claimOlder(older)) return false
        moveIn(snapshot)
        return true
      }).then(async ok => {
        if (ok) {
          legacyMigrationUnresolved = false
          try { location.reload() } catch { legacyClaimPending = false }
        } else {
          legacyClaimPending = false
          // A claim already bound to another account is not this account's migration.
          try {
            const claim = JSON.parse(localStorage.getItem(OLDER_CLAIM) ?? 'null')
            if (claim?.marker === older && claim?.owner && claim.owner !== TAB_UID) {
              legacyMigrationUnresolved = false
              if (localStorage.getItem(`${SPACE}widget-move:guest:v2`) || (!localStorage.getItem(`${SPACE}moved`) && hasVisitorState())) {
                const priorSettled = legacyClaimSettled
                moveIn(undefined, true)
                if (legacyClaimSettled !== priorSettled) await legacyClaimSettled
              }
            }
          } catch { /* ambiguous: stay blocked */ }
        }
      }, () => { legacyClaimPending = false })
      return
    }
    const flag = `${SPACE}moved`, plainPlan = `${SPACE}widget-move:plain:v2`, guestPlan = `${SPACE}widget-move:guest:v2`, plainDone = `${SPACE}widget-move:plain:done:v2`
    let ordinaryCopied = false
    if (!localStorage.getItem(flag)) {
      const keys = Object.keys(localStorage)
      const snapshot = authorized ?? snapshotLegacy()
      if (!sameOwnership(snapshot)) throw new Error('Legacy ownership changed; sources retained')
      const marker = snapshot.marker
      const theirs = TAB_UID ? marker === TAB_UID || (underGate && !marker && !!snapshot.older) : !marker && !snapshot.older
      // Separate monotonic intent flags cannot overwrite another starter's positive claim.
      // Failed IDB must not reopen other stores' import or discard the original envelope.
      // Bind the intent to both the ownership markers and exact source, not merely the account
      // that happened to observe them. A later legacy writer may replace either before IDB opens.
      if (theirs && !localStorage.getItem(plainDone) && Object.hasOwn(snapshot.values, WIDGET_STORAGE_KEY)) localStorage.setItem(plainPlan, JSON.stringify({ marker, older: snapshot.older, source: snapshot.values[WIDGET_STORAGE_KEY], target: localStorage.getItem(accountKey(WIDGET_STORAGE_KEY)) }))
      if (TAB_UID && !localStorage.getItem(plainPlan)) {
        const source = localStorage.getItem('mvlos.visitor.sync.widgets:state:v2')
        if (source !== null) localStorage.setItem(guestPlan, JSON.stringify({ source, target: localStorage.getItem(accountKey(WIDGET_STORAGE_KEY)) }))
      }
      if (theirs) {
        const entries = Object.entries(snapshot.values).filter(([k]) => k !== WIDGET_STORAGE_KEY)
        if (entries.length > 256 || new TextEncoder().encode(JSON.stringify(entries)).length > 1024 * 1024) throw new Error('Legacy copy limit reached; original data retained')
        for (const [k, v] of entries) {
          if (!sameOwnership(snapshot) || localStorage.getItem(k) !== v) throw new Error('Legacy source changed; original data retained')
          if (WIDGET_LEGACY.has(k)) { stageWidgetLegacy(k, v, { owner: TAB_UID, kind: 'plain', marker, older: snapshot.older }); ordinaryCopied = true; continue }
          const to = accountKey(k)
          const target = localStorage.getItem(to)
          // Each source has its own write-ahead receipt, so two starting tabs cannot erase
          // each other's completed copy provenance by replacing a shared aggregate.
          const receiptKey = `${SPACE}legacy-copy:v2:${encodeURIComponent(k)}`
          const raw = localStorage.getItem(receiptKey)
          if (raw !== null) {
            const receipt = JSON.parse(raw)
            if (!receipt || receipt.marker !== snapshot.marker || receipt.older !== snapshot.older || receipt.source !== v) throw new Error('Legacy copy provenance unavailable; originals retained')
          } else {
            if (target !== null && target !== v && !sameSyncedValue(k, v, target)) throw new Error('Legacy target conflicts; original data retained')
            localStorage.setItem(receiptKey, JSON.stringify({ marker: snapshot.marker, older: snapshot.older, source: v }))
          }
          // A recorded earlier copy may have been updated locally or by server hydration.
          // Never overwrite that account-owned value while retrying the incomplete migration.
          if (target === null) { localStorage.setItem(to, v); ordinaryCopied = true }
        }
        // Legacy writers can create or replace the widget envelope at any time. Never remove
        // ownership markers, even when no envelope was present during this startup.
      }
      if (TAB_UID) for (const k of keys) if (k.startsWith('mvlos.visitor.sync.') && k !== 'mvlos.visitor.sync.widgets:state:v2') {
        const to = SPACE + k.slice('mvlos.visitor.'.length)
        const v = localStorage.getItem(k)
        if (v !== null) {
          const m = JSON.parse(v), rebased = JSON.stringify({ value: m.value, base: 0, dirty: true })
          const oldKey = `mvlos.${k.slice('mvlos.visitor.'.length)}`
          if (!WIDGET_LEGACY.has(oldKey) && localStorage.getItem(to) === null) { localStorage.setItem(to, rebased); ordinaryCopied = true }
        }
      }
      ordinaryCopied = stageVisitorWidgets() || ordinaryCopied
      localStorage.setItem(flag, '1')
    }
    if (localStorage.getItem(guestPlan)) ordinaryCopied = stageVisitorWidgets() || ordinaryCopied
    if (localStorage.getItem(plainPlan) || localStorage.getItem(guestPlan)) {
      let copied = false
      const transfer = () => {
        if (frozen || cookieUid() !== TAB_UID || revocation() !== TAB_REVOCATION) throw new Error('Account changed during widget migration')
        const to = accountKey(WIDGET_STORAGE_KEY)
        const plan = localStorage.getItem(plainPlan)
        if (plan && !localStorage.getItem(plainDone)) {
          let claim: { marker: string | null; older: string | null; source: string; target?: string | null } | undefined
          try { claim = JSON.parse(plan) } catch { /* older unbound intent is not proof of ownership */ }
          const marker = localStorage.getItem(OLD_MARKER), older = localStorage.getItem(OLDER_MARKER)
          const v = localStorage.getItem(WIDGET_STORAGE_KEY)
          if (!claim || typeof claim.source !== 'string' || claim.marker !== marker || claim.older !== older || claim.source !== v || (authorized && !sameOwnership(authorized)) || !(TAB_UID ? marker === TAB_UID || (underGate && !marker && !!older && claimOlder(older)) : !marker && !older)) throw new Error('Widget migration source changed; original data retained')
          const target = localStorage.getItem(to)
          if (claim.target != null) {
            if (target !== claim.target) throw new Error('Widget migration target changed; original data retained')
          } else {
            if (target === null) { localStorage.setItem(to, v); copied = true }
            if (localStorage.getItem(to) !== v) throw new Error('Widget migration copy not verified; original data retained')
          }
          // Non-cooperating legacy tabs do not use this gate. Their source and ownership markers
          // can change at any point, so this migration never removes or rewrites either.
          localStorage.setItem(plainDone, '1')
        }
        const guestRaw = localStorage.getItem(guestPlan)
        if (guestRaw) {
          let guest: { source: string; target: string | null } | undefined
          if (guestRaw === '1' && localStorage.getItem(to) === null) {
            // Earlier visitor intents had no snapshot. They are safe to bind only while no
            // account target exists; an existing target is ambiguous and remains untouched.
            const source = localStorage.getItem('mvlos.visitor.sync.widgets:state:v2')
            if (source !== null) { guest = { source, target: null }; localStorage.setItem(guestPlan, JSON.stringify(guest)) }
          } else try { guest = JSON.parse(guestRaw) } catch { /* old unbound intent must fail closed */ }
          if (!guest || typeof guest.source !== 'string' || !(guest.target === null || typeof guest.target === 'string') || localStorage.getItem('mvlos.visitor.sync.widgets:state:v2') !== guest.source) throw new Error('Visitor widget migration source changed; original data retained')
          const target = localStorage.getItem(to)
          if (guest.target !== null) {
            if (target !== guest.target) throw new Error('Visitor widget migration target changed; original data retained')
          } else {
            const m = JSON.parse(guest.source), value = JSON.stringify({ value: m.value, base: 0, dirty: true })
            if (target === null) { localStorage.setItem(to, value); copied = true }
            if (localStorage.getItem(to) !== value) throw new Error('Visitor widget migration copy not verified; original data retained')
          }
        }
        localStorage.removeItem(plainPlan)
        localStorage.removeItem(guestPlan)
      }
      if (underGate) transfer()
      else {
        legacyClaimPending = true
        legacyClaimSettled = storageTransaction(transfer).then(() => {
          legacyMigrationUnresolved = false
          if (copied || (skipOlder && ordinaryCopied)) {
            try { location.reload() } catch { legacyClaimPending = false }
          } else legacyClaimPending = false
        }, () => { legacyClaimPending = false })
      }
    } else if (!underGate) {
      legacyMigrationUnresolved = false
      // The foreign-owner decision completed asynchronously, after ordinary stores initialized.
      // Reload so those stores observe visitor data before their default layout can be saved.
      if (skipOlder && ordinaryCopied) {
        legacyClaimPending = true
        try { location.reload() } catch { legacyClaimPending = false }
      }
    }
  } catch (error) { if (authorized) throw error; /* storage unavailable: ordinary stores remain usable in memory */ }
}
moveIn()

// ---------------------------------------------------------------------------------------------
// The API

const isApi = (url: string | URL) => {
  try {
    const u = new URL(String(url), location.href)
    return u.origin === location.origin && u.pathname.startsWith('/api/')
  } catch {
    return false
  }
}

/**
 * Every request to the site's API from this page, by fetch or XMLHttpRequest: checked against
 * accountGuard() first (a tab of another account sends nothing: the request fails), and saying
 * whose state this tab holds (X-MvL-Account).
 */
export function installApiGuard() {
  if (typeof window === 'undefined') return
  const fetch0 = window.fetch.bind(window)
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input
    if (!isApi(url)) return fetch0(input, init)
    if (!accountGuard()) return Promise.reject(new Error('Signed in as another account'))
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    headers.set('X-MvL-Account', TAB_ACCOUNT)
    return fetch0(input, { ...init, headers })
  }
  const open0 = XMLHttpRequest.prototype.open
  const send0 = XMLHttpRequest.prototype.send
  const api = new WeakSet<XMLHttpRequest>()
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    if (isApi(url)) api.add(this)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (open0 as any).call(this, method, url, ...rest)
  } as typeof XMLHttpRequest.prototype.open
  XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    if (api.has(this)) {
      if (!accountGuard()) return this.abort()
      this.setRequestHeader('X-MvL-Account', TAB_ACCOUNT)
    }
    return send0.call(this, body)
  }
}
