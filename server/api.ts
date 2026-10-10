import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { forgejoActivity } from './activity.ts'
import { handleWebSearchApi } from './websearch.ts'
import { addMemory, agentsPrompt, answer, approve, automaticModels, createProject, deleteProject, listProjects, orderProjects, renameProject, updateMemory, contextOf, createThread, listQuick, clearQuick, suggestTitle, deleteMemory, deleteThread, getThread, listMemories, listThreads, models as agentModels, ollamaSource, removeOllamaKey, runTurn, setOllamaKey, stopThread, updateThread } from './agents.ts'
import { authEnabled, currentUser, finishLogin, logout, requireUser, startLogin } from './auth.ts'
import { addForge, listForges, removeForge } from './forges.ts'
import { githubCommits } from './github.ts'
import { addCaldav, listCaldav, removeCaldav } from './caldav.ts'
import { allCalendars, allEvents, createEvent, deleteEvent, updateEvent } from './calendars.ts'
import { disconnectGoogle, finishGoogle, googleAccount, googleEnabled, MAX_RANGE_DAYS, startGoogle } from './google.ts'
import { inbox } from './inbox.ts'
import { linkPreview } from './preview.ts'
import { cleanTrash, history, quota, setHistory, shareLink, createFile, fileLink, rangeRead, restore, streamFile, thumbnail, trash, trashDir, uploadedBytes, libraries, removeItems, rename, transfer, linkSeafile, listDir, lock, mkdir, unlock, unlocked, removeOffice, seafileInfo, setOffice, unlinkSeafile } from './seafile.ts'
import { officeCallback, officeCheck, officeConfig } from './office.ts'
import { archiveFile, cancelExtract, extractStatus, listArchive, startExtract } from './unzip.ts'
import { removeUpdownKey, setUpdownKey, updownChecks, updownSource } from './updown.ts'
import { HttpError, json, readJson, redirect, sameOrigin, SECURITY, UNTRUSTED } from './http.ts'
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
        caldav: user ? listCaldav(user) : [],
        integrations: { updown: user ? updownSource(user) : null, ollama: user ? ollamaSource(user) : null },
        seafile: user ? seafileInfo(user) : null,
      })
      return true
    }

    // Google Calendar, attached to the signed-in owner (server/google.ts).
    if (read && path === '/api/google/connect') {
      if (!currentUser(req)) return redirect(res, '/?google=signin'), true
      return startGoogle(req, res), true
    }
    if (read && path === '/api/google/callback') return await finishGoogle(req, res, url, currentUser(req)), true

    // OnlyOffice's document server saying a document was edited: not a browser, so no same-origin
    // check; its sealed ticket and OnlyOffice's signature are checked instead (server/office.ts).
    if (path === '/api/office/callback' && method === 'POST') return json(res, 200, await officeCallback(req, url.searchParams.get('t'), await readJson(req, 64 * 1024))), true

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
    if (path === '/api/caldav' && method === 'POST') return json(res, 200, await addCaldav(requireUser(req), await readJson(req, 8 * 1024))), true
    const caldavId = /^\/api\/caldav\/(\d+)$/.exec(path)?.[1]
    if (caldavId && method === 'DELETE') return removeCaldav(requireUser(req), Number(caldavId)), json(res, 200, { ok: true }), true
    if (path === '/api/calendar/calendars' && read) return json(res, 200, await allCalendars(requireUser(req))), true
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
        if (isNaN(from.getTime()) || isNaN(to.getTime()) || to <= from || to.getTime() - from.getTime() > MAX_RANGE_DAYS * 864e5) throw new HttpError(400, 'Bad date range')
      }
      return json(res, 200, await allEvents(requireUser(req), ids ? ids.split(',') : null, { from, to })), true
    }
    // The Calendar app's changes: { calendar, event } to add, { ref, event, calendar?, all? } to change, { ref, all? } to delete.
    if (path === '/api/calendar/events' && method === 'POST') return await createEvent(requireUser(req), await readJson(req, 64 * 1024)), json(res, 200, { ok: true }), true
    if (path === '/api/calendar/events' && method === 'PATCH') return await updateEvent(requireUser(req), await readJson(req, 64 * 1024)), json(res, 200, { ok: true }), true
    if (path === '/api/calendar/events' && method === 'DELETE') return await deleteEvent(requireUser(req), await readJson(req, 8 * 1024)), json(res, 200, { ok: true }), true
    if (path === '/api/integrations/updown' && method === 'PUT') return await setUpdownKey(requireUser(req), await readJson(req, 4096)), json(res, 200, { ok: true }), true
    if (path === '/api/integrations/updown' && method === 'DELETE') return removeUpdownKey(requireUser(req)), json(res, 200, { ok: true }), true
    // Seafile, for the Files app (server/seafile.ts): link with { url, username, password, otp? }.
    if (path === '/api/integrations/seafile' && method === 'POST') return json(res, 200, await linkSeafile(requireUser(req), await readJson(req, 8 * 1024))), true
    if (path === '/api/integrations/seafile' && method === 'DELETE') return await unlinkSeafile(requireUser(req)), json(res, 200, { ok: true }), true
    if (path === '/api/integrations/onlyoffice' && method === 'PUT') return await setOffice(requireUser(req), await readJson(req, 8 * 1024)), json(res, 200, seafileInfo(requireUser(req))), true
    if (path === '/api/integrations/onlyoffice' && method === 'DELETE') return removeOffice(requireUser(req)), json(res, 200, seafileInfo(requireUser(req))), true
    if (path === '/api/office/check' && read) return json(res, 200, await officeCheck(req, requireUser(req), url.searchParams.get('repo'), url.searchParams.get('p'))), true
    if (path === '/api/office/config' && read) return json(res, 200, await officeConfig(req, requireUser(req), url.searchParams.get('repo'), url.searchParams.get('p'), { theme: url.searchParams.get('theme'), mobile: url.searchParams.has('mobile') })), true
    if (path === '/api/seafile/libraries' && read) return json(res, 200, await libraries(requireUser(req))), true
    if (path === '/api/seafile/dir' && read) return json(res, 200, await listDir(requireUser(req), url.searchParams.get('repo'), url.searchParams.get('p'))), true
    if (path === '/api/seafile/dir' && method === 'POST') return json(res, 200, await mkdir(requireUser(req), await readJson(req, 8 * 1024))), true
    if (path === '/api/seafile/file' && method === 'POST') return json(res, 200, await createFile(requireUser(req), await readJson(req, 8 * 1024))), true
    if (path === '/api/seafile/rename' && method === 'POST') return json(res, 200, await rename(requireUser(req), await readJson(req, 8 * 1024))), true
    if (path === '/api/seafile/delete' && method === 'POST') return await removeItems(requireUser(req), await readJson(req, 256 * 1024)), json(res, 200, { ok: true }), true
    if (path === '/api/seafile/transfer' && method === 'POST') return await transfer(requireUser(req), await readJson(req, 256 * 1024)), json(res, 200, { ok: true }), true
    if (path === '/api/seafile/thumb' && read) {
      const t = await thumbnail(requireUser(req), url.searchParams.get('repo'), url.searchParams.get('p'), url.searchParams.get('size'))
      res.writeHead(200, { 'Content-Type': t.type, 'Cache-Control': 'private, max-age=3600', ...SECURITY }).end(head ? undefined : t.body)
      return true
    }
    if (path === '/api/seafile/trash' && read) {
      const q = (k: string) => url.searchParams.get(k)
      return json(res, 200, q('commit') ? await trashDir(requireUser(req), q('repo'), q('commit'), q('p')) : await trash(requireUser(req), q('repo'), q('p'), q('scan'))), true
    }
    if (path === '/api/seafile/trash/restore' && method === 'POST') return json(res, 200, await restore(requireUser(req), await readJson(req, 256 * 1024))), true
    if (path === '/api/seafile/trash/clean' && method === 'POST') return await cleanTrash(requireUser(req), await readJson(req, 4096)), json(res, 200, { ok: true }), true
    if (path === '/api/seafile/quota' && read) return json(res, 200, await quota(requireUser(req))), true
    if (path === '/api/seafile/history' && read) return json(res, 200, await history(requireUser(req), url.searchParams.get('repo'))), true
    if (path === '/api/seafile/history' && method === 'POST') return json(res, 200, await setHistory(requireUser(req), await readJson(req, 4096))), true
    if (path === '/api/seafile/share' && method === 'POST') return json(res, 200, await shareLink(requireUser(req), await readJson(req, 4096))), true
    if (path === '/api/seafile/uploaded' && read) return json(res, 200, await uploadedBytes(requireUser(req), url.searchParams.get('repo'), url.searchParams.get('parent'), url.searchParams.get('name'))), true
    // Archives in Seafile (server/unzip.ts): what one holds, one file from a tar, and unpacking
    // (start a job, ask how it goes, cancel it).
    if (path === '/api/seafile/archive' && read) return json(res, 200, await listArchive(requireUser(req), url.searchParams.get('repo'), url.searchParams.get('p'))), true
    if (path === '/api/seafile/archive/file' && read) {
      const f = await archiveFile(requireUser(req), url.searchParams.get('repo'), url.searchParams.get('p'), url.searchParams.get('entry'))
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(f.size),
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`,
        'Cache-Control': 'private, no-store',
        ...SECURITY,
      })
      if (head) return f.body.destroy(), res.end(), true
      f.body.on('error', () => res.destroy())
      res.on('close', () => f.body.destroy())
      f.body.pipe(res)
      return true
    }
    if (path === '/api/seafile/extract' && method === 'POST') return json(res, 200, await startExtract(requireUser(req), await readJson(req, 4 * 1024 * 1024))), true
    if (path === '/api/seafile/extract' && read) return json(res, 200, extractStatus(requireUser(req), url.searchParams.get('id'), url.searchParams.get('since'))), true
    if (path === '/api/seafile/extract' && method === 'DELETE') return cancelExtract(requireUser(req), url.searchParams.get('id')), json(res, 200, { ok: true }), true
    // Byte ranges of a file, for the ZIP viewer (Seafile's file server sends no CORS headers on 206).
    if (path === '/api/seafile/raw' && read) {
      const range = req.headers.range
      const r = await rangeRead(requireUser(req), url.searchParams.get('repo'), url.searchParams.get('p'), typeof range === 'string' ? range : undefined)
      res.writeHead(206, { 'Content-Type': 'application/octet-stream', 'Content-Range': r.contentRange, 'Content-Length': String(r.body.length), 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=600', ...SECURITY, ...UNTRUSTED }).end(head ? undefined : r.body)
      return true
    }
    // A whole file, piped with whatever range the browser asks for (the music player).
    if (path === '/api/seafile/stream' && read) {
      const range = req.headers.range
      const r = await streamFile(requireUser(req), url.searchParams.get('repo'), url.searchParams.get('p'), typeof range === 'string' ? range : undefined)
      // Only media types pass: an HTML or SVG file served from this origin would run as the site.
      const type = r.headers.get('content-type') ?? ''
      const headers: Record<string, string> = { 'Content-Type': /^(audio|video)\//i.test(type) ? type : 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=600', ...SECURITY, ...UNTRUSTED }
      for (const h of ['content-length', 'content-range']) {
        const v = r.headers.get(h)
        if (v) headers[h.replace(/(^|-)\w/g, (c) => c.toUpperCase())] = v
      }
      res.writeHead(r.status, headers)
      if (head || !r.body) {
        await r.body?.cancel().catch(() => {})
        res.end()
        return true
      }
      const body = Readable.fromWeb(r.body as import('node:stream/web').ReadableStream)
      res.on('close', () => body.destroy())
      body.on('error', () => res.destroy())
      body.pipe(res)
      return true
    }
    if (path === '/api/seafile/link' && read) return json(res, 200, await fileLink(requireUser(req), url.searchParams.get('repo'), url.searchParams.get('p'), url.searchParams.get('op'))), true
    if (path === '/api/seafile/unlock' && method === 'POST') return json(res, 200, await unlock(requireUser(req), await readJson(req, 8 * 1024))), true
    if (path === '/api/seafile/unlock' && read) return json(res, 200, unlocked(requireUser(req))), true
    if (path === '/api/seafile/lock' && method === 'POST') return lock(requireUser(req), (await readJson<{ repo?: string }>(req, 1024)).repo), json(res, 200, { ok: true }), true
    if (path === '/api/updown' && read) return json(res, 200, await updownChecks(requireUser(req))), true

    // The Agents app (server/agents.ts): Ollama Cloud's key, threads, a turn (streamed) and memory.
    if (path === '/api/integrations/ollama' && method === 'PUT') return await setOllamaKey(requireUser(req), await readJson(req, 4096)), json(res, 200, { ok: true }), true
    if (path === '/api/integrations/ollama' && method === 'DELETE') return removeOllamaKey(requireUser(req)), json(res, 200, { ok: true }), true
    if (path === '/api/agents/defaults' && read) return requireUser(req), json(res, 200, await automaticModels()), true
    if (path === '/api/agents/models' && read) return requireUser(req), json(res, 200, await agentModels()), true
    if (path === '/api/agents/threads' && read) return json(res, 200, listThreads(requireUser(req), url.searchParams.get('archived') === '1')), true
    if (path === '/api/agents/quick' && read) return json(res, 200, listQuick(requireUser(req))), true
    if (path === '/api/agents/quick' && method === 'DELETE') return clearQuick(requireUser(req)), json(res, 200, { ok: true }), true
    if (path === '/api/agents/threads' && method === 'POST') return json(res, 200, await createThread(requireUser(req), await readJson(req, 4096))), true
    const agentThread = /^\/api\/agents\/threads\/([0-9a-f-]{36})(\/messages|\/stop|\/approve|\/answer|\/title|\/context)?$/.exec(path)
    if (agentThread) {
      const [, tid, sub] = agentThread
      if (!sub && read) return json(res, 200, getThread(requireUser(req), tid)), true
      if (!sub && method === 'PATCH') return json(res, 200, await updateThread(requireUser(req), tid, await readJson(req, 4096))), true
      if (!sub && method === 'DELETE') return deleteThread(requireUser(req), tid), json(res, 200, { ok: true }), true
      if (sub === '/messages' && method === 'POST') {
        const user = requireUser(req)
        return await runTurn(res, user, tid, await readJson(req, 16 * 1024 * 1024)), true
      }
      if (sub === '/stop' && method === 'POST') return stopThread(requireUser(req), tid), json(res, 200, { ok: true }), true
      if (sub === '/title' && method === 'POST') return json(res, 200, await suggestTitle(requireUser(req), tid)), true
      if (sub === '/context' && read) return json(res, 200, await contextOf(requireUser(req), tid)), true
      if (sub === '/answer' && method === 'POST') return answer(requireUser(req), tid, await readJson(req, 64 * 1024)), json(res, 200, { ok: true }), true
      if (sub === '/approve' && method === 'POST') return approve(requireUser(req), tid, await readJson(req, 1024)), json(res, 200, { ok: true }), true
    }
    if (path === '/api/agents/prompt' && read) return json(res, 200, await agentsPrompt(requireUser(req), url.searchParams.has('fresh'))), true
    if (path.startsWith('/api/agents/websearch') && (await handleWebSearchApi(req, res, url, method, requireUser(req)))) return true
    if (path === '/api/agents/projects' && read) return json(res, 200, listProjects(requireUser(req))), true
    if (path === '/api/agents/projects' && method === 'POST') return json(res, 200, createProject(requireUser(req), await readJson(req, 4096))), true
    if (path === '/api/agents/projects/order' && method === 'PUT') return json(res, 200, orderProjects(requireUser(req), await readJson(req, 16 * 1024))), true
    const projectId = /^\/api\/agents\/projects\/(\d+)$/.exec(path)?.[1]
    if (projectId && method === 'PATCH') return json(res, 200, renameProject(requireUser(req), projectId, await readJson(req, 4096))), true
    if (projectId && method === 'DELETE') return deleteProject(requireUser(req), projectId), json(res, 200, { ok: true }), true
    if (path === '/api/agents/memories' && method === 'POST') return json(res, 200, addMemory(requireUser(req), await readJson(req, 8192))), true
    if (path === '/api/agents/memories' && read) return json(res, 200, listMemories(requireUser(req))), true
    const memoryId = /^\/api\/agents\/memories\/(\d+)$/.exec(path)?.[1]
    if (memoryId && method === 'PATCH') return json(res, 200, updateMemory(requireUser(req), memoryId, await readJson(req, 8192))), true
    if (memoryId && method === 'DELETE') return deleteMemory(requireUser(req), Number(memoryId)), json(res, 200, { ok: true }), true
    if (path === '/api/preview' && read) {
      requireUser(req) // fetches other sites on request: the signed-in owner only
      const res2 = await linkPreview(url.searchParams.get('url') ?? '')
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'private, max-age=3600', ...SECURITY }).end(JSON.stringify(res2))
      return true
    }
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
