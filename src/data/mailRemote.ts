// What the Mail app's remote-content settings mean, shared by the browser (src/data/mail.ts,
// Settings → Apps → Mail) and the server (server/jmap.ts), which decides what an HTML message is
// shown with: remote content stays blocked unless this says otherwise, so nothing loads before
// the decision. Tracking pixels never load, whatever is set here (server/mailhtml.ts).

/** Ask each time, load for the senders on the allow list only, or always. */
export type RemoteMode = 'ask' | 'allowed' | 'always'
export const REMOTE_MODES: RemoteMode[] = ['ask', 'allowed', 'always']

/** One entry of the allow list: an address ("news@shop.example") or a whole domain ("@shop.example"), and when it was added. */
export type Allowed = { who: string; at: number }

export const ALLOWED_MAX = 2000

/** The part of the synced "mail" state both sides read. */
export type RemoteSettings = { remote: RemoteMode; allowed: Allowed[] }

const ADDRESS = /^[^\s@<>()[\],;:"\\]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i
const DOMAIN = /^@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i

/** An address or "@domain" tidied up (lowercase, no "<>"), or null when it is neither. */
export function parseSender(input: string): string | null {
  const v = input.trim().replace(/^<|>$/g, '').trim().toLowerCase()
  return ADDRESS.test(v) || DOMAIN.test(v) ? v : null
}

/** The allow list from a stored value: the entries as saved, or the older plain list of addresses (added "a while ago"). */
export function readAllowed(v: unknown): Allowed[] {
  const o = (v && typeof v === 'object' ? v : {}) as { allowed?: unknown; imageSenders?: unknown }
  const out = new Map<string, Allowed>()
  const add = (who: unknown, at: unknown) => {
    const w = typeof who === 'string' ? parseSender(who) : null
    if (w && !out.has(w)) out.set(w, { who: w, at: typeof at === 'number' && Number.isFinite(at) ? at : 0 })
  }
  if (Array.isArray(o.allowed)) for (const e of o.allowed) add((e as Partial<Allowed> | null)?.who, (e as Partial<Allowed> | null)?.at)
  if (Array.isArray(o.imageSenders)) for (const e of o.imageSenders) add(e, 0)
  return [...out.values()].slice(0, ALLOWED_MAX)
}

/** The remote-content mode from a stored value. Without one, a list built before the setting existed counts as "allowed". */
export function readRemote(v: unknown): RemoteMode {
  const o = (v && typeof v === 'object' ? v : {}) as { remote?: unknown }
  if (REMOTE_MODES.includes(o.remote as RemoteMode)) return o.remote as RemoteMode
  return readAllowed(v).length ? 'allowed' : 'ask'
}

export const readRemoteSettings = (v: unknown): RemoteSettings => ({ remote: readRemote(v), allowed: readAllowed(v) })

/** Whether the allow list covers this sender, by address or by domain. */
export function isAllowed(list: Allowed[], email: string): boolean {
  const e = email.trim().toLowerCase()
  const domain = e.slice(e.lastIndexOf('@'))
  return list.some((a) => a.who === e || a.who === domain)
}

/** Whether a message from `senders` is shown with remote images and styles, without being asked. */
export function loadsRemote(s: RemoteSettings, senders: string[]): boolean {
  if (s.remote === 'always') return true
  if (s.remote === 'allowed') return senders.some((e) => isAllowed(s.allowed, e))
  return false
}
