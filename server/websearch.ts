import type { IncomingMessage, ServerResponse } from 'node:http'
import type { User } from './auth.ts'
import { database, decrypt, encrypt } from './db.ts'
import { HttpError, json, readJson } from './http.ts'

// The Agents app's web search, with a choice of provider. Ollama's own search is the default and
// needs nothing beyond the Ollama key the agent already has; the others are set up in the Agents
// settings. Reading a page (web_fetch) stays on Ollama whatever is picked here.
//
// The settings, keys and header values included, are stored as one encrypted JSON blob in the
// `integrations` table under the name "websearch". The browser only ever learns which secrets are
// set, never their values, and saving with a secret left empty keeps the stored one.
//
// Where each provider's request and answer come from (checked 2026-10-10):
// - Ollama: https://docs.ollama.com/capabilities/web-search
//   POST https://ollama.com/api/web_search, "Authorization: Bearer <key>", body {query, max_results
//   (max 10)}, answers {results: [{title, url, content}]}.
// - SearXNG: https://docs.searxng.org/dev/search_api.html
//   GET <instance>/search?q=…&format=json. The JSON format has to be enabled under search.formats in
//   the instance's settings.yml, or it answers 403. Answers {results: [{title, url, content, …}]}
//   (searx/webutils.py, get_json_response). No key; an optional Authorization value is sent for
//   instances behind basic auth or a proxy token.
// - Brave Search: https://api-dashboard.search.brave.com/app/documentation/web-search/get-started
//   GET https://api.search.brave.com/res/v1/web/search?q=…&count=… (count at most 20),
//   "X-Subscription-Token: <key>", answers {web: {results: [{title, url, description}]}}.
//   Descriptions carry <strong> highlights, which are stripped.
// - Kagi: https://kagi.com/api/docs (OpenAPI spec at https://kagi.com/api/docs/_spec/openapi.yaml)
//   POST https://kagi.com/api/v1/search, "Authorization: Bearer <key>", body {query, limit},
//   answers {meta, data: {search: [{url, title, snippet}], …}}; errors come as HTTP 400 with
//   {errors: [{code, message}]}, a bad key as code "general.invalid_token" (tried 2026-10-10).
// - Tavily: https://docs.tavily.com/documentation/api-reference/endpoint/search
//   POST https://api.tavily.com/search, "Authorization: Bearer <key>", body {query, max_results
//   (0 to 20), search_depth}, answers {results: [{title, url, content}]}. 432 and 433 mean a plan
//   or pay-as-you-go limit was reached.

// Stand-ins for testing, like OLLAMA_URL in server/agents.ts; the real APIs are the defaults.
const OLLAMA = (process.env.OLLAMA_URL || 'https://ollama.com').replace(/\/+$/, '')
const BRAVE = process.env.WEBSEARCH_BRAVE_URL || 'https://api.search.brave.com/res/v1/web/search'
const KAGI = process.env.WEBSEARCH_KAGI_URL || 'https://kagi.com/api/v1/search'
const TAVILY = process.env.WEBSEARCH_TAVILY_URL || 'https://api.tavily.com/search'

const NAME = 'websearch'
const SNIPPET_CHARS = 1200
// Search answers are small; anything far bigger is not a search API and is not read to the end.
const BODY_LIMIT = 4 * 1024 * 1024

export type SearchResult = { title: string; url: string; snippet: string }
export type Provider = 'ollama' | 'searxng' | 'brave' | 'kagi' | 'tavily' | 'custom'
export const PROVIDERS: Provider[] = ['ollama', 'searxng', 'brave', 'kagi', 'tavily', 'custom']
const LABEL: Record<Provider, string> = { ollama: 'Ollama', searxng: 'SearXNG', brave: 'Brave Search', kagi: 'Kagi', tavily: 'Tavily', custom: 'The custom search API' }

