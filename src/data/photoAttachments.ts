import type { SourceId } from './photos'

export const MAX_PHOTO_ATTACHMENT = 5 * 1024 * 1024
/** Camera raws (TIFF-based: DNG, iPhone ProRAW, NEF, ARW, CR2) and HEIC are read whole, then attached as a JPEG (data/stillPicture.ts). */
export const MAX_PHOTO_RAW = 200 * 1024 * 1024
export const MAX_PHOTO_HEIF = 25 * 1024 * 1024
export const photoOriginalUrl = (source: SourceId, id: string, download = false) => `/api/photos/${source}/original?id=${encodeURIComponent(id)}${download ? '&download=1' : ''}`

/** Read only the authenticated Photos original endpoint, with a streaming attachment-size cap. */
export async function readPhotoOriginal(source: SourceId, id: string, init: RequestInit = {}, request: typeof fetch = fetch): Promise<Blob> {
  if (!['seafile', 'immich'].includes(source) || !id || id.length > 1024) throw new Error('Invalid Photos source')
  const response = await request(photoOriginalUrl(source, id), { signal: init.signal, headers: init.headers, method: 'GET', credentials: 'same-origin', redirect: 'error' })
  if (!response.ok) throw new Error(`Could not read the original photo (${response.status})`)
  const tooBig = () => new Error('Photo is too big (over 5 MB). Choose a smaller original.')
  if (Number(response.headers.get('Content-Length')) > MAX_PHOTO_RAW) { await response.body?.cancel(); throw tooBig() }
  if (!response.body) throw new Error('The original photo is empty')
  const reader = response.body.getReader(), chunks: Uint8Array<ArrayBuffer>[] = []
  // The cap is 5 MB until the first bytes show a raw or HEIC, which are converted before attaching.
  let size = 0, cap = MAX_PHOTO_ATTACHMENT, head = new Uint8Array()
  try {
    while (true) {
      init.signal?.throwIfAborted()
      const part = await reader.read()
      if (part.done) break
      if (head.length < 12) {
        head = new Uint8Array([...head, ...part.value.subarray(0, 12 - head.length)])
        cap = photoKind(head) === 'raw' ? MAX_PHOTO_RAW : photoKind(head) === 'heif' ? MAX_PHOTO_HEIF : MAX_PHOTO_ATTACHMENT
      }
      size += part.value.byteLength
      if (size > cap) throw cap === MAX_PHOTO_ATTACHMENT ? tooBig() : new Error(`Photo is too big (over ${cap / 1024 / 1024} MB).`)
      chunks.push(new Uint8Array(part.value))
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error }
  finally { reader.releaseLock() }
  init.signal?.throwIfAborted()
  const blob = new Blob(chunks), bytes = new Uint8Array(await blob.slice(0, 16).arrayBuffer())
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end))
  const mime = bytes[0] === 137 && ascii(1, 4) === 'PNG' && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10 ? 'image/png'
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg'
      : ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP' ? 'image/webp'
        : ['GIF87a', 'GIF89a'].includes(ascii(0, 6)) ? 'image/gif'
          : photoKind(bytes) === 'raw' ? 'image/x-adobe-dng'
            : photoKind(bytes) === 'heif' ? 'image/heic' : null
  if (!mime) throw new Error('Choose an original PNG, JPEG, WebP, GIF, camera raw (DNG) or HEIC image. Videos cannot be attached.')
  return blob.slice(0, blob.size, mime)
}

/** TIFF-based camera raws and HEIC/HEIF, from a file's first 12 bytes (data/rawImage.ts has the full checks). */
function photoKind(b: Uint8Array): 'raw' | 'heif' | null {
  if (b.length >= 4 && ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 42 && b[3] === 0) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && b[3] === 42))) return 'raw'
  const brand = b.length >= 12 ? String.fromCharCode(...b.subarray(4, 12)) : ''
  return /^ftyp(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(brand) ? 'heif' : null
}

/** Match the normal Agents count and combined text/base64 payload limits, without dropping files. */
export function checkPhotoAttachmentBudget(files: { kind: string; data?: string; text?: string }[]) {
  if (files.length > 10) throw new Error('At most 10 attachments can be added. Remove an attachment first.')
  if (files.reduce((size, file) => size + (file.kind === 'image' ? file.data?.length ?? 0 : file.text?.length ?? 0), 0) > 14_000_000) throw new Error('The attachments are too big together. Attach fewer photos.')
}
