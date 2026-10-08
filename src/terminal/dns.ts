// Real DNS lookups from the browser via DNS-over-HTTPS JSON APIs (both send CORS headers).
// The queried name goes to Cloudflare, or to Google if Cloudflare does not answer.

const RESOLVERS = [
  (name: string, type: string) => `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`,
  (name: string, type: string) => `https://dns.google/resolve?name=${encodeURIComponent(name)}&type=${type}`,
]

export const RECORD_TYPES: Record<string, number> = { A: 1, NS: 2, CNAME: 5, SOA: 6, MX: 15, TXT: 16, AAAA: 28, CAA: 257 }
const TYPE_NAMES = Object.fromEntries(Object.entries(RECORD_TYPES).map(([k, v]) => [v, k]))

const STATUS: Record<number, string> = { 0: 'NOERROR', 1: 'FORMERR', 2: 'SERVFAIL', 3: 'NXDOMAIN', 5: 'REFUSED' }

export type DnsAnswer = { name: string; type: string; ttl: number; data: string }
export type DnsResult = { status: string; answers: DnsAnswer[]; resolver: string; ms: number }

export async function resolve(name: string, type = 'A', signal?: AbortSignal): Promise<DnsResult> {
  let lastError: unknown
  for (const url of RESOLVERS) {
    const t0 = performance.now()
    try {
      const res = await fetch(url(name, type), { headers: { accept: 'application/dns-json' }, signal })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      return {
        status: STATUS[json.Status] ?? `RCODE${json.Status}`,
        answers: (json.Answer ?? []).map((a: { name: string; type: number; TTL: number; data: string }) => ({
          name: a.name.replace(/\.$/, ''),
          type: TYPE_NAMES[a.type] ?? String(a.type),
          ttl: a.TTL,
          data: a.data,
        })),
        resolver: new URL(url(name, type)).host,
        ms: performance.now() - t0,
      }
    } catch (err) {
      if (signal?.aborted) throw err
      lastError = err
    }
  }
  throw lastError instanceof Error ? lastError : new Error('no resolver answered')
}

/** First IPv4 (or IPv6) address for a name, or null when the name does not exist. */
export async function lookupAddress(name: string, signal?: AbortSignal): Promise<{ address: string | null; status: string }> {
  const a = await resolve(name, 'A', signal)
  const v4 = a.answers.find((x) => x.type === 'A')
  if (v4) return { address: v4.data, status: a.status }
  if (a.status === 'NXDOMAIN') return { address: null, status: a.status }
  const aaaa = await resolve(name, 'AAAA', signal)
  return { address: aaaa.answers.find((x) => x.type === 'AAAA')?.data ?? null, status: aaaa.status }
}
