import { guardDatabaseWrites } from './db.ts'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { sessionBinding, type User } from './auth.ts'
import { HttpError, SECURITY } from './http.ts'
import { sessionStored, track, type SessionBinding } from './liveSessions.ts'

// Slow private handlers share one immutable request authority. Provider helpers use this scope
// before side effects; the response checks it at headers, every write, and end (including HEAD/304).
// Background work may retain it until its own completion, rather than silently becoming anonymous.
type Scope = {
  req: IncomingMessage
  binding: SessionBinding
  userId: number
  signal: AbortSignal
  check: () => void
  end: (error: HttpError) => void
  keys: Set<string>
  access: Set<() => void>
  cleanup: Set<() => void>
  retain: () => () => void
}
type Operation = Pick<Scope, 'signal' | 'check' | 'end' | 'access' | 'cleanup' | 'keys'>
const operations = new AsyncLocalStorage<Operation>()
const targets = new AsyncLocalStorage<Set<number>>()
/** An already authorized admin operation may act on its target, retaining the admin session. */
export function withPrivateTarget<T>(user: Pick<User, 'id'>, work: () => T): T {
  requirePrivateRequest()
  return targets.run(new Set([...(targets.getStore() ?? []), user.id]), work)
}
const requests = new AsyncLocalStorage<Scope>()
const providerSignals = new AsyncLocalStorage<AbortSignal[]>()
const providerGuards = new AsyncLocalStorage<(() => void)[]>()
/** Preserve prepared provider authority across approval and every await in execution. */
export function withProviderGuard<T>(check: () => void, work: () => T): T {
  return providerGuards.run([...(providerGuards.getStore() ?? []), check], work)
}
/** An aggregate retains every participating provider until its result and side effects finish. */
export async function withPrivateOperation<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (requests.getStore() || operations.getStore()) return work()
  const gone = new AbortController()
  const scope: Operation = {
    signal: gone.signal, access: new Set(), cleanup: new Set(), keys: new Set(),
    check() { gone.signal.throwIfAborted(); for (const check of scope.access) check() },
    end(error) { gone.abort(error) },
  }
  const abort = () => scope.end(new HttpError(409, 'Operation ended'))
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  try {
    return await operations.run(scope, async () => {
      const result = await work()
      scope.check()
      return result
    })
  } finally { signal?.removeEventListener('abort', abort); for (const cleanup of scope.cleanup) cleanup() }
}

/** Immutable authority for callbacks/queued transports invoked outside their initiating context. */
export function privateAuthorityCheck(): () => void {
  const request = requests.getStore(), operation = operations.getStore(), guards = providerGuards.getStore() ?? []
  return () => { for (const guard of guards) guard(); operation?.check(); request?.check() }
}

/** Credential refresh stays single-flight, but each subscriber retains its own authority. The
 * detached job may commit only while a subscriber remains valid, and aborts when the last leaves. */
export function sharedProviderJob<T>(checkLink: () => void, subscribe: (end: () => void) => () => void, load: () => Promise<T>) {
  const gone = new AbortController()
  const clients = new Set<() => void>()
  let finished = false
  const verify = () => {
    gone.signal.throwIfAborted()
    checkLink()
    if (![...clients].some((check) => { try { check(); return true } catch { return false } })) throw new HttpError(401, 'Request ended')
  }
  // Defer the start until the first join has installed its subscriber.
  const value = withoutPrivateRequest(() => Promise.resolve().then(() => withProviderLifetime(verify, (end) => {
    const stop = subscribe(end)
    gone.signal.addEventListener('abort', end, { once: true })
    return () => { stop(); gone.signal.removeEventListener('abort', end) }
  }, load)))
  value.then(() => { finished = true }, () => { finished = true })
  return {
    value, signal: gone.signal,
    join(signal?: AbortSignal) {
      const check = privateAuthorityCheck(), current = privateSignal(signal)
      return new Promise<T>((resolve, reject) => {
        let ended = false
        const settle = (error?: unknown, result?: T) => {
          if (ended) return
          ended = true; clients.delete(check); current?.removeEventListener('abort', abort)
          if (!clients.size && !finished) gone.abort(new HttpError(401, 'Request ended'))
          if (error) reject(error); else resolve(result!)
        }
        const abort = () => settle(current?.reason ?? new HttpError(401, 'Request ended'))
        try { check(); current?.throwIfAborted() } catch (error) { settle(error); return }
        clients.add(check)
        current?.addEventListener('abort', abort, { once: true })
        value.then((result) => { try { check(); checkLink(); settle(undefined, result) } catch (error) { settle(error) } }, (error) => settle(error))
      })
    },
  }
}

