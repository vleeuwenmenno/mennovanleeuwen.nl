import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { forgejoActivity } from './activity.ts'
import { handleWebSearchApi } from './websearch.ts'
import { fxRates } from './fx.ts'
import { addMemory, allowSite, listSites, removeSite, agentsPrompt, messagePicture, answer, approve, retryTurn, rewind, enqueue, override, editQueued, removeQueued, moveQueued, sendQueued, automaticModels, clientResult, skillInfo, skillsInstall, skillsList, skillsRemove, createProject, deleteProject, followThread, listProjects, orderProjects, renameProject, updateMemory, contextOf, createThread, listQuick, clearQuick, suggestTitle, regenerateTitle, deleteMemory, deleteThread, getThread, getMailReads, revokeMailReads, setMailReads, listMemories, listThreads, models as agentModels, ollamaSource, removeOllamaKey, runTurn, setOllamaKey, stopThread, updateThread } from './agents.ts'
import { adminStats, adminUser, banUser, listUsers, removeUser, signOutUser, unbanUser, updateSettings } from './admin.ts'
import { authEnabled, currentUser, finishLogin, logout, registration, requireAdmin, requireUser, startLogin } from './auth.ts'
import { addForge, listForges, removeForge } from './forges.ts'
import { githubCommits } from './github.ts'
import { handleGitApi } from './git.ts'
import { addCaldav, clearCaldavCache, listCaldav, removeCaldav } from './caldav.ts'
import { allCalendars, allEvents, createEvent, deleteEvent, knownUids, updateEvent } from './calendars.ts'
import { findLinked, noteLinkApi } from './noteLinks.ts'
import { handleContactsApi } from './contacts.ts'
import { handleTasksApi } from './tasks.ts'
import { handlePimApi } from './pim.ts'
import { empiresAway } from './empires.ts'
import { disconnectGoogle, finishGoogle, googleAccount, googleEnabled, MAX_RANGE_DAYS, startGoogle } from './google.ts'
import { inbox } from './inbox.ts'
import { linkPreview } from './preview.ts'
import { cleanTrash, history, quota, setHistory, shareLink, createFile, fileLink, rangeRead, restore, streamFile, thumbnail, trash, trashDir, uploadedBytes, libraries, removeItems, rename, transfer, linkSeafile, listDir, lock, mkdir, unlock, unlocked, removeOffice, seafileInfo, setOffice, unlinkSeafile } from './seafile.ts'
import { officeCallback, officeCheck, officeConfig } from './office.ts'
import { handlePhotosApi } from './photos.ts'
import { archiveFile, cancelExtract, extractStatus, listArchive, startExtract } from './unzip.ts'
import { removeUpdownKey, setUpdownKey, updownChecks, updownSource } from './updown.ts'
import { HttpError, json, readJson, redirect, sameOrigin, SECURITY, UNTRUSTED } from './http.ts'
import { pushPublicKey, pushToUser, subscribe, unsubscribe } from './webpush.ts'
import { changeEntries, listEntries, noticeFromPage, openStream, presence } from './notifier.ts'
import { minecraftAdmin, minecraftOverview, minecraftStatus, rconConfigured } from './minecraft.ts'
import { search, clearSearchCache, orgAccess } from './search.ts'
import { suggest } from './suggest.ts'
import { readState, writeState } from './state.ts'
import { deleteUser } from './users.ts'
import { createShare, deleteShare, isShareToken, listShares, serveShare } from './shares.ts'
import { handleMailApi } from './jmap.ts'

// Every /api route, shared by the production server (server/index.ts) and Vite's dev and
// preview servers (vite.config.ts), plus the one page outside /api the server renders itself:
// an Agents shared link (/s/<token>, server/shares.ts). Resolves true when it answered the request.

