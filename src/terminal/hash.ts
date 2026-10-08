// Checksums for sha1sum, sha256sum, sha384sum, sha512sum (Web Crypto) and md5sum (Web Crypto
// has no MD5, so it is implemented here, RFC 1321).

const toHex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')

export async function sha(algo: 'SHA-1' | 'SHA-256' | 'SHA-384' | 'SHA-512', text: string) {
  return toHex(new Uint8Array(await crypto.subtle.digest(algo, new TextEncoder().encode(text))))
}

const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21]
const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0)

export function md5(text: string): string {
  const msg = new TextEncoder().encode(text)
  const len = (((msg.length + 8) >>> 6) + 1) * 64
  const buf = new Uint8Array(len)
  buf.set(msg)
  buf[msg.length] = 0x80
  const view = new DataView(buf.buffer)
  view.setUint32(len - 8, (msg.length * 8) >>> 0, true)
  view.setUint32(len - 4, Math.floor((msg.length * 8) / 2 ** 32), true)

  let a0 = 0x67452301
  let b0 = 0xefcdab89
  let c0 = 0x98badcfe
  let d0 = 0x10325476
  for (let off = 0; off < len; off += 64) {
    const M = Array.from({ length: 16 }, (_, i) => view.getUint32(off + i * 4, true))
    let a = a0
    let b = b0
    let c = c0
    let d = d0
    for (let i = 0; i < 64; i++) {
      let f: number
      let g: number
      if (i < 16) {
        f = (b & c) | (~b & d)
        g = i
      } else if (i < 32) {
        f = (d & b) | (~d & c)
        g = (5 * i + 1) % 16
      } else if (i < 48) {
        f = b ^ c ^ d
        g = (3 * i + 5) % 16
      } else {
        f = c ^ (b | ~d)
        g = (7 * i) % 16
      }
      const tmp = d
      d = c
      c = b
      const x = (a + f + K[i] + M[g]) >>> 0
      b = (b + ((x << S[i]) | (x >>> (32 - S[i])))) >>> 0
      a = tmp
    }
    a0 = (a0 + a) >>> 0
    b0 = (b0 + b) >>> 0
    c0 = (c0 + c) >>> 0
    d0 = (d0 + d) >>> 0
  }
  const out = new Uint8Array(16)
  const ov = new DataView(out.buffer)
  ;[a0, b0, c0, d0].forEach((v, i) => ov.setUint32(i * 4, v, true))
  return toHex(out)
}