/** Where the results and their fields are in a custom API's JSON, as dot paths ("data.items"). */
export type ResultMap = { results: string; title: string; url: string; snippet: string }
export type CustomApi = { url: string; method: 'GET' | 'POST'; body: string; headers: { name: string; value: string }[]; map: ResultMap }
type KeyOnly = { key: string }
export type Settings = { provider: Provider; searxng: { url: string; auth: string }; brave: KeyOnly; kagi: KeyOnly; tavily: KeyOnly; custom: CustomApi }

/** What the browser sees: the settings with every secret replaced by whether it is set. */
export type WebSearchView = {
  provider: Provider
  searxng: { url: string; auth: boolean }
  brave: { key: boolean }
  kagi: { key: boolean }
  tavily: { key: boolean }
  custom: Omit<CustomApi, 'headers'> & { headers: { name: string; set: boolean }[] }
}

/** What the browser sends. Every part is optional; a secret left empty keeps the stored one. */
export type WebSearchInput = {
  provider?: Provider
  searxng?: { url?: string; auth?: string }
  brave?: { key?: string }
  kagi?: { key?: string }
  tavily?: { key?: string }
  custom?: { url?: string; method?: string; body?: string; headers?: { name?: string; value?: string }[]; map?: Partial<ResultMap> }
}

const defaults = (): Settings => ({
  provider: 'ollama',
  searxng: { url: '', auth: '' },
  brave: { key: '' },
  kagi: { key: '' },
  tavily: { key: '' },
  custom: { url: '', method: 'GET', body: '', headers: [], map: { results: '', title: '', url: '', snippet: '' } },
})

// --- storage -----------------------------------------------------------------------------------

export function loadSettings(user: User): Settings {
  const row = database().prepare('SELECT secret FROM integrations WHERE user_id = ? AND name = ?').get(user.id, NAME) as { secret: string } | undefined
  if (!row) return defaults()
  // A blob that no longer decrypts or parses (a changed SESSION_SECRET) falls back to Ollama
  // rather than breaking every search.
  try {
    const saved = JSON.parse(decrypt(row.secret)) as Partial<Settings>
    const d = defaults()
    return {
      provider: PROVIDERS.includes(saved.provider as Provider) ? (saved.provider as Provider) : 'ollama',
      searxng: { ...d.searxng, ...saved.searxng },
      brave: { ...d.brave, ...saved.brave },
      kagi: { ...d.kagi, ...saved.kagi },
      tavily: { ...d.tavily, ...saved.tavily },
      custom: { ...d.custom, ...saved.custom, map: { ...d.custom.map, ...saved.custom?.map } },
    }
  } catch {
    return defaults()
  }
}

function storeSettings(user: User, s: Settings) {
  database()
    .prepare('INSERT INTO integrations (user_id, name, secret, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, name) DO UPDATE SET secret = excluded.secret')
    .run(user.id, NAME, encrypt(JSON.stringify(s)), Date.now())
}

export function viewSettings(s: Settings): WebSearchView {
  return {
    provider: s.provider,
    searxng: { url: s.searxng.url, auth: !!s.searxng.auth },
    brave: { key: !!s.brave.key },
    kagi: { key: !!s.kagi.key },
    tavily: { key: !!s.tavily.key },
    custom: { ...s.custom, headers: s.custom.headers.map((h) => ({ name: h.name, set: !!h.value })) },
  }
}

/** The Ollama key, read the same way server/agents.ts does: saved in Settings, else the server's. */
function ollamaKeyOf(user: User): string {
  const row = database().prepare('SELECT secret FROM integrations WHERE user_id = ? AND name = ?').get(user.id, 'ollama') as { secret: string } | undefined
  return row ? decrypt(row.secret) : process.env.OLLAMA_API_KEY?.trim() || ''
}

// --- validation --------------------------------------------------------------------------------

const bad = (message: string) => new HttpError(400, message)

function text(v: unknown, max: number, what: string): string | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') throw bad(`${what} must be text`)
  const s = v.trim()
  if (s.length > max) throw bad(`${what} is too long (at most ${max} characters)`)
  return s
}

