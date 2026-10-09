import type { IncomingMessage, ServerResponse } from 'node:http'
import { forgejoActivity } from './activity.ts'
import { authEnabled, currentUser, finishLogin, logout, requireUser, startLogin } from './auth.ts'
import { addForge, listForges, removeForge } from './forges.ts'
import { githubCommits } from './github.ts'
import { disconnectGoogle, finishGoogle, googleAccount, googleEnabled, listCalendars, listEvents, startGoogle } from './google.ts'
import { inbox } from './inbox.ts'
import { removeUpdownKey, setUpdownKey, updownChecks, updownSource } from './updown.ts'
import { HttpError, json, readJson, redirect, sameOrigin, SECURITY } from './http.ts'
import { minecraftOverview, minecraftStatus } from './minecraft.ts'
import { search, clearSearchCache } from './search.ts'
import { suggest } from './suggest.ts'
import { readState, writeState } from './state.ts'

// Every /api route, shared by the production server (server/index.ts) and Vite's dev and
// preview servers (vite.config.ts). Resolves true when it answered the request.

export async function handleApi(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname
  if (!path.startsWith('/api/')) return false
  const method = req.method ?? 'GET'
  const head = method === 'HEAD'
  const read = method === 'GET' || head

  try {
    // Public, read-only endpoints.
    if (read && (path === '/api/minecraft' || path === '/api/activity')) {
      const body = JSON.stringify(path === '/api/minecraft' ? await minecraftStatus() : { items: await forgejoActivity() })
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...SECURITY }).end(head ? undefined : body)
      return true
    }
    if (read && path === '/api/minecraft/overview') {
      json(res, 200, await minecraftOverview(url.searchParams.get('range')))
      return true
    }
    if (read && path === '/api/suggest') {
      json(res, 200, { suggestions: await suggest(url.searchParams.get('engine') ?? '', url.searchParams.get('q') ?? '') })
      return true
    }
    if (read && path === '/api/version') {
      json(res, 200, { version: process.env.APP_VERSION || 'dev', commit: process.env.APP_COMMIT || null })
      return true
    }
    if (read && path.startsWith('/api/git/')) {
      const r = await githubCommits(path.slice('/api/git/'.length) + url.search)
      res.writeHead(r.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...SECURITY }).end(head ? undefined : r.body)
      return true
    }

    // Sign-in.
    if (read && path === '/api/auth/github/login') return startLogin(req, res), true
    if (read && path === '/api/auth/github/callback') return await finishLogin(req, res, url), true
    if (read && path === '/api/me') {
      const user = currentUser(req)
      json(res, 200, {
        authEnabled: authEnabled(),
        user: user && { login: user.login, name: user.name, avatar: user.avatar },
        forges: user ? listForges(user) : [],
        googleEnabled: googleEnabled(),
        google: user ? googleAccount(user) : null,
        integrations: { updown: user ? updownSource(user) : null },
      })
      return true
    }

    // Google Calendar, attached to the signed-in owner (server/google.ts).
    if (read && path === '/api/google/connect') {
      if (!currentUser(req)) return redirect(res, '/?google=signin'), true
      return startGoogle(req, res), true
    }
    if (read && path === '/api/google/callback') return await finishGoogle(req, res, url, currentUser(req)), true

    // Everything below changes something or reads private data.
    if (!read && !sameOrigin(req)) throw new HttpError(403, 'Cross-site request')
    if (method === 'POST' && path === '/api/auth/logout') return logout(req, res), true

    if (path === '/api/state' && read) return json(res, 200, readState(requireUser(req))), true
    const stateKey = /^\/api\/state\/([^/]+)$/.exec(path)?.[1]
    if (stateKey && method === 'PUT') return json(res, 200, writeState(requireUser(req), decodeURIComponent(stateKey), await readJson(req))), true

    if (path === '/api/forges' && method === 'POST') {
      const user = requireUser(req)
      const forge = await addForge(user, await readJson(req, 16 * 1024))
      clearSearchCache(user)
      return json(res, 200, forge), true
    }
    const forgeId = /^\/api\/forges\/(\d+)$/.exec(path)?.[1]
    if (forgeId && method === 'DELETE') {
      const user = requireUser(req)
      removeForge(user, Number(forgeId))
      clearSearchCache(user)
      return json(res, 200, { ok: true }), true
    }

    if (path === '/api/google' && method === 'DELETE') return await disconnectGoogle(requireUser(req)), json(res, 200, { ok: true }), true
    if (path === '/api/calendar/calendars' && read) return json(res, 200, await listCalendars(requireUser(req))), true
    if (path === '/api/calendar/events' && read) {
      // ?from=&to= (ISO dates or times) for a range, or ?days=N from the start of today.
      const ids = url.searchParams.get('calendars')
      const q = (k: string) => url.searchParams.get(k)
      let from = new Date()
      from.setHours(0, 0, 0, 0)
      let to = new Date(from.getTime() + Math.min(14, Math.max(1, Number(q('days') ?? 3))) * 864e5)
      if (q('from') && q('to')) {
        from = new Date(q('from')!)
        to = new Date(q('to')!)
        if (isNaN(from.getTime()) || isNaN(to.getTime())) throw new HttpError(400, 'Bad date range')
      }
      return json(res, 200, await listEvents(requireUser(req), ids ? ids.split(',') : null, { from, to })), true
    }
    if (path === '/api/integrations/updown' && method === 'PUT') return await setUpdownKey(requireUser(req), await readJson(req, 4096)), json(res, 200, { ok: true }), true
    if (path === '/api/integrations/updown' && method === 'DELETE') return removeUpdownKey(requireUser(req)), json(res, 200, { ok: true }), true
    if (path === '/api/updown' && read) return json(res, 200, await updownChecks(requireUser(req))), true
    if (path === '/api/inbox' && read) return json(res, 200, await inbox(requireUser(req), url.searchParams.has('fresh'))), true

    if (path === '/api/search' && read) return json(res, 200, await search(requireUser(req), url.searchParams.get('q') ?? '')), true

    throw new HttpError(404, 'Not found')
  } catch (e) {
    if (res.headersSent) return true
    if (e instanceof HttpError) json(res, e.status, { error: e.message })
    else {
      console.error(e)
      json(res, 500, { error: 'Something went wrong' })
    }
    return true
  }
}
