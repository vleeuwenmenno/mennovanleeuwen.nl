import type { Line } from './text.ts'

export const ART_BYTES = 3 * 1024 * 1024
export type ArtMode = 'truecolour' | 'grayscale'
/** The MvL terminal supports RGB markup; an explicitly limited TERM gets density blocks. */
export function artMode(tty: boolean, enabled: boolean, cols: number, env: Record<string, string>): ArtMode | null {
  if (!tty || !enabled || cols < 24 || env.TERM?.toLowerCase() === 'dumb') return null
  return !env.TERM || env.TERM === 'xterm-mvlos' || /^(truecolor|24bit)$/i.test(env.COLORTERM ?? '') ? 'truecolour' : 'grayscale'
}
/** Two vertical samples per cell. Bound both axes, without enlarging small images. */
export function artSize(width: number, height: number, cols: number) {
  if (cols < 24 || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > 16_777_216) return null
  const scale = Math.min(1, Math.min(48, cols - 4) / width, 48 / height)
  const w = Math.max(1, Math.floor(width * scale)), h = Math.max(1, Math.floor(height * scale))
  return { width: w, height: h, rows: Math.ceil(h / 2) }
}
/** Only a private generated artifact, not a share, arbitrary path, redirect or remote URL. */
export const privateArtUrl = (url: string) => /^\/api\/agents\/images\/[0-9a-f-]{36}$/.test(url)
export function pngSize(bytes: Uint8Array) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10]
  if (bytes.length < 24 || !signature.every((b, i) => bytes[i] === b) || String.fromCharCode(...bytes.slice(12, 16)) !== 'IHDR') return null
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const width = data.getUint32(16), height = data.getUint32(20)
  return artSize(width, height, 80) ? { width, height } : null
}
export async function artBytes(url: string, headers: Record<string, string>, signal: AbortSignal, request: typeof fetch = fetch): Promise<Uint8Array | null> {
  if (!privateArtUrl(url) || signal.aborted) return null
  const res = await request(url, { headers, signal, credentials: 'same-origin', redirect: 'error' })
  if (!res.ok || res.headers.get('Content-Type')?.split(';')[0] !== 'image/png' || Number(res.headers.get('Content-Length')) > ART_BYTES || !res.body) { await res.body?.cancel(); return null }
  const reader = res.body.getReader(), chunks: Uint8Array[] = []; let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break
      total += value.length
      if (total > ART_BYTES) { await reader.cancel(); return null }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(total); let at = 0
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length }
  return pngSize(bytes) ? bytes : null
}
/** Pixels are sampled by canvas; these colours belong to the image, not the interface palette. */
export function pixelArt(pixels: Uint8ClampedArray, width: number, height: number, mode: ArtMode): Line[] {
  if (width < 1 || width > 48 || height < 1 || height > 48 || pixels.length !== width * height * 4) return []
  const rgb = (at: number) => '#' + [pixels[at], pixels[at + 1], pixels[at + 2]].map((n) => n.toString(16).padStart(2, '0')).join('')
  const light = (at: number) => (pixels[at] * 0.2126 + pixels[at + 1] * 0.7152 + pixels[at + 2] * 0.0722) / 255
  const lines: Line[] = []
  for (let y = 0; y < height; y += 2) {
    const line: Line = [{ t: '  ' }]
    for (let x = 0; x < width; x++) {
      const top = (y * width + x) * 4, bottom = (Math.min(y + 1, height - 1) * width + x) * 4
      const next = mode === 'truecolour' ? { t: '▀', fg: rgb(top), bg: rgb(bottom) } : { t: ' ░▒▓█'[Math.round((light(top) + light(bottom)) * 2)] }
      const previous = line[line.length - 1]
      if (line.length > 1 && previous.fg === next.fg && previous.bg === next.bg) previous.t += next.t
      else line.push(next)
    }
    lines.push(line)
  }
  return lines
}
export async function decodeArt(bytes: Uint8Array, cols: number, mode: ArtMode): Promise<Line[]> {
  const source = pngSize(bytes), target = source && artSize(source.width, source.height, cols)
  if (!target) return []
  const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }))
  try {
    if (bitmap.width !== source!.width || bitmap.height !== source!.height) return []
    const canvas = document.createElement('canvas'); canvas.width = target.width; canvas.height = target.height
    const ctx = canvas.getContext('2d', { willReadFrequently: true }); if (!ctx) return []
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
    ctx.fillRect(0, 0, target.width, target.height)
    ctx.drawImage(bitmap, 0, 0, target.width, target.height)
    return pixelArt(ctx.getImageData(0, 0, target.width, target.height).data, target.width, target.height, mode)
  } finally { bitmap.close() }
}