function httpUrl(s: string, what: string) {
  let u: URL
  try {
    u = new URL(s)
  } catch {
    throw bad(`${what} is not a URL`)
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw bad(`${what} must start with http:// or https://`)
}

const PATH = /^(\.|[\w$@-]+(\.[\w$@-]+)*)$/
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

/** Folds what the browser sent into the stored settings, then checks the chosen provider has what it needs. */
export function mergeSettings(old: Settings, input: WebSearchInput): Settings {
  if (!input || typeof input !== 'object') throw bad('Expected the web search settings')
  const s: Settings = structuredClone(old)
  if (input.provider !== undefined) {
    if (!PROVIDERS.includes(input.provider)) throw bad('Unknown search provider')
    s.provider = input.provider
  }
  if (input.searxng) {
    s.searxng.url = text(input.searxng.url, 2000, 'The SearXNG URL') ?? s.searxng.url
    s.searxng.auth = text(input.searxng.auth, 4000, 'The SearXNG Authorization value') || s.searxng.auth
  }
  for (const p of ['brave', 'kagi', 'tavily'] as const) {
    const key = text(input[p]?.key, 4000, `The ${LABEL[p]} key`)
    if (key) s[p].key = key
  }
  const c = input.custom
  if (c) {
    s.custom.url = text(c.url, 2000, 'The URL template') ?? s.custom.url
    if (c.method !== undefined) {
      if (c.method !== 'GET' && c.method !== 'POST') throw bad('The method must be GET or POST')
      s.custom.method = c.method
    }
    s.custom.body = text(c.body, 8000, 'The body template') ?? s.custom.body
    if (c.headers !== undefined) {
      if (!Array.isArray(c.headers) || c.headers.length > 20) throw bad('At most 20 headers')
      s.custom.headers = c.headers.map((h) => {
        const name = text(h?.name, 200, 'A header name') ?? ''
        if (!HEADER_NAME.test(name)) throw bad(`"${name}" is not a valid header name`)
        const value = text(h?.value, 4000, `The ${name} header`) || old.custom.headers.find((o) => o.name.toLowerCase() === name.toLowerCase())?.value || ''
        if (!value) throw bad(`The ${name} header needs a value`)
        if (/[\r\n]/.test(value)) throw bad(`The ${name} header cannot hold line breaks`)
        return { name, value }
      })
    }
    if (c.map) {
      for (const k of ['results', 'title', 'url', 'snippet'] as const) s.custom.map[k] = text(c.map[k], 200, `The ${k} path`) ?? s.custom.map[k]
    }
  }
  validate(s)
  return s
}

function validate(s: Settings) {
  switch (s.provider) {
    case 'searxng':
      if (!s.searxng.url) throw bad("Fill in your SearXNG instance's URL")
      httpUrl(s.searxng.url, 'The SearXNG URL')
      return
    case 'brave':
    case 'kagi':
    case 'tavily':
      if (!s[s.provider].key) throw bad(`Paste a ${LABEL[s.provider]} API key`)
      return
    case 'custom': {
      const c = s.custom
      if (!c.url) throw bad('Fill in the URL template')
      if (!c.url.includes('{query}') && !(c.method === 'POST' && c.body.includes('{query}'))) throw bad('Put {query} in the URL template, or in the body of a POST')
      httpUrl(fill(c.url, 'test', 5, encodeURIComponent), 'The URL template')
      if (c.method === 'POST' && c.body) {
        try {
          JSON.parse(fill(c.body, 'test "quoted"', 5, jsonEscape))
        } catch {
          throw bad('The body template is not JSON once {query} and {count} are filled in. Put {query} inside quotes: "q": "{query}"')
        }
      }
      for (const k of ['results', 'title', 'url'] as const) if (!c.map[k]) throw bad(`Fill in the ${k} path`)
      for (const k of ['results', 'title', 'url', 'snippet'] as const) if (c.map[k] && !PATH.test(c.map[k])) throw bad(`The ${k} path should look like data.items or name (or . for the whole answer)`)
      return
    }
  }
}

// --- requests ----------------------------------------------------------------------------------

const jsonEscape = (s: string) => JSON.stringify(s).slice(1, -1)
const fill = (template: string, query: string, count: number, escape: (s: string) => string) => template.replaceAll('{query}', escape(query)).replaceAll('{count}', String(count))

export type SearchRequest = { url: string; init: RequestInit }

/** The HTTP request a provider is asked with. Exported for the tests. */
export function buildRequest(s: Settings, ollamaKey: string, query: string, max: number): SearchRequest {
  const jsonPost = (url: string, auth: string, body: unknown): SearchRequest => ({
    url,
    init: { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) },
  })
  switch (s.provider) {
    case 'ollama':
      if (!ollamaKey) throw new HttpError(409, 'Add an Ollama API key in Settings → Integrations first')
      return jsonPost(`${OLLAMA}/api/web_search`, `Bearer ${ollamaKey}`, { query, max_results: max })
    case 'searxng': {
      // Accept both the instance's root and its /search page.
      const base = s.searxng.url.replace(/\/+$/, '').replace(/\/search$/, '')
      const headers: Record<string, string> = { Accept: 'application/json' }
      if (s.searxng.auth) headers.Authorization = s.searxng.auth
      return { url: `${base}/search?${new URLSearchParams({ q: query, format: 'json' })}`, init: { method: 'GET', headers } }
    }
    case 'brave':
      // Brave rejects queries over 400 characters.
      return { url: `${BRAVE}?${new URLSearchParams({ q: query.slice(0, 400), count: String(max) })}`, init: { method: 'GET', headers: { Accept: 'application/json', 'X-Subscription-Token': s.brave.key } } }
    case 'kagi':
      return jsonPost(KAGI, `Bearer ${s.kagi.key}`, { query, limit: max })
    case 'tavily':
      return jsonPost(TAVILY, `Bearer ${s.tavily.key}`, { query, max_results: max, search_depth: 'basic' })
    case 'custom': {
      const c = s.custom
      const headers: Record<string, string> = { Accept: 'application/json' }
      const post = c.method === 'POST'
      if (post && c.body) headers['Content-Type'] = 'application/json'
      // The owner's headers come last, so they can replace Accept or Content-Type.
      for (const h of c.headers) headers[h.name] = h.value
      return { url: fill(c.url, query, max, encodeURIComponent), init: { method: c.method, headers, ...(post && c.body ? { body: fill(c.body, query, max, jsonEscape) } : {}) } }
    }
  }
}

