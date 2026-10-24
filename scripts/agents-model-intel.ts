// Model facts and the image quality check (server/agentModelIntel.ts, server/agentImageQuality.ts,
// src/data/modelFamilies.ts): LoRA Manager parsing and the exact join, Civitai parsing from a trimmed
// fixture, the example consensus and the A1111 → ComfyUI mapping, caching with TTLs and negative
// results, egress that never leaves civitai.com, the lookup switch and the API key header, v-pred
// detection and its graph, and the quality check with its one automatic retry, end to end through a
// real Agents turn against mocked ComfyUI and Ollama. No GPU, no network, no real data.
import assert from 'node:assert/strict'
import { createServer, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { crc32, deflateSync } from 'node:zlib'
import { Server } from './empires-harness.ts'
import { asPage } from './as-page.ts'
import { exampleConsensus, familyOf, isVpred, mapA1111Sampler, median, MODEL_FAMILIES } from '../src/data/modelFamilies.ts'
import { modelDetailsLabel, qualityNote } from '../src/data/imageToolLabel.ts'

// --- PNG fixtures ------------------------------------------------------------------------------
function png(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]) {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const [r, g, b] = pixel(x, y); raw.set([r, g, b], y * (width * 3 + 1) + 1 + x * 3) }
  const chunk = (kind: string, body: Buffer) => { const head = Buffer.alloc(4), tail = Buffer.alloc(4), payload = Buffer.concat([Buffer.from(kind), body]); head.writeUInt32BE(body.length); tail.writeUInt32BE(crc32(payload)); return Buffer.concat([head, payload, tail]) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
const black = png(256, 256, () => [0, 0, 0])
const white = png(256, 256, () => [255, 255, 255])
let seed = 7
const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
const noise = png(256, 256, () => { const v = Math.floor(rand() * 256); return [v, Math.floor(rand() * 256), Math.floor(rand() * 256)] })
// A plausible picture: a sky gradient, a sun and a hill, with a little texture.
const fine = png(256, 256, (x, y) => { const sun = (x - 180) ** 2 + (y - 60) ** 2 < 600, hill = y > 170 + 20 * Math.sin(x / 30); const t = Math.floor(rand() * 6); return sun ? [250, 220, 90] : hill ? [40 + t, 120 + (y >> 3) + t, 50] : [90 + (y >> 2), 140 + (y >> 3), 230 - (y >> 3)] })
const tiny = png(1, 1, () => [0, 0, 0])

// --- end to end: a real Agents turn ------------------------------------------------------------
const send = (res: ServerResponse, v: unknown) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(v))
const nodes = ['CheckpointLoaderSimple', 'UNETLoader', 'CLIPLoader', 'VAELoader', 'CLIPTextEncode', 'EmptyLatentImage', 'KSampler', 'VAEDecode', 'SaveImage', 'ConditioningZeroOut', 'LoraLoader', 'LoraLoaderModelOnly', 'CLIPSetLastLayer', 'ModelSamplingDiscrete']
const info: Record<string, any> = Object.fromEntries(nodes.map((n) => [n, { input: { required: {} } }]))
info.CheckpointLoaderSimple.input.required.ckpt_name = [['NoobAI/noob_vpred.safetensors', 'Illustrious/prefect.safetensors', 'NoobAI/hashed.safetensors', 'NoobAI/described.safetensors']]
info.KSampler.input.required = { sampler_name: [['euler', 'euler_ancestral', 'dpmpp_2m']], scheduler: [['simple', 'karras', 'normal']] }
let outputs: Buffer[] = []
const graphs: Record<string, any>[] = []
const comfy = createServer((req, res) => {
  let raw = ''
  req.on('data', (b) => raw += b)
  req.on('end', () => {
    const url = new URL(req.url!, 'http://test')
    if (url.pathname.startsWith('/object_info/')) { const n = url.pathname.slice(13); return send(res, info[n] ? { [n]: info[n] } : {}) }
    if (url.pathname === '/api/lm/checkpoints/list') return send(res, { items: [{ folder: 'NoobAI', file_path: '/m/NoobAI/noob_vpred.safetensors', sub_type: 'checkpoint', base_model: 'NoobAI' }, { folder: 'Illustrious', file_path: '/m/Illustrious/prefect.safetensors', sub_type: 'checkpoint', base_model: 'Illustrious', tags: ['anime'] }, { folder: 'NoobAI', file_path: '/m/NoobAI/hashed.safetensors', sub_type: 'checkpoint', base_model: 'NoobAI', sha256: 'c'.repeat(64) }, { folder: 'NoobAI', file_path: '/m/NoobAI/described.safetensors', sub_type: 'checkpoint', base_model: 'NoobAI', civitai: { id: 920001, modelId: 920002 } }], total_pages: 1 })
    if (url.pathname.startsWith('/api/lm/')) return send(res, { items: [], total_pages: 1 })
    if (url.pathname === '/prompt') { graphs.push(JSON.parse(raw).prompt); return send(res, { prompt_id: `job-${graphs.length}` }) }
    if (url.pathname.startsWith('/history/')) { const id = url.pathname.split('/').pop()!; return send(res, { [id]: { status: { completed: true }, outputs: { '9': { images: [{ filename: `${id}.png`, subfolder: '', type: 'output' }] } } } }) }
    if (url.pathname === '/view') { const n = Number(/job-(\d+)/.exec(url.searchParams.get('filename') ?? '')?.[1] ?? 1); return res.writeHead(200, { 'Content-Type': 'image/png' }).end(outputs[Math.min(n, outputs.length) - 1]) }
    res.writeHead(404).end()
  })
})
let plan: { name: string; arguments: Record<string, unknown> }[][] = []
let visionVerdict = '{"score": 7, "very_bad": false, "defects": []}'
let visionQueue: string[] = []
let visionCalls = 0, modelReplies = 0
const ollama = createServer((req, res) => {
  let raw = ''
  req.on('data', (b) => raw += b)
  req.on('end', () => {
    if (req.url === '/api/tags') return send(res, { models: [{ name: 'test-model' }] })
    if (req.url === '/api/show') return send(res, { capabilities: ['tools', 'vision'], model_info: { 'test.context_length': 131072 } })
    const body = JSON.parse(raw)
    if (!body.stream) return send(res, { message: { content: '{"title":"Quality test"}' } })
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
    if (body.messages.some((m: any) => m.images?.length)) { visionCalls++; return res.end(JSON.stringify({ message: { role: 'assistant', content: visionQueue.shift() ?? visionVerdict }, done: true }) + '\n') }
    const after = body.messages.slice(body.messages.findLastIndex((m: any) => m.role === 'user') + 1)
    const step = plan[after.filter((m: any) => m.role === 'assistant').length]
    modelReplies++
    const message = step ? { content: 'Retrying with other settings.', tool_calls: step.map((call) => ({ function: call })) } : { content: 'Both tries came out broken.' }
    res.end(JSON.stringify({ message: { role: 'assistant', ...message }, done: true }) + '\n')
  })
})
const listen = async (s: ReturnType<typeof createServer>) => { await new Promise<void>((r) => s.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${(s.address() as { port: number }).port}` }
const comfyUrl = await listen(comfy), ollamaUrl = await listen(ollama)
const server = new Server({ OLLAMA_URL: ollamaUrl, OLLAMA_API_KEY: 'fake', GITHUB_CLIENT_ID: 'x', GITHUB_CLIENT_SECRET: 'x', ADMIN_USERS: 'intel-admin' })
// One data folder for this process and the server it starts.
process.env.DATA_DIR = server.data

try {
// --- pure parts ---------------------------------------------------------------------------------
{
  const cases: [string, string | undefined, string | null, string | null][] = [
    ['DPM++ 2M', 'Karras', 'dpmpp_2m', 'karras'], ['DPM++ 2M Karras', undefined, 'dpmpp_2m', 'karras'], ['Euler a', undefined, 'euler_ancestral', null],
    ['DPM++ SDE Karras', undefined, 'dpmpp_sde', 'karras'], ['DPM++ 2M SDE', undefined, 'dpmpp_2m_sde', null], ['DPM++ 2M SDE Exponential', undefined, 'dpmpp_2m_sde', 'exponential'],
    ['Euler', 'Simple', 'euler', 'simple'], ['DDIM', undefined, 'ddim', null], ['UniPC', undefined, 'uni_pc', null], ['LCM', undefined, 'lcm', null],
    ['Euler', 'SGM Uniform', 'euler', 'sgm_uniform'], ['Euler', 'Normal', 'euler', 'normal'], ['Euler', 'Beta', 'euler', 'beta'], ['DPM++ 2M', 'Automatic', 'dpmpp_2m', null],
    ['euler_ancestral', undefined, 'euler_ancestral', null], ['dpmpp_2m_karras', undefined, 'dpmpp_2m', 'karras'], ['Restart', undefined, null, null], ['res_2s', undefined, null, null],
  ]
  for (const [sampler, schedule, want, wantSchedule] of cases) {
    const m = mapA1111Sampler(sampler, schedule)
    assert.equal(m.sampler, want, `${sampler} ${schedule ?? ''}`)
    assert.equal(m.scheduler, wantSchedule, `${sampler} ${schedule ?? ''} schedule`)
  }
  assert.equal(median([3, 1, 2]), 2); assert.equal(median([1, 2, 3, 4]), 2.5); assert.equal(median([]), null)
  for (const [t, v] of [['jankunV10BasedOnNoobVpred_v10', true], ['miaomiaoPixel_vPred11', true], ['NoobAI-XL V-Pred 1.0', true], ['noob_v-prediction', true], ['devPred', false], ['preview', false], ['prefectIllustriousXL_v8', false]] as const) assert.equal(isVpred(t), v, t)
  assert.equal(familyOf('NoobAI', { vpred: true }), 'noobai_vpred')
  assert.equal(familyOf('Illustrious', { vpred: true }), 'noobai_vpred')
  assert.equal(familyOf('Krea 2', { name: 'DasiwaKrea2TurboRaw_cutedisasterV2Turbo' }), 'krea2_turbo')
  assert.equal(familyOf('Krea 2', { name: 'moodyKrea2Mix_v70', tags: ['drawing'] }), 'krea2', 'a tag like "drawing" is not "raw"')
  assert.equal(familyOf('ZImageTurbo'), 'z_image_turbo'); assert.equal(familyOf('SDXL 1.0'), 'sdxl'); assert.equal(familyOf('SD 1.5'), 'sd15'); assert.equal(familyOf('Pony'), 'pony')
  assert.equal(familyOf('Anima'), 'anima'); assert.equal(MODEL_FAMILIES.anima.supported, false); assert.equal(familyOf('MiniMax H3'), 'minimax_h3'); assert.equal(MODEL_FAMILIES.minimax_h3.supported, false)
  assert.equal(familyOf(''), null); assert.equal(familyOf('Hunyuan 1'), null)
  // Consensus: combined and separate names agree; unmapped and uninstalled samplers are reported, not used.
  const c = exampleConsensus([{ sampler: 'DPM++ 2M', 'Schedule type': 'Karras', steps: 20, cfgScale: 5, clipSkip: 2 }, { sampler: 'DPM++ 2M Karras', steps: 30, cfgScale: '7', clipSkip: 2 }, { sampler: 'Euler a', steps: 25 }, null, { prompt: 'no settings' }])
  assert.deepEqual([c.images, c.total, c.sampler?.agree, c.sampler?.comfy, c.steps, c.cfg, c.clipSkip], [3, 5, 2, { sampler: 'dpmpp_2m', scheduler: 'karras' }, 25, 6, 2])
  const notInstalled = exampleConsensus([{ sampler: 'DPM++ 2M', 'Schedule type': 'Karras' }, { sampler: 'DPM++ 2M Karras' }], { samplers: ['euler'], schedulers: ['karras'] })
  assert.equal(notInstalled.sampler?.comfy, null); assert.match(notInstalled.sampler?.unmapped ?? '', /not installed/)
  const unmapped = exampleConsensus([{ sampler: 'res_2s', steps: 8 }, { sampler: 'res_2s', steps: 8 }])
  assert.equal(unmapped.sampler?.comfy, null); assert.match(unmapped.sampler?.unmapped ?? '', /no ComfyUI equivalent/)
  const badSchedule = exampleConsensus([{ sampler: 'Euler', 'Schedule type': 'Align Your Steps' }, { sampler: 'Euler', 'Schedule type': 'Align Your Steps' }])
  assert.deepEqual(badSchedule.sampler?.comfy, { sampler: 'euler', scheduler: null }); assert.match(badSchedule.sampler?.unmapped ?? '', /schedule/)
  console.log('PASS A1111 → ComfyUI sampler mapping (combined names, schedules, unmapped), medians, consensus, family detection, v-pred names')
}

const { managerItem, joinInstalled, usageTips, parseCivitaiVersion, stripHtml, civitaiFacts, civitaiGet, setCivitaiFetcher, recommend, fitSize, civitaiScope, cachedCivitai, assetIsVpred, loraWeights, managerIndex, MANAGER_MAX_PAGES } = await import('../server/agentModelIntel.ts')
const { pixelQuality, parseVisionVerdict, checkImageQuality, QualityRetry, QUALITY_MAX_PIXELS } = await import('../server/agentImageQuality.ts')
{
  // LoRA Manager: folder + file joins exactly; a leaf alone never does; ambiguous joins drop.
  const raw = [
    { folder: 'Illustrious/Prefect', file_path: '/root/ComfyUI/models/checkpoints/Illustrious/Prefect/prefect_v8.safetensors', sub_type: 'checkpoint', base_model: 'Illustrious', model_name: 'Prefect', tags: ['anime', 'base model'], auto_tags: [], civitai: { id: 2864868, modelId: 1224788, name: 'v8', trainedWords: [] }, sha256: 'A'.repeat(64), usage_tips: '{}', notes: '' },
    { folder: 'Krea2', file_path: 'C:\\models\\diffusion_models\\Krea2\\cute.safetensors', sub_type: 'diffusion_model', base_model: 'Krea 2', auto_tags: ['Turbo'], civitai: { id: '3151280' } },
    { folder: 'Other', file_path: '/m/Other/prefect_v8.safetensors', sub_type: 'checkpoint', base_model: 'SDXL 1.0' },
    { folder: '', file_path: '/m/loose.safetensors', sub_type: 'checkpoint', base_model: 'SD 1.5' },
    { folder: 'Dup', file_path: '/a/Dup/x.safetensors', sub_type: 'checkpoint', base_model: 'Pony' }, { folder: 'Dup', file_path: '/b/Dup/x.safetensors', sub_type: 'checkpoint', base_model: 'SDXL 1.0' },
    { folder: 'Bad', file_path: '/x', sub_type: 'video' }, null, 'junk',
  ]
  const items = raw.map((r) => managerItem(r, 'checkpoint')).filter((x): x is NonNullable<typeof x> => !!x)
  const loraItem = managerItem({ folder: 'Style', file_path: '/l/Style/ink.safetensors', base_model: 'SDXL 1.0', usage_tips: '{"strength": 0.7, "bad key!": 1}', civitai: { trainedWords: ['inkwash', 'x'.repeat(200), 'inkwash'] } }, 'lora')!
  const joined = joinInstalled([...items, loraItem], { checkpoints: ['Illustrious/Prefect/prefect_v8.safetensors', 'prefect_v8.safetensors', 'loose.safetensors', 'Dup/x.safetensors'], diffusionModels: ['Krea2\\cute.safetensors'], loras: ['Style\\ink.safetensors'] })
  const by = (n: string) => joined.find((f) => f.name === n)
  assert.equal(by('Illustrious/Prefect/prefect_v8.safetensors')?.baseModel, 'Illustrious')
  assert.equal(by('Illustrious/Prefect/prefect_v8.safetensors')?.versionId, 2864868)
  assert.equal(by('Illustrious/Prefect/prefect_v8.safetensors')?.sha256, 'a'.repeat(64))
  assert.equal(by('prefect_v8.safetensors'), undefined, 'the same leaf in another folder does not join')
  assert.equal(by('loose.safetensors')?.baseModel, 'SD 1.5', 'root files join on the file name with an empty folder')
  assert.equal(by('Dup/x.safetensors'), undefined, 'ambiguous joins are dropped')
  assert.equal(by('Krea2\\cute.safetensors')?.versionId, 3151280, 'exact backslash identifiers are kept')
  assert.deepEqual(by('Krea2\\cute.safetensors')?.autoTags, ['Turbo'])
  assert.deepEqual(by('Style\\ink.safetensors')?.usageTips, { strength: 0.7 })
  assert.deepEqual(by('Style\\ink.safetensors')?.trainedWords, ['inkwash'])
  assert.deepEqual(usageTips({ strength: 0.5, clip_skip: 2 }), { strength: 0.5, clip_skip: 2 }); assert.deepEqual(usageTips('not json'), {})
  console.log('PASS LoRA Manager parsing: exact folder + file joins, leaf-only refused, duplicates dropped, usage tips and trained words cleaned')

  // Civitai: the trimmed fixture.
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/civitai-model-version.json', import.meta.url), 'utf8'))
  const installed = { samplers: ['euler', 'euler_ancestral', 'dpmpp_2m'], schedulers: ['simple', 'karras', 'normal'] }
  const facts = parseCivitaiVersion(fixture, installed)!
  assert.equal(facts.versionId, 111222); assert.equal(facts.modelId, 333444); assert.equal(facts.baseModel, 'Illustrious')
  assert.equal(facts.url, 'https://civitai.com/models/333444?modelVersionId=111222')
  assert.deepEqual(facts.trainedWords, ['fixture style'])
  assert.ok(!facts.description.includes('alert') && !facts.description.includes('<') && facts.description.includes('Clip skip 2 & no score tags.'), facts.description)
  assert.deepEqual([facts.consensus.images, facts.consensus.total, facts.consensus.sampler?.agree, facts.consensus.sampler?.comfy, facts.consensus.steps, facts.consensus.cfg, facts.consensus.clipSkip], [5, 6, 4, { sampler: 'dpmpp_2m', scheduler: 'karras' }, 20, 5, 2])
  assert.deepEqual(facts.consensus.sizes[0], { size: '832x1216', count: 3 })
  assert.ok(facts.consensus.sizes.some((s) => s.size === '1664x2432'), 'the picture size stands in for a missing Size')
  assert.deepEqual(facts.examples.map((e) => e.prompt.split(',')[0]), ['masterpiece', 'a red fox in a snowy forest', 'a sailboat on a calm lake'])
  assert.equal(facts.loraWeight, null, 'without the LoRA file name, other LoRAs in the prompts say nothing')
  assert.equal(parseCivitaiVersion(fixture, installed, ['Detail/fixtureDetail.safetensors'])!.loraWeight, 0.7)
  // Only this LoRA's own weight: by modelVersionId in the resource lists, else by its file name.
  assert.deepEqual(loraWeights([{ prompt: '<lora:target:0.2> <lora:unrelated:1.8>' }], 1, ['Style/target.safetensors']), [0.2])
  assert.deepEqual(loraWeights([{ prompt: '<lora:target:0.2> <lora:unrelated:1.8>' }], 1, []), [], 'no identity, no recommendation')
  assert.deepEqual(loraWeights([{ prompt: '<lora:renamed:0.9>', civitaiResources: [{ type: 'lora', modelVersionId: 77, weight: 0.45 }, { type: 'lora', modelVersionId: 78, weight: 1.9 }] }], 77, ['Style/target.safetensors']), [0.45])
  assert.deepEqual(loraWeights([{ resources: [{ type: 'lora', name: 'other', weight: 1.7 }, { type: 'lora', name: 'Target', weight: 0.6 }] }], 1, ['target.safetensors']), [0.6])
  assert.deepEqual(loraWeights([{ prompt: '<lora:unrelated:1.8>', civitaiResources: [{ type: 'lora', modelVersionId: 78, weight: 1.9 }] }], 77, ['target.safetensors']), [])
  assert.equal(stripHtml('<p>a&nbsp;b &lt;c&gt;</p><style>x{}</style>', 100), 'a b <c>')
  const rec = recommend('checkpoints', 'illustrious', facts.consensus, installed, false)
  assert.deepEqual({ ...rec, notes: undefined }, { preset: 'sdxl', sampler: 'dpmpp_2m', scheduler: 'karras', steps: 20, cfg: 5, clip_skip: 2, width: 832, height: 1216, source: 'civitai_examples', agree: '4 of 5', notes: undefined })
  const plain = recommend('checkpoints', 'illustrious', null, installed, false)
  assert.deepEqual([plain.sampler, plain.scheduler, plain.steps, plain.cfg, plain.clip_skip, plain.source], ['euler_ancestral', 'normal', 26, 5, 2, 'family_default'])
  const turbo = recommend('diffusionModels', 'z_image_turbo', exampleConsensus([{ sampler: 'Euler', steps: 9, cfgScale: 3, clipSkip: 2 }, { sampler: 'Euler', steps: 9, cfgScale: 3, clipSkip: 2 }]), installed, false)
  assert.deepEqual([turbo.preset, turbo.cfg, turbo.clip_skip, turbo.steps], ['z_image_turbo', 1, 1, 9], 'Turbo keeps CFG 1; diffusion presets have no clip skip')
  assert.equal(recommend('checkpoints', 'noobai_vpred', null, installed, true).v_prediction, true)
  assert.equal(recommend('diffusionModels', 'sdxl', null, installed, false).preset, null, 'a separate diffusion model never gets a checkpoint preset')
  assert.deepEqual(fitSize(1664, 2432), { width: 832, height: 1216 }); assert.deepEqual(fitSize(2048, 2048), { width: 1024, height: 1024 }); assert.deepEqual(fitSize(512, 768), { width: 512, height: 768 })
  console.log('PASS Civitai parsing from a fixture: base model, trained words, stripped description, consensus 4 of 5, sizes, example prompts, LoRA weight, recommended block and its precedence')

  // Network: cache, TTL, negative results, egress, the switch, the key.
  const requests: { url: string; auth: string | null }[] = []
  let answer: (url: URL) => Response = (url) => url.pathname.includes('/by-hash/') ? Response.json({ id: 111222 }) : url.pathname.startsWith('/api/v1/models/') ? Response.json({ description: '<p>Model page</p>' }) : url.pathname.endsWith('/404404') ? new Response('', { status: 404 }) : Response.json(fixture)
  setCivitaiFetcher(async (url, init) => { requests.push({ url: url.href, auth: new Headers(init.headers).get('authorization') }); assert.equal(init.redirect, 'manual'); return answer(url) })
  const { database } = await import('../server/db.ts')
  // An entry from before keys were scoped (shared `k` namespace) is discarded on first use.
  database().exec('CREATE TABLE IF NOT EXISTS civitai_cache (key TEXT PRIMARY KEY, body TEXT NOT NULL, expires_at INTEGER NOT NULL)')
  database().prepare('INSERT INTO civitai_cache (key, body, expires_at) VALUES (?, ?, ?)').run('v:111222:k', JSON.stringify({ ...fixture, name: 'leaked' }), Date.now() + 86_400_000)
  const on = { civitaiLookup: true, civitaiKey: '', scope: 'p' }
  assert.equal((await civitaiFacts({ civitaiLookup: false, civitaiKey: 'k', scope: civitaiScope(1, 'k') }, { versionId: 111222, sha256: null })).facts, null)
  assert.equal(requests.length, 0, 'the switch off means no requests')
  const first = await civitaiFacts(on, { versionId: 111222, sha256: null }, installed)
  assert.equal(first.facts?.modelDescription, 'Model page'); assert.equal(first.cached, false)
  assert.deepEqual(requests.map((r) => r.url), ['https://civitai.com/api/v1/model-versions/111222', 'https://civitai.com/api/v1/models/333444'])
  assert.ok(requests.every((r) => r.auth === null), 'no key, no Authorization header')
  assert.equal((await civitaiFacts(on, { versionId: 111222, sha256: null }, installed)).cached, true)
  assert.equal(requests.length, 2, 'the second read is cached')
  assert.equal(database().prepare("SELECT 1 FROM civitai_cache WHERE key LIKE '%:k'").get(), undefined, 'legacy shared-key entries are gone')
  database().prepare("UPDATE civitai_cache SET expires_at = ? WHERE key LIKE 'v:111222:%'").run(Date.now() - 1)
  await civitaiFacts(on, { versionId: 111222, sha256: null }, installed)
  assert.equal(requests.length, 3, 'past its TTL the version is read again (the model page still cached)')
  const ttl = database().prepare("SELECT expires_at FROM civitai_cache WHERE key = 'v:111222:p'").get() as { expires_at: number }
  assert.ok(Math.abs(ttl.expires_at - Date.now() - 7 * 86_400_000) < 60_000, 'kept for 7 days')
  assert.equal((await civitaiFacts(on, { versionId: 404404, sha256: null })).facts, null)
  assert.equal((await civitaiFacts(on, { versionId: 404404, sha256: null })).facts, null)
  assert.equal(requests.filter((r) => r.url.endsWith('/404404')).length, 1, 'a missing version is cached as missing')
  const negative = database().prepare("SELECT expires_at FROM civitai_cache WHERE key = 'v:404404:p'").get() as { expires_at: number }
  assert.ok(Math.abs(negative.expires_at - Date.now() - 86_400_000) < 60_000, 'negative results last a day')
  requests.length = 0
  const byHash = await civitaiFacts({ civitaiLookup: true, civitaiKey: 'civitai-key-123', scope: civitaiScope(1, 'civitai-key-123') }, { versionId: null, sha256: 'b'.repeat(64) }, installed)
  assert.equal(byHash.facts?.versionId, 111222)
  assert.equal(requests[0].url, `https://civitai.com/api/v1/model-versions/by-hash/${'b'.repeat(64)}`)
  assert.ok(requests.every((r) => r.auth === 'Bearer civitai-key-123'), 'the key goes as a Bearer header, to civitai.com only')
  assert.ok(requests.every((r) => new URL(r.url).origin === 'https://civitai.com'))
  // Keys never share answers: account A's keyed answer is not served to B, with another or an invalid key.
  const keyA = { civitaiLookup: true, civitaiKey: 'key-of-account-a', scope: civitaiScope(31, 'key-of-account-a') }
  const sameKeyOtherAccount = { civitaiLookup: true, civitaiKey: 'key-of-account-a', scope: civitaiScope(32, 'key-of-account-a') }
  const keyB = { civitaiLookup: true, civitaiKey: 'not-a-valid-key', scope: civitaiScope(32, 'not-a-valid-key') }
  assert.notEqual(keyA.scope, sameKeyOtherAccount.scope); assert.notEqual(keyA.scope, keyB.scope); assert.ok(!keyA.scope.includes('key-of-account-a'))
  answer = (url) => url.pathname === '/api/v1/model-versions/515151' ? Response.json({ ...fixture, id: 515151, name: 'members-only' }) : Response.json({ description: '' })
  const answers = new Map<string, Response>()
  setCivitaiFetcher(async (url, init) => { const auth = new Headers(init.headers).get('authorization'); requests.push({ url: url.href, auth }); return auth === 'Bearer not-a-valid-key' ? new Response('', { status: 401 }) : answers.get(url.href) ?? answer(url) })
  assert.equal((await civitaiFacts(keyA, { versionId: 515151, sha256: null })).facts?.versionName, 'members-only')
  requests.length = 0
  const b = await civitaiFacts(keyB, { versionId: 515151, sha256: null })
  assert.equal(b.facts, null, 'B with an invalid key gets nothing A fetched'); assert.match(b.note ?? '', /401/)
  assert.equal(requests.length, 1, 'B asked Civitai itself')
  await civitaiFacts(sameKeyOtherAccount, { versionId: 515151, sha256: null })
  assert.equal(requests.length, 3, 'another account with the same key also asks itself (version and model page)')
  assert.equal(cachedCivitai(keyB.scope, { versionId: 515151, sha256: null }), null)
  assert.equal(cachedCivitai('p', { versionId: 515151, sha256: null }), null, 'keyed answers never land in the shared anonymous namespace')
  assert.ok(!(database().prepare('SELECT group_concat(key) AS k FROM civitai_cache').get() as { k: string }).k.includes('key-of-account'), 'the key itself is never stored')
  setCivitaiFetcher(async (url, init) => { requests.push({ url: url.href, auth: new Headers(init.headers).get('authorization') }); assert.equal(init.redirect, 'manual'); return answer(url) })
  console.log('PASS Civitai cache scope: anonymous shared, keyed answers per account and key digest, invalid key gets nothing, legacy entries discarded')

  // V-pred from cached Civitai facts, shared by model_details and generate_image: a version found by
  // hash whose name says v-pred, and a version whose model page alone says so.
  answer = (url) => url.pathname.includes('/by-hash/') ? Response.json({ ...fixture, id: 620001, name: 'v-pred 1.0' }) : url.pathname === '/api/v1/model-versions/630001' ? Response.json({ ...fixture, id: 630001, modelId: 630002, name: '1.0', description: '<p>Use Euler.</p>' }) : url.pathname === '/api/v1/models/630002' ? Response.json({ description: '<p>This is a v-prediction model; enable zsnr.</p>' }) : Response.json({ description: '' })
  const hashed = { name: 'NoobAI/x.safetensors', title: 'x', versionName: '', tags: [], autoTags: [], baseModel: 'NoobAI', versionId: null, modelId: null, sha256: 'd'.repeat(64) }
  const described = { ...hashed, name: 'NoobAI/y.safetensors', versionId: 630001, sha256: null }
  assert.equal(assetIsVpred(hashed, cachedCivitai('p', hashed)), false, 'nothing cached yet')
  await civitaiFacts(on, hashed); await civitaiFacts(on, described)
  assert.equal(assetIsVpred(hashed, cachedCivitai('p', hashed)), true, 'version found via sha256')
  assert.equal(cachedCivitai('p', described)?.modelDescription.includes('v-prediction'), true)
  assert.equal(assetIsVpred(described, cachedCivitai('p', described)), true, 'v-pred named only in the model description')
  assert.equal(assetIsVpred({ ...described, baseModel: 'Krea 2' }, cachedCivitai('p', described)), false, 'not for families without v-pred builds')
  assert.equal(assetIsVpred(described, { versionName: '', description: 'This is not a v-pred model.', modelDescription: '', baseModel: 'NoobAI' }), false)
  console.log('PASS v-pred from cached Civitai facts: via file hash, via the model description only, one shared detector')

  // Redirects: within civitai.com followed, anywhere else refused; failures are not cached.
  answer = (url) => url.pathname === '/api/v1/model-versions/5' ? new Response(null, { status: 301, headers: { location: 'https://evil.example/steal' } }) : url.pathname === '/api/v1/model-versions/6' ? new Response(null, { status: 302, headers: { location: '/api/v1/model-versions/7' } }) : url.pathname === '/api/v1/model-versions/8' ? new Response(null, { status: 302, headers: { location: 'http://civitai.com/api/v1/model-versions/7' } }) : Response.json({ ...fixture, id: 7 })
  requests.length = 0
  await assert.rejects(civitaiGet('/api/v1/model-versions/5', '', AbortSignal.timeout(1000)), /redirected off civitai.com/)
  await assert.rejects(civitaiGet('/api/v1/model-versions/8', '', AbortSignal.timeout(1000)), /redirected off civitai.com/, 'a downgrade to http is refused')
  assert.equal((await civitaiGet('/api/v1/model-versions/6', '', AbortSignal.timeout(1000)))?.id, 7)
  assert.ok(!requests.some((r) => r.url.includes('evil.example')), 'the redirect target is never requested')
  const failed = await civitaiFacts(on, { versionId: 5, sha256: null })
  assert.match(failed.note ?? '', /redirected off/)
  assert.equal(database().prepare("SELECT 1 FROM civitai_cache WHERE key = 'v:5:p'").get(), undefined, 'a failed lookup is not cached')
  await assert.rejects(civitaiGet('https://evil.example/api/v1/model-versions/1', '', AbortSignal.timeout(1000)), /civitai.com only/)
  console.log('PASS Civitai: switch off sends nothing, 7-day cache and TTL, 1-day negative cache, hash lookup, Bearer key only to civitai.com, redirects off civitai.com refused and not cached')
}

{
  // LoRA Manager paging: pages, raw records and bytes bounded on their own; a stalled page keeps what came before.
  const seen = new Map<string, number>()
  let mode: 'junk' | 'stall' = 'junk'
  const lm = createServer((req, res) => {
    const url = new URL(req.url!, 'http://lm')
    seen.set(url.pathname, (seen.get(url.pathname) ?? 0) + 1)
    const page = Number(url.searchParams.get('page'))
    if (mode === 'stall' && page === 2) return // never answers
    const items = mode === 'junk' ? Array.from({ length: 100 }, () => ({ nope: true })) : Array.from({ length: 100 }, (_, i) => ({ folder: 'F', file_path: `/m/F/${page}-${i}.safetensors`, sub_type: 'checkpoint', base_model: 'SDXL 1.0' }))
    send(res, { items, total_pages: 999 })
  })
  const lmUrl = await listen(lm)
  const { database, encrypt } = await import('../server/db.ts')
  database().prepare('INSERT INTO users (id, github_id, login, github_token, created_at, updated_at) VALUES (20, 20, ?, ?, 0, 0)').run('paging', encrypt('none'))
  const { saveImageSettings } = await import('../server/agentImages.ts')
  const pager = { id: 20, admin: true } as never
  saveImageSettings(pager, { url: lmUrl })
  const junk = await managerIndex(pager)
  for (const [path, n] of seen) assert.ok(n <= MANAGER_MAX_PAGES, `${path}: ${n} requests`)
  assert.equal(seen.get('/api/lm/checkpoints/list'), MANAGER_MAX_PAGES, 'full pages of rejected records stop at the page cap')
  assert.deepEqual([junk.items.length, junk.truncated], [0, true])
  mode = 'stall'; seen.clear()
  saveImageSettings(pager, { token: 'other-scope' })
  const partial = await managerIndex(pager, undefined, 800)
  assert.deepEqual([partial.available, partial.items.length, partial.complete], [true, 300, false], 'page 1 of each list kept after the timeout')
  lm.closeAllConnections(); await new Promise<void>((r) => lm.close(() => r()))
  console.log(`PASS LoRA Manager paging: ${MANAGER_MAX_PAGES}-page cap with all-rejected pages, partial results kept on timeout`)
}

{
  // Pixel checks.
  assert.equal(pixelQuality(black).very_bad, true); assert.match(pixelQuality(black).defects[0], /black/)
  assert.equal(pixelQuality(white).very_bad, true)
  assert.equal(pixelQuality(png(256, 256, () => [120, 80, 200])).very_bad, true, 'one flat colour')
  assert.equal(pixelQuality(noise).very_bad, true); assert.match(pixelQuality(noise).defects.join(), /noise/)
  assert.equal(pixelQuality(fine).very_bad, false, JSON.stringify(pixelQuality(fine)))
  assert.equal(pixelQuality(tiny).checked, false); assert.equal(pixelQuality(Buffer.from('nope')).checked, false)
  // Normal generation sizes, sampled; above about 4 MP only vision runs.
  const wide = png(1536, 1024, (x, y) => (x * y) % 997 < 2 ? [3, 3, 3] : [0, 0, 0])
  let started = performance.now()
  assert.equal(pixelQuality(wide).very_bad, true)
  const wideMs = performance.now() - started
  const big = png(2048, 2048, () => { const v = Math.floor(rand() * 256); return [v, v, v] })
  started = performance.now()
  assert.equal(pixelQuality(big).very_bad, true, '2048 × 2048 noise')
  const bigMs = performance.now() - started
  assert.ok(bigMs < 400, `2048 × 2048 checked in ${Math.round(bigMs)} ms`)
  const huge = png(2100, 2100, () => [0, 0, 0])
  assert.ok(2100 * 2100 > QUALITY_MAX_PIXELS)
  assert.deepEqual([pixelQuality(huge).checked, pixelQuality(huge).large], [false, true])
  let hugeAsked = 0
  assert.equal((await checkImageQuality(huge, 'x', async () => { hugeAsked++; return '{"score": 2, "very_bad": true, "defects": ["mush"]}' })).very_bad, true); assert.equal(hugeAsked, 1, 'too large for pixels: vision decides')
  assert.equal(await checkImageQuality(tiny, 'x', async () => { throw new Error('must not be asked') }).then((v) => v.checked), false)
  console.log(`PASS pixel checks sampled: 1536 × 1024 in ${Math.round(wideMs)} ms, 2048 × 2048 in ${Math.round(bigMs)} ms, larger pictures left to vision`)
  // Vision verdicts.
  assert.deepEqual(parseVisionVerdict('Sure: {"score": 2, "very_bad": true, "defects": ["melted face", 5]} done'), { score: 2, very_bad: true, defects: ['melted face'] })
  assert.equal(parseVisionVerdict('{"score": 7, "very_bad": true, "defects": []}')?.very_bad, false, 'very_bad needs a low score')
  assert.equal(parseVisionVerdict('no json'), null); assert.equal(parseVisionVerdict('{"score": 11, "very_bad": false}'), null)
  let asked = 0
  const vision = async (system: string, text: string) => { asked++; assert.match(system, /JSON/); assert.match(text, /a fox/); return '{"score": 3, "very_bad": true, "defects": ["garbled anatomy"]}' }
  assert.deepEqual((await checkImageQuality(black, 'a fox', vision)).by, ['pixels']); assert.equal(asked, 0, 'pixels catch it: no vision call')
  const seen = await checkImageQuality(fine, 'a fox', vision)
  assert.deepEqual([seen.very_bad, seen.score, seen.defects, seen.by, asked], [true, 3, ['garbled anatomy'], ['pixels', 'vision'], 1])
  assert.equal((await checkImageQuality(fine, 'a fox', null)).very_bad, false)
  assert.equal((await checkImageQuality(fine, 'a fox', async () => { throw new Error('down') })).very_bad, false)
  // The retry cap.
  const q = new QualityRetry()
  const bad = { checked: true, very_bad: true, score: 1, defects: ['noise'], by: ['pixels' as const], notes: [] }, good = { ...bad, very_bad: false, score: 7, defects: [] }
  assert.equal(q.blocked(), null); q.started()
  const once = q.after(bad); assert.equal(once.complete, false); assert.equal((once.extra.retry as { allowed: boolean }).allowed, true)
  assert.equal(q.blocked(), null, 'the retry may run'); q.started()
  const twice = q.after(bad); assert.equal(twice.complete, false); assert.equal((twice.extra.retry as { allowed: boolean }).allowed, false)
  assert.match(q.blocked() ?? '', /already used/, 'no third generation')
  const fixed = new QualityRetry(); fixed.started(); fixed.after(bad); fixed.started()
  assert.deepEqual([fixed.after(good).complete, fixed.after(good).retryFixed], [true, true])
  // Flagged by vision; the retry's vision check timed out: inconclusive, not a fix; the first failure stays in the result.
  const visionBad = { checked: true, very_bad: true, score: 2, defects: ['melted face'], by: ['pixels' as const, 'vision' as const], notes: [] }
  const timedOut = { checked: true, very_bad: false, score: null, defects: [], by: ['pixels' as const], notes: ['The vision check failed: timed out.'], inconclusive: true }
  const unsure = new QualityRetry(); unsure.started(); unsure.after(visionBad); unsure.started()
  const after = unsure.after(timedOut)
  assert.deepEqual([after.complete, after.retryFixed], [true, false])
  assert.deepEqual((after.extra.first_attempt as { defects: string[] }).defects, ['melted face'])
  assert.equal((after.extra.quality as { inconclusive: boolean }).inconclusive, true)
  assert.deepEqual((after.extra.quality as { notes: string[] }).notes, ['The vision check failed: timed out.'])
  // Flagged by pixels (black); the retry passes the pixels with vision down: the same check passed, so fixed.
  const pixelsFixed = new QualityRetry(); pixelsFixed.started(); pixelsFixed.after(bad); pixelsFixed.started()
  assert.equal(pixelsFixed.after(timedOut).retryFixed, true)
  const fineFirst = new QualityRetry(); fineFirst.started()
  assert.deepEqual(fineFirst.after(good), { complete: true, extra: {}, retryFixed: false }, 'a fine picture stays silent')
  assert.deepEqual(new QualityRetry().after(null), { complete: true, extra: {}, retryFixed: false }, 'no check, no change')
  assert.equal(qualityNote(JSON.stringify({ image: {}, quality: { very_bad: true, defects: ['noise'] } })), ' · clearly broken: noise'); assert.equal(qualityNote('{}'), '')
  assert.equal(modelDetailsLabel({ name: 'Illustrious/Prefect/prefect.safetensors' }, JSON.stringify({ family: { label: 'Illustrious' }, recommended: { sampler: 'dpmpp_2m', scheduler: 'karras', steps: 20, cfg: 5, clip_skip: 2, source: 'civitai_examples', agree: '9 of 9' } })), 'Model details: prefect.safetensors · Illustrious · dpmpp_2m/karras · 20 steps · CFG 5 · clip skip 2 · Civitai examples (9 of 9 agree)')
  console.log('PASS quality check: black, white, flat and noise caught without vision, fine pictures pass, tiny ones skipped, vision rubric parsed and bounded, one retry then stop, labels')
}

{
  const { database, encrypt, sha256 } = await import('../server/db.ts')
  const { civitaiScope } = await import('../server/agentModelIntel.ts')
  const session = randomBytes(24).toString('hex')
  database().prepare('INSERT INTO users (id, github_id, login, github_token, created_at, updated_at) VALUES (1, 1, ?, ?, ?, ?)').run('intel-admin', encrypt('none'), Date.now(), Date.now())
  database().prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, 1, ?, ?)').run(sha256(session), Date.now(), Date.now() + 86400_000)
  await server.start()
  const headers = { Cookie: `mvlos_sid=${session}`, ...await asPage(session), 'Content-Type': 'application/json' }
  const call = async (method: string, path: string, body?: unknown) => { const r = await fetch(server.origin + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }); assert.equal(r.status, 200, await r.clone().text()); return r.json() as Promise<any> }
  const settings = await call('PUT', '/api/agents/images/settings', { url: comfyUrl, token: 'comfy-secret', preset: 'sdxl', model: 'Illustrious/prefect.safetensors', civitaiKey: 'civitai-key-123' })
  assert.deepEqual([settings.qualityCheck, settings.civitaiLookup, settings.civitaiKey], [true, true, true], 'on by default; the key is reported as set, never returned')
  assert.equal((await fetch(server.origin + '/api/agents/images/settings', { method: 'PUT', headers, body: JSON.stringify({ civitaiKey: 'bad key\n' }) })).status, 400)
  assert.equal((await call('PUT', '/api/agents/images/settings', { civitaiKey: true })).civitaiKey, true, 'sending the view back keeps the key')
  const turn = async (permission = 'bypass') => {
    const t = await call('POST', '/api/agents/threads', { mode: 'quick', model: 'test-model', permission })
    const r = await fetch(`${server.origin}/api/agents/threads/${t.id}/messages`, { method: 'POST', headers, body: JSON.stringify({ text: 'Make a picture of a fox' }) })
    await r.text()
    return (await call('GET', `/api/agents/threads/${t.id}`)).messages as any[]
  }
  const gen = { name: 'generate_image', arguments: { prompt: 'a fox', seed: 1 } }
  const retry = { name: 'generate_image', arguments: { prompt: 'a fox', seed: 2, sampler: 'euler_ancestral', scheduler: 'normal', steps: 28, clip_skip: 2 } }
  const results = (m: any[]) => m.filter((x) => x.role === 'tool' && x.toolName === 'generate_image').map((x) => JSON.parse(x.content))
  // The review gate answers the first call of a turn with learnings, so each plan starts with it.
  const reviewed = (...steps: typeof plan) => [[gen], ...steps]

  // 1. Black, then fine: exactly one retry, the turn ends silently after it, both observations saved.
  outputs = [black, fine]; graphs.length = 0; plan = reviewed([gen], [retry], [retry]); visionCalls = 0
  let m = await turn()
  let r = results(m).filter((x) => x.image)
  assert.equal(graphs.length, 2, 'one automatic retry')
  assert.equal(r[0].quality.very_bad, true); assert.equal(r[0].retry.allowed, true); assert.match(r[0].quality.defects[0], /black/)
  assert.equal(r[1].quality.very_bad, false, 'the retry passed')
  assert.equal(graphs[1].clipSkip.inputs.stop_at_clip_layer, -2, 'clip skip 2 is CLIPSetLastLayer -2')
  assert.equal(m.at(-1).role, 'tool', 'after a good retry the turn ends silently')
  assert.equal(visionCalls, 1, 'vision only for the picture the pixels passed')
  let observations = (await call('GET', '/api/agents/images/observations')).observations as any[]
  assert.deepEqual(observations.map((o) => o.source).sort(), ['automatic', 'automatic'])
  assert.ok(observations.some((o) => /retry fixed/.test(o.note) && /sampler "dpmpp_2m" → "euler_ancestral"/.test(o.note)), JSON.stringify(observations.map((o) => o.note)))

  // 2. Black twice: the second is the retry; a third call is refused; the agent explains.
  outputs = [black, black, black]; graphs.length = 0; plan = reviewed([gen], [retry], [retry]); visionCalls = 0
  m = await turn()
  r = results(m)
  assert.equal(graphs.length, 2, 'never more than one retry')
  assert.equal(r.filter((x) => x.image)[1].retry.allowed, false)
  assert.match(r.at(-1).skipped ?? '', /already used/)
  assert.equal(m.at(-1).role, 'assistant'); assert.match(m.at(-1).content, /broken/)

  // 3. Vision says broken: same retry path.
  outputs = [fine, fine]; graphs.length = 0; plan = reviewed([gen], [retry]); visionVerdict = '{"score": 2, "very_bad": true, "defects": ["melted face"]}'; visionCalls = 0
  m = await turn()
  r = results(m).filter((x) => x.image)
  assert.deepEqual([graphs.length, r[0].quality.defects[0], r[0].quality.checked_by.join('+'), visionCalls], [2, 'melted face', 'pixels+vision', 2])
  visionVerdict = '{"score": 7, "very_bad": false, "defects": []}'

  // 4. A fine picture stays silent: no quality field, no further model reply.
  outputs = [fine]; graphs.length = 0; plan = reviewed([gen], [retry]); modelReplies = 0
  m = await turn()
  assert.equal(graphs.length, 1); assert.equal(results(m).find((x) => x.image).quality, undefined); assert.equal(m.at(-1).role, 'tool'); assert.equal(modelReplies, 2, 'review, generate, then silence')

  // 5. Setting off: no check, no retry, even for black.
  await call('PUT', '/api/agents/images/settings', { qualityCheck: false })
  outputs = [black]; graphs.length = 0; plan = reviewed([gen], [retry]); visionCalls = 0
  m = await turn()
  assert.deepEqual([graphs.length, results(m).find((x) => x.image).quality, visionCalls, m.at(-1).role], [1, undefined, 0, 'tool'])
  await call('PUT', '/api/agents/images/settings', { qualityCheck: true })

  // 6. A v-pred checkpoint gets ModelSamplingDiscrete v_prediction + zsnr, decided by the server.
  outputs = [fine]; graphs.length = 0; plan = reviewed([{ name: 'generate_image', arguments: { prompt: 'a fox', model: 'NoobAI/noob_vpred.safetensors' } }])
  m = await turn()
  assert.deepEqual(graphs[0].vpred, { class_type: 'ModelSamplingDiscrete', inputs: { model: ['1', 0], sampling: 'v_prediction', zsnr: true } })
  assert.deepEqual(graphs[0]['7'].inputs.model, ['vpred', 0])
  assert.equal(results(m).find((x) => x.image).image.settings.v_prediction, true)
  outputs = [fine]; graphs.length = 0; plan = reviewed([gen])
  await turn()
  assert.equal(graphs[0].vpred, undefined, 'an eps model is unchanged')
  // Known v-pred only from cached Civitai facts (this account's key scope): by hash, and by model page.
  const scope = civitaiScope(1, 'civitai-key-123')
  const put = (key: string, body: unknown) => database().prepare('INSERT INTO civitai_cache (key, body, expires_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET body = excluded.body').run(key, JSON.stringify(body), Date.now() + 86_400_000)
  put(`h:${'c'.repeat(64)}:${scope}`, { versionId: 910001 })
  put(`v:910001:${scope}`, { id: 910001, modelId: 910002, name: 'vpred-1.0', baseModel: 'NoobAI', images: [] })
  put(`v:920001:${scope}`, { id: 920001, modelId: 920002, name: '1.0', baseModel: 'NoobAI', description: 'Euler, 28 steps.', images: [] })
  put(`m:920002:${scope}`, 'A v-prediction checkpoint: enable zsnr.')
  for (const model of ['NoobAI/hashed.safetensors', 'NoobAI/described.safetensors']) {
    outputs = [fine]; graphs.length = 0; plan = reviewed([{ name: 'generate_image', arguments: { prompt: 'a fox', model } }])
    await turn()
    assert.equal(graphs[0].vpred?.inputs.sampling, 'v_prediction', model)
  }
  // Vision flagged it, the retry's vision answer is unusable: inconclusive, no "retry fixed" observation.
  const fixedBefore = ((await call('GET', '/api/agents/images/observations')).observations as any[]).filter((o) => /retry fixed/.test(o.note)).length
  outputs = [fine, fine]; graphs.length = 0; plan = reviewed([gen], [retry]); visionQueue = ['{"score": 2, "very_bad": true, "defects": ["melted face"]}', 'I cannot tell.']
  m = await turn()
  r = results(m).filter((x) => x.image)
  assert.deepEqual([graphs.length, r[1].quality.inconclusive, r[1].first_attempt.defects[0]], [2, true, 'melted face'])
  assert.equal(((await call('GET', '/api/agents/images/observations')).observations as any[]).filter((o) => /retry fixed/.test(o.note)).length, fixedBefore, 'an inconclusive retry is not recorded as fixed')

  // model_details over HTTP: family defaults when Civitai is off; no backend secrets in the answer.
  await call('PUT', '/api/agents/images/settings', { civitaiLookup: false })
  const details = await call('GET', `/api/agents/images/model-details?${new URLSearchParams({ name: 'NoobAI/noob_vpred.safetensors', kind: 'checkpoint' })}`)
  assert.deepEqual([details.family.id, details.supported, details.recommended.source, details.recommended.v_prediction, details.recommended.sampler], ['noobai_vpred', true, 'family_default', true, 'euler'])
  assert.ok(details.notes.some((n: string) => /lookups are off/.test(n)))
  assert.ok(!JSON.stringify(details).includes(comfyUrl) && !JSON.stringify(details).includes('comfy-secret') && !JSON.stringify(details).includes('civitai-key'))
  const search = await call('GET', `/api/agents/images/model-details?${new URLSearchParams({ kind: 'checkpoint', query: 'anime' })}`)
  assert.deepEqual(search.matches.map((x: any) => x.name), ['Illustrious/prefect.safetensors'])
  console.log('PASS end to end: black → one retry → silent end with automatic observations; broken twice → stop and explain; vision verdicts; fine stays silent; setting off; v-pred graph; model_details over HTTP')
  console.log('All model intel and quality checks passed')
}
} finally {
  await server.dispose()
  comfy.closeAllConnections(); ollama.closeAllConnections()
  await Promise.all([new Promise<void>((r) => comfy.close(() => r())), new Promise<void>((r) => ollama.close(() => r()))])
}
