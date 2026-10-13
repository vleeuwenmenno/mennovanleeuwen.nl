// Bytes in a shell that passes strings around. msh's pipes, files and arguments are JavaScript
// strings, so bytes ride in them the way Python's `surrogateescape` does:
//
//   - Bytes that are valid UTF-8 are the characters they encode (`é` is c3 a9, as on Linux).
//   - Any other byte (0x80 to 0xFF) is one lone surrogate, U+DC00 plus the byte (U+DC80 to U+DCFF).
//
// So every byte sequence has exactly one text, and `textToBytes(bytesToText(b))` gives `b` back.
// Text commands keep working on ordinary text; the byte commands (head -c, xxd, wc -c, the
// checksums) turn the text into bytes first. /dev/urandom is mostly escapes, which is what it
// should look like. The screen shows an escape as the replacement character (see `printable`).

const encoder = new TextEncoder()
const strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const LONE = /[\ud800-\udfff]/

/** The text for one byte that is not part of a valid UTF-8 sequence. */
const escape = (byte: number) => String.fromCharCode(0xdc00 + byte)

/** The bytes of a text: UTF-8, with the escapes turned back into the bytes they stand for. */
export function textToBytes(text: string): Uint8Array<ArrayBuffer> {
  if (!LONE.test(text)) return encoder.encode(text)
  const parts: Uint8Array<ArrayBuffer>[] = []
  let run = 0
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i)
    if (unit < 0xd800 || unit > 0xdfff) continue
    const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0
    if (unit <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      i++
      continue
    }
    parts.push(encoder.encode(text.slice(run, i)))
    parts.push(unit >= 0xdc80 && unit <= 0xdcff ? Uint8Array.of(unit - 0xdc00) : Uint8Array.of(0xef, 0xbf, 0xbd))
    run = i + 1
  }
  parts.push(encoder.encode(text.slice(run)))
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** The text of some bytes: UTF-8 where it is valid, an escape for every byte that is not. */
export function bytesToText(bytes: Uint8Array): string {
  try {
    return strict.decode(bytes)
  } catch {
    /* some bytes are not UTF-8: decode by hand */
  }
  const out: string[] = []
  let run = ''
  const flush = () => {
    if (run) out.push(run)
    run = ''
  }
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i]
    if (b < 0x80) {
      run += String.fromCharCode(b)
      i++
      if (run.length > 8192) flush()
      continue
    }
    const length = b >= 0xc2 && b <= 0xdf ? 2 : b >= 0xe0 && b <= 0xef ? 3 : b >= 0xf0 && b <= 0xf4 ? 4 : 0
    let ok = length > 0 && i + length <= bytes.length
    for (let k = 1; ok && k < length; k++) {
      const lo = k === 1 ? (b === 0xe0 ? 0xa0 : b === 0xf0 ? 0x90 : 0x80) : 0x80
      const hi = k === 1 ? (b === 0xed ? 0x9f : b === 0xf4 ? 0x8f : 0xbf) : 0xbf
      ok = bytes[i + k] >= lo && bytes[i + k] <= hi
    }
    if (!ok) {
      run += escape(b)
      i++
      continue
    }
    const cp = length === 2 ? b & 0x1f : length === 3 ? b & 0x0f : b & 0x07
    let point = cp
    for (let k = 1; k < length; k++) point = (point << 6) | (bytes[i + k] & 0x3f)
    run += String.fromCodePoint(point)
    i += length
  }
  flush()
  return out.join('')
}

/** The byte count of a text. */
export const byteLength = (text: string) => (LONE.test(text) ? textToBytes(text).length : encoder.encode(text).length)

/** Texts with escapes in them that spell valid UTF-8 (printf '\xc3\xa9') become the characters. */
export const settle = (text: string) => (/[\udc80-\udcff]/.test(text) ? bytesToText(textToBytes(text)) : text)

/** What the screen shows for a text: escapes and stray control characters become U+FFFD, NULs vanish. */
export function printable(text: string): string {
  if (!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ud800-\udfff]/.test(text)) return text
  return text
    .replace(/\u0000/g, '')
    .replace(/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '�')
    .replace(/[\ud800-\udbff][\udc00-\udfff]|[\ud800-\udfff]/g, (m) => (m.length === 2 ? m : '�'))
}

// --- hex dumps -------------------------------------------------------------------------------------

const HEX = '0123456789abcdef'
export const hexByte = (b: number, upper = false) => {
  const s = HEX[b >> 4] + HEX[b & 15]
  return upper ? s.toUpperCase() : s
}
/** A byte as the character a dump shows beside it: itself if printable ASCII, else a dot. */
export const dumpChar = (b: number) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')

/** Bytes from hex digits (whitespace between them is fine); null for anything else. */
export function fromHex(text: string): Uint8Array | null {
  const digits = text.replace(/\s+/g, '')
  if (!/^[0-9a-fA-F]*$/.test(digits)) return null
  const out = new Uint8Array(digits.length >> 1)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(digits.slice(i * 2, i * 2 + 2), 16)
  return out
}
