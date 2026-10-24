/** Shared message syntax. Quoted identifiers preserve spaces and Windows separators exactly. */
export type Mention = { sigil: '#' | '$' | '@'; name: string; weight?: number }
export const mentionText = (sigil: string, name: string) => sigil + (/\s|["':,;!?()[\]{}]/.test(name) ? JSON.stringify(name) : name)
export function messageMentions(text: string): Mention[] {
  const mentions: Mention[] = []
  const seen = new Set<string>()
  for (const match of text.matchAll(/(?:^|\s)([#$@])("(?:\\.|[^"\\])*"|[^\s"':,;!?()[\]{}]+)(?::([^\s,;!?()[\]{}]+))?/g)) {
    const sigil = match[1] as Mention['sigil']
    let name = match[2]
    if (name.startsWith('"')) { try { name = JSON.parse(name) } catch { continue } }
    else name = name.replace(/\.+$/, '')
    // Explicit paths remain CLI file attachments, not tool mentions.
    if (sigil === '@' && /[/\\]/.test(name)) continue
    if (!name || name.length > 2048) continue
    const key = `${sigil}${name}:${match[3] ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    mentions.push({ sigil, name, ...(sigil === '#' ? { weight: match[3] === undefined ? 1 : Number(match[3]) } : {}) })
    if (mentions.length === 20) break
  }
  return mentions
}
/** An unfinished mention at the caret; selections in the middle of a message also work. */
export function mentionAt(text: string, cursor: number) {
  const match = /(?:^|\s)([#$@])("(?:\\.|[^"\\])*|[^\s"':,;!?()[\]{}]*)$/.exec(text.slice(0, cursor))
  if (!match || match[1] === '@' && /[/\\]/.test(match[2])) return null
  return { start: match.index + match[0].length - match[1].length - match[2].length, sigil: match[1], query: match[2].replace(/^"/, '').toLowerCase() }
}
