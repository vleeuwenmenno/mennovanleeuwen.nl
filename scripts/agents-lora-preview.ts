// The # picker's LoRA facts and previews (server/agentLoraPreview.ts) against a mocked ComfyUI with
// LoRA Manager: exact joins to installed LoRAs, a cached preview with its real type, a non-image
// refused, facts only without a preview or without LoRA Manager, and nobody else's thumbnail.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const data = mkdtempSync(join(tmpdir(), 'mvlos-lora-preview-'))
process.env.DATA_DIR = data
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(64, 1)])
let manager: 'on' | 'missing' = 'on'
let previewBody: 'png' | 'html' | 'webp-as-jpeg' = 'png'
let previewFetches = 0
const installed = ['Styles\\ink-wash.safetensors', 'Styles/paper.safetensors', 'plain.safetensors', 'Other/unmatched.safetensors']
const comfy = createServer((req, res) => {
  const url = new URL(req.url!, 'http://test')
  const send = (v: unknown) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(v))
  if (url.pathname === '/object_info/LoraLoader') return send({ LoraLoader: { input: { required: { lora_name: [installed] } } } })
  if (url.pathname.startsWith('/object_info/')) return send({})
  if (url.pathname === '/api/lm/loras/list') {
    if (manager === 'missing') return res.writeHead(404).end()
    assert.equal(url.searchParams.get('page_size'), '50')
    return send({ items: [
      { model_name: 'Ink Wash Style', folder: 'Styles', file_path: '/models/loras/Styles/ink-wash.safetensors', base_model: 'SDXL 1.0', tags: ['style', 'ink'], file_size: 151_000_000, preview_url: '/api/lm/previews?path=%2Fmodels%2Floras%2FStyles%2Fink-wash.preview.png', civitai: { trainedWords: ['inkwash', 'sumi-e'] } },
      // A preview outside its own folder must not be used.
      { model_name: 'Paper', folder: 'Styles', file_path: '/models/loras/Styles/paper.safetensors', base_model: 'Flux.1 D', tags: [], file_size: 9000, preview_url: '/api/lm/previews?path=%2Fetc%2Fsecret.png', civitai: {} },
      { model_name: 'Not installed', folder: 'Gone', file_path: '/models/loras/Gone/x.safetensors', base_model: 'SD 1.5' },
    ] })
  }
  if (url.pathname === '/api/lm/previews') {
    previewFetches++
    assert.equal(url.searchParams.get('path'), '/models/loras/Styles/ink-wash.preview.png')
    if (previewBody === 'html') return res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html>')
    if (previewBody === 'webp-as-jpeg') return res.writeHead(200, { 'Content-Type': 'image/jpeg' }).end(Buffer.from('not really a picture'))
    return res.writeHead(200, { 'Content-Type': 'image/png' }).end(png)
  }
  if (url.pathname === '/api/lm/checkpoints/list') return res.writeHead(404).end()
  res.writeHead(404).end()
})
await new Promise<void>((ok) => comfy.listen(0, '127.0.0.1', ok))
const backend = `http://127.0.0.1:${(comfy.address() as { port: number }).port}`
try {
  const { database, encrypt } = await import('../server/db.ts')
  for (const id of [1, 2]) database().prepare('INSERT INTO users (id, github_id, login, github_token, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0)').run(id, id, `u${id}`, encrypt('none'))
  const { saveImageSettings } = await import('../server/agentImages.ts')
  const { loraDetails, loraPreview, sidecarPreview, previewCacheBytes } = await import('../server/agentLoraPreview.ts')
  const owner = { id: 1, admin: true } as never, other = { id: 2, admin: false } as never
  saveImageSettings(owner, { url: backend, token: 'secret' })
  saveImageSettings(other, { url: backend, token: 'secret' })

  const view = await loraDetails(owner)
  assert.equal(view.manager, true)
  assert.deepEqual(view.loras.map((l) => l.name), [...installed].sort(), 'exactly the installed LoRAs, nothing else')
  const by = (v: typeof view, n: string) => v.loras.find((l) => l.name === n)!
  const ink = by(view, installed[0]), paper = by(view, installed[1])
  assert.deepEqual({ ...ink }, { name: 'Styles\\ink-wash.safetensors', title: 'Ink Wash Style', baseModel: 'SDXL 1.0', triggers: ['inkwash', 'sumi-e'], tags: ['style', 'ink'], folder: 'Styles', size: 151_000_000, hasPreview: true })
  assert.equal(paper.hasPreview, false, 'a preview outside the LoRA’s own folder is ignored')
  assert.equal(paper.baseModel, 'Flux.1 D')
  assert.deepEqual({ ...by(view, 'plain.safetensors') }, { name: 'plain.safetensors', title: 'plain', baseModel: '', triggers: [], tags: [], folder: '', size: null, hasPreview: false }, 'unmatched: facts from the name only')
  assert.ok(!JSON.stringify(view).includes(backend) && !JSON.stringify(view).includes('secret') && !JSON.stringify(view).includes('/models/'), 'no backend URL, token or backend path leaks')

  const first = await loraPreview(owner, ink.name)
  assert.equal(first.mime, 'image/png')
  assert.ok(first.body.equals(png))
  await loraPreview(owner, ink.name)
  assert.equal(previewFetches, 1, 'the second read comes from the cache')
  assert.equal(previewCacheBytes(), png.length)
  await assert.rejects(loraPreview(owner, paper.name), /No preview/, 'no preview: refused, facts stay')
  await assert.rejects(loraPreview(other, ink.name), /No preview/, 'another account cannot read the owner’s thumbnail')

  // A response that is not a picture is refused, whatever its header says.
  for (const mode of ['html', 'webp-as-jpeg'] as const) {
    previewBody = mode
    saveImageSettings(owner, { token: `secret-${mode}` }) // a new backend scope: no cache hit
    await loraDetails(owner)
    await assert.rejects(loraPreview(owner, ink.name), /not a picture/)
  }
  assert.equal(sidecarPreview('http://elsewhere.example/api/lm/previews?path=%2Fm%2Fa.png', '/m/a.safetensors', backend), null, 'another host is never fetched')
  assert.equal(sidecarPreview('/api/lm/previews?path=%2Fm%2F..%2Fa.png', '/m/a.safetensors', backend), null)

  // Without LoRA Manager the list still comes, with names only and no previews.
  manager = 'missing'
  const plain = await loraDetails(owner)
  assert.equal(plain.manager, false)
  assert.deepEqual(plain.loras.map((l) => [l.title, l.hasPreview]), [['unmatched', false], ['paper', false], ['ink-wash', false], ['plain', false]])
  console.log('PASS LoRA details: exact installed joins, cached typed previews, non-images refused, facts-only fallback, owner-only thumbnails')
} finally {
  comfy.close()
  rmSync(data, { recursive: true, force: true })
}
