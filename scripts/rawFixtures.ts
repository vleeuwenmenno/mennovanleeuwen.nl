// Generated camera raw and multi-picture JPEG fixtures (no real photos): a TIFF/DNG assembler and
// helpers to make JPEGs with other frame sizes, MPF segments and appended pictures.
import { readFileSync } from 'node:fs'

export const fixtureJpeg = (name = 'source.jpg') => readFileSync(new URL(`./fixtures/agent-image-sources/${name}`, import.meta.url))

/** A JPEG with its SOF frame size changed (the source checks read the header, they do not decode). */
export function resized(jpeg: Buffer, width: number, height: number): Buffer {
  const out = Buffer.from(jpeg)
  for (let at = 2; at + 9 < out.length;) {
    const marker = out[at + 1], size = out.readUInt16BE(at + 2)
    if (marker >= 0xc0 && marker <= 0xc2) { out.writeUInt16BE(height, at + 5); out.writeUInt16BE(width, at + 7); return out }
    at += 2 + size
  }
  throw new Error('No SOF')
}

/** A JPEG whose frame is lossless (SOF3), like a DNG's raw data. */
export function lossless(jpeg: Buffer): Buffer {
  const out = Buffer.from(jpeg)
  for (let at = 2; at + 4 < out.length;) {
    const marker = out[at + 1], size = out.readUInt16BE(at + 2)
    if (marker >= 0xc0 && marker <= 0xc2) { out[at + 1] = 0xc3; return out }
    at += 2 + size
  }
  throw new Error('No SOF')
}

/** An iPhone-style multi-picture JPEG: an APP2 MPF segment after SOI, and more pictures appended. */
export function multiPicture(primary: Buffer, ...more: Buffer[]): Buffer {
  const body = Buffer.concat([Buffer.from('MPF\0'), Buffer.from('MM\0*\0\0\0\x08\0\0', 'latin1')])
  const app2 = Buffer.concat([Buffer.from([0xff, 0xe2]), Buffer.from([0, body.length + 2]), body])
  return Buffer.concat([primary.subarray(0, 2), app2, primary.subarray(2), ...more])
}

/** An IFD entry: tag, TIFF type (3 SHORT, 4 LONG, 13 IFD) and its values, which may depend on where things were laid out. */
export type Entry = [tag: number, type: number, values: number[] | ((at: Layout) => number[])]
export type Layout = { blob: number[]; blobLength: number[]; ifd: number[] }

/**
 * A TIFF: `ifds[0]` is IFD0, `chain[i]` names the IFD after IFD i (or -1), and blobs are the image
 * data the entries point to. Entries values longer than 4 bytes go after their IFD.
 */
export function tiff(le: boolean, ifds: Entry[][], blobs: Buffer[], chain: number[] = []): Buffer {
  const layout: Layout = { blob: [], blobLength: blobs.map((b) => b.length), ifd: [] }
  let at = 8
  for (const b of blobs) { layout.blob.push(at); at += b.length + (b.length % 2) }
  const sizeOf = (entries: Entry[]) => 2 + entries.length * 12 + 4 + entries.reduce((n, [, type, v]) => {
    const count = typeof v === 'function' ? v({ blob: blobs.map(() => 0), blobLength: layout.blobLength, ifd: ifds.map(() => 0) }).length : v.length
    const bytes = count * (type === 3 ? 2 : 4)
    return n + (bytes > 4 ? bytes : 0)
  }, 0)
  for (const entries of ifds) { layout.ifd.push(at); at += sizeOf(entries) }
  const out = Buffer.alloc(at)
  const w16 = (v: number, p: number) => (le ? out.writeUInt16LE(v, p) : out.writeUInt16BE(v, p))
  const w32 = (v: number, p: number) => (le ? out.writeUInt32LE(v >>> 0, p) : out.writeUInt32BE(v >>> 0, p))
  out.write(le ? 'II' : 'MM', 0, 'latin1'); w16(42, 2); w32(layout.ifd[0], 4)
  blobs.forEach((b, i) => b.copy(out, layout.blob[i]))
  ifds.forEach((entries, i) => {
    const start = layout.ifd[i]
    let extra = start + 2 + entries.length * 12 + 4
    w16(entries.length, start)
    entries.forEach(([tag, type, v], k) => {
      const values = typeof v === 'function' ? v(layout) : v
      const e = start + 2 + k * 12, size = type === 3 ? 2 : 4
      w16(tag, e); w16(type, e + 2); w32(values.length, e + 4)
      let p = e + 8
      if (values.length * size > 4) { w32(extra, e + 8); p = extra; extra += values.length * size }
      values.forEach((value, j) => (size === 2 ? w16(value, p + j * 2) : w32(value, p + j * 4)))
    })
    w32(chain[i] >= 0 ? layout.ifd[chain[i]] : 0, start + 2 + entries.length * 12)
  })
  return out
}

/**
 * An iPhone-ProRAW-like DNG: IFD0 a small thumbnail strip with the orientation, SubIFD 1 the raw
 * data (lossless JPEG), SubIFD 2 the full preview (NewSubFileType 1).
 */
export function dng(le: boolean, { orientation = 1, preview, thumb }: { orientation?: number; preview: Buffer; thumb: Buffer }): Buffer {
  const raw = lossless(resized(fixtureJpeg(), 9000, 6000))
  return tiff(le, [
    [[254, 4, [1]], [256, 4, [48]], [257, 4, [32]], [259, 3, [7]], [273, 4, (l) => [l.blob[0]]], [274, 3, [orientation]], [279, 4, [thumb.length]], [330, 4, (l) => [l.ifd[1], l.ifd[2]]]],
    [[254, 4, [0]], [259, 3, [7]], [273, 4, (l) => [l.blob[1]]], [279, 4, [raw.length]]],
    [[254, 4, [1]], [259, 3, [7]], [273, 4, (l) => [l.blob[2]]], [279, 4, [preview.length]]],
  ], [thumb, raw, preview])
}
