// Text files as the computer writes them: UTF-8 (with or without a byte order mark), or UTF-16 as
// Windows apps save them (a BOM, or every other byte a NUL when it has none). Used wherever the
// Calendar and Contacts read .ics and .vcf files, so a file from Outlook or Notepad reads right.

/** Text from file bytes, decoding UTF-16 (either order) and dropping any byte order mark. */
export function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2))
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2))
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3))
  // No mark: ASCII-ish text in UTF-16 has a NUL in every other byte.
  const head = bytes.subarray(0, 400)
  let evenNul = 0
  let oddNul = 0
  for (let i = 0; i < head.length; i++) {
    if (head[i] !== 0) continue
    if (i % 2) oddNul++
    else evenNul++
  }
  const pairs = Math.floor(head.length / 2)
  if (pairs >= 2 && oddNul > pairs / 3 && evenNul === 0) return new TextDecoder('utf-16le').decode(bytes)
  if (pairs >= 2 && evenNul > pairs / 3 && oddNul === 0) return new TextDecoder('utf-16be').decode(bytes)
  return new TextDecoder('utf-8').decode(bytes)
}

/** A file's (or Seafile blob's) text, decoded like decodeText. */
export async function blobText(blob: Blob): Promise<string> {
  return decodeText(new Uint8Array(await blob.arrayBuffer()))
}