/** Reads a response's text, giving up past BODY_LIMIT. */
async function readText(res: Response): Promise<string> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > BODY_LIMIT) {
      await reader.cancel().catch(() => {})
      throw new Error('too large')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** An error's own words, from the shapes these APIs use: {error}, {error: {detail}}, {detail}, {errors: [{message}]}. */
function errorDetail(body: unknown): string {
  const pick = (v: unknown): string => {
    if (typeof v === 'string') return v
    if (Array.isArray(v)) return pick(v[0])
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>
      return pick(o.message ?? o.detail ?? o.error ?? o.code ?? '')
    }
    return ''
  }
  const o = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  return pick(o.error ?? o.errors ?? o.detail ?? o.message ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** Sends a request and reads its JSON, with failures turned into messages the window and the agent can use. */
async function call(provider: Provider, req: SearchRequest, signal: AbortSignal): Promise<unknown> {
  const label = LABEL[provider]
  // A timeout is reported as one; the agent being stopped is passed on as it is.
  const aborted = (e: unknown): never => {
    if ((signal.reason as Error | undefined)?.name === 'TimeoutError') throw new HttpError(504, `${label} took too long to answer`)
    throw e
  }
  let res: Response
  try {
    res = await fetch(req.url, { ...req.init, signal })
  } catch (e) {
    if (signal.aborted) aborted(e)
    // The host only: a custom URL can hold a key in its query.
    throw new HttpError(502, `${label} could not be reached at ${hostOf(req.url)}`)
  }
  let raw: string
  try {
    raw = await readText(res)
  } catch (e) {
    if (signal.aborted) aborted(e)
    throw new HttpError(502, `${label} sent an answer that is too large or broke off`)
  }
  let body: unknown
  let parsed = true
  try {
    body = JSON.parse(raw)
  } catch {
    parsed = false
  }
  if (!res.ok) {
    const detail = parsed ? errorDetail(body) : ''
    const tail = detail ? `: ${detail}` : ''
    if (provider === 'searxng' && res.status === 403) throw new HttpError(502, `SearXNG refused to answer in JSON. Add json under search.formats in the instance's settings.yml${tail}`)
    // Brave answers 422 for a malformed or unknown subscription token, Kagi 400 with an invalid_token code.
    const kagiToken = provider === 'kagi' && /token/i.test(JSON.stringify((body as { errors?: unknown })?.errors ?? ''))
    if (res.status === 401 || res.status === 403 || (provider === 'brave' && res.status === 422 && /token/i.test(detail)) || kagiToken)
      throw new HttpError(409, provider === 'ollama' ? 'Ollama refused the API key: set it again in Settings → Integrations' : `${label} refused the ${provider === 'custom' ? 'credentials' : 'API key'}${tail}`)
    if (res.status === 429 || (provider === 'tavily' && (res.status === 432 || res.status === 433))) throw new HttpError(429, `${label} says the rate or usage limit is reached${tail}`)
    throw new HttpError(502, `${label} answered ${res.status}${tail}`)
  }
  if (!parsed) throw new HttpError(502, `${label} did not answer with JSON`)
  return body
}

// --- answers -----------------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'" }
/** Plain text from a title or snippet: highlight tags stripped, common entities decoded, spaces collapsed. */
const plain = (v: unknown) =>
  (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '')
    .replace(/<[^>]{0,200}>/g, '')
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#39|#x27);/g, (_, e: string) => ENTITIES[e])
    .replace(/\s+/g, ' ')
    .trim()

const shape = (provider: Provider, expected: string) => new HttpError(502, `${LABEL[provider]} sent an answer in an unexpected shape (expected ${expected})`)
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Follows a dot path ("data.items.0") into parsed JSON; "." is the value itself. */
export function atPath(value: unknown, path: string): unknown {
  if (path === '.' || path === '') return value
  let at = value
  for (const key of path.split('.')) {
    if (Array.isArray(at) && /^\d+$/.test(key)) at = at[Number(key)]
    else if (isObject(at)) at = at[key]
    else return undefined
  }
  return at
}

/** Reads a list of results at `path`, with each result's fields at their own paths. */
function listAt(provider: Provider, body: unknown, path: string, fields: { title: string; url: string; snippet: string }, optional = false): SearchResult[] {
  const list = atPath(body, path)
  if (list === undefined && optional && isObject(body)) return []
  if (!Array.isArray(list)) throw shape(provider, path === '.' ? 'a list of results' : `a list at ${path}`)
  return list.map((r) => ({ title: plain(atPath(r, fields.title)), url: plain(atPath(r, fields.url)), snippet: plain(fields.snippet ? atPath(r, fields.snippet) : '') }))
}

// One parser per provider, exported for the tests. Each answers the results as sent, before
// clipping and capping.
export const parseOllama = (body: unknown) => listAt('ollama', body, 'results', { title: 'title', url: 'url', snippet: 'content' })
export const parseSearxng = (body: unknown) => listAt('searxng', body, 'results', { title: 'title', url: 'url', snippet: 'content' })
// Brave leaves out `web` when nothing was found.
export const parseBrave = (body: unknown) => listAt('brave', body, 'web.results', { title: 'title', url: 'url', snippet: 'description' }, true)
export function parseKagi(body: unknown) {
  // Kagi sorts results by kind under `data`; web pages are `data.search`, absent when there are none.
  if (!isObject(body) || !isObject(body.data)) throw shape('kagi', 'an object at data')
  return listAt('kagi', body, 'data.search', { title: 'title', url: 'url', snippet: 'snippet' }, true)
}
export const parseTavily = (body: unknown) => listAt('tavily', body, 'results', { title: 'title', url: 'url', snippet: 'content' })
export const parseCustom = (body: unknown, map: ResultMap) => listAt('custom', body, map.results, { title: map.title, url: map.url, snippet: map.snippet })

export function parse(s: Settings, body: unknown): SearchResult[] {
  switch (s.provider) {
    case 'ollama':
      return parseOllama(body)
    case 'searxng':
      return parseSearxng(body)
    case 'brave':
      return parseBrave(body)
    case 'kagi':
      return parseKagi(body)
    case 'tavily':
      return parseTavily(body)
    case 'custom':
      return parseCustom(body, s.custom.map)
  }
}

/** Drops results without a URL, clips snippets and keeps at most `max`. */
export function finish(results: SearchResult[], max: number): SearchResult[] {
  return results
    .filter((r) => r.url)
    .slice(0, max)
    .map((r) => ({ title: r.title || r.url, url: r.url, snippet: r.snippet.length > SNIPPET_CHARS ? `${r.snippet.slice(0, SNIPPET_CHARS)}…` : r.snippet }))
}

/** A search with the given settings. Exported for the tests; the agent goes through webSearch. */
export async function searchWith(s: Settings, ollamaKey: string, query: string, max: number, signal: AbortSignal): Promise<{ provider: string; results: SearchResult[] }> {
  const n = Math.min(10, Math.max(1, Math.round(max) || 5))
  const body = await call(s.provider, buildRequest(s, ollamaKey, query, n), signal)
  return { provider: s.provider, results: finish(parse(s, body), n) }
}

/** The agent's web_search: the configured provider, or Ollama's search when nothing is set up. */
export async function webSearch(user: User, ollamaKey: string, query: string, max: number, signal: AbortSignal): Promise<{ provider: string; results: SearchResult[] }> {
  return searchWith(loadSettings(user), ollamaKey, query, max, signal)
}

// --- routes ------------------------------------------------------------------------------------

/** The Web search settings in Agents: read (no secrets), save, reset to Ollama, and a test search. */
export async function handleWebSearchApi(req: IncomingMessage, res: ServerResponse, url: URL, method: string, user: User): Promise<boolean> {
  const path = url.pathname
  if (path === '/api/agents/websearch') {
    if (method === 'GET') return json(res, 200, viewSettings(loadSettings(user))), true
    if (method === 'PUT') {
      const s = mergeSettings(loadSettings(user), await readJson<WebSearchInput>(req, 64 * 1024))
      storeSettings(user, s)
      return json(res, 200, viewSettings(s)), true
    }
    if (method === 'DELETE') {
      database().prepare('DELETE FROM integrations WHERE user_id = ? AND name = ?').run(user.id, NAME)
      return json(res, 200, viewSettings(defaults())), true
    }
    return false
  }
  if (path === '/api/agents/websearch/test' && method === 'POST') {
    // Tests the form as it is, saved or not, so a provider can be tried before switching to it.
    const body = await readJson<{ query?: unknown; settings?: WebSearchInput }>(req, 64 * 1024)
    const query = typeof body.query === 'string' ? body.query.trim().slice(0, 400) : ''
    if (!query) throw bad('Type something to search for')
    const stored = loadSettings(user)
    const s = body.settings ? mergeSettings(stored, body.settings) : stored
    const started = Date.now()
    const found = await searchWith(s, ollamaKeyOf(user), query, 5, AbortSignal.timeout(20_000))
    return json(res, 200, { ...found, ms: Date.now() - started }), true
  }
  return false
}
