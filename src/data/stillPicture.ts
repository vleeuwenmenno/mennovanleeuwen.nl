import { HEIF_MIME, HEIF_NAME, jpegPrimary, jpegSize, RAW_MIME, RAW_NAME, StillImageError, stillImage } from './rawImage'

/** The largest camera raw read in the browser to find its preview (a 48 MP ProRAW is about 100 MB). */
export const MAX_RAW = 200 * 1024 * 1024
const MAX_HEIF = 25 * 1024 * 1024
const MAX_PIXELS = 16_777_216
const MAX_SIDE = 8192
/** The long edge a picture is drawn down to when it is too big to send as it is. */
const FIT_EDGE = 4096

export const isRawFile = (name: string, mime: string) => RAW_NAME.test(name) || RAW_MIME.test(mime)
export const isHeifFile = (name: string, mime: string) => HEIF_NAME.test(name) || HEIF_MIME.test(mime)

const encode = (canvas: HTMLCanvasElement, quality: number) =>
  new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not convert the picture'))), 'image/jpeg', quality))

/**
 * A picture drawn down through a canvas as a JPEG of at most `maxBytes`: the long edge at most
 * 4096 pixels and 16 megapixels, smaller and lower quality until it fits (a few tries at most).
 * EXIF orientation is applied while decoding, so the result is upright without metadata.
 */
async function drawDown(blob: Blob, maxBytes: number): Promise<Blob> {
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' })
  try {
    let scale = Math.min(1, FIT_EDGE / Math.max(bitmap.width, bitmap.height), Math.sqrt(MAX_PIXELS / (bitmap.width * bitmap.height)))
    for (let attempt = 0; attempt < 4; attempt++, scale *= 0.75) {
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale))
      canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
      const out = await encode(canvas, attempt ? 0.8 : 0.9)
      if (out.size <= maxBytes) return out
    }
  } finally { bitmap.close() }
  throw new Error('The picture is still too big after shrinking it')
}

/**
 * A camera raw (DNG, iPhone ProRAW, NEF, ARW, CR2) as its embedded JPEG preview, a HEIC as a JPEG
 * when this browser can decode it (Safari can, Chrome and Firefox cannot), or a multi-picture JPEG
 * (iPhone gain or depth maps) as its primary picture. Drawn down when over `maxBytes` or the
 * sources' 16 megapixels. Other pictures are returned as they are.
 */
export async function stillPicture(blob: Blob, name: string, maxBytes: number): Promise<Blob> {
  const mime = blob.type || ''
  if (isRawFile(name, mime)) {
    if (blob.size > MAX_RAW) throw new Error(`${name} is over ${MAX_RAW / 1024 / 1024} MB`)
    let jpeg: Uint8Array
    try { jpeg = stillImage(new Uint8Array(await blob.arrayBuffer()), { largest: true }) } catch (e) { throw new Error(`${name}: ${e instanceof StillImageError ? e.message : 'could not read this raw file; export a JPEG'}`) }
    return fit(jpeg, maxBytes)
  }
  if (isHeifFile(name, mime)) {
    if (blob.size > MAX_HEIF) throw new Error(`${name} is over ${MAX_HEIF / 1024 / 1024} MB`)
    try { return await drawDown(blob, maxBytes) } catch { throw new Error(`${name}: this browser cannot read HEIC pictures; export it as a JPEG first (on an iPhone: Settings → Camera → Formats → Most Compatible)`) }
  }
  if (/^image\/jpe?g$/i.test(mime) || /\.jpe?g$/i.test(name)) {
    if (blob.size > MAX_HEIF) return blob
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const cut = jpegPrimary(bytes)
    return cut === bytes ? blob : new Blob([cut as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' })
  }
  return blob
}

async function fit(jpeg: Uint8Array, maxBytes: number): Promise<Blob> {
  const blob = new Blob([jpeg as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' })
  const size = jpegSize(jpeg)
  if (size && jpeg.length <= maxBytes && size.width <= MAX_SIDE && size.height <= MAX_SIDE && size.width * size.height <= MAX_PIXELS) return blob
  return drawDown(blob, maxBytes)
}
