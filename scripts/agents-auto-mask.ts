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
  SAM3Segment: { input: { required: { image: ['IMAGE'], prompt: ['STRING'], output_mode: [['Merged', 'Separate']], confidence_threshold: ['FLOAT'] }, optional: { max_segments: ['INT'], segment_pick: ['INT'], mask_blur: ['INT'], mask_offset: ['INT'], device: [['Auto', 'CPU', 'GPU']], invert_output: ['BOOLEAN'], unload_model: ['BOOLEAN'], background: [['Alpha', 'Color']], background_color: ['COLORCODE', { default: '#222222' }] } } },
  SAM2Segment: { input: { required: { image: ['IMAGE'], prompt: ['STRING'], sam2_model: [['sam2.1_hiera_tiny', 'sam2.1_hiera_small', 'sam2.1_hiera_base_plus', 'sam2.1_hiera_large']], dino_model: [['GroundingDINO_SwinT_OGC (694MB)', 'GroundingDINO_SwinB (938MB)']], device: [['Auto', 'CPU', 'GPU']] }, optional: { threshold: ['FLOAT'], mask_blur: ['INT'], mask_offset: ['INT'], invert_output: ['BOOLEAN'], background: [['Alpha', 'Color']], background_color: ['COLORCODE', { default: '#222222' }] } } },
  GrowMask: { input: { required: { mask: ['MASK'], expand: ['INT'], tapered_corners: ['BOOLEAN'] } } },
  MaskComposite: { input: { required: { destination: ['MASK'], source: ['MASK'], x: ['INT'], y: ['INT'], operation: ['COMBO', { options: ['multiply', 'add', 'subtract', 'and', 'or', 'xor'] }] } } },
  MaskToImage: { input: { required: { mask: ['MASK'] } } },
  SaveImage: { input: { required: { images: ['IMAGE'], filename_prefix: ['STRING'] } } },
  ImageCompositeMasked: { input: { required: { destination: ['IMAGE'], source: ['IMAGE'], x: ['INT'], y: ['INT'], resize_source: ['BOOLEAN'] }, optional: { mask: ['MASK'] } } },
  AILab_LamaRemover: { input: { required: { images: ['IMAGE'], masks: ['MASK'], removal_strength: ['INT'], edge_smoothness: ['INT'] } } },
}
// What the fake segmenter "finds" per phrase, by column: a person is the left quarter, a bicycle
// columns 4–5, a woman column 2, a unicorn nothing. `found` forces nothing or nearly everything.
let found: 'left' | 'nothing' | 'most' = 'left'
const region = (prompt: string, x: number) => found === 'nothing' ? false : found === 'most' ? x < 13 : /unicorn/.test(prompt) ? false : /bicycle/.test(prompt) ? x >= 4 && x < 6 : /woman/.test(prompt) ? x === 2 : x < 4
/** The fake output of one SaveImage: a phrase's own selection, or the union of targets minus excludes (no growing). */
function viewOf(graph: any, node: string) {
  const prompts = (key: string) => Object.keys(graph).filter((id) => new RegExp(`^${key}[0-9]$`).test(id)).map((id) => graph[id].inputs.prompt as string)
  const part = /^([tx][0-9])_save$/.exec(node)
  const selected = (x: number) => part ? region(graph[part[1]].inputs.prompt, x) : prompts('t').some((p) => region(p, x)) && !prompts('x').some((p) => region(p, x))
  return png(W, H, (x) => selected(x) ? 200 : 40)
}
const send = (res: ServerResponse, value: unknown) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(value))
const jpegUploads: Buffer[] = []
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
    assert.match(filename!, /^agents-(source|mask)-[0-9a-f-]{36}\.(png|jpg)$/)
    if (filename!.endsWith('.jpg')) jpegUploads.push(Buffer.concat(chunks))
    uploads.push(filename!)
    return send(res, { name: filename, type: 'input', subfolder: '' })
  }
  if (path === '/prompt') { graphs.push(JSON.parse(raw).prompt); return send(res, { prompt_id: `job-${graphs.length}` }) }
  if (path.startsWith('/history/')) {
    const id = path.split('/').at(-1)!, graph = graphs.at(-1)
    // A segmenter that is installed but broken, like GroundingDINO on a newer transformers.
    if (failing && graph.t1?.class_type === failing) return send(res, { [id]: { status: { status_str: 'error', completed: false, messages: [['execution_error', { node_type: failing, exception_message: "'BertModel' object has no attribute\n 'get_extended_attention_mask'" }]] } } })
    const saves = Object.keys(graph).filter((node) => graph[node].class_type === 'SaveImage')
    return send(res, { [id]: { status: { completed: true }, outputs: Object.fromEntries(saves.map((node) => [node, { images: [{ filename: node, subfolder: '', type: 'output' }] }])) } })
  }
  if (path === '/view') {
    const graph = graphs.at(-1)
    if (graph.save) return res.end(viewOf(graph, new URL(req.url!, 'http://fixture').searchParams.get('filename')!))
    // Removal: LaMa repaints everything grey 120. With the composite through the mask (node 31, the
    // fixture mask is the left quarter) the source (90) comes back outside it, off by one level in
    // places, as ComfyUI's float round trip may do; without it, LaMa's 120 leaks everywhere.
    return res.end(graph['31'] ? png(W, H, (x, y) => x < 4 ? 120 : 90 - ((x + y) % 3 === 0 ? 1 : 0)) : png(W, H, () => 120))
  }
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
const server = new Server({ OLLAMA_URL: ollamaUrl, OLLAMA_API_KEY: 'synthetic', GITHUB_CLIENT_ID: 'fixture', GITHUB_CLIENT_SECRET: 'fixture', ADMIN_GITHUB_IDS: '1' })
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
  assert.equal(made.mask.source_url, `${made.mask.mask_url}/source`); assert.ok(Buffer.from(await (await api('GET', made.mask.source_url)).arrayBuffer()).equals(png(W, H)))
  assert.equal(made.warning, undefined)
  assert.match(made.next, /generate_image with operation remove/)
  const g = graphs.at(-1)
  assert.deepEqual(Object.keys(g).sort(), ['1', 'grow', 'image', 'save', 't1', 't1_image', 't1_save'])
  assert.equal(g['1'].class_type, 'LoadImage'); assert.match(g['1'].inputs.image, /^agents-source-/)
  assert.deepEqual(made.phrases, [{ phrase: 'cyclist', role: 'target', coverage_percent: 25 }])
  assert.deepEqual(g.t1, { class_type: 'SAM3Segment', inputs: { image: ['1', 0], prompt: 'cyclist', mask_blur: 0, mask_offset: 0, invert_output: false, background: 'Alpha', background_color: '#222222', max_segments: 0, segment_pick: 0, unload_model: true, device: 'Auto', output_mode: 'Merged', confidence_threshold: 0.4 } })
  assert.deepEqual(g.grow.inputs, { mask: ['t1', 1], expand: 12, tapered_corners: true })
  assert.deepEqual(g.image.inputs, { mask: ['grow', 0] }); assert.equal(g.save.class_type, 'SaveImage'); assert.equal(g.t1_save.class_type, 'SaveImage')
  assert.equal(uploads.length, 1)
  // The stored mask is the clean binary RGB format, with ComfyUI's metadata dropped, and owner-only.
  const stored = Buffer.from(await (await api('GET', made.mask.mask_url)).arrayBuffer())
  assert.equal(stored[25], 2); assert.ok(!stored.includes(Buffer.from('tEXt')))
  assert.equal((await api('GET', made.mask.mask_url, undefined, 1)).status, 404)
  // Private pictures never stay in a shared browser's cache.
  for (const url of [made.mask.mask_url, made.mask.source_url]) assert.equal((await api('GET', url)).headers.get('cache-control'), 'private, no-store')
  // A broken SAM3 hands over to SAM2 within the same call, with one upload; the reason reaches the agent if both fail.
  // An iPhone ProRAW-like DNG attached to a message is masked from its embedded JPEG preview, not refused.
  {
    const { dng, fixtureJpeg, resized } = await import('./rawFixtures.ts')
    const raw = dng(true, { preview: resized(fixtureJpeg(), W, H), thumb: resized(fixtureJpeg(), 8, 6) })
    const message = Number(database().prepare("INSERT INTO agent_messages (thread_id, role, content, attachments, created_at) VALUES (?, 'user', 'Remove these people', ?, ?)").run(t.id, JSON.stringify([{ kind: 'image', name: 'IMG_2426.DNG', mime: 'image/x-adobe-dng', data: raw.toString('base64'), size: raw.length }]), Date.now()).lastInsertRowid)
    const fromRaw = await call(t.id, 'make_image_mask', { source_image_id: `attachment:${message}:0`, target: 'person' })
    assert.ok(fromRaw.mask, JSON.stringify(fromRaw))
    assert.match(uploads.at(-1)!, /\.jpg$/)
    const body = jpegUploads.at(-1)!
    assert.ok(body.includes(Buffer.from([0xff, 0xd8, 0xff])) && !body.includes(Buffer.from('II*\0', 'latin1')))
    console.log('PASS make_image_mask on a DNG attachment uses its embedded JPEG preview')
  }
  const uploadsBefore = uploads.length, graphsBefore = graphs.length
  failing = 'SAM3Segment'
  const fallback = await call(t.id, 'make_image_mask', { source_image_id: source, target: 'cyclist', threshold: 0.25 })
  assert.ok(fallback.mask, JSON.stringify(fallback))
  assert.equal(graphs.length - graphsBefore, 2); assert.equal(uploads.length - uploadsBefore, 1)
  const g2 = graphs.at(-1).t1
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
  assert.equal(ge.x1.inputs.prompt, 'woman sitting on the wall'); assert.equal(ge.grow.inputs.expand, 8); assert.deepEqual(ge.xgrow.inputs, { mask: ['x1', 1], expand: 12, tapered_corners: true })
  assert.deepEqual(ge.subtract.inputs, { destination: ['grow', 0], source: ['xgrow', 0], x: 0, y: 0, operation: 'subtract' })
  assert.deepEqual(ge.image.inputs, { mask: ['subtract', 0] })
  assert.equal(kept.mask.coverage_percent, 18.8)
  assert.deepEqual(kept.phrases.map((p: any) => [p.role, p.coverage_percent]), [['target', 25], ['exclude', 6.3]])

  // Several phrases: each segmented on its own, unioned with add before growing; a phrase that
  // finds nothing does not sink the mask, and the result says what each one caught.
  const both = await call(t.id, 'make_image_mask', { source_image_id: source, target: 'cyclist, bicycle', exclude: 'woman in a light blue shirt, red unicorn' })
  assert.ok(both.mask, JSON.stringify(both))
  const gu = graphs.at(-1)
  assert.equal(gu.t1.inputs.prompt, 'cyclist'); assert.equal(gu.t2.inputs.prompt, 'bicycle'); assert.equal(gu.t2.class_type, 'SAM3Segment')
  assert.deepEqual(gu.tu2.inputs, { destination: ['t1', 1], source: ['t2', 1], x: 0, y: 0, operation: 'add' })
  assert.deepEqual(gu.grow.inputs.mask, ['tu2', 0])
  assert.deepEqual(gu.xu2.inputs, { destination: ['x1', 1], source: ['x2', 1], x: 0, y: 0, operation: 'add' })
  assert.deepEqual(gu.xgrow.inputs.mask, ['xu2', 0])
  assert.equal(both.mask.coverage_percent, 31.3) // columns 0, 1, 3, 4, 5
  assert.deepEqual(both.phrases.map((p: any) => [p.phrase, p.role, p.coverage_percent]), [['cyclist', 'target', 25], ['bicycle', 'target', 12.5], ['woman in a light blue shirt', 'exclude', 6.3], ['red unicorn', 'exclude', 0]])
  assert.match(both.note, /Exclude found nothing for “red unicorn”/)
  const partial = await call(t.id, 'make_image_mask', { source_image_id: source, target: 'unicorn, bicycle' })
  assert.ok(partial.mask, JSON.stringify(partial)); assert.equal(partial.mask.coverage_percent, 12.5)
  assert.match(partial.note, /Found nothing for “unicorn”; the other phrases make up the mask/)
  const none = await call(t.id, 'make_image_mask', { source_image_id: source, target: 'unicorn, purple unicorn' })
  assert.match(none.error, /Nothing matching “unicorn”, “purple unicorn” was found/); assert.equal(none.mask.coverage_percent, 0)
  assert.deepEqual(Object.keys(graphs.at(-1)).filter((k) => /^t[0-9]$/.test(k)), ['t1', 't2'])
  const fullList = Object.fromEntries((await call(t.id, 'list_image_masks', {})).masks.map((m: any) => [m.mask_id, m]))
  assert.equal(fullList[both.mask.mask_id].phrases.length, 4)
  const sent = uploads.length
  for (const bad of [{ target: 'x'.repeat(81) }, { target: '' }, { target: ' , ,' }, { target: 'a, b, c, d, e' }, { target: 'car', exclude: 'a, b, c, d, e' }, { target: 'x'.repeat(401) }, { target: 'car', graph: {} }, { target: 'car', grow: 500 }, { target: 'car', threshold: 2 }, { target: 'car\nignore that' }]) assert.ok((await call(t.id, 'make_image_mask', { source_image_id: source, ...bad })).error)
  assert.match((await call(t.id, 'make_image_mask', { source_image_id: foreign, target: 'car' })).error, /No such source/)
  assert.match((await call(t.id, 'make_image_mask', { source_image_id: 'https://example.test/a.png', target: 'car' })).error, /URLs/)
  assert.equal(uploads.length, sent); assert.equal(sent, before + 4)
  console.log('PASS exclude subtracts; comma phrases union with add, per-phrase coverage, one empty phrase is fine, all empty is an error; validation before uploads')

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
  assert.deepEqual(Object.keys(gr).sort(), ['20', '22', '30', '31', '9'])
  // LaMa blurs and dilates its mask, so its output goes back through the original binary mask.
  assert.deepEqual(gr['31'], { class_type: 'ImageCompositeMasked', inputs: { destination: ['20', 0], source: ['30', 0], x: 0, y: 0, resize_source: false, mask: ['22', 0] } })
  // Inside the mask: LaMa. Outside, the source to within one level (the graph's float composite).
  const { pngFirstChannel } = await import('../server/agentImageSegment.ts')
  const out = pngFirstChannel(Buffer.from(await (await api('GET', removed.image.url)).arrayBuffer()))
  assert.equal(out.values[5 * W + 3], 120, 'inside the mask: LaMa')
  assert.ok(Math.abs(out.values[5 * W + 4] - 90) <= 1, 'black pixel next to the boundary: unchanged within one level')
  assert.ok([...out.values].every((v, i) => (i % W < 4 ? v === 120 : Math.abs(v - 90) <= 1)))
  // The result is ComfyUI's composite as is: no server-side pixel rewriting.
  assert.ok([...out.values].some((v) => v === 89))
  assert.deepEqual(gr['22'].inputs.channel, 'red'); assert.match(gr['22'].inputs.image, /^agents-mask-/)
  assert.deepEqual(gr['30'], { class_type: 'AILab_LamaRemover', inputs: { images: ['20', 0], masks: ['22', 0], removal_strength: 230, edge_smoothness: 8 } })
  assert.deepEqual(gr['9'].inputs.images, ['31', 0])
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

  // Segmenter schemas: built from what the backend advertises. The newer SAM3Segment requires
  // model_name; an unbuildable SAM3 falls to SAM2 without blocking it; neither buildable: nothing uploaded.
  const fresh = await json('POST', '/api/agents/threads', { mode: 'quick', model: 'test-model', tools: ['images'], permission: 'auto' })
  database().prepare('INSERT INTO agent_images(id, thread_id, name, body, created_at) VALUES (?, ?, ?, ?, ?)').run(source, fresh.id, 'street.png', png(W, H), Date.now())
  const oldSam3 = schemas.SAM3Segment
  schemas.SAM3Segment = { input: { required: { ...oldSam3.input.required, model_name: [['sam3', 'sam3.1'], { default: 'sam3.1' }] }, optional: { ...oldSam3.input.optional, new_option: ['INT', { default: 3 }] } } }
  const newer = await call(fresh.id, 'make_image_mask', { source_image_id: source, target: 'cyclist' })
  assert.ok(newer.mask, JSON.stringify(newer))
  assert.equal(graphs.at(-1).t1.class_type, 'SAM3Segment'); assert.equal(graphs.at(-1).t1.inputs.model_name, 'sam3.1'); assert.equal(graphs.at(-1).t1.inputs.new_option, 3)
  // Filling an input we do not understand never picks something that looks like a download.
  schemas.SAM3Segment = { input: { required: { ...oldSam3.input.required, model_name: [['https://huggingface.co/x/sam3.pt', 'sam3 (download)', 'sam3-local'], { default: 'https://huggingface.co/x/sam3.pt' }] }, optional: oldSam3.input.optional } }
  assert.ok((await call(fresh.id, 'make_image_mask', { source_image_id: source, target: 'cyclist' })).mask)
  assert.equal(graphs.at(-1).t1.inputs.model_name, 'sam3-local')
  schemas.SAM3Segment = { input: { required: { ...oldSam3.input.required, model_name: [['⬇ sam3', 'Download sam3.1']] }, optional: oldSam3.input.optional } }
  assert.ok((await call(fresh.id, 'make_image_mask', { source_image_id: source, target: 'cyclist' })).mask)
  assert.equal(graphs.at(-1).t1.class_type, 'SAM2Segment', 'only download choices: SAM3 is skipped')
  schemas.SAM3Segment = { input: { required: { ...oldSam3.input.required, clip: ['CLIP'] }, optional: oldSam3.input.optional } }
  const g0 = graphs.length
  const viaSam2 = await call(fresh.id, 'make_image_mask', { source_image_id: source, target: 'cyclist' })
  assert.ok(viaSam2.mask, JSON.stringify(viaSam2))
  assert.equal(graphs.length - g0, 1); assert.equal(graphs.at(-1).t1.class_type, 'SAM2Segment')
  assert.equal((await json('GET', '/api/agents/images/catalog')).autoMask, true)
  schemas.SAM2Segment.input.required.extra_link = ['LATENT']
  const u2 = uploads.length
  assert.match((await call(fresh.id, 'make_image_mask', { source_image_id: source, target: 'cyclist' })).error, /unavailable.*SAM3Segment needs clip.*SAM2Segment needs extra_link/)
  assert.equal(uploads.length, u2)
  assert.equal((await json('GET', '/api/agents/images/catalog')).autoMask, false)
  delete schemas.SAM2Segment.input.required.extra_link
  schemas.SAM3Segment = oldSam3
  console.log('PASS segmenter inputs from the advertised schema: old SAM3, new SAM3 with model_name, no download choices, SAM3 unbuildable falls to SAM2, neither buildable uploads nothing')

  // Pruning keeps 40 agent masks, deleting only unreferenced ones, oldest first; masks shown by a
  // result card in any thread or branch are kept, also from explicit deletion. The record counts toward quota.
  const { saveAutoMask } = await import('../server/agentImageMasks.ts')
  const { imageSource } = await import('../server/agentImageSources.ts')
  const { usedBytes } = await import('../server/quota.ts')
  const owner = { id: 1, login: 'mask-admin' } as Parameters<typeof saveAutoMask>[0]
  const pruned = await json('POST', '/api/agents/threads', { mode: 'quick', model: 'test-model', tools: ['images'], permission: 'auto' })
  const elsewhere = await json('POST', '/api/agents/threads', { mode: 'quick', model: 'test-model', tools: ['images'], permission: 'auto' })
  const src = imageSource(owner, source)
  const { binaryMaskPng } = await import('../server/agentImageSegment.ts')
  const maskBytes = binaryMaskPng(W, H, Uint8Array.from({ length: W * H }, (_, i) => (i % W < 4 ? 255 : 0)))
  // Non-ASCII text: quota counts bytes, not characters.
  const detail = { target: '自行车', exclude: '骑自行车的人', grow: 12, threshold: null, verdict: 'ok' as const }
  const before0 = usedBytes(1)
  const first = saveAutoMask(owner, pruned.id, src, maskBytes, detail)
  const record = (database().prepare('SELECT details FROM agent_image_masks WHERE id = ?').get(first.id) as { details: string }).details
  assert.ok(Buffer.byteLength(record) > record.length)
  assert.equal(usedBytes(1) - before0, maskBytes.length + Buffer.byteLength(record))
  const second = saveAutoMask(owner, pruned.id, src, maskBytes, detail)
  // The first is shown by a result card in another thread: kept.
  database().prepare("INSERT INTO agent_messages(thread_id, role, content, tool_name, created_at) VALUES (?, 'tool', ?, 'make_image_mask', ?)").run(elsewhere.id, JSON.stringify({ mask: { mask_id: first.id } }), Date.now())
  for (let i = 0; i < 40; i++) saveAutoMask(owner, pruned.id, src, maskBytes, detail)
  const count = () => (database().prepare("SELECT COUNT(*) AS n FROM agent_image_masks WHERE thread_id = ? AND origin = 'auto'").get(pruned.id) as { n: number }).n
  assert.equal(count(), 40)
  assert.equal((await api('GET', `/api/agents/image-masks/${first.id}`)).status, 200)
  assert.equal((await api('GET', `/api/agents/image-masks/${second.id}`)).status, 404)
  assert.equal((await api('DELETE', `/api/agents/image-masks/${first.id}`)).status, 409)
  // When every mask is referenced the cap is exceeded instead.
  for (const { id } of database().prepare('SELECT id FROM agent_image_masks WHERE thread_id = ?').all(pruned.id) as { id: string }[]) database().prepare("INSERT INTO agent_messages(thread_id, role, content, tool_name, created_at) VALUES (?, 'tool', ?, 'list_image_masks', ?)").run(pruned.id, JSON.stringify({ masks: [{ mask_id: id }] }), Date.now())
  saveAutoMask(owner, pruned.id, src, maskBytes, detail)
  assert.equal(count(), 41)
  // Many messages: references are collected once per operation, not searched per mask.
  const busy = await json('POST', '/api/agents/threads', { mode: 'quick', model: 'test-model', tools: ['images'], permission: 'auto' })
  // Inserted directly: saving them one by one would already prune.
  const busyMasks = Array.from({ length: 100 }, (_, i) => { const id = randomUUID(); database().prepare("INSERT INTO agent_image_masks(id, thread_id, source_id, body, width, height, created_at, origin, details) VALUES (?, ?, ?, ?, ?, ?, ?, 'auto', ?)").run(id, busy.id, source, maskBytes, W, H, i, record); return id })
  const insert = database().prepare("INSERT INTO agent_messages(thread_id, role, content, tool_name, tool_calls, created_at) VALUES (?, ?, ?, ?, ?, ?)")
  database().exec('BEGIN')
  for (let i = 0; i < 10_000; i++) {
    const kind = i % 4
    if (kind === 0) insert.run(elsewhere.id, 'tool', JSON.stringify({ mask: { mask_id: busyMasks[(i / 4) % 50 | 0] }, note: 'x'.repeat(200) }), 'make_image_mask', null, Date.now())
    else if (kind === 1) insert.run(elsewhere.id, 'assistant', '', null, JSON.stringify([{ name: 'generate_image', arguments: { operation: 'remove', mask_id: busyMasks[50 + ((i / 4) % 10 | 0)] } }]), Date.now())
    else insert.run(elsewhere.id, kind === 2 ? 'user' : 'tool', `${busyMasks[99]} mentioned in plain text ${'y'.repeat(300)}`, kind === 3 ? 'web_fetch' : null, null, Date.now())
  }
  database().exec('COMMIT')
  const started = performance.now()
  saveAutoMask(owner, busy.id, src, maskBytes, detail)
  const took = performance.now() - started
  const left = new Set((database().prepare('SELECT id FROM agent_image_masks WHERE thread_id = ?').all(busy.id) as { id: string }[]).map((r) => r.id))
  // 101 masks, cap 40: 61 must go; the 60 referenced (50 cards, 10 calls) stay, so only the
  // 40 unreferenced (60–99; text mentions do not count) can be pruned, all of them.
  assert.equal(left.size, 61)
  assert.ok(busyMasks.slice(0, 60).every((id) => left.has(id)))
  assert.ok(busyMasks.slice(60).every((id) => !left.has(id)))
  assert.ok(took < 200, `pruning with 10k messages took ${took.toFixed(0)} ms`)
  console.log(`PASS mask pruning: cap of 40, shown or used masks never pruned or deleted, cap exceeded when all are referenced; details counted in bytes; 10k messages pruned in ${took.toFixed(0)} ms`)

  // An attachment's mask preview keeps working after the thread it was sent in is deleted, via a
  // surviving branch copy, also for cards saved before (the app loads every preview by mask ID).
  const sent2 = await json('POST', '/api/agents/threads', { mode: 'quick', model: 'test-model', tools: ['images'], permission: 'auto' })
  const photo = png(W, H, () => 77)
  const photoMessage = Number(database().prepare("INSERT INTO agent_messages(thread_id, role, content, attachments, created_at) VALUES (?, 'user', 'Remove the cyclist', ?, ?)").run(sent2.id, JSON.stringify([{ kind: 'image', name: 'photo.png', type: 'image/png', size: photo.length, data: photo.toString('base64') }]), Date.now()).lastInsertRowid)
  const attached = await call(sent2.id, 'make_image_mask', { source_image_id: `attachment:${photoMessage}:0`, target: 'cyclist' })
  assert.ok(attached.mask, JSON.stringify(attached))
  assert.equal(attached.mask.source_url, `${attached.mask.mask_url}/source`)
  const history2 = await json('GET', `/api/agents/threads/${sent2.id}`)
  const copy = await json('POST', `/api/agents/threads/${sent2.id}/branch`, { messageId: history2.messages.at(-1).id })
  await json('DELETE', `/api/agents/threads/${sent2.id}`)
  const preview = await api('GET', attached.mask.source_url)
  assert.equal(preview.status, 200); assert.ok(Buffer.from(await preview.arrayBuffer()).equals(photo))
  assert.equal((await api('GET', attached.mask.source_url, undefined, 1)).status, 404)
  const copied = (await json('GET', `/api/agents/threads/${copy.thread.id}`)).messages.find((m: any) => m.toolName === 'make_image_mask')
  const { agentMasks } = await import('../src/data/agentMasks.ts')
  const card = agentMasks(copied.content)[0]
  assert.equal(card.source_url, `/api/agents/image-masks/${attached.mask.mask_id}/source`)
  // An older card that stored the original attachment link still loads by mask ID.
  assert.equal(agentMasks(JSON.stringify({ mask: { ...attached.mask, source_url: `/api/agents/threads/${sent2.id}/messages/${photoMessage}/attachments/0` } }))[0].source_url, attached.mask.source_url)
  console.log('PASS attachment mask previews by mask ID: after the parent thread is deleted, owner-only, older cards included')
} finally {
  await server.dispose(); database().close()
  comfy.closeAllConnections(); ollama.closeAllConnections()
  await Promise.all([new Promise<void>(r => comfy.close(() => r())), new Promise<void>(r => ollama.close(() => r()))])
}
