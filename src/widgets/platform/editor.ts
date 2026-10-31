/** Synchronous native-input policy. Package responses can never intercept browser key events. */
export function continueList(value: string, start: number, end: number): { start: number; end: number; text: string } | null {
  if (start !== end) return null
  const from = value.lastIndexOf('\n', start - 1) + 1
  const line = value.slice(from, start)
  const match = /^(\s*)([-*+] \[[ xX]\] |[-*+] |(\d+)([.)]) )(.*)$/.exec(line)
  if (!match) return null
  if (!match[5].trim()) return { start: from, end: start, text: '' }
  const marker = match[3] ? `${Number(match[3]) + 1}${match[4]} ` : match[2].replace(/\[[xX]\]/, '[ ]')
  return { start, end, text: `\n${match[1]}${marker}` }
}
export const noteRevision = (note: { text: string; edited?: number; updated: number }) => `${note.edited ?? note.updated}:${note.text.length}`
