import { createHash, createPublicKey, verify, type KeyObject, type webcrypto } from 'node:crypto'

// Google ID tokens (OpenID Connect), checked here rather than trusted because they came over TLS:
// the RS256 signature against Google's published keys, the issuer, the audience (this site's
// client id), expiry and issue time, and the nonce this sign-in sent. Only then is `sub`, Google's
// stable account id, used (https://developers.google.com/identity/openid-connect/openid-connect).
//
// GOOGLE_JWKS_URL points the keys at a stand-in for scripts/auth-identities-check.ts; nothing else sets it.

const JWKS_URL = process.env.GOOGLE_JWKS_URL || 'https://www.googleapis.com/oauth2/v3/certs'
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com'])
/** Clock difference allowed between Google and this server. */
const SKEW_S = 120
/** Keys are fetched again after this long at most, or sooner when Google says so (Cache-Control). */
const MAX_KEY_AGE = 6 * 3600_000
/** An unknown key id refetches the keys, but not more often than this. */
const REFETCH_GAP = 60_000

let keys: { at: number; until: number; byKid: Map<string, KeyObject> } | null = null
let lastFetch = 0

async function fetchKeys(): Promise<void> {
  lastFetch = Date.now()
  const res = await fetch(JWKS_URL, { signal: AbortSignal.timeout(10_000) })
  if (!res.ok) throw new Error(`Google keys: ${res.status}`)
  const body = (await res.json()) as { keys?: (webcrypto.JsonWebKey & { kid?: string; alg?: string; use?: string })[] }
  const byKid = new Map<string, KeyObject>()
  for (const k of body.keys ?? []) {
    if (k.kty !== 'RSA' || typeof k.kid !== 'string' || (k.use && k.use !== 'sig') || (k.alg && k.alg !== 'RS256')) continue
    try {
      byKid.set(k.kid, createPublicKey({ key: k, format: 'jwk' }))
    } catch {
      /* not a usable key */
    }
  }
  const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get('cache-control') ?? '')?.[1])
  const now = Date.now()
  keys = { at: now, until: now + Math.min(MAX_KEY_AGE, Number.isFinite(maxAge) && maxAge > 0 ? maxAge * 1000 : MAX_KEY_AGE), byKid }
}

async function keyFor(kid: string): Promise<KeyObject | null> {
  if (!keys || Date.now() > keys.until) await fetchKeys()
  let key = keys!.byKid.get(kid)
  if (!key && Date.now() - lastFetch > REFETCH_GAP) {
    await fetchKeys()
    key = keys!.byKid.get(kid)
  }
  return key ?? null
}

export type GoogleIdentity = { sub: string; email: string | null; emailVerified: boolean; name: string | null; picture: string | null }

const part = (s: string) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as Record<string, unknown>

/** The checked identity in a Google ID token, or an Error saying which check failed. */
export async function verifyGoogleIdToken(token: string, opts: { clientId: string; nonce: string; now?: number }): Promise<GoogleIdentity> {
  const pieces = token.split('.')
  if (pieces.length !== 3 || pieces.some((p) => !/^[A-Za-z0-9_-]*$/.test(p))) throw new Error('malformed token')
  let header: Record<string, unknown>
  let claims: Record<string, unknown>
  try {
    header = part(pieces[0])
    claims = part(pieces[1])
  } catch {
    throw new Error('malformed token')
  }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error('unexpected algorithm')
  const key = await keyFor(header.kid)
  if (!key) throw new Error('unknown signing key')
  const signed = Buffer.from(`${pieces[0]}.${pieces[1]}`)
  if (!verify('RSA-SHA256', signed, key, Buffer.from(pieces[2], 'base64url'))) throw new Error('bad signature')

  const now = Math.floor((opts.now ?? Date.now()) / 1000)
  if (typeof claims.iss !== 'string' || !ISSUERS.has(claims.iss)) throw new Error('wrong issuer')
  const aud = claims.aud
  if (Array.isArray(aud) ? !aud.includes(opts.clientId) || (aud.length > 1 && claims.azp !== opts.clientId) : aud !== opts.clientId) throw new Error('wrong audience')
  if (typeof claims.exp !== 'number' || claims.exp + SKEW_S < now) throw new Error('expired')
  if (typeof claims.iat !== 'number' || claims.iat - SKEW_S > now) throw new Error('issued in the future')
  if (typeof claims.nonce !== 'string' || !sameText(claims.nonce, opts.nonce)) throw new Error('wrong nonce')
  if (typeof claims.sub !== 'string' || !/^[\x21-\x7e]{1,255}$/.test(claims.sub)) throw new Error('no subject')
  const email = typeof claims.email === 'string' && claims.email.length <= 320 ? claims.email : null
  return {
    sub: claims.sub,
    email,
    emailVerified: claims.email_verified === true || claims.email_verified === 'true',
    name: typeof claims.name === 'string' ? claims.name.slice(0, 200) : null,
    picture: typeof claims.picture === 'string' && /^https:\/\/[a-z0-9.-]+\.googleusercontent\.com\//i.test(claims.picture) ? claims.picture.slice(0, 1000) : null,
  }
}

/** Compares two strings by their hashes, so the time taken says nothing about where they differ. */
function sameText(a: string, b: string) {
  return createHash('sha256').update(a).digest().equals(createHash('sha256').update(b).digest())
}

/** For the checks: forget the cached keys. */
export const oidcForTest = { reset: () => ((keys = null), (lastFetch = 0)) }