export async function handleApi(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  let url: URL
  try {
    url = new URL(req.url ?? '/', 'http://localhost')
  } catch {
    return false // not a path: server/index.ts answers 400
  }
  const path = url.pathname
  if (path.startsWith('/s/')) return serveShare(req, res, path)
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
    // Exchange rates, shared by everyone, guests too (server/fx.ts).
    if (read && path === '/api/fx') {
      const fx = await fxRates()
      if (!fx) return json(res, 503, { error: 'Exchange rates are unavailable right now' }), true
      const body = JSON.stringify({ ...fx.rates, stale: fx.stale })
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${fx.maxAge}`, ...SECURITY }).end(head ? undefined : body)
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
    if (read && path === '/api/auth/github/login') return startLogin(req, res, url), true
    if (read && path === '/api/auth/github/callback') return await finishLogin(req, res, url), true
    if (read && path === '/api/me') {
      const user = currentUser(req)
      json(res, 200, {
        authEnabled: authEnabled(),
        // Whether a new account could sign up now (the sign-in button says so before GitHub does).
        registration: authEnabled() ? (({ open, full }) => ({ open, full }))(registration()) : null,
        user: user && { id: user.id, login: user.login, name: user.name, avatar: user.avatar, admin: user.admin, githubScopes: user.githubScopes },
        forges: user ? listForges(user) : [],
        googleEnabled: googleEnabled(),
        google: user ? googleAccount(user) : null,
        caldav: user ? listCaldav(user) : [],
        integrations: { updown: user ? updownSource(user) : null, ollama: user ? ollamaSource(user) : null },
        seafile: user ? seafileInfo(user) : null,
      })
      return true
    }

    // Google Calendar, attached to the signed-in user (server/google.ts).
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
    // Deleting your own account (Settings → Account): everything it stored goes (server/users.ts).
    if (method === 'DELETE' && path === '/api/me') {
      await deleteUser(requireUser(req).id)
      return logout(req, res), true
    }

    // The Minecraft server window's RCON panel, for admins only (server/minecraft.ts).
    if (path === '/api/minecraft/rcon' && read) return requireAdmin(req), json(res, 200, { configured: rconConfigured() }), true
    if (path === '/api/minecraft/rcon' && method === 'POST') return json(res, 200, await minecraftAdmin(requireAdmin(req), await readJson(req, 4096))), true

    // Settings → Users, for admins only (server/admin.ts).
    if (path === '/api/admin/stats' && read) return requireAdmin(req), json(res, 200, adminStats()), true
    if (path === '/api/admin/settings' && method === 'PUT') return requireAdmin(req), json(res, 200, updateSettings(await readJson(req, 1024))), true
    if (path === '/api/admin/users' && read) return requireAdmin(req), json(res, 200, listUsers(url.searchParams.get('q'), url.searchParams.get('cursor'))), true
    const adminTarget = /^\/api\/admin\/users\/(\d+)(\/ban|\/unban|\/signout)?$/.exec(path)
    if (adminTarget) {
      const admin = requireAdmin(req)
      const [, uid, sub] = adminTarget
      if (!sub && read) return json(res, 200, adminUser(uid)), true
      if (!sub && method === 'DELETE') return await removeUser(admin, uid), json(res, 200, { ok: true }), true
      if (sub === '/ban' && method === 'POST') return json(res, 200, banUser(admin, uid, await readJson(req, 4096))), true
      if (sub === '/unban' && method === 'POST') return json(res, 200, unbanUser(admin, uid)), true
      if (sub === '/signout' && method === 'POST') return json(res, 200, signOutUser(admin, uid)), true
    }

    // Empires At War: whether a multiplayer battle waits for this browser's player (by its token) or
    // this account's, for the menus' "Rejoin battle" (server/empires.ts). Guests may ask too.
    if (path === '/api/empires/away' && method === 'POST') {
      const body = await readJson<{ token?: unknown }>(req, 1024)
      return json(res, 200, empiresAway(body?.token, currentUser(req)?.login ?? null)), true
    }

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
    // The Contacts app (server/contacts.ts): the address book on this site and CardDAV ones.
    if (path.startsWith('/api/contacts') && (await handleContactsApi(req, res, url, method, requireUser(req)))) return true
    if (path === '/api/calendar/calendars' && read) return json(res, 200, await allCalendars(requireUser(req), true)), true
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
      const user = requireUser(req)
      // The Calendar app's refresh button: past the server's cache of CalDAV calendars too.
      if (q('fresh') === '1') clearCaldavCache(user)
      return json(res, 200, await allEvents(user, ids ? ids.split(',') : null, { from, to })), true
    }
    // The Calendar app's changes: { calendar, event } to add, { ref, event, calendar?, all? } to change, { ref, all? } to delete.
    if (path === '/api/calendar/events' && method === 'POST') return await createEvent(requireUser(req), await readJson(req, 64 * 1024)), json(res, 200, { ok: true }), true
    if (path === '/api/calendar/events' && method === 'PATCH') return await updateEvent(requireUser(req), await readJson(req, 64 * 1024)), json(res, 200, { ok: true }), true
    if (path === '/api/calendar/events' && method === 'DELETE') return await deleteEvent(requireUser(req), await readJson(req, 8 * 1024)), json(res, 200, { ok: true }), true
    // Which of the UIDs of an .ics being imported the calendar has already: { calendar, uids } answers { known }.
    if (path === '/api/calendar/known' && method === 'POST') return json(res, 200, { known: await knownUids(requireUser(req), await readJson(req, 256 * 1024)) }), true
    // Notes linked to events (server/noteLinks.ts): the event's backlink to a note, { ref | link, note, all?, unlink? }; and the event a note's link points at now, { uid, calendarId?, occurrence?, start?, fresh? }.
    if (path === '/api/calendar/note-link' && method === 'POST') return json(res, 200, await noteLinkApi(requireUser(req), await readJson(req, 16 * 1024))), true
    if (path === '/api/calendar/find' && method === 'POST') {
      const body = await readJson<{ uid?: unknown; calendarId?: unknown; occurrence?: unknown; start?: unknown; fresh?: unknown }>(req, 8 * 1024)
      const text = (v: unknown) => (typeof v === 'string' && v ? v.slice(0, 1000) : undefined)
      const uid = text(body?.uid)
      if (!uid) throw new HttpError(400, 'Which event?')
      return json(res, 200, await findLinked(requireUser(req), { uid, calendarId: text(body.calendarId), occurrence: text(body.occurrence), start: text(body.start) }, body.fresh === true)), true
    }
    // The Tasks app (server/tasks.ts): CalDAV task lists and the ones on this site.
    if ((path === '/api/tasks' || path.startsWith('/api/tasks/')) && (await handleTasksApi(req, res, url, method, requireUser(req)))) return true
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
    // A whole file, piped with whatever range the browser asks for (the music and video players).
    if (path === '/api/seafile/stream' && read) {
      const range = req.headers.range
      // Scrubbing cancels range requests all the time: the request to Seafile goes with each one.
      const gone = new AbortController()
      res.on('close', () => gone.abort())
      const r = await streamFile(requireUser(req), url.searchParams.get('repo'), url.searchParams.get('p'), typeof range === 'string' ? range : undefined, gone.signal)
      if (r.status === 416) return res.writeHead(416, { ...(r.contentRange ? { 'Content-Range': r.contentRange } : {}), 'Cache-Control': 'no-store', ...SECURITY }).end(), true
      // Only media types pass: an HTML or SVG file served from this origin would run as the site.
      const headers: Record<string, string> = { 'Content-Type': /^(audio|video)\//i.test(r.type) ? r.type : 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=600', ...SECURITY, ...UNTRUSTED }
      if (r.length) headers['Content-Length'] = r.length
      if (r.contentRange) headers['Content-Range'] = r.contentRange
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
    // The Photos app (server/photos.ts): its Seafile index and Immich, and linking Immich.
    if ((path.startsWith('/api/photos/') || path === '/api/integrations/immich') && (await handlePhotosApi(req, res, url, method))) return true

    // The Agents app (server/agents.ts): Ollama Cloud's key, threads, a turn (streamed) and memory.
    if (path === '/api/integrations/ollama' && method === 'PUT') return await setOllamaKey(requireUser(req), await readJson(req, 4096)), json(res, 200, { ok: true }), true
    if (path === '/api/integrations/ollama' && method === 'DELETE') return removeOllamaKey(requireUser(req)), json(res, 200, { ok: true }), true
    if (path === '/api/agents/defaults' && read) return requireUser(req), json(res, 200, await automaticModels()), true
    if (path === '/api/agents/models' && read) return requireUser(req), json(res, 200, await agentModels()), true
    if (path === '/api/agents/threads' && read) return json(res, 200, listThreads(requireUser(req), url.searchParams.get('archived') === '1')), true
    if (path === '/api/agents/quick' && read) return json(res, 200, listQuick(requireUser(req))), true
    if (path === '/api/agents/quick' && method === 'DELETE') return clearQuick(requireUser(req)), json(res, 200, { ok: true }), true
    if (path === '/api/agents/threads' && method === 'POST') return json(res, 200, await createThread(requireUser(req), await readJson(req, 4096))), true
    // A picture sent with one of your messages: the thumbnails and the full view in the app. The
    // address never changes what it shows (message ids are not reused), so the browser keeps it.
    const agentPicture = /^\/api\/agents\/threads\/([0-9a-f-]{36})\/messages\/(\d{1,15})\/attachments\/(\d{1,2})$/.exec(path)
    if (agentPicture && read) {
      const p = messagePicture(requireUser(req), agentPicture[1], agentPicture[2], agentPicture[3])
      res.writeHead(200, { 'Content-Type': p.type, 'Content-Length': String(p.body.length), 'Cache-Control': 'private, max-age=86400', ...SECURITY, ...UNTRUSTED }).end(head ? undefined : p.body)
      return true
    }
    const agentThread = /^\/api\/agents\/threads\/([0-9a-f-]{36})(\/messages|\/follow|\/stop|\/approve|\/answer|\/result|\/title|\/retitle|\/context|\/queue|\/override|\/retry|\/rewind|\/share|\/mail-reads|\/queue\/[0-9a-f-]{36}(?:\/send|\/move)?)?$/.exec(path)
    if (agentThread) {
      const [, tid, sub] = agentThread
      if (!sub && read) return json(res, 200, getThread(requireUser(req), tid)), true
      if (!sub && method === 'PATCH') return json(res, 200, await updateThread(requireUser(req), tid, await readJson(req, 4096))), true
      if (!sub && method === 'DELETE') return deleteThread(requireUser(req), tid), json(res, 200, { ok: true }), true
      if (sub === '/messages' && method === 'POST') {
        const user = requireUser(req)
        return await runTurn(res, user, tid, await readJson(req, 16 * 1024 * 1024)), true
      }
      if (sub === '/follow' && read) return followThread(res, requireUser(req), tid, url.searchParams.get('client') === 'terminal'), true
      if (sub === '/result' && method === 'POST') return clientResult(requireUser(req), tid, await readJson(req, 512 * 1024)), json(res, 200, { ok: true }), true
      if (sub === '/stop' && method === 'POST') return stopThread(requireUser(req), tid), json(res, 200, { ok: true }), true
      if (sub === '/title' && method === 'POST') return json(res, 200, await suggestTitle(requireUser(req), tid)), true
      if (sub === '/retitle' && method === 'POST') return json(res, 200, await regenerateTitle(requireUser(req), tid)), true
      if (sub === '/context' && read) return json(res, 200, await contextOf(requireUser(req), tid)), true
      if (sub === '/answer' && method === 'POST') return answer(requireUser(req), tid, await readJson(req, 64 * 1024)), json(res, 200, { ok: true }), true
      if (sub === '/approve' && method === 'POST') return approve(requireUser(req), tid, await readJson(req, 8192)), json(res, 200, { ok: true }), true
      // Mail reads allowed for a while (from a read's card) end now: the × on the thread's chip.
      if (sub === '/mail-reads' && method === 'DELETE') return json(res, 200, revokeMailReads(requireUser(req), tid)), true
      // Retry runs the last turn again (streamed like a message); Rewind cuts the thread back to one of your messages.
      if (sub === '/retry' && method === 'POST') {
        const user = requireUser(req)
        return await retryTurn(res, user, tid, await readJson(req, 4096)), true
      }
      if (sub === '/rewind' && method === 'POST') return json(res, 200, await rewind(requireUser(req), tid, await readJson(req, 1024))), true
      // A shared link: a snapshot of the thread, or of one answer, readable by anyone with the link.
      if (sub === '/share' && method === 'POST') return json(res, 200, createShare(req, requireUser(req), tid, await readJson(req, 1024))), true
      // The queue: messages written while it works, sent one by one when it is done (or now).
      if (sub === '/queue' && method === 'POST') return json(res, 200, enqueue(requireUser(req), tid, await readJson(req, 16 * 1024 * 1024))), true
      if (sub === '/override' && method === 'POST') return json(res, 200, override(requireUser(req), tid, await readJson(req, 16 * 1024 * 1024))), true
      const queued = sub?.startsWith('/queue/') ? sub.split('/') : null
      if (queued && !queued[3] && method === 'PATCH') return json(res, 200, editQueued(requireUser(req), tid, queued[2], await readJson(req, 16 * 1024 * 1024))), true
      if (queued && !queued[3] && method === 'DELETE') return json(res, 200, removeQueued(requireUser(req), tid, queued[2])), true
      if (queued?.[3] === 'send' && method === 'POST') return json(res, 200, sendQueued(requireUser(req), tid, queued[2])), true
      if (queued?.[3] === 'move' && method === 'POST') return json(res, 200, moveQueued(requireUser(req), tid, queued[2], await readJson(req, 1024))), true
    }
    // The user's shared links (?thread= for one thread's), and Stop sharing.
    if (path === '/api/agents/shares' && read) {
      const thread = url.searchParams.get('thread')
      return json(res, 200, listShares(req, requireUser(req), thread && /^[0-9a-f-]{36}$/.test(thread) ? thread : null)), true
    }
    const shareToken = /^\/api\/agents\/shares\/([^/]+)$/.exec(path)?.[1]
    if (shareToken && method === 'DELETE') {
      if (!isShareToken(shareToken)) throw new HttpError(404, 'No such shared link')
      return deleteShare(requireUser(req), shareToken), json(res, 200, { ok: true }), true
    }
    if (path === '/api/agents/prompt' && read) return json(res, 200, await agentsPrompt(requireUser(req), url.searchParams.has('fresh'))), true
    if (path === '/api/agents/skills' && read) return json(res, 200, await skillsList(requireUser(req), url.searchParams)), true
    if (path === '/api/agents/skills/install' && method === 'POST') return json(res, 200, await skillsInstall(requireUser(req), await readJson(req, 8192))), true
    if (path === '/api/agents/skills/remove' && method === 'POST') return await skillsRemove(requireUser(req), await readJson(req, 8192)), json(res, 200, { ok: true }), true
    const skillName = /^\/api\/agents\/skills\/([\w.-]{1,64})$/.exec(path)?.[1]
    if (skillName && read) return json(res, 200, await skillInfo(requireUser(req), skillName, url.searchParams)), true
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
    // Mail reads (the agent's mail searches and reads): ask each time (the default), or always allowed.
    if (path === '/api/agents/mail-reads' && read) return json(res, 200, getMailReads(requireUser(req))), true
    if (path === '/api/agents/mail-reads' && method === 'PUT') return json(res, 200, setMailReads(requireUser(req), await readJson(req, 1024))), true
    // Web sites the user allowed for good: their threads read addresses there without asking.
    if (path === '/api/agents/sites' && read) return json(res, 200, listSites(requireUser(req))), true
    if (path === '/api/agents/sites' && method === 'POST') return json(res, 200, allowSite(requireUser(req), await readJson(req, 4096))), true
    const siteHost = /^\/api\/agents\/sites\/([a-z0-9.-]{1,253})$/i.exec(path)?.[1]
    if (siteHost && method === 'DELETE') return json(res, 200, removeSite(requireUser(req), siteHost)), true
    // The notification hub (server/notifier.ts): the account's list (the bell), changes to it, a
    // page's live stream and heartbeat, and notifications a page noticed itself.
    if (path === '/api/notifications' && read) return json(res, 200, { entries: listEntries(requireUser(req)) }), true
    if (path === '/api/notifications' && method === 'POST') return json(res, 200, noticeFromPage(requireUser(req), await readJson(req, 8 * 1024))), true
    if (path === '/api/notifications' && method === 'PATCH') return json(res, 200, changeEntries(requireUser(req), await readJson(req, 64 * 1024))), true
    if (path === '/api/notifications/stream' && read) return openStream(req, res, requireUser(req), url.searchParams.get('page')), true
    if (path === '/api/notifications/presence' && method === 'POST') return json(res, 200, presence(requireUser(req), await readJson(req, 1024))), true
    // Web Push (server/webpush.ts): the server's public key, this browser's subscription, a test.
    if (path === '/api/push/key' && read) return requireUser(req), json(res, 200, pushPublicKey()), true
    if (path === '/api/push/subscription' && method === 'POST') return json(res, 200, subscribe(requireUser(req), await readJson(req, 8 * 1024))), true
    if (path === '/api/push/subscription' && method === 'DELETE') return json(res, 200, unsubscribe(requireUser(req), await readJson(req, 8 * 1024))), true
    if (path === '/api/push/test' && method === 'POST') return json(res, 200, await pushToUser(requireUser(req), { title: 'MvL OS', body: 'Push notifications work on this device.', tag: 'push-test', url: '/' })), true
    if (path === '/api/preview' && read) {
      requireUser(req) // fetches other sites on request: the signed-in user only
      const res2 = await linkPreview(url.searchParams.get('url') ?? '')
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'private, max-age=3600', ...SECURITY }).end(JSON.stringify(res2))
      return true
    }
    if (path === '/api/inbox' && read) return json(res, 200, await inbox(requireUser(req), url.searchParams.has('fresh'))), true

    if (path === '/api/search' && read) return json(res, 200, await search(requireUser(req), url.searchParams.get('q') ?? '')), true
    // Settings → Code hosts: the GitHub organisations and whether this site's OAuth app reaches them.
    if (path === '/api/code/orgs' && read) return json(res, 200, await orgAccess(requireUser(req), url.searchParams.get('fresh') === '1')), true
    // The Git app (server/git.ts): repositories, pull requests, issues and commits, read only.
    if (path === '/api/repos' || path.startsWith('/api/repos/')) return await handleGitApi(req, res, url, requireUser(req))
    // The Mail app over JMAP (server/jmap.ts): accounts, mailboxes, conversations, drafts, sending and attachments.
    if (path.startsWith('/api/mail/')) return await handleMailApi(req, res, url)
    // Mail, Contacts, Calendar and Tasks together (server/pim.ts): invitations, a contact's mail and events, tasks from mail.
    if (path.startsWith('/api/pim/') && (await handlePimApi(req, res, url, method, requireUser(req)))) return true

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
