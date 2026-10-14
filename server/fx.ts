import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

// Exchange rates for everyone (GET /api/fx): Spotlight's calculator and the amounts in Agents
// replies (src/os/smartcalc.ts loadRates). The ECB's reference rates via Frankfurter, topped up
// with open.er-api.com for the currencies the ECB doesn't publish, the same merge the browser
// used to do itself. Fetched at most once per six hours for the whole site, one fetch at a time,
// and kept in DATA_DIR/fx-rates.json so a restart doesn't fetch again. When the sources fail, the
// last rates are served (marked stale) and they're asked again after a few minutes.
//
// Both addresses are fixed (FX_URL_ECB and FX_URL_WIDE override them, for checks against a stand-in),
// never chosen by a user, so these requests don't go through server/egress.ts.

export type FxRates = {
  base: 'EUR'
  /** The ECB's publication date (or today, when only the wider source answered) */
  date: string
  source: string
  /** Units per 1 EUR */
  rates: Record<string, number>
  /** Codes only the wider source has */
  wide: string[]
  fetchedAt: number
}

export const FX_TTL = 6 * 3600_000
/** After a failed fetch, the sources are left alone this long (stale rates are served meanwhile). */
export const FX_RETRY = 5 * 60_000

type Options = {
  ecbUrl?: string
  wideUrl?: string
  /** Where the rates are kept between restarts; null keeps them in memory only. */
  file?: string | null
  now?: () => number
  timeoutMs?: number
}

export function createFx(opts: Options = {}) {
  const ecbUrl = opts.ecbUrl ?? process.env.FX_URL_ECB ?? 'https://api.frankfurter.dev/v1/latest?base=EUR'
  const wideUrl = opts.wideUrl ?? process.env.FX_URL_WIDE ?? 'https://open.er-api.com/v6/latest/EUR'
  const file = opts.file === undefined ? join(resolve(process.env.DATA_DIR ?? 'data'), 'fx-rates.json') : opts.file
  const now = opts.now ?? Date.now
  const timeoutMs = opts.timeoutMs ?? 8000

  let current: FxRates | null = null
  let loaded = false
  let inflight: Promise<FxRates | null> | null = null
  let failedAt = -Infinity
  /** How many times the sources were asked (both at once count as one), for the checks. */
  let fetches = 0

  const validRates = (v: unknown): Record<string, number> | null => {
    if (!v || typeof v !== 'object') return null
    const out: Record<string, number> = {}
    for (const [k, n] of Object.entries(v)) if (/^[A-Z]{3}$/.test(k) && typeof n === 'number' && Number.isFinite(n) && n > 0) out[k] = n
    return Object.keys(out).length ? out : null
  }

  function fromDisk() {
    if (loaded || !file) return
    loaded = true
    try {
      const d = JSON.parse(readFileSync(file, 'utf8')) as FxRates
      const rates = validRates(d?.rates)
      if (rates && typeof d.fetchedAt === 'number' && typeof d.date === 'string') current = { base: 'EUR', date: d.date, source: String(d.source), rates, wide: Array.isArray(d.wide) ? d.wide : [], fetchedAt: d.fetchedAt }
    } catch {
      /* none yet */
    }
  }

  function toDisk(r: FxRates) {
    if (!file) return
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(`${file}.tmp`, JSON.stringify(r))
      renameSync(`${file}.tmp`, file)
    } catch {
      /* kept in memory */
    }
  }

  const getJson = async (url: string) => {
    const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) })
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`)
    return (await r.json()) as { date?: string; rates?: unknown }
  }

  async function refresh(): Promise<FxRates | null> {
    fetches++
    const [ecb, wide] = await Promise.allSettled([getJson(ecbUrl), getJson(wideUrl)])
    const ecbRates = ecb.status === 'fulfilled' ? validRates(ecb.value.rates) : null
    const wideRates = wide.status === 'fulfilled' ? validRates(wide.value.rates) : null
    // The ECB's rates win where both have one.
    const rates = { ...wideRates, ...ecbRates, EUR: 1 }
    if (Object.keys(rates).length < 2) return null
    const at = now()
    const ecbDate = ecb.status === 'fulfilled' && typeof ecb.value.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ecb.value.date) ? ecb.value.date : null
    return {
      base: 'EUR',
      date: ecbRates && ecbDate ? ecbDate : new Date(at).toISOString().slice(0, 10),
      source: ecbRates ? 'European Central Bank' : 'exchangerate-api.com',
      rates,
      wide: ecbRates ? Object.keys(rates).filter((c) => c !== 'EUR' && !(c in ecbRates)) : [],
      fetchedAt: at,
    }
  }

  /** The rates, and whether they're older than six hours because the sources failed; null when there are none. */
  async function get(): Promise<{ rates: FxRates; stale: boolean; maxAge: number } | null> {
    fromDisk()
    const answer = (r: FxRates | null) => {
      if (!r) return null
      const left = FX_TTL - (now() - r.fetchedAt)
      // Browsers may keep fresh rates until they'd be fetched again here (at most an hour), stale ones briefly.
      return left > 0 ? { rates: r, stale: false, maxAge: Math.min(3600, Math.floor(left / 1000)) } : { rates: r, stale: true, maxAge: 300 }
    }
    if (current && now() - current.fetchedAt < FX_TTL) return answer(current)
    if (now() - failedAt < FX_RETRY) return answer(current)
    inflight ??= refresh()
      .catch(() => null)
      .then((r) => {
        if (r) {
          current = r
          toDisk(r)
        } else failedAt = now()
        return r
      })
      .finally(() => (inflight = null))
    await inflight
    return answer(current)
  }

  return { get, fetches: () => fetches }
}

const shared = createFx()
export const fxRates = () => shared.get()
