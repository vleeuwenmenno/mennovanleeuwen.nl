import { stillPicture } from '../../data/stillPicture'

// Keyframes are cropped in the browser (the server has no image library): the picture is drawn at
// the clip's exact size, covering it, with the focal point (0–1 across and down) kept in view, and
// sent as a PNG. ComfyUI then gets exactly what the person saw in the crop.

export type Focal = { x: number; y: number }

/** A picture as a bitmap, the right way up (EXIF), from a blob of any picture the browser can read (HEIC and raws through stillPicture). */
export async function bitmapOf(blob: Blob, name: string): Promise<ImageBitmap> {
  return createImageBitmap(await stillPicture(blob, name, 40 * 1024 * 1024), { imageOrientation: 'from-image' })
}

/** Where the picture lands when it covers a W×H frame with `focal` kept in view: its offset and scale. */
export function coverPlacement(sw: number, sh: number, w: number, h: number, focal: Focal) {
  const scale = Math.max(w / sw, h / sh)
  const dw = sw * scale, dh = sh * scale
  const x = Math.min(0, Math.max(w - dw, w / 2 - focal.x * dw))
  const y = Math.min(0, Math.max(h - dh, h / 2 - focal.y * dh))
  return { x, y, dw, dh, scale }
}

/** The bitmap cropped to exactly w × h around `focal`, as base64 PNG. */
export async function cropToPng(bitmap: ImageBitmap, w: number, h: number, focal: Focal): Promise<string> {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingQuality = 'high'
  const p = coverPlacement(bitmap.width, bitmap.height, w, h, focal)
  ctx.drawImage(bitmap, p.x, p.y, p.dw, p.dh)
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not make the keyframe'))), 'image/png'))
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

export async function fetchBlob(url: string): Promise<Blob> {
  const res = await fetch(url, { credentials: 'same-origin' })
  if (!res.ok) throw new Error(`Could not load the picture (${res.status})`)
  return res.blob()
}