/** Scope pending cache jobs to their initiating authority; settled results remain reusable. */
const cacheOwners = new WeakMap<Promise<unknown>, { authority: object | undefined; settled: boolean }>()
export function ownPrivateCache<T>(value: Promise<T>): Promise<T> {
  const owner = { authority: privateRequestAuthority(), settled: false }, check = privateAuthorityCheck()
  cacheOwners.set(value, owner)
  value.then(() => { try { check(); owner.settled = true } catch { /* revoked results stay unusable */ } }, () => {})
  return value
}
export function canUsePrivateCache(value: Promise<unknown>) {
  const owner = cacheOwners.get(value)
  return !owner || owner.settled || owner.authority === privateRequestAuthority()
}

/** Native fetch for trusted endpoints, with the same authority and body lifetime as guardedFetch. */
export async function privateFetch(input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit): Promise<Response> {
  const check = privateAuthorityCheck()
  check()
  const signal = privateSignal(init?.signal ?? (input instanceof Request ? input.signal : undefined))
  const response = await globalThis.fetch(input, { ...init, ...(signal ? { signal } : {}) })
  try { check(); signal?.throwIfAborted() }
  catch (error) { await response.body?.cancel().catch(() => {}); throw error }
  if (!response.body || (!requests.getStore() && !operations.getStore() && !providerGuards.getStore())) return response
  const reader = response.body.getReader()
  const cancel = () => { void reader.cancel(signal?.reason).catch(() => {}) }
  signal?.addEventListener('abort', cancel, { once: true })
  const done = () => signal?.removeEventListener('abort', cancel)
  const body = new ReadableStream<Uint8Array>({
    async pull(out) {
      try {
        check(); signal?.throwIfAborted()
        const next = await reader.read()
        check(); signal?.throwIfAborted()
        if (next.done) { done(); out.close() } else out.enqueue(next.value)
      } catch (error) { cancel(); done(); out.error(error) }
    },
    async cancel(reason) { done(); await reader.cancel(reason).catch(() => {}) },
  }, { highWaterMark: 0 })
  const guarded = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
  for (const name of ['url', 'redirected', 'type'] as const) Object.defineProperty(guarded, name, { value: response[name] })
  return guarded
}

/** Keeps standalone provider jobs abortable for their entire awaited lifetime. */
export async function withProviderLifetime<T>(check: () => void, subscribe: (end: () => void) => () => void, work: () => Promise<T>): Promise<T> {
  const gone = new AbortController()
  const guard = () => {
    gone.signal.throwIfAborted()
    try { check() } catch (error) { gone.abort(error); throw error }
  }
  const stop = subscribe(() => gone.abort(new HttpError(409, 'The linked account changed: try again')))
  try {
    return await providerSignals.run([...(providerSignals.getStore() ?? []), gone.signal], () => withProviderGuard(guard, async () => {
      requirePrivateRequest()
      const result = await work()
      requirePrivateRequest()
      return result
    }))
  } finally { stop() }
}
export const privateSessionBinding = () => requests.getStore()?.binding
export const privateRequestAuthority = (): object | undefined => requests.getStore() ?? operations.getStore() ?? providerGuards.getStore()
export const withoutPrivateRequest = <T>(work: () => T): T => requests.exit(() => targets.exit(() => operations.exit(() => providerGuards.exit(() => providerSignals.exit(work)))))
export const privateRequestActive = (req: IncomingMessage) => requests.getStore()?.req === req
export function requirePrivateRequest(user?: Pick<User, 'id'>) {
  for (const check of providerGuards.getStore() ?? []) check()
  operations.getStore()?.check()
  const scope = requests.getStore()
  if (!scope) return // autonomous provider jobs have no initiating HTTP session
  if (user && scope.userId !== user.id && !targets.getStore()?.has(user.id)) throw new HttpError(401, 'Not signed in')
  scope.check()
}
export function privateSignal(signal?: AbortSignal | null): AbortSignal | undefined {
  const signals = [...(providerSignals.getStore() ?? [])]
  if (operations.getStore()) signals.push(operations.getStore()!.signal)
  if (requests.getStore()?.signal) signals.push(requests.getStore()!.signal)
  if (signal) signals.push(signal)
  return signals.length ? AbortSignal.any(signals) : undefined
}
export const retainPrivateRequest = () => requests.getStore()?.retain() ?? (() => {})

