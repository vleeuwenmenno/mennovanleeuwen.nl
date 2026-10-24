// End-to-end inpaint lifecycle with synthetic PNGs and mocked ComfyUI/Ollama only.
import assert from 'node:assert/strict'
import { createServer, type ServerResponse } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { Server } from './empires-harness.ts'
import { asPage } from './as-page.ts'
import type { InpaintNodeInfo } from '../server/agentImageInpaint.ts'
const schemas: InpaintNodeInfo = {
  CheckpointLoaderSimple: { input: { required: { ckpt_name: [['SDXL/studio.safetensors']] } } },
  CLIPTextEncode: { input: { required: { clip: ['CLIP'], text: ['STRING'] } } },
  EmptyLatentImage: { input: { required: { width: ['INT'], height: ['INT'], batch_size: ['INT'] } } },
  LoadImage: { input: { required: { image: [['source.png']] } } },
  LoadImageMask: { input: { required: { image: [['mask.png']], channel: [['red','green','blue','alpha']] } } },
  MaskToImage: { input: { required: { mask: ['MASK'] } } },
  ImageToMask: { input: { required: { image: ['IMAGE'], channel: [['red','green','blue','alpha']] } } },
  SetLatentNoiseMask: { input: { required: { samples: ['LATENT'], mask: ['MASK'] } } },
  ImageCompositeMasked: { input: { required: { source: ['IMAGE'], destination: ['IMAGE'], mask: ['MASK'], x: ['INT'], y: ['INT'], resize_source: ['BOOLEAN'] } } },
  VAEEncode: { input: { required: { pixels: ['IMAGE'], vae: ['VAE'] } } },
  VAEDecode: { input: { required: { samples: ['LATENT'], vae: ['VAE'] } } },
  ImageScale: { input: { required: { image: ['IMAGE'], upscale_method: [['lanczos']], crop: [['disabled','center']], width: ['INT'], height: ['INT'] } } },
  SaveImage: { input: { required: { images: ['IMAGE'], filename_prefix: ['STRING'] } } },
  KSampler: { input: { required: { model: ['MODEL'], positive: ['CONDITIONING'], negative: ['CONDITIONING'], latent_image: ['LATENT'], seed: ['INT'], steps: ['INT'], cfg: ['FLOAT'], sampler_name: [['dpmpp_2m','euler']], scheduler: [['karras','normal']], denoise: ['FLOAT'] } } },
}
function png(width: number, height: number, mask = false) {
  const chunk = (kind: string, body: Buffer) => {
    const payload = Buffer.concat([Buffer.from(kind), body]); let crc = 0xffffffff
    for (const byte of payload) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0) }
    const head = Buffer.alloc(4), tail = Buffer.alloc(4); head.writeUInt32BE(body.length); tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
    return Buffer.concat([head, payload, tail])
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2
  const raw = Buffer.alloc((width * 3 + 1) * height, 0)
  if (mask) for (let y = 0; y < height; y++) raw.fill(255, y * (width * 3 + 1) + 1 + Math.floor(width / 2) * 3, (y + 1) * (width * 3 + 1))
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
const send = (res: ServerResponse, value: unknown) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(value))
let uploads = 0, submissions = 0, chats = 0, mode = 'ok', missing = '', outputWidth = 512, outputHeight = 384
const graphs: any[] = [], deleted: string[] = []
let args: Record<string, unknown> = {}, requestedTool = 'generate_image'
const comfy = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString(), path = new URL(req.url!, 'http://fixture').pathname
  assert.equal(req.headers.authorization, 'Bearer synthetic-token')
  if (path.startsWith('/object_info/')) { const node = path.slice(13); return send(res, node === missing ? {} : { [node]: schemas[node] }) }
  if (path.startsWith('/api/lm/')) return res.writeHead(404).end()
  if (path === '/upload/image') {
    uploads++
    const filename = /filename="([^"]+)"/.exec(raw)?.[1]
    assert.match(filename!, /^agents-(source|mask)-[0-9a-f-]{36}\.png$/)
    assert.ok(raw.includes('name="overwrite"\r\n\r\nfalse'))
    return send(res, { name: mode === 'upload-path' ? '../other.png' : filename, type: 'input', subfolder: '' })
  }
  if (path === '/prompt') { const body = JSON.parse(raw); graphs.push(body.prompt); submissions++; return send(res, { prompt_id: `up-${submissions}` }) }
  if (path.startsWith('/history/')) {
    const id = path.split('/').at(-1)!
    if (mode === 'wait') return send(res, {})
    return send(res, { [id]: { status: { completed: true }, outputs: { '9': { images: [{ filename: 'fixture.png', subfolder: '', type: 'output' }] } } } })
  }
  if (path === '/view') {
    if (mode === 'oversize') return res.writeHead(200, { 'Content-Length': 21 * 1024 * 1024 }).end()
    return res.end(mode === 'invalid' ? '<html>no</html>' : png(mode === 'dimensions' ? 1 : outputWidth, outputHeight))
  }
  if (path === '/queue') { if (req.method === 'POST') deleted.push(...JSON.parse(raw).delete); return send(res, {}) }
  if (path === '/interrupt') assert.fail('Never interrupt another ComfyUI job')
  return res.writeHead(404).end()
})
const ollama = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk)
  if (req.url?.includes('/tags')) return send(res, { models: [{ name: 'test-model', model: 'test-model' }] })
  if (req.url?.includes('/show')) return send(res, { capabilities: ['completion', 'tools', 'vision'] })
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
  if (!body.stream) return send(res, { message: { content: '{"title":"Upscale test"}' } })
  chats++
  const after = body.messages?.slice(body.messages.findLastIndex((m: any) => m.role === 'user') + 1) ?? []
  const complete = after.some((m: any) => m.role === 'tool' && !m.content.includes('"status":"review_once"'))
  const message = complete ? { content: 'Handled.' } : { content: '', tool_calls: [{ function: { name: requestedTool, arguments: args } }] }
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson' }).end(JSON.stringify({ message: { role: 'assistant', ...message }, done: true }) + '\n')
})
const listen = async (s: ReturnType<typeof createServer>) => { await new Promise<void>(r => s.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${(s.address() as { port: number }).port}` }
const comfyUrl = await listen(comfy), ollamaUrl = await listen(ollama)
const server = new Server({ OLLAMA_URL: ollamaUrl, OLLAMA_API_KEY: 'synthetic', GITHUB_CLIENT_ID: 'fixture', GITHUB_CLIENT_SECRET: 'fixture', ADMIN_USERS: 'upscale-admin', USER_STORAGE_MB: '2' })
process.env.DATA_DIR = server.data
const { database, encrypt, sha256 } = await import('../server/db.ts')
const sessions = [randomBytes(24).toString('hex'), randomBytes(24).toString('hex')]
for (let i = 1; i <= 2; i++) {
  database().prepare('INSERT INTO users (id, github_id, login, github_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(i, i, i === 1 ? 'upscale-admin' : 'other', encrypt('none'), Date.now(), Date.now())
  database().prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(sessions[i - 1]), i, Date.now(), Date.now() + 86400000)
}
const api = async (method: string, path: string, body?: unknown, owner = 0) => fetch(server.origin + path, { method, headers: { Cookie: `mvlos_sid=${sessions[owner]}`, ...await asPage(sessions[owner]), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
const json = async (method: string, path: string, body?: unknown, owner = 0) => { const res = await api(method, path, body, owner); assert.equal(res.status, 200, await res.clone().text()); return res.json() as Promise<any> }
const events = async (path: string, body?: unknown) => { const res = await api('POST', path, body); assert.equal(res.status, 200, await res.clone().text()); return (await res.text()).trim().split('\n').filter(Boolean).map(x => JSON.parse(x)) }
async function approvedTurn(id: string, allow: boolean, changeBackend = false) {
  const res = await api('POST', `/api/agents/threads/${id}/messages`, { text: 'Upscale the fixture' })
  assert.equal(res.status, 200)
  const reader = res.body!.getReader(), out: any[] = []; let buffer = ''
  for (;;) {
    const { value, done } = await reader.read(); if (done) break
    buffer += new TextDecoder().decode(value)
    let at: number
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); if (!line) continue
      const event = JSON.parse(line); out.push(event)
      if (event.type === 'approval') {
        assert.match(event.summary.title, /Inpaint/)
        assert.ok(event.summary.rows.some((r: string[]) => r[0] === 'Mask' && r[1].includes(String(args.mask_id))))
        assert.ok(event.summary.rows.some((r: string[]) => r[0] === 'Resize' && /final compositing/.test(r[1])))
        if (changeBackend) await json('PUT', '/api/agents/images/settings', { token: 'changed-token' })
        await json('POST', `/api/agents/threads/${id}/approve`, { callId: event.callId, allow })
      }
    }
  }
  return out
}
const toolResult = (ev: any[]) => JSON.parse(ev.findLast(e => e.type === 'message' && e.message.role === 'tool').message.content)
try {
  await server.start()
  await json('PUT', '/api/agents/images/settings', { url: comfyUrl, token: 'synthetic-token', preset: 'sdxl', model: 'SDXL/studio.safetensors' })
  const t = await json('POST', '/api/agents/threads', { mode: 'quick', model: 'test-model', tools: ['images'], permission: 'auto' })
  const other = await json('POST', '/api/agents/threads', { mode: 'quick', model: 'test-model', tools: ['images'] }, 1)
  const source = randomUUID(), foreign = randomUUID(), alternate = randomUUID()
  for (const [id, thread] of [[source, t.id], [foreign, other.id], [alternate, t.id]]) database().prepare('INSERT INTO agent_images(id, thread_id, name, body, created_at) VALUES (?, ?, ?, ?, ?)').run(id, thread, 'source.png', png(16,12), Date.now())
  const data = png(16,12,true).toString('base64')
  const upload = `/api/agents/threads/${t.id}/image-masks`
  assert.equal((await api('POST', upload, { source_image_id: source, data }, 1)).status, 404)
  assert.equal((await api('POST', upload, { source_image_id: foreign, data })).status, 404)
  assert.equal((await api('POST', upload, { source_image_id: source, data: png(16,12).toString('base64') })).status, 400)
  assert.equal((await api('POST', upload, { source_image_id: source, data: png(12,16,true).toString('base64') })).status, 400)
  const { usedBytes } = await import('../server/quota.ts')
  const beforeMaskBytes = usedBytes(1)
  const mask = await json('POST', upload, { source_image_id: source, data })
  assert.equal(usedBytes(1) - beforeMaskBytes, Buffer.from(data,'base64').length)
  assert.equal((await api('GET', mask.url)).status, 200)
  assert.equal((await api('GET', mask.url, undefined, 1)).status, 404)
  const foreignMask = await json('POST', `/api/agents/threads/${other.id}/image-masks`, { source_image_id: foreign, data }, 1)
  const catalog = await json('GET', '/api/agents/images/catalog')
  assert.equal(catalog.inpaint, true); assert.equal(catalog.inpaintSchemas, undefined)
  args = { operation: 'inpaint', source_image_id: source, mask_id: mask.id, prompt: 'replace the white area with a tree', width: outputWidth, height: outputHeight }
  const direct = `/api/agents/threads/${t.id}/inpaint`
  const result = toolResult(await events(direct, args))
  assert.ok(result.image, JSON.stringify(result))
  assert.equal(uploads, 2); assert.equal(submissions, 1); assert.equal(chats, 0)
  assert.equal(result.image.settings.operation, 'inpaint')
  assert.equal(result.image.settings.mask.id, mask.id)
  assert.equal(result.image.settings.source.id, source)
  assert.equal(result.image.settings.denoise, 0.65)
  const graph = graphs.at(-1)
  assert.equal(graph['22'].inputs.channel, 'red')
  assert.deepEqual(graph['7'].inputs.latent_image, ['inpaint_latent',0])
  assert.deepEqual(graph.inpaint_composite.inputs.destination, ['21',0])
  assert.deepEqual(graph['9'].inputs.images, ['inpaint_composite',0])
  assert.deepEqual(graph.inpaint_resize.inputs, { ...graph['21'].inputs, image:['inpaint_pixels',0] })
  const meta = await json('GET', result.image.url + '/metadata')
  assert.ok(JSON.stringify(meta).includes(mask.id))
  const repeated = toolResult(await events(`/api/agents/threads/${t.id}/images/${result.image.id}/again`))
  assert.ok(repeated.image, JSON.stringify(repeated))
  assert.equal(repeated.image.settings.mask.id, mask.id)
  assert.notEqual(repeated.image.seed, result.image.seed)
  assert.equal(toolResult(await events(`/api/agents/threads/${t.id}/retry`, {})).image.settings.operation, 'inpaint')
  console.log('PASS owned mask storage, binary/empty/dimension validation, final-composite graph, metadata, Again and Retry')
  const u0 = uploads, s0 = submissions
  for (const bad of [{ mask_id: foreignMask.id }, { source_image_id: foreign }, { source_image_id: alternate }, { mask_id: undefined }, { mask_id: 'https://example.test/mask.png' }, { graph: {} }, { hires: { scale: 1.5 } }, { denoise: 0 }, { width: 2048 }]) assert.ok(toolResult(await events(direct, { ...args, ...bad })).error)
  missing = 'ImageCompositeMasked'
  assert.equal((await json('GET','/api/agents/images/catalog')).inpaint, false)
  assert.ok(toolResult(await events(direct, args)).error)
  missing = ''
  schemas.SetLatentNoiseMask.input!.required!.new_required = ['STRING']
  assert.ok(toolResult(await events(direct, args)).error)
  delete schemas.SetLatentNoiseMask.input!.required!.new_required
  assert.equal(uploads,u0); assert.equal(submissions,s0)
  assert.equal((await api('POST',direct,args,1)).status,404)
  console.log('PASS foreign masks/sources, source binding, required nodes and preflight BEFORE uploads')
  await json('PUT','/api/agents/images/settings',{askBeforeGenerate:true})
  const beforeDecline = uploads
  await approvedTurn(t.id,false)
  assert.equal(uploads,beforeDecline)
  assert.ok(toolResult(await approvedTurn(t.id,true)).image)
  assert.ok(toolResult(await approvedTurn(t.id,true,true)).error)
  await json('PUT','/api/agents/images/settings',{token:'synthetic-token',askBeforeGenerate:false})
  const beforeCancel = submissions
  mode='wait'
  const cancelled = events(direct,args)
  const until=Date.now()+5000
  while(submissions===beforeCancel) { if(Date.now()>until) throw new Error('Mock submission timeout'); await new Promise(r=>setTimeout(r,10)) }
  await json('POST',`/api/agents/threads/${t.id}/stop`,{})
  await cancelled
  assert.ok(deleted.includes(`up-${submissions}`))
  mode='ok'
  assert.ok(toolResult(await events(direct,args)).image)
  requestedTool='list_image_masks'; args={}
  assert.equal(toolResult(await events(`/api/agents/threads/${t.id}/messages`,{text:'List saved masks'})).masks[0].mask_id,mask.id)
  console.log('PASS tool discovery, mask-aware approval, decline, frozen credentials, scoped cancellation and recovery')
  // Unused uploads from interrupted clients are bounded; referenced masks are never evicted.
  const drafts: any[] = []
  for (let i=0;i<12;i++) drafts.push(await json('POST',upload,{source_image_id:source,data}))
  const storedMasks = database().prepare('SELECT id FROM agent_image_masks WHERE thread_id=?').all(t.id)
  assert.equal(storedMasks.length,9) // 8 drafts plus the used mask
  assert.equal((await api('GET',drafts[0].url)).status,404)
  assert.equal((await api('GET',mask.url)).status,200)
  assert.equal((await api('DELETE',mask.url)).status,409)
  assert.equal((await api('DELETE',drafts.at(-1).url,undefined,1)).status,404)
  await json('DELETE',drafts.at(-1).url)
  assert.equal((await api('GET',drafts.at(-1).url)).status,404)
  database().prepare('INSERT INTO state(user_id,key,value,updated_at) VALUES(?,?,?,?)').run(1,'quota-fixture','x'.repeat(2*1024*1024),Date.now())
  assert.equal((await api('POST',upload,{source_image_id:source,data})).status,413)
  database().prepare('DELETE FROM state WHERE user_id=1 AND key=?').run('quota-fixture')
  assert.equal((await api('POST',upload,{source_image_id:source,data:Buffer.alloc(8*1024*1024+1).toString('base64')})).status,413)
  // Rewind removes messages, but the persisted output still references its mask for Again.
  const beforeRewind = await json('GET',`/api/agents/threads/${t.id}`)
  const lastUser = beforeRewind.messages.findLast((m:any)=>m.role==='user')
  await json('POST',`/api/agents/threads/${t.id}/rewind`,{messageId:lastUser.id})
  assert.equal((await api('GET',mask.url)).status,200)
  assert.equal((await api('DELETE',mask.url)).status,409)
  // Synthetic source has no original generation turn; add its reference like a real source turn.
  database().prepare('INSERT INTO agent_messages(thread_id,role,content,tool_name,created_at) VALUES(?,?,?,?,?)').run(t.id,'tool',JSON.stringify({image:{id:source}}),'generate_image',Date.now())
  const thread = await json('GET',`/api/agents/threads/${t.id}`)
  const branch = await json('POST',`/api/agents/threads/${t.id}/branch`,{messageId:thread.messages.at(-1).id})
  const shared = await json('POST',`/api/agents/threads/${t.id}/share`,{kind:'thread'})
  const publicPage = await (await fetch(shared.url)).text()
  assert.ok(!publicPage.includes(mask.id) && !publicPage.includes('image-masks/') && !publicPage.includes(data))
  const unauthenticated = await fetch(server.origin+mask.url)
  assert.ok(unauthenticated.status===401 || unauthenticated.status===404)
  await json('DELETE',`/api/agents/threads/${t.id}`)
  assert.equal((await api('GET',mask.url)).status,200)
  assert.equal((database().prepare('SELECT thread_id FROM agent_image_masks WHERE id=?').get(mask.id) as any).thread_id,branch.thread.id)
  const branchAgain = toolResult(await events(`/api/agents/threads/${branch.thread.id}/images/${result.image.id}/again`))
  assert.ok(branchAgain.image,JSON.stringify(branchAgain))
  await json('DELETE',`/api/agents/threads/${branch.thread.id}`)
  assert.equal((await api('GET',mask.url)).status,404)
  assert.equal(database().prepare('SELECT COUNT(*) AS n FROM agent_image_masks WHERE thread_id=?').get(t.id)?.n,0)
  // A persisted upload needs no intermediary generation; its identity and mask survive branches.
  const attachedThread = await json('POST', '/api/agents/threads', { mode:'quick', model:'test-model', tools:['images'], permission:'auto' })
  const attachmentBytes = png(16,12)
  const attachedMessage = Number(database().prepare('INSERT INTO agent_messages(thread_id,role,content,attachments,created_at) VALUES(?,?,?,?,?)').run(attachedThread.id,'user','Paint this upload',JSON.stringify([{kind:'image',name:'upload.png',type:'image/png',size:attachmentBytes.length,data:attachmentBytes.toString('base64')}]),Date.now()).lastInsertRowid)
  const attachmentId = `attachment:${attachedMessage}:0`
  const attachedMask = await json('POST', `/api/agents/threads/${attachedThread.id}/image-masks`, { source_image_id:attachmentId,data })
  const attachedResult = toolResult(await events(`/api/agents/threads/${attachedThread.id}/inpaint`, { operation:'inpaint',source_image_id:attachmentId,mask_id:attachedMask.id,prompt:'Paint the selected upload area',width:outputWidth,height:outputHeight }))
  assert.ok(attachedResult.image,JSON.stringify(attachedResult))
  const attachedHistory = await json('GET',`/api/agents/threads/${attachedThread.id}`)
  let survivor = await json('POST',`/api/agents/threads/${attachedThread.id}/branch`,{messageId:attachedHistory.messages.at(-1).id})
  await json('DELETE',`/api/agents/threads/${attachedThread.id}`)
  for (let generation=0;generation<2;generation++) {
    const replay = toolResult(await events(`/api/agents/threads/${survivor.thread.id}/images/${attachedResult.image.id}/again`))
    assert.ok(replay.image,JSON.stringify(replay))
    assert.equal(replay.image.settings.source.id,attachmentId)
    assert.equal(replay.image.settings.mask.id,attachedMask.id)
    assert.equal((await api('GET',replay.image.settings.source.url)).status,200)
    if (generation===0) {
      const history = await json('GET',`/api/agents/threads/${survivor.thread.id}`)
      const descendant = await json('POST',`/api/agents/threads/${survivor.thread.id}/branch`,{messageId:history.messages.at(-1).id})
      await json('DELETE',`/api/agents/threads/${survivor.thread.id}`)
      survivor=descendant
    }
  }
  await json('DELETE',`/api/agents/threads/${survivor.thread.id}`)
  assert.equal((await api('GET',attachedMask.url)).status,404)
  assert.equal(database().prepare('SELECT COUNT(*) AS n FROM agent_image_source_aliases').get()?.n,0)
  console.log('PASS attachment inpainting: upload, nested branch after parent deletion, Again, stable mask/source binding, live source URL, cleanup')
  await json('DELETE','/api/admin/users/2')
  assert.equal(database().prepare('SELECT COUNT(*) AS n FROM agent_image_masks WHERE id=?').get(foreignMask.id)?.n,0)
  console.log('PASS mask quota/size, bounded abandoned uploads, protected deletion, rewind, branch retention/Again, thread/account cleanup and public-share exclusion')

} finally {
  await server.dispose(); database().close()
  comfy.closeAllConnections(); ollama.closeAllConnections()
  await Promise.all([new Promise<void>(r=>comfy.close(()=>r())),new Promise<void>(r=>ollama.close(()=>r()))])
}
