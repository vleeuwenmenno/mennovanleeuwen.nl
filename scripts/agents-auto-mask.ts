// make_image_mask and LaMa removal, end to end against mocked ComfyUI/Ollama with synthetic PNGs only.
// Run by check:agents-images. No GPU, no real pictures.
import assert from 'node:assert/strict'
import { createServer, type ServerResponse } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { Server } from './empires-harness.ts'
import { asPage } from './as-page.ts'

const W = 16, H = 12
/** An RGB PNG; `fill(x, y)` gives the grey value. A tEXt chunk rides along like ComfyUI's SaveImage metadata. */
function png(width: number, height: number, fill: (x: number, y: number) => number = () => 90) {
  const chunk = (kind: string, body: Buffer) => {
    const payload = Buffer.concat([Buffer.from(kind), body]); let crc = 0xffffffff
    for (const byte of payload) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0) }
    const head = Buffer.alloc(4), tail = Buffer.alloc(4); head.writeUInt32BE(body.length); tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
    return Buffer.concat([head, payload, tail])
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = y % 2 ? 1 : 0 // Sub-filtered rows exercise the decoder too.
    let previous = [0, 0, 0]
    for (let x = 0; x < width; x++) {
      const v = fill(x, y)
      for (let c = 0; c < 3; c++) { raw[y * (width * 3 + 1) + 1 + x * 3 + c] = y % 2 ? (v - previous[c]) & 255 : v; previous[c] = v }
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('tEXt', Buffer.from('prompt\0{"graph":"x"}')), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
const schemas: Record<string, any> = {
  LoadImage: { input: { required: { image: [['source.png']] } } },
  LoadImageMask: { input: { required: { image: [['mask.png']], channel: [['red', 'green', 'blue', 'alpha']] } } },
  SAM3Segment: { input: { required: { image: ['IMAGE'], prompt: ['STRING'], output_mode: [['Merged', 'Separate']], confidence_threshold: ['FLOAT'] }, optional: { max_segments: ['INT'], segment_pick: ['INT'], mask_blur: ['INT'], mask_offset: ['INT'], device: [['Auto', 'CPU', 'GPU']], invert_output: ['BOOLEAN'], unload_model: ['BOOLEAN'], background: [['Alpha', 'Color']], background_color: ['COLORCODE'] } } },
  SAM2Segment: { input: { required: { image: ['IMAGE'], prompt: ['STRING'], sam2_model: [['sam2.1_hiera_tiny', 'sam2.1_hiera_small', 'sam2.1_hiera_base_plus', 'sam2.1_hiera_large']], dino_model: [['GroundingDINO_SwinT_OGC (694MB)', 'GroundingDINO_SwinB (938MB)']], device: [['Auto', 'CPU', 'GPU']] }, optional: { threshold: ['FLOAT'], mask_blur: ['INT'], mask_offset: ['INT'], invert_output: ['BOOLEAN'], background: [['Alpha', 'Color']], background_color: ['COLORCODE'] } } },
  GrowMask: { input: { required: { mask: ['MASK'], expand: ['INT'], tapered_corners: ['BOOLEAN'] } } },
  MaskComposite: { input: { required: { destination: ['MASK'], source: ['MASK'], x: ['INT'], y: ['INT'], operation: ['COMBO', { options: ['multiply', 'add', 'subtract', 'and', 'or', 'xor'] }] } } },
  MaskToImage: { input: { required: { mask: ['MASK'] } } },
  SaveImage: { input: { required: { images: ['IMAGE'], filename_prefix: ['STRING'] } } },
  AILab_LamaRemover: { input: { required: { images: ['IMAGE'], masks: ['MASK'], removal_strength: ['INT'], edge_smoothness: ['INT'] } } },
}
// What the fake SAM2 "finds": the left quarter, nothing, or nearly everything. Grey 200 is selected, 40 is not.
let found: 'left' | 'nothing' | 'most' = 'left'
const maskPng = () => png(W, H, (x) => found === 'nothing' ? 40 : found === 'most' ? (x < 13 ? 200 : 40) : (x < 4 ? 200 : 40))
const send = (res: ServerResponse, value: unknown) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(value))
let uploads: string[] = [], missing: string[] = [], chats = 0, failing = ''
const graphs: any[] = []
let args: Record<string, unknown> = {}, requestedTool = 'make_image_mask'
const comfy = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString(), path = new URL(req.url!, 'http://fixture').pathname
  assert.equal(req.headers.authorization, 'Bearer synthetic-token')
  if (path.startsWith('/object_info/')) { const node = path.slice(13); return send(res, missing.includes(node) || !schemas[node] ? {} : { [node]: schemas[node] }) }
  if (path.startsWith('/api/lm/')) return res.writeHead(404).end()
  if (path === '/upload/image') {
    const filename = /filename="([^"]+)"/.exec(raw)?.[1]
    assert.match(filename!, /^agents-(source|mask)-[0-9a-f-]{36}\.png$/)
    uploads.push(filename!)
    return send(res, { name: filename, type: 'input', subfolder: '' })
  }
  if (path === '/prompt') { graphs.push(JSON.parse(raw).prompt); return send(res, { prompt_id: `job-${graphs.length}` }) }
  if (path.startsWith('/history/')) {
    const id = path.split('/').at(-1)!, graph = graphs.at(-1)
    // A segmenter that is installed but broken, like GroundingDINO on a newer transformers.
    if (failing && graph['2']?.class_type === failing) return send(res, { [id]: { status: { status_str: 'error', completed: false, messages: [['execution_error', { node_type: failing, exception_message: "'BertModel' object has no attribute\n 'get_extended_attention_mask'" }]] } } })
    return send(res, { [id]: { status: { completed: true }, outputs: { [graph['8'] ? '8' : '9']: { images: [{ filename: 'fixture.png', subfolder: '', type: 'output' }] } } } })
  }
  if (path === '/view') return res.end(graphs.at(-1)['8'] ? maskPng() : png(W, H, () => 120))
  if (path === '/queue') return send(res, {})
  return res.writeHead(404).end()
})
const ollama = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk)
  if (req.url?.includes('/tags')) return send(res, { models: [{ name: 'test-model', model: 'test-model' }] })
  if (req.url?.includes('/show')) return send(res, { capabilities: ['completion', 'tools', 'vision'] })
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
  if (!body.stream) return send(res, { message: { content: '{"title":"Mask test"}' } })
  chats++
  const after = body.messages?.slice(body.messages.findLastIndex((m: any) => m.role === 'user') + 1) ?? []
  const message = after.some((m: any) => m.role === 'tool') ? { content: 'Handled.' } : { content: '', tool_calls: [{ function: { name: requestedTool, arguments: args } }] }
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson' }).end(JSON.stringify({ message: { role: 'assistant', ...message }, done: true }) + '\n')
})
const listen = async (s: ReturnType<typeof createServer>) => { await new Promise<void>(r => s.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${(s.address() as { port: number }).port}` }
const comfyUrl = await listen(comfy), ollamaUrl = await listen(ollama)
const server = new Server({ OLLAMA_URL: ollamaUrl, OLLAMA_API_KEY: 'synthetic', GITHUB_CLIENT_ID: 'fixture', GITHUB_CLIENT_SECRET: 'fixture', ADMIN_USERS: 'mask-admin' })
process.env.DATA_DIR = server.data
const { database, encrypt, sha256 } = await import('../server/db.ts')
const sessions = [randomBytes(24).toString('hex'), randomBytes(24).toString('hex')]
for (let i = 1; i <= 2; i++) {
  database().prepare('INSERT INTO users (id, github_id, login, github_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(i, i, i === 1 ? 'mask-admin' : 'other', encrypt('none'), Date.now(), Date.now())
  database().prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(sessions[i - 1]), i, Date.now(), Date.now() + 86400000)
}
const api = async (method: string, path: string, body?: unknown, owner = 0) => fetch(server.origin + path, { method, headers: { Cookie: `mvlos_sid=${sessions[owner]}`, ...await asPage(sessions[owner]), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
const json = async (method: string, path: string, body?: unknown, owner = 0) => { const res = await api(method, path, body, owner); assert.equal(res.status, 200, await res.clone().text()); return res.json() as Promise<any> }
const events = async (path: string, body?: unknown, owner = 0) => { const res = await api('POST', path, body, owner); assert.equal(res.status, 200, await res.clone().text()); return (await res.text()).trim().split('\n').filter(Boolean).map(x => JSON.parse(x)) }
const toolResult = (ev: any[]) => JSON.parse(ev.findLast(e => e.type === 'message' && e.message.role === 'tool').message.content)
/** One agent turn that calls `tool` with `input`; answers the tool's result. */
const call = async (thread: string, tool: string, input: Record<string, unknown>, owner = 0) => { requestedTool = tool; args = input; return toolResult(await events(`/api/agents/threads/${thread}/messages`, { text: 'Remove the cyclists on the left' }, owner)) }
try {
  await server.start()
  const { decide } = await import('../server/agents.ts')
  const { autoMaskGraph, removeGraph } = await import('../server/agentImageSegment.ts')
  await json('PUT', '/api/agents/images/settings', { url: comfyUrl, token: 'synthetic-token', preset: 'sdxl', model: 'SDXL/studio.safetensors' })
  const t = await json('POST', '/api/agents/threads', { mode: 'quick', model: 'test-model', tools: ['images'], permission: 'auto' })
  const other = await json('POST', '/api/agents/threads', { mode: 'quick', model: 'test-model', tools: ['images'], permission: 'auto' }, 1)
  const source = randomUUID(), foreign = randomUUID()
  for (const [id, thread] of [[source, t.id], [foreign, other.id]]) database().prepare('INSERT INTO agent_images(id, thread_id, name, body, created_at) VALUES (?, ?, ?, ?, ?)').run(id, thread, 'street.png', png(W, H), Date.now())

  // Discovery: both capabilities are reported, then the fixed graph and an owned mask.
  const catalog = await json('GET', '/api/agents/images/catalog')
  assert.equal(catalog.autoMask, true, catalog.autoMaskError); assert.equal(catalog.remove, true, catalog.removeError)
  const made = await call(t.id, 'make_image_mask', { source_image_id: source, target: 'cyclist' })
  assert.ok(made.mask, JSON.stringify(made))
  assert.equal(made.mask.coverage_percent, 25)
  assert.deepEqual(made.mask.bbox, { x: 0, y: 0, width: 4, height: 12 })
  assert.equal(made.mask.source_url, `/api/agents/images/${source}`)
  assert.equal(made.warning, undefined)
  assert.match(made.next, /generate_image with operation remove/)
  const g = graphs.at(-1)
  assert.deepEqual(Object.keys(g).sort(), ['1', '2', '3', '7', '8'])
  assert.equal(g['1'].class_type, 'LoadImage'); assert.match(g['1'].inputs.image, /^agents-source-/)
  assert.deepEqual(g['2'], { class_type: 'SAM3Segment', inputs: { image: ['1', 0], prompt: 'cyclist', mask_blur: 0, mask_offset: 0, invert_output: false, background: 'Alpha', background_color: '#222222', max_segments: 0, segment_pick: 0, unload_model: false, device: 'Auto', output_mode: 'Merged', confidence_threshold: 0.4 } })
  assert.deepEqual(g['3'].inputs, { mask: ['2', 1], expand: 12, tapered_corners: true })
  assert.deepEqual(g['7'].inputs, { mask: ['3', 0] }); assert.equal(g['8'].class_type, 'SaveImage')
  assert.equal(uploads.length, 1)
  // The stored mask is the clean binary RGB format, with ComfyUI's metadata dropped, and owner-only.
  const stored = Buffer.from(await (await api('GET', made.mask.mask_url)).arrayBuffer())
  assert.equal(stored[25], 2); assert.ok(!stored.includes(Buffer.from('tEXt')))
  assert.equal((await api('GET', made.mask.mask_url, undefined, 1)).status, 404)
  // A broken SAM3 hands over to SAM2 within the same call, with one upload; the reason reaches the agent if both fail.
  const uploadsBefore = uploads.length, graphsBefore = graphs.length
  failing = 'SAM3Segment'
  const fallback = await call(t.id, 'make_image_mask', { source_image_id: source, target: 'cyclist', threshold: 0.25 })
  assert.ok(fallback.mask, JSON.stringify(fallback))
  assert.equal(graphs.length - graphsBefore, 2); assert.equal(uploads.length - uploadsBefore, 1)
  const g2 = graphs.at(-1)['2']
  assert.equal(g2.class_type, 'SAM2Segment'); assert.equal(g2.inputs.sam2_model, 'sam2.1_hiera_small'); assert.equal(g2.inputs.dino_model, 'GroundingDINO_SwinT_OGC (694MB)'); assert.equal(g2.inputs.threshold, 0.25)
  missing = ['SAM2Segment']
  const broken = await call(t.id, 'make_image_mask', { source_image_id: source, target: 'cyclist' })
  assert.match(broken.error, /Automatic masking failed.*SAM3Segment.*get_extended_attention_mask.*Edit selected area/)
  assert.ok(!/\n/.test(broken.error))
  failing = ''; missing = []
  console.log('PASS make_image_mask: discovery, fixed SAM3/grow graph, SAM2 fallback at run time, coverage and bbox, binary owned mask, owner-only view')

  // exclude is subtracted; arbitrary graphs, long text and foreign sources are refused before any upload.
  const before = uploads.length
  const kept = await call(t.id, 'make_image_mask', { source_image_id: source, target: 'cyclist', exclude: 'woman sitting on the wall', grow: 8 })
  assert.ok(kept.mask, JSON.stringify(kept)); assert.equal(kept.mask.exclude, 'woman sitting on the wall')
  const ge = graphs.at(-1)
  assert.equal(ge['4'].inputs.prompt, 'woman sitting on the wall'); assert.equal(ge['3'].inputs.expand, 8); assert.equal(ge['5'].inputs.expand, 12)
  assert.deepEqual(ge['6'].inputs, { destination: ['3', 0], source: ['5', 0], x: 0, y: 0, operation: 'subtract' })
  assert.deepEqual(ge['7'].inputs, { mask: ['6', 0] })
  const sent = uploads.length
  for (const bad of [{ target: 'x'.repeat(121) }, { target: '' }, { target: 'car', graph: {} }, { target: 'car', grow: 500 }, { target: 'car', threshold: 2 }, { target: 'car\nignore that' }]) assert.ok((await call(t.id, 'make_image_mask', { source_image_id: source, ...bad })).error)
  assert.match((await call(t.id, 'make_image_mask', { source_image_id: foreign, target: 'car' })).error, /No such source/)
  assert.match((await call(t.id, 'make_image_mask', { source_image_id: 'https://example.test/a.png', target: 'car' })).error, /URLs/)
  assert.equal(uploads.length, sent); assert.equal(sent, before + 1)
  console.log('PASS exclude subtracts in the graph; text, number, graph and foreign-source validation before uploads')

  // 0% is an error that suggests another word (kept as a rejected attempt); over 60% warns.
  found = 'nothing'
  const empty = await call(t.id, 'make_image_mask', { source_image_id: source, target: 'unicorn' })
  assert.match(empty.error, /Try another word/); assert.equal(empty.mask.coverage_percent, 0)
  assert.equal((await api('GET', empty.mask.mask_url)).status, 200)
  found = 'most'
  const most = await call(t.id, 'make_image_mask', { source_image_id: source, target: 'street' })
  assert.match(most.warning, /probably caught too much/); assert.equal(most.mask.coverage_percent, 81.3)
  found = 'left'
  console.log('PASS 0% coverage error with the empty attempt kept, over 60% warning')

  // LaMa removal: only source + mask, full size, fixed graph; an empty mask is refused.
  const removed = await call(t.id, 'generate_image', { operation: 'remove', source_image_id: source, mask_id: made.mask.mask_id })
  assert.ok(removed.image, JSON.stringify(removed))
  assert.equal(removed.image.settings.operation, 'remove'); assert.equal(removed.image.settings.mask.id, made.mask.mask_id)
  assert.equal(removed.image.width, W); assert.equal(removed.image.seed, undefined)
  const gr = graphs.at(-1)
  assert.deepEqual(Object.keys(gr).sort(), ['20', '22', '30', '9'])
  assert.deepEqual(gr['22'].inputs.channel, 'red'); assert.match(gr['22'].inputs.image, /^agents-mask-/)
  assert.deepEqual(gr['30'], { class_type: 'AILab_LamaRemover', inputs: { images: ['20', 0], masks: ['22', 0], removal_strength: 230, edge_smoothness: 8 } })
  assert.deepEqual(gr['9'].inputs.images, ['30', 0])
  assert.match((await call(t.id, 'generate_image', { operation: 'remove', source_image_id: source, mask_id: empty.mask.mask_id })).error, /empty/)
  assert.match((await call(t.id, 'generate_image', { operation: 'remove', source_image_id: source, mask_id: made.mask.mask_id, prompt: 'x' })).error, /no prompt/)
  // The editor's direct route can remove too, and Again repeats it.
  const direct = toolResult(await events(`/api/agents/threads/${t.id}/inpaint`, { operation: 'remove', source_image_id: source, mask_id: kept.mask.mask_id }))
  assert.equal(direct.image.settings.operation, 'remove')
  assert.equal(toolResult(await events(`/api/agents/threads/${t.id}/images/${direct.image.id}/again`)).image.settings.mask.id, kept.mask.mask_id)
  console.log('PASS operation remove: LaMa graph with the owned mask, no diffusion settings, empty masks refused, direct route and Again')

  // Every attempt is listed with what it selected and how it ended.
  const listed = await call(t.id, 'list_image_masks', {})
  const byId = Object.fromEntries(listed.masks.map((m: any) => [m.mask_id, m]))
  assert.equal(byId[made.mask.mask_id].status, 'used'); assert.equal(byId[made.mask.mask_id].target, 'cyclist'); assert.equal(byId[made.mask.mask_id].made_by, 'agent')
  assert.equal(byId[empty.mask.mask_id].status, 'rejected')
  assert.equal(byId[most.mask.mask_id].status, 'ready'); assert.match(byId[most.mask.mask_id].warning, /60%/)
  assert.equal(byId[kept.mask.mask_id].status, 'used')
  assert.equal(listed.masks[0].mask_url, `/api/agents/image-masks/${listed.masks[0].mask_id}`)
  // Another account sees none of it.
  assert.equal((await api('GET', `/api/agents/image-masks/${most.mask.mask_id}`, undefined, 1)).status, 404)
  const { listImageMasks } = await import('../server/agentImageMasks.ts')
  const { generateImage, makeImageMask } = await import('../server/agentImages.ts')
  const stranger = { id: 2, login: 'other' } as Parameters<typeof listImageMasks>[0]
  const never = new AbortController().signal
  await assert.rejects(generateImage(stranger, other.id, { operation: 'remove', source_image_id: foreign, mask_id: made.mask.mask_id }, never), /No such image mask/)
  await assert.rejects(generateImage(stranger, other.id, { operation: 'remove', source_image_id: source, mask_id: made.mask.mask_id }, never), /No such source/)
  await assert.rejects(makeImageMask(stranger, other.id, { source_image_id: source, target: 'cyclist' }, never), /No such source/)
  await assert.rejects(makeImageMask(stranger, t.id, { source_image_id: foreign, target: 'cyclist' }, never), /No such thread/)
  assert.throws(() => listImageMasks(stranger, other.id, { thread_id: t.id }), /No such thread/)
  // A newer attempt supersedes an older unused one.
  const again = await call(t.id, 'make_image_mask', { source_image_id: source, target: 'bicycle' })
  const relisted = Object.fromEntries((await call(t.id, 'list_image_masks', {})).masks.map((m: any) => [m.mask_id, m.status]))
  assert.equal(relisted[again.mask.mask_id], 'ready'); assert.equal(relisted[most.mask.mask_id], 'rejected')
  console.log('PASS list_image_masks: every attempt with target, coverage and status used/ready/rejected/superseded; owner-only')

  // Missing nodes: the tool falls back with a clear message and uploads nothing; LaMa likewise.
  const u0 = uploads.length
  missing = ['SAM3Segment']
  assert.equal((await json('GET', '/api/agents/images/catalog')).autoMask, true)
  missing = ['SAM3Segment', 'SAM2Segment']
  assert.equal((await json('GET', '/api/agents/images/catalog')).autoMask, false)
  assert.match((await call(t.id, 'make_image_mask', { source_image_id: source, target: 'cyclist' })).error, /Automatic masks are unavailable.*paint/)
  missing = ['AILab_LamaRemover']
  assert.equal((await json('GET', '/api/agents/images/catalog')).remove, false)
  assert.match((await call(t.id, 'generate_image', { operation: 'remove', source_image_id: source, mask_id: made.mask.mask_id })).error, /AILab_LamaRemover/)
  missing = []
  assert.equal(uploads.length, u0)
  assert.throws(() => autoMaskGraph({ target: 'a', exclude: '', grow: 1, threshold: null, handOff: false }, 'x.png', { ...schemas, MaskComposite: { input: { required: { ...schemas.MaskComposite.input.required, operation: [['add']] } } } }), /subtract/)
  assert.throws(() => removeGraph('a.png', 'b.png', { ...schemas, AILab_LamaRemover: { input: { required: { ...schemas.AILab_LamaRemover.input.required, new_required: ['INT'] } } } }), /new_required/)
  console.log('PASS missing SAM3/SAM2/LaMa nodes: catalog flags, fallback message, nothing uploaded; schema drift refused')

  // Plan mode refuses it like other image writes; every other mode runs it without a card.
  const callOf = { name: 'make_image_mask', arguments: { source_image_id: source, target: 'cyclist' } }
  assert.equal(decide(t.id, 'plan', callOf, 1), 'refuse')
  for (const mode of ['default', 'auto', 'acceptEdits', 'bypass'] as const) assert.equal(decide(t.id, mode, callOf, 1), 'run')
  await json('PUT', '/api/agents/images/settings', { askBeforeGenerate: true })
  assert.equal(decide(t.id, 'default', callOf, 1), 'run')
  assert.equal(decide(t.id, 'default', { name: 'generate_image', arguments: { operation: 'remove' } }, 1), 'ask')
  await json('PUT', '/api/agents/images/settings', { askBeforeGenerate: false })
  const planned = await json('POST', '/api/agents/threads', { mode: 'quick', model: 'test-model', tools: ['images'], permission: 'plan' })
  const u1 = uploads.length
  assert.match((await call(planned.id, 'make_image_mask', { source_image_id: source, target: 'cyclist' })).error, /Plan mode/)
  assert.equal(uploads.length, u1)
  // Hand-off: the result tells the app to offer the editor and the agent to stop.
  const handed = await call(t.id, 'make_image_mask', { source_image_id: source, target: 'cyclist', hand_off: true })
  assert.equal(handed.mask.hand_off, true); assert.match(handed.next, /Open mask editor/)
  console.log('PASS Plan mode refuses make_image_mask, other modes run it without approval; hand_off result')

  // A branch that shows the masks keeps them when the original thread goes.
  const history = await json('GET', `/api/agents/threads/${t.id}`)
  const branch = await json('POST', `/api/agents/threads/${t.id}/branch`, { messageId: history.messages.at(-1).id })
  await json('DELETE', `/api/agents/threads/${t.id}`)
  assert.equal((await api('GET', handed.mask.mask_url)).status, 200)
  await json('DELETE', `/api/agents/threads/${branch.thread.id}`)
  assert.equal((await api('GET', handed.mask.mask_url)).status, 404)
  assert.equal(chats > 0, true)
  console.log('PASS mask history survives in a branch and goes with the last thread')
} finally {
  await server.dispose(); database().close()
  comfy.closeAllConnections(); ollama.closeAllConnections()
  await Promise.all([new Promise<void>(r => comfy.close(() => r())), new Promise<void>(r => ollama.close(() => r()))])
}
