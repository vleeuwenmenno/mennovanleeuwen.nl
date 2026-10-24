import { clipLine, seg, type Line } from './text.ts'
import type { ThreadSearchResult } from '../../data/agents.ts'

export function threadsCommand(arg: string, lastQuery = ''): { kind: 'search'; query: string; current: boolean } | { kind: 'open'; id: string } | { kind: 'error'; error: string } {
  const text = arg.trim()
  if (/^open(?:\s|$)/.test(text)) {
    const id = text.slice(4).trim()
    return /^[0-9a-f-]{8,36}$/.test(id) ? { kind: 'open', id } : { kind: 'error', error: 'Use /threads open <thread id> (or a unique prefix from the last results).' }
  }
  const current = /^this(?:\s|$)/.test(text), query = current ? text.slice(4).trim() || lastQuery : text
  if (!query) return { kind: 'error', error: 'Use /threads <words> or /threads this <words>. /threads this repeats the last search in this thread.' }
  if (query.length > 200) return { kind: 'error', error: 'Use at most 200 characters to search past threads.' }
  return { kind: 'search', query, current }
}
/** Plain text and explicit state words; no colour carries a result's meaning. */
export function threadSearchLines(result: ThreadSearchResult, cols: number): Line[] {
  const plain = (s: string) => s.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim()
  const row = (s: string) => clipLine([seg(plain(s))], Math.max(1, cols))
  if ('error' in result) return [row(result.error)]
  if ('found' in result) return [row(`No results. Searched ${result.searched}.`)]
  const lines = result.threads.flatMap((t) => [row(`${t.archived ? '[archived] ' : ''}${t.title}`), row(`Project: ${t.project?.name ?? '(none)'}`), row(`Date: ${t.last_active}`), row(`ID: ${t.thread_id}`), row(t.hits[0]?.excerpt ?? '(Title match; no message excerpt)'), []])
  if (result.capped || result.more_threads || result.truncated) lines.push(row('More or clipped matches; narrow the search words.'))
  return lines
}