/** Adds a provider lifetime to the original request, before its first provider await. */
export function bindPrivateAccess(check: () => void, subscribe: (end: () => void) => () => void, key?: string) {
  const scope = requests.getStore() ?? operations.getStore()
  if (!scope) return
  if (key && scope.keys.has(key)) { scope.check(); return }
  if (key) scope.keys.add(key)
  scope.access.add(check)
  scope.cleanup.add(subscribe(() => scope.end(new HttpError(409, 'The linked account changed: try again'))))
  scope.check()
}

export function runPrivateRequest<T>(req: IncomingMessage, res: ServerResponse, user: User, work: () => T, original?: SessionBinding): T {
  const binding = original ?? sessionBinding(req)
  if (!binding || binding.userId !== user.id) throw new HttpError(401, 'Not signed in')
  const gone = new AbortController()
  const writeHead = res.writeHead.bind(res), write = res.write.bind(res), end = res.end.bind(res)
  let invalid: HttpError | null = null
  let references = 1
  let disposed = false
  const scope: Scope = {
    req, binding, userId: user.id, signal: gone.signal, access: new Set(), cleanup: new Set(), keys: new Set(),
    check() {
      if (invalid) throw invalid
      if (Date.now() >= binding.expiresAt || !sessionStored(binding.key, binding.userId)) {
        scope.end(new HttpError(401, 'Not signed in'))
        throw invalid!
      }
      for (const check of scope.access) check()
    },
    end(error) {
      if (invalid) return
      invalid = error
      gone.abort(error)
      if (res.writableFinished || res.destroyed) return
      if (res.headersSent) res.destroy()
      else {
        for (const name of res.getHeaderNames()) res.removeHeader(name)
        writeHead(error.status, { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store', ...SECURITY })
        end(JSON.stringify({ error: error.message }))
      }
    },
    retain() {
      references++
      let released = false
      return () => {
        if (released) return
        released = true
        if (--references || disposed) return
        disposed = true
        live.stop()
        for (const cleanup of scope.cleanup) cleanup()
        scope.cleanup.clear()
      }
    },
  }
  const live = track(binding, () => scope.end(new HttpError(401, 'Not signed in')))
  // Treat the response's reference just like a background job's, releasing it exactly once.
  const release = scope.retain()
  references--
  res.once('finish', release)
  res.once('close', () => {
    if (!res.writableFinished) scope.end(new HttpError(401, 'Request ended'))
    release()
  })
  const allowed = () => {
    try { scope.check(); return !invalid }
    catch (error) {
      scope.end(error instanceof HttpError ? error : new HttpError(401, 'Not signed in'))
      return false
    }
  }
  res.writeHead = ((...args: unknown[]) => allowed() ? Reflect.apply(writeHead, res, args) : res) as typeof res.writeHead
  res.write = ((...args: unknown[]) => allowed() ? Reflect.apply(write, res, args) : false) as typeof res.write
  res.end = ((...args: unknown[]) => allowed() ? Reflect.apply(end, res, args) : res) as typeof res.end
  return requests.run(scope, work)
}

// Response serialization, trusted/guarded transport, and local writes share one commit guard.
guardDatabaseWrites(() => requirePrivateRequest())
