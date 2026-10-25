import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { checkPhotoAttachmentBudget, MAX_PHOTO_ATTACHMENT, photoOriginalUrl, readPhotoOriginal } from '../src/data/photoAttachments.ts'

const png = readFileSync(new URL('./fixtures/agent-image-sources/source.png', import.meta.url))
let seen = ''
const request: typeof fetch = async (url, init) => {
  seen = String(url)
  assert.equal(init?.credentials, 'same-origin')
  assert.equal(init?.redirect, 'error')
  assert.equal(init?.method, 'GET')
  assert.equal(init?.body, undefined)
  assert.equal((init?.headers as Record<string, string>)['X-MvL-Account'], '7')
  return new Response(png, { headers: { 'Content-Type': 'application/octet-stream' } })
}
const blob = await readPhotoOriginal('immich', 'photo /?other=1', { headers: { 'X-MvL-Account': '7' }, method: 'POST', body: 'ignored' }, request)
assert.equal(seen, '/api/photos/immich/original?id=photo%20%2F%3Fother%3D1')
assert.equal(blob.type, 'image/png')
assert.deepEqual(Buffer.from(await blob.arrayBuffer()), png)
assert.equal(photoOriginalUrl('seafile', 'id', true), '/api/photos/seafile/original?id=id&download=1')
for (const [file, mime] of [['source.jpg', 'image/jpeg'], ['lossy.webp', 'image/webp'], ['lossless.webp', 'image/webp']]) {
  const data = readFileSync(new URL(`./fixtures/agent-image-sources/${file}`, import.meta.url))
  assert.equal((await readPhotoOriginal('seafile', 'id', {}, async () => new Response(data))).type, mime)
}
await assert.rejects(readPhotoOriginal('https://evil.test' as never, 'id', {}, request), /Invalid Photos source/)
await assert.rejects(readPhotoOriginal('immich', '', {}, request), /Invalid Photos source/)
await assert.rejects(readPhotoOriginal('immich', 'id', {}, async () => new Response('denied', { status: 403 })), /403/)
await assert.rejects(readPhotoOriginal('immich', 'id', {}, async () => new Response('<html>not an image</html>', { headers: { 'Content-Type': 'image/jpeg' } })), /Choose an original/)
await assert.rejects(readPhotoOriginal('immich', 'id', {}, async () => new Response(new Uint8Array())), /Choose an original/)
let cancelled = false
const stream = () => new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)) }, cancel() { cancelled = true } })
await assert.rejects(readPhotoOriginal('immich', 'id', {}, async () => new Response(stream(), { headers: { 'Content-Length': String(MAX_PHOTO_ATTACHMENT + 1) } })), /too big/)
assert.equal(cancelled, true)
cancelled = false
await assert.rejects(readPhotoOriginal('immich', 'id', {}, async () => new Response(stream())), /too big/)
assert.equal(cancelled, true)
// A camera raw (TIFF-based) may be larger than 5 MB: it is attached as its embedded preview.
const raw = new Uint8Array(6 * 1024 * 1024); raw.set([0x49, 0x49, 42, 0, 8, 0, 0, 0])
const rawBlob = await readPhotoOriginal('immich', 'id', {}, async () => new Response(raw))
assert.equal(rawBlob.type, 'image/x-adobe-dng')
assert.equal(rawBlob.size, raw.length)
const heic = new Uint8Array(64); heic.set([0, 0, 0, 24, ...new TextEncoder().encode('ftypheic')])
assert.equal((await readPhotoOriginal('immich', 'id', {}, async () => new Response(heic))).type, 'image/heic')
const abort = new AbortController(); abort.abort()
await assert.rejects(readPhotoOriginal('immich', 'id', { signal: abort.signal }, async () => new Response(png)), { name: 'AbortError' })
checkPhotoAttachmentBudget([{ kind: 'text', text: 'Existing draft attachment' }, { kind: 'image', data: 'abc' }])
assert.throws(() => checkPhotoAttachmentBudget(Array.from({ length: 11 }, () => ({ kind: 'image', data: 'abc' }))), /At most 10/)
assert.throws(() => checkPhotoAttachmentBudget([{ kind: 'image', data: 'a'.repeat(14_000_001) }]), /too big together/)
console.log('Photos attachments: original bytes, MIME detection, fixed authenticated URLs, caps, errors, cancellation and combined limits passed')
