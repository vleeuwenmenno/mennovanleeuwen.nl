// Several ComfyUI hosts per account, against stand-in ComfyUI servers (never a GPU): migration of
// the single-URL settings, saving, defaults and removal with token redaction, routing (offline
// default, a model only on the second host, explicit hosts), separate catalogs and credentials,
// jobs pinned to their host (no resubmission, a default switch mid-job, edited or removed hosts),
// video job scopes, and ownership and egress checks.
//
//   node scripts/agents-image-hosts.ts   (pnpm check:agents-image-hosts)
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const scratch = mkdtempSync(join(tmpdir(), 'agents-image-hosts-'))
process.env.DATA_DIR = scratch
const { database, encrypt, privateDigest } = await import('../server/db.ts')
const images = await import('../server/agentImages.ts')
const { saveImageSettings, imageHosts, imageSettings, imageHostSettings, imageBackendScope, imageHostForScope, prepareImageGeneration, saveThreadImageSettings, threadImageHost, imageHostsOverview, recordedImageHost, imageAgainInput, IMAGE_HOSTS_MAX } = images
const { modelDetails } = await import('../server/agentModelIntel.ts')
const { imagePromptSection, IMAGE_HOSTS_PROMPT } = await import('../server/agentImagePrompt.ts')

const png = readFileSync(new URL('./fixtures/agent-image-sources/source.png', import.meta.url))
const NODES = ['CheckpointLoaderSimple', 'UNETLoader', 'CLIPLoader', 'VAELoader', 'CLIPTextEncode', 'EmptyLatentImage', 'KSampler', 'VAEDecode', 'SaveImage', 'LoraLoader', 'LoraLoaderModelOnly', 'LoadImage', 'ImageScale', 'VAEEncode']
/** One stand-in ComfyUI: its own checkpoints and LoRAs, its own token, and a log of what it was asked. */
function comfy(name: string, opts: { checkpoints: string[]; loras?: string[]; token?: string }) {
  const info: Record<string, any> = Object.fromEntries(NODES.map((n) => [n, { input: { required: {} } }]))
  info.CheckpointLoaderSimple.input.required.ckpt_name = [opts.checkpoints]
  info.LoraLoader.input.required.lora_name = [opts.loras ?? []]
  info.KSampler.input.required = { sampler_name: [['euler', 'dpmpp_2m']], scheduler: [['simple', 'karras', 'normal']] }
  const state = { name, prompts: 0, history: 0, deleted: [] as string[], auth: new Set<string>(), mode: 'ok' as 'ok' | 'history-error' | 'prompt-500' | 'hang', requests: 0, server: null as unknown as Server, url: '' }
  state.server = createServer(async (req: IncomingMessage, res) => {
    const chunks = []; for await (const c of req) chunks.push(c)
    const body = Buffer.concat(chunks).toString(), path = new URL(req.url!, 'http://fixture').pathname
    state.requests++
    state.auth.add(req.headers.authorization ?? '')
    if (opts.token && req.headers.authorization !== `Bearer ${opts.token}`) return res.writeHead(401).end()
    const send = (v: unknown) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(v))
    if (state.mode === 'hang' && path.startsWith('/object_info/')) return
    if (path.startsWith('/object_info/')) { const node = path.slice(13); return send(info[node] ? { [node]: info[node] } : {}) }
    if (path.startsWith('/api/lm/')) return res.writeHead(404).end()
    if (path === '/prompt') {
      state.prompts++
      if (state.mode === 'prompt-500') return res.writeHead(500).end()
      return send({ prompt_id: `${name}-job` })
    }
    if (path === '/queue') { if (body) state.deleted.push(...(JSON.parse(body).delete ?? [])); return send({ queue_running: [], queue_pending: [] }) }
    if (path === `/history/${name}-job`) {
      state.history++
      if (state.mode === 'history-error') return send({ [`${name}-job`]: { status: { status_str: 'error', completed: false } } })
      return send({ [`${name}-job`]: { status: { completed: true }, outputs: { '9': { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } } } })
    }
    if (path === '/view') return res.writeHead(200, { 'Content-Type': 'image/png' }).end(png)
    res.writeHead(404).end()
  })
  return state
}
const listen = async (s: Server) => { await new Promise<void>((r) => s.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${(s.address() as { port: number }).port}` }
const A = comfy('alpha', { checkpoints: ['alpha.safetensors', 'shared.safetensors'], token: 'legacy-token' })
const B = comfy('beta', { checkpoints: ['beta.safetensors', 'shared.safetensors'], loras: ['beta-style.safetensors'], token: 'token-b' })
const bait = comfy('bait', { checkpoints: ['beta.safetensors'] })
A.url = await listen(A.server); B.url = await listen(B.server); bait.url = await listen(bait.server)
// An address with nothing listening: the offline host.
const closed = createServer(); const offlineUrl = await listen(closed); await new Promise<void>((r) => closed.close(() => r()))

const db = database()
const owner = { id: 1, admin: true, login: 'owner' } as never
const other = { id: 2, admin: false, login: 'other' } as never
const thread = randomUUID(), otherThread = randomUUID()
const NAME = 'agents-comfyui'
const total = () => A.prompts + B.prompts + bait.prompts
try {
  db.prepare("INSERT INTO users (id,github_id,login,github_token,created_at,updated_at) VALUES (1,1,'owner','',0,0), (2,2,'other','',0,0)").run()
  db.prepare("INSERT INTO agent_threads (id,user_id,title,mode,model,created_at,updated_at) VALUES (?,1,'Hosts','quick','fixture',0,0), (?,2,'Other','quick','fixture',0,0)").run(thread, otherThread)

  // --- 1. The single URL saved before hosts becomes the default host, token and scope intact. ---
  db.prepare('INSERT INTO integrations (user_id, name, secret, created_at) VALUES (?, ?, ?, ?)').run(1, NAME, encrypt(JSON.stringify({ url: A.url, token: 'legacy-token', preset: 'sdxl', model: 'alpha.safetensors', askBeforeGenerate: true, civitaiLookup: false })), 0)
  const migrated = imageHosts(owner)
  assert.equal(migrated.length, 1)
  assert.equal(migrated[0].hostName, 'ComfyUI'); assert.equal(migrated[0].url, A.url); assert.equal(migrated[0].token, 'legacy-token')
  assert.match(migrated[0].hostId, /^h[0-9a-f]{16}$/)
  assert.equal(imageHosts(owner)[0].hostId, migrated[0].hostId, 'the legacy host keeps one id on every read')
  assert.equal(imageSettings(owner).askBeforeGenerate, true, 'global preferences survive the migration')
  assert.equal(imageSettings(owner).civitaiLookup, false)
  // Observations recorded before hosts keep matching: the scope formula is per address and token.
  assert.equal(imageBackendScope(owner), privateDigest(JSON.stringify(['image-backend', 1, A.url, 'legacy-token'])))
  const legacyId = migrated[0].hostId
  console.log('PASS legacy single-URL settings migrate to one stable default host with its token, preferences and backend scope')

  // --- 2. Saving hosts: add, keep tokens, default, removal, limits; never a token in the view. ---
  let view = saveImageSettings(owner, { hosts: [{ id: legacyId, name: 'Alpha', url: A.url, token: '' }, { name: 'Beta', url: `${B.url}/`, token: 'token-b' }] })
  assert.equal(view.hosts.length, 2)
  assert.deepEqual(view.hosts.map((h) => [h.name, h.token, h.default]), [['Alpha', true, true], ['Beta', true, false]])
  assert.equal(view.hosts[1].url, B.url, 'URLs are normalized')
  assert.equal(imageHosts(owner).find((h) => h.hostName === 'Alpha')!.token, 'legacy-token', 'an empty token keeps the saved one')
  for (const secret of ['legacy-token', 'token-b']) assert.ok(!JSON.stringify(view).includes(secret), 'the settings view never carries a token')
  const betaId = view.hosts[1].id
  assert.notEqual(betaId, legacyId)
  view = saveImageSettings(owner, { defaultHost: betaId })
  assert.equal(view.defaultHost, betaId); assert.equal(view.url, B.url); assert.equal(imageSettings(owner).hostId, betaId)
  view = saveImageSettings(owner, { hosts: view.hosts.map((h) => ({ ...h, default: h.id === legacyId })) })
  assert.equal(view.defaultHost, legacyId, 'default: true marks the default; sending the view back keeps every token')
  assert.equal(imageHosts(owner).find((h) => h.hostId === betaId)!.token, 'token-b')
  for (const bad of [
    { hosts: [{ id: 'h0000000000000000', name: 'X', url: A.url }] },
    { hosts: [{ name: 'Same', url: A.url }, { name: 'same', url: B.url }] },
    { hosts: [{ name: 'One', url: A.url }, { name: 'Two', url: A.url }] },
    { hosts: Array.from({ length: IMAGE_HOSTS_MAX + 1 }, (_, i) => ({ name: `H${i}`, url: `http://127.0.0.1:${2000 + i}` })) },
    { hosts: [{ name: 'Creds', url: 'http://user:pass@127.0.0.1:1' }] },
    { hosts: [{ name: 'Bad', url: 'ftp://127.0.0.1' }] },
    { defaultHost: 'h1111111111111111' },
    { hosts: [], url: A.url },
  ]) assert.throws(() => saveImageSettings(owner, bad), (e: any) => e.status === 400, JSON.stringify(bad).slice(0, 80))
  // Another account cannot name this account's host ids.
  assert.throws(() => saveImageSettings(other, { hosts: [{ id: betaId, name: 'Stolen', url: B.url }] }), /Unknown ComfyUI host/)
  assert.throws(() => imageHostSettings(other, betaId), (e: any) => e.status === 409 || e.status === 404)
  // Removing the default leaves the first remaining host as the default; removing the last disconnects.
  const scratchView = saveImageSettings(owner, { hosts: [...view.hosts.map(({ default: _d, ...h }) => h), { name: 'Temp', url: 'http://127.0.0.1:9', default: true }] })
  assert.throws(() => saveImageSettings(owner, { hosts: view.hosts.map((h) => ({ ...h, default: true })) }), /one host as the default/)
  const tempId = scratchView.defaultHost
  view = saveImageSettings(owner, { hosts: scratchView.hosts.filter((h) => h.id !== tempId) })
  assert.equal(view.defaultHost, legacyId, 'removing the default makes the first host the default')
  // The older single-host form edits the default host, and may send the whole view back unchanged.
  const { prediction: _p, civitaiKey: _k, ...oldForm } = view // what the older form sent back
  view = saveImageSettings(owner, { ...oldForm, url: A.url, token: '', preset: 'sdxl', model: 'alpha.safetensors' })
  assert.equal(view.hosts.length, 2); assert.equal(imageHosts(owner)[0].token, 'legacy-token')
  console.log('PASS hosts save with stable ids, kept and per-host tokens, explicit and removed defaults, bounds, ownership and redacted views')

  // --- 3. Routing: requested model only on the second host; explicit host; unknown host. ---
  const signal = AbortSignal.timeout(60_000)
  const before = total()
  let plan = await prepareImageGeneration(owner, thread, { prompt: 'a lighthouse', model: 'beta.safetensors', width: 512, height: 512, seed: 1 }, signal)
  assert.equal(plan.parameters.host?.id, betaId, 'a model missing on the default goes to the host that has it')
  assert.ok(plan.summary.rows.some(([k, v]) => k === 'ComfyUI host' && v.startsWith('Beta') && v.includes('Alpha')), 'the card names the host and the one that could not')
  assert.equal((plan.parameters as any).model, 'beta.safetensors', 'the requested model is never swapped')
  assert.equal(total(), before, 'planning queues nothing')
  let out = JSON.parse(await plan.run())
  assert.equal(B.prompts, 1); assert.equal(A.prompts, 0)
  assert.deepEqual(out.host, { id: betaId, name: 'Beta' }); assert.equal(out.fallback_from[0].host.name, 'Alpha')
  assert.ok(!JSON.stringify(out).includes(A.url) && !JSON.stringify(out).includes(B.url), 'results name hosts, never addresses')
  assert.equal(recordedImageHost(owner, thread, out.image.id), betaId)
  assert.equal((imageAgainInput(owner, thread, out.image.id) as any).host, undefined, 'Generate another prefers the recorded host without forcing it')
  // A model both hosts have runs on the default.
  plan = await prepareImageGeneration(owner, thread, { prompt: 'a lighthouse', model: 'shared.safetensors', width: 512, height: 512 }, signal)
  assert.equal(plan.parameters.host?.name, 'Alpha')
  const loraPlan = await prepareImageGeneration(owner, thread, { prompt: 'x', model: 'shared.safetensors', loras: [{ name: 'beta-style.safetensors', weight: 1 }] }, signal)
  assert.equal(loraPlan.parameters.host?.id, betaId, 'a missing LoRA is a host failure, not malformed input')
  await assert.rejects(prepareImageGeneration(owner, thread, { prompt: 'x', model: 'shared.safetensors', loras: [{ name: 'beta-style.safetensors', weight: 9 }] }, signal), (e: any) => e.status === 400)
  // Explicit host: only that host, and its error lists the others.
  await assert.rejects(prepareImageGeneration(owner, thread, { prompt: 'x', model: 'beta.safetensors', host: 'alpha' }, signal), (e: any) => /On ComfyUI host “Alpha”/.test(e.message) && /Beta/.test(e.message) && /pass one of them as host/.test(e.message))
  plan = await prepareImageGeneration(owner, thread, { prompt: 'x', model: 'shared.safetensors', host: betaId, width: 512, height: 512 }, signal)
  assert.equal(plan.parameters.host?.id, betaId, 'an explicit host is used even when the default has the model')
  // Nothing but an owned host id or name: an address, an unknown name, a foreign id.
  for (const host of [bait.url, 'gamma', 'h0000000000000000']) await assert.rejects(prepareImageGeneration(owner, thread, { prompt: 'x', model: 'beta.safetensors', host }, signal), (e: any) => e.status === 404 && /Configured hosts/.test(e.message))
  await assert.rejects(prepareImageGeneration(owner, thread, { prompt: 'x', host: { url: bait.url } }, signal), (e: any) => e.status === 400)
  assert.equal(bait.requests, 0, 'an address in host is never contacted')
  // Nowhere: every host's reason, and the model is not replaced.
  await assert.rejects(prepareImageGeneration(owner, thread, { prompt: 'x', model: 'nowhere.safetensors' }, signal), (e: any) => e.status === 409 && /No ComfyUI host could run this/.test(e.message) && /Alpha/.test(e.message) && /Beta/.test(e.message))
  // An input error stops at once, not once per host.
  const requests = A.requests + B.requests
  await assert.rejects(prepareImageGeneration(owner, thread, { prompt: 'x', width: 333 }, signal), (e: any) => e.status === 400)
  assert.equal(A.requests + B.requests, requests)
  console.log('PASS model only on the second host routes there, explicit host and its alternatives, owned names only, nothing swapped or queued while planning')

  // --- 4. An offline default: the next host answers, and the overview keeps both. ---
  view = saveImageSettings(owner, { hosts: [{ name: 'Down', url: offlineUrl, default: true }, ...imageHosts(owner).map((h) => ({ id: h.hostId, name: h.hostName, url: h.url }))] })
  const downId = view.defaultHost
  plan = await prepareImageGeneration(owner, thread, { prompt: 'x', model: 'shared.safetensors', width: 512, height: 512 }, signal)
  assert.equal(plan.parameters.host?.name, 'Alpha', 'an unreachable default falls back to the next host')
  assert.equal((plan as any).summary.rows.find((r: string[]) => r[0] === 'ComfyUI host')[1].includes('Down'), true)
  const overview = await imageHostsOverview(owner, signal, 'beta')
  const byName = Object.fromEntries(overview.hosts.map((h: any) => [h.name, h]))
  assert.equal(byName.Down.reachable, false); assert.ok(byName.Down.error)
  assert.ok(!byName.Down.error.includes(new URL(offlineUrl).host), 'errors name the host, not its address')
  assert.equal(byName.Alpha.reachable, true); assert.equal(byName.Alpha.matches?.checkpoints, undefined, 'catalogs stay separate: Alpha has no beta')
  assert.deepEqual(byName.Beta.matches.checkpoints.values, ['beta.safetensors'])
  assert.deepEqual(byName.Beta.matches.loras.values, ['beta-style.safetensors'])
  assert.equal(byName.Alpha.counts.loras, 0); assert.equal(byName.Beta.counts.loras, 1)
  // model_details looks the name up on the host that has it.
  const details = await modelDetails(owner, { name: 'beta.safetensors' }, signal) as any
  assert.deepEqual(details.host, { id: betaId, name: 'Beta' })
  await assert.rejects(modelDetails(owner, { name: 'beta.safetensors', host: 'Alpha' }, signal), /On ComfyUI host “Alpha”/)
  // Credentials stay per host.
  assert.deepEqual([...A.auth], ['Bearer legacy-token']); assert.deepEqual([...B.auth], ['Bearer token-b'])
  console.log('PASS offline default falls back, per-host overview with errors and separate catalogs, model_details per host, per-host credentials')

  // --- 5. Pinned jobs: no resubmission after a prompt is accepted or ambiguous. ---
  view = saveImageSettings(owner, { hosts: imageHosts(owner).filter((h) => h.hostId !== downId).map((h) => ({ id: h.hostId, name: h.hostName, url: h.url, default: h.hostId === legacyId })) })
  B.mode = 'history-error'
  let counts = [A.prompts, B.prompts]
  plan = await prepareImageGeneration(owner, thread, { prompt: 'x', model: 'beta.safetensors', width: 512, height: 512 }, signal)
  await assert.rejects(plan.run(), (e: any) => /On ComfyUI host “Beta”/.test(e.message) && /not moved to another host/.test(e.message))
  assert.deepEqual([A.prompts, B.prompts], [counts[0], counts[1] + 1], 'a failed accepted job is never queued on another host')
  assert.ok(B.deleted.includes('beta-job'), 'cleanup deletes the queued prompt on its own host')
  B.mode = 'prompt-500'
  counts = [A.prompts, B.prompts]
  plan = await prepareImageGeneration(owner, thread, { prompt: 'x', model: 'shared.safetensors', host: 'Beta', width: 512, height: 512 }, signal)
  await assert.rejects(plan.run())
  assert.deepEqual([A.prompts, B.prompts], [counts[0], counts[1] + 1], 'an ambiguous submission is not replayed on the default')
  B.mode = 'ok'
  // A default switch after planning keeps the job on its host; an edited or removed host stops it.
  plan = await prepareImageGeneration(owner, thread, { prompt: 'x', model: 'beta.safetensors', width: 512, height: 512 }, signal)
  saveImageSettings(owner, { defaultHost: betaId }); saveImageSettings(owner, { defaultHost: legacyId })
  counts = [A.prompts, B.prompts]
  out = JSON.parse(await plan.run())
  assert.equal(out.host.id, betaId); assert.deepEqual([A.prompts, B.prompts], [counts[0], counts[1] + 1])
  plan = await prepareImageGeneration(owner, thread, { prompt: 'x', model: 'beta.safetensors', width: 512, height: 512 }, signal)
  saveImageSettings(owner, { hosts: imageHosts(owner).map((h) => ({ id: h.hostId, name: h.hostName, url: h.url, ...(h.hostId === betaId ? { token: 'token-b-rotated' } : {}) })) })
  await assert.rejects(plan.run(), /backend changed/)
  saveImageSettings(owner, { hosts: imageHosts(owner).map((h) => ({ id: h.hostId, name: h.hostName, url: h.url, ...(h.hostId === betaId ? { token: 'token-b' } : {}) })) })
  plan = await prepareImageGeneration(owner, thread, { prompt: 'x', model: 'beta.safetensors', width: 512, height: 512 }, signal)
  const kept = imageHosts(owner)
  saveImageSettings(owner, { hosts: kept.filter((h) => h.hostId !== betaId).map((h) => ({ id: h.hostId, name: h.hostName, url: h.url })) })
  counts = [A.prompts, B.prompts]
  await assert.rejects(plan.run(), /backend changed/)
  assert.deepEqual([A.prompts, B.prompts], counts, 'a removed host runs nothing, anywhere')
  view = saveImageSettings(owner, { hosts: [...kept.filter((h) => h.hostId !== betaId).map((h) => ({ id: h.hostId, name: h.hostName, url: h.url })), { name: 'Beta', url: B.url, token: 'token-b' }] })
  const beta2 = view.hosts.find((h) => h.name === 'Beta')!.id
  assert.notEqual(beta2, betaId, 'a re-added host is a new host')
  console.log('PASS jobs stay on their host: no resubmission after acceptance or an ambiguous answer, own cleanup, default switch keeps, edit or removal stops')

  // --- 6. Video jobs find their host by scope, whatever the default. ---
  const scopeB = imageBackendScope(owner, imageHostSettings(owner, beta2))
  saveImageSettings(owner, { defaultHost: beta2 }); saveImageSettings(owner, { defaultHost: legacyId })
  assert.equal(imageHostForScope(owner, scopeB)?.hostId, beta2, 'a queued render keeps its host after a default switch')
  assert.equal(imageHostForScope(other, scopeB), null, 'another account never resolves it')
  saveImageSettings(owner, { hosts: imageHosts(owner).map((h) => ({ id: h.hostId, name: h.hostName, url: h.url, ...(h.hostId === beta2 ? { token: 'token-b-new' } : {}) })) })
  assert.equal(imageHostForScope(owner, scopeB), null, 'changed credentials fail the render instead of running it elsewhere')
  saveImageSettings(owner, { hosts: imageHosts(owner).map((h) => ({ id: h.hostId, name: h.hostName, url: h.url, ...(h.hostId === beta2 ? { token: 'token-b' } : {}) })) })
  console.log('PASS video render scopes resolve to their own host across default switches and fail on changed credentials')

  // --- 7. A thread's own host is preferred; it must be an owned host. ---
  const pinned = await saveThreadImageSettings(owner, thread, { host: beta2 }) as any
  assert.equal(pinned.host.id, beta2); assert.equal(threadImageHost(owner, thread)?.hostId, beta2)
  plan = await prepareImageGeneration(owner, thread, { prompt: 'x', model: 'shared.safetensors', width: 512, height: 512 }, signal)
  assert.equal(plan.parameters.host?.id, beta2, 'the thread host goes before the default')
  await assert.rejects(saveThreadImageSettings(other, otherThread, { host: beta2 }), /configured ComfyUI hosts/)
  await assert.rejects(saveThreadImageSettings(owner, thread, { host: 'http://evil.example' }), (e: any) => e.status === 400)
  // A thread model only on the other host is checked there.
  const saved = await saveThreadImageSettings(owner, thread, { model: 'alpha.safetensors' }) as any
  assert.equal(saved.overrides.model, 'alpha.safetensors')
  console.log('PASS thread host preference, owned hosts only, thread models checked on the host that has them')

  // --- 8. A non-admin's LAN host is refused by the egress guard, named but not addressed. ---
  saveImageSettings(other, { hosts: [{ name: 'Mine', url: A.url }, { name: 'Also mine', url: B.url }] })
  const lan = A.requests
  await assert.rejects(prepareImageGeneration(other, otherThread, { prompt: 'x', model: 'alpha.safetensors' }, signal), (e: any) => !e.message.includes(new URL(A.url).host) && /Mine/.test(e.message))
  assert.equal(A.requests, lan, 'nothing reaches a LAN host for a non-admin')
  console.log('PASS non-admin LAN hosts refused per host, errors without addresses')

  // Review regressions: a listening but stalled primary must leave time for another host.
  saveImageSettings(owner, { defaultHost: legacyId, model: 'shared.safetensors' })
  await saveThreadImageSettings(owner, thread, {})
  const originalTimeout = AbortSignal.timeout
  AbortSignal.timeout = (ms) => originalTimeout(ms === 8_000 ? 100 : ms)
  A.mode = 'hang'
  try {
    const discovered = await images.discoverThreadImageSettings(owner, thread)
    assert.equal(discovered.host?.id, beta2, 'thread discovery survives a stalled primary')
    const savedOnBeta = await saveThreadImageSettings(owner, thread, { model: 'beta.safetensors' })
    assert.equal(savedOnBeta.host?.id, beta2, 'saving a thread model survives a stalled primary')
    const timedPlan = await prepareImageGeneration(owner, thread, { prompt: 'x', model: 'shared.safetensors' }, signal)
    assert.equal(timedPlan.parameters.host?.id, beta2, 'generation planning survives a stalled primary')
    const beforeBeta = B.requests
    await assert.rejects(prepareImageGeneration(owner, thread, { operation: 'upscale', source_image_id: out.image.id, upscale_model: 'missing.pth', scale: 2 }, signal), /Beta/)
    assert.ok(B.requests > beforeBeta, 'upscale discovery continues to Beta after Alpha times out')
    const beforeMask = B.requests
    await assert.rejects(images.makeImageMask(owner, thread, { source_image_id: out.image.id, target: 'lighthouse' }, signal), /Beta/)
    assert.ok(B.requests > beforeMask, 'mask discovery continues to Beta after Alpha times out')
    const controller = new AbortController(); controller.abort()
    const beforeAbort = A.requests + B.requests
    await assert.rejects(prepareImageGeneration(owner, thread, { prompt: 'x' }, controller.signal))
    assert.equal(A.requests + B.requests, beforeAbort, 'caller cancellation does not contact another host')
  } finally { A.mode = 'ok'; AbortSignal.timeout = originalTimeout }
  const { loraDetails } = await import('../server/agentLoraPreview.ts')
  const betaLoras = await loraDetails(owner, imageHostSettings(owner, beta2))
  assert.deepEqual(betaLoras.loras.map((l) => [l.name, l.host]), [['beta-style.safetensors', beta2]], 'LoRA discovery and preview references stay on the selected host')
  const alphaLoras = await loraDetails(owner, imageHostSettings(owner, legacyId))
  assert.equal(alphaLoras.loras.length, 0, 'host LoRA lists are separate')
  console.log('PASS stalled host fallback for thread discovery, save, generation, upscale and mask; cancellation; selected-host LoRA references')

  // --- 9. The several-hosts guidance is only in a several-hosts prompt. ---
  assert.ok(!imagePromptSection().includes('COMFYUI HOSTS'))
  assert.ok(imagePromptSection(true).includes(IMAGE_HOSTS_PROMPT))
  assert.ok(IMAGE_HOSTS_PROMPT.includes('list_image_hosts') && IMAGE_HOSTS_PROMPT.includes('Never swap'))
  // Removing the last host disconnects.
  view = saveImageSettings(owner, { hosts: [] })
  assert.equal(view.url, ''); assert.equal(view.defaultHost, ''); assert.equal(imageSettings(owner).url, '')
  await assert.rejects(prepareImageGeneration(owner, thread, { prompt: 'x' }, signal), /Configure ComfyUI/)
  console.log('PASS hosts guidance only with several hosts; removing the last host disconnects')
} finally {
  for (const s of [A, B, bait]) { s.server.closeAllConnections(); await new Promise<void>((r) => s.server.close(() => r())) }
  db.close(); rmSync(scratch, { recursive: true, force: true })
}
