import { AsyncLocalStorage } from 'node:async_hooks'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { sessionBinding, type User } from './auth.ts'
import { HttpError, SECURITY } from './http.ts'
import { sessionStored, track } from './liveSessions.ts'

// Slow private handlers share one immutable request authority. Provider helpers use this scope
// before side effects; the response checks it at headers, every write, and end (including HEAD/304).
// Background work may retain it until its own completion, rather than silently becoming anonymous.
type Scope = {
  req: IncomingMessage
  userId: number
  signal: AbortSignal
  check: () => void
  end: (error: HttpError) => void
  access: Set<() => void>
  cleanup: Set<() => void>
  retain: () => () => void
}
const requests = new AsyncLocalStorage<Scope>()
export const privateRequestAuthority = (): object | undefined => requests.getStore()
export const withoutPrivateRequest = <T>(work: () => T): T => requests.exit(work)
export const privateRequestActive = (req: IncomingMessage) => requests.getStore()?.req === req
export function requirePrivateRequest(user?: Pick<User, 'id'>) {
  const scope = requests.getStore()
  if (!scope) return // autonomous provider jobs have no initiating HTTP session
  if (user && scope.userId !== user.id) throw new HttpError(401, 'Not signed in')
  scope.check()
}
export function privateSignal(signal?: AbortSignal | null): AbortSignal | undefined {
  const own = requests.getStore()?.signal
  return own && signal ? AbortSignal.any([own, signal]) : own ?? signal ?? undefined
}
export const retainPrivateRequest = () => requests.getStore()?.retain() ?? (() => {})

/** Adds a provider lifetime to the original request, before its first provider await. */
export function bindPrivateAccess(check: () => void, subscribe: (end: () => void) => () => void) {
  const scope = requests.getStore()
  if (!scope) return
  scope.access.add(check)
  scope.cleanup.add(subscribe(() => scope.end(new HttpError(409, 'The linked account changed: try again'))))
  scope.check()
}

export function runPrivateRequest<T>(req: IncomingMessage, res: ServerResponse, user: User, work: () => T): T {
  const binding = sessionBinding(req)
  if (!binding || binding.userId !== user.id) throw new HttpError(401, 'Not signed in')
  const gone = new AbortController()
  const writeHead = res.writeHead.bind(res), write = res.write.bind(res), end = res.end.bind(res)
  let invalid: HttpError | null = null
  let references = 1
  let disposed = false
  const scope: Scope = {
    req, userId: user.id, signal: gone.signal, access: new Set(), cleanup: new Set(),
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
