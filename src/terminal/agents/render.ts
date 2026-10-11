import { calendarTime, toolLabel, type Todo, type ToolCall } from '../../data/agents'
import { diffCounts, diffLines } from './diff'
import { markdown } from './markdown'
import { clipLine, seg, wrap, type Line } from './text'

// How the agents TUI shows a conversation: your messages after >, replies after ●, each tool call
// as a line with what came of it under ⎿, edits as diffs, like a coding agent's CLI.

const s = (call: ToolCall, k: string) => (typeof call.arguments?.[k] === 'string' ? (call.arguments[k] as string) : '')
const oneLine = (t: string, n = 80) => {
  const l = t.replace(/\s+/g, ' ').trim()
  return l.length > n ? `${l.slice(0, n - 1)}…` : l
}

export function userLines(text: string, w: number): Line[] {
  return wrap([seg(text)], w, [seg('> ', 'muted')], [seg('  ')])
}

export function assistantLines(content: string, w: number): Line[] {
  const md = markdown(content.trim(), w - 2)
  return md.map((l, i) => [seg(i === 0 ? '● ' : '  ', i === 0 ? 'bold' : undefined), ...l])
}

export function thinkingLines(thinking: string, verbose: boolean, w: number): Line[] {
  if (!thinking.trim()) return []
  if (verbose) return wrap([seg(thinking.trim(), 'muted')], w, [seg('✻ ', 'muted')], [seg('  ')])
  return [clipLine([seg('✻ ', 'muted'), seg(`Thought: ${oneLine(thinking, 200)}`, 'muted')], w)]
}

/** A tool call's name and argument, as its header line shows it. */
export function toolTitle(call: ToolCall): [string, string] {
  switch (call.name) {
    case 'read_file':
      return ['Read', s(call, 'path')]
    case 'write_file':
      return ['Write', s(call, 'path')]
    case 'edit_file':
    case 'multi_edit':
      return ['Update', s(call, 'path')]
    case 'list_dir':
      return ['List', s(call, 'path') || '.']
    case 'glob':
      return ['Search', `pattern: "${s(call, 'pattern')}"${s(call, 'path') ? `, path: ${s(call, 'path')}` : ''}`]
    case 'grep':
      return ['Search', `"${s(call, 'pattern')}"${s(call, 'path') ? ` in ${s(call, 'path')}` : ''}${s(call, 'glob') ? ` (${s(call, 'glob')})` : ''}`]
    case 'make_dir':
      return ['MakeDir', s(call, 'path')]
    case 'move_path':
      return ['Move', `${s(call, 'from')} → ${s(call, 'to')}`]
    case 'delete_path':
      return ['Delete', s(call, 'path')]
    case 'terminal':
      return ['Terminal', oneLine(s(call, 'command'), 120)]
    case 'web_search':
      return ['Web Search', `"${s(call, 'query')}"`]
    case 'web_fetch':
      return ['Fetch', s(call, 'url')]
    case 'update_todos':
      return ['Update Todos', '']
    case 'ask_user':
      return ['Ask', s(call, 'title') || 'a question']
    case 'use_skill':
      return ['Skill', s(call, 'name')]
    case 'read_skill_file':
      return ['Skill', `${s(call, 'name')}/${s(call, 'path')}`]
    case 'exit_plan_mode':
      return ['Plan', '']
    case 'calendar_list_calendars':
      return ['Calendars', '']
    case 'calendar_list_events':
      return ['Calendar', [s(call, 'query') ? `"${s(call, 'query')}"` : '', s(call, 'from') || s(call, 'to') ? `${s(call, 'from') ? calendarTime(s(call, 'from')) : 'now'} → ${s(call, 'to') ? calendarTime(s(call, 'to')) : 'later'}` : ''].filter(Boolean).join(', ')]
    case 'calendar_create_event':
      return ['Add Event', `${s(call, 'title')}${s(call, 'start') ? `, ${calendarTime(s(call, 'start'))}` : ''}`]
    case 'calendar_update_event':
      return ['Change Event', s(call, 'title')]
    case 'calendar_delete_event':
      return ['Delete Event', '']
    default:
      return [toolLabel(call), '']
  }
}

function header(call: ToolCall, color: string, w: number): Line {
  const [name, arg] = toolTitle(call)
  return clipLine([seg('● ', color), seg(name, 'bold'), ...(arg ? [seg(`(${arg})`)] : [])], w)
}

const under = (text: string, color = 'muted'): Line => [seg('  ⎿  ', 'muted'), seg(text, color)]
const more = (n: number, verbose: boolean): Line[] => (n > 0 ? [[seg(`     … +${n} lines${verbose ? '' : ' (ctrl+o to expand)'}`, 'muted')]] : [])

/** Diff lines under a tool call, numbered. */
function diffBlock(before: string, after: string, w: number, max: number): { lines: Line[]; added: number; removed: number } {
  const d = diffLines(before, after)
  const { added, removed } = diffCounts(d)
  const numW = String(Math.max(...d.map((l) => l.new ?? l.old ?? 0), 1)).length
  const out = d.map((l): Line => {
    const num = l.text === '…' && l.kind === ' ' && l.old === undefined ? ' '.repeat(numW) : String((l.kind === '-' ? l.old : l.new) ?? '').padStart(numW)
    const color = l.kind === '-' ? 'red' : l.kind === '+' ? 'green' : 'muted'
    return clipLine([seg('     '), seg(num, 'muted'), seg(` ${l.kind} `, color), seg(l.text, l.kind === ' ' ? undefined : color)], w)
  })
  return { lines: out.slice(0, max).concat(more(out.length - max, false)), added, removed }
}

/** What an edit changes, as diff lines (for the approval preview and the result). */
export function editPreview(call: ToolCall, w: number, max = 40): { lines: Line[]; added: number; removed: number } {
  const edits = call.name === 'multi_edit' && Array.isArray(call.arguments?.edits) ? (call.arguments.edits as Record<string, unknown>[]) : [call.arguments ?? {}]
  const all: Line[] = []
  let added = 0
  let removed = 0
  edits.forEach((e, k) => {
    const b = diffBlock(String(e.old_string ?? ''), String(e.new_string ?? ''), w, max)
    if (k > 0) all.push([seg('     ⋯', 'muted')])
    all.push(...b.lines)
    added += b.added
    removed += b.removed
  })
  return { lines: all, added, removed }
}

/** A file's first lines, numbered (write_file previews). */
export function filePreview(content: string, w: number, max: number): Line[] {
  const ls = content.replace(/\n$/, '').split('\n')
  const numW = String(Math.min(ls.length, max)).length
  return ls
    .slice(0, max)
    .map((l, i) => clipLine([seg('     '), seg(String(i + 1).padStart(numW), 'muted'), seg('  '), seg(l)], w))
    .concat(more(ls.length - max, false))
}

export function todoLines(todos: Todo[], w: number): Line[] {
  return todos.map((t) =>
    clipLine(
      t.status === 'done' ? [seg('     ☒ ', 'muted'), seg(t.text, 'muted')] : t.status === 'active' ? [seg('     ◼ ', 'accent'), seg(t.text, 'bold')] : [seg('     ☐ '), seg(t.text)],
      w,
    ),
  )
}

const parse = (result: string): Record<string, unknown> | unknown[] | null => {
  try {
    return JSON.parse(result) as Record<string, unknown>
  } catch {
    return null
  }
}

/** A finished tool call: its header and what came of it. */
export function toolLines(call: ToolCall, result: string, w: number, verbose: boolean): Line[] {
  const json = parse(result)
  const obj = json && !Array.isArray(json) ? json : null
  if (obj && typeof obj.error === 'string') {
    const msg = obj.error
    const declined = /declined|did not allow|Plan mode|switched off/.test(msg)
    return [header(call, declined ? 'yellow' : 'red', w), ...wrap([seg(declined ? msg : `Error: ${msg}`, declined ? 'yellow' : 'red')], w, [seg('  ⎿  ', 'muted')], [seg('     ')])]
  }
  const ok = (body: Line[]) => [header(call, 'green', w), ...body]
  const max = verbose ? 200 : 6
  switch (call.name) {
    case 'read_file': {
      const n = result.split('\n').filter((l) => /^\s+\d+\t/.test(l)).length
      return ok([under(n ? `Read ${n} line${n === 1 ? '' : 's'}` : oneLine(result))])
    }
    case 'write_file': {
      const content = s(call, 'content')
      const n = content.replace(/\n$/, '').split('\n').length
      return ok([under(`${obj?.created ? 'Created' : 'Wrote'} ${n} line${n === 1 ? '' : 's'} to ${s(call, 'path')}`), ...filePreview(content, w, verbose ? 60 : 8)])
    }
    case 'edit_file':
    case 'multi_edit': {
      const p = editPreview(call, w, verbose ? 200 : 24)
      return ok([under(`Updated ${s(call, 'path')} with ${p.added} addition${p.added === 1 ? '' : 's'} and ${p.removed} removal${p.removed === 1 ? '' : 's'}`), ...p.lines])
    }
    case 'list_dir': {
      const n = Math.max(0, result.split('\n').length - 1)
      return ok([under(`Listed ${n} path${n === 1 ? '' : 's'}`)])
    }
    case 'glob': {
      const n = result.startsWith('No files') ? 0 : result.split('\n').filter((l) => l && !l.startsWith('[')).length
      return ok([under(`Found ${n} file${n === 1 ? '' : 's'}`), ...(verbose ? result.split('\n').slice(0, 50).map((l) => clipLine([seg('     '), seg(l, 'muted')], w)) : [])])
    }
    case 'grep': {
      const n = result.startsWith('No matches') ? 0 : result.split('\n').filter((l) => l && !l.startsWith('[') && l !== '--').length
      return ok([under(`Found ${n} ${call.arguments?.files_only === true ? 'file' : 'line'}${n === 1 ? '' : 's'}`), ...(verbose ? result.split('\n').slice(0, 50).map((l) => clipLine([seg('     '), seg(l, 'muted')], w)) : [])])
    }
    case 'terminal': {
      const out = typeof obj?.output === 'string' ? obj.output : result
      const code = typeof obj?.exit_code === 'number' ? obj.exit_code : 0
      const ls = out.replace(/\n$/, '').split('\n')
      const shown = out.trim() ? ls.slice(0, max).map((l, i) => clipLine([seg(i === 0 ? '  ⎿  ' : '     ', 'muted'), seg(l)], w)) : [under('(no output)')]
      return [header(call, code === 0 ? 'green' : 'red', w), ...shown, ...more(out.trim() ? ls.length - max : 0, verbose), ...(code !== 0 ? [[seg(`     exit code ${code}`, 'red')]] : [])]
    }
    case 'web_search': {
      const list = Array.isArray(json) ? (json as { title?: string; url?: string }[]) : []
      return ok([under(`${list.length} result${list.length === 1 ? '' : 's'}`), ...(verbose ? list.map((r) => clipLine([seg('     '), seg(r.title ?? '', 'bold'), seg(`  ${r.url ?? ''}`, 'muted')], w)) : [])])
    }
    case 'web_fetch': {
      const text = typeof obj?.content === 'string' ? obj.content : result
      return ok([under(`Read ${Math.max(1, Math.round(text.length / 1024))} KB${typeof obj?.title === 'string' ? `: ${oneLine(obj.title, 60)}` : ''}`)])
    }
    case 'update_todos': {
      const items = Array.isArray(call.arguments?.items) ? (call.arguments.items as Todo[]) : []
      return ok(items.length ? todoLines(items, w).map((l, i) => (i === 0 ? [seg('  ⎿  ', 'muted'), ...l.slice(1)] : l)) : [under('Cleared the plan')])
    }
    case 'ask_user': {
      const summary = typeof obj?.summary === 'string' ? obj.summary : obj?.skipped ? 'You closed the form' : ''
      return ok(summary ? summary.split('\n').map((l, i) => clipLine([seg(i === 0 ? '  ⎿  ' : '     ', 'muted'), seg(l)], w)) : [under('Answered')])
    }
    case 'exit_plan_mode':
      return obj?.approved ? [header(call, 'green', w), under(`You approved the plan${obj.permission === 'acceptEdits' ? ' (edits allowed)' : ''}`, 'green')] : [header(call, 'yellow', w), under(`You asked for changes: ${String(obj?.feedback ?? '')}`, 'yellow')]
    case 'calendar_list_calendars': {
      const list = Array.isArray(obj?.calendars) ? (obj.calendars as { name?: string; account?: string; writable?: boolean; default?: boolean }[]) : []
      return ok([
        under(`${list.length} calendar${list.length === 1 ? '' : 's'}`),
        ...(verbose ? list.map((c) => clipLine([seg('     '), seg(c.name ?? '', 'bold'), seg(`  ${c.account ?? ''}${c.writable ? '' : ', read only'}${c.default ? ', default' : ''}`, 'muted')], w)) : []),
      ])
    }
    case 'calendar_list_events': {
      const list = Array.isArray(obj?.events) ? (obj.events as { title?: string; when?: string; calendar?: string }[]) : []
      const total = list.length + (typeof obj?.more === 'number' ? obj.more : 0)
      return ok([
        under(`${total} event${total === 1 ? '' : 's'}`),
        ...list.slice(0, max).map((e) => clipLine([seg('     '), seg(e.when ?? '', 'muted'), seg(`  ${e.title ?? ''}`), seg(`  ${e.calendar ?? ''}`, 'muted')], w)),
        ...more(list.length - max, verbose),
      ])
    }
    case 'calendar_create_event':
    case 'calendar_update_event':
    case 'calendar_delete_event': {
      const done = (obj?.created ?? obj?.updated ?? obj?.deleted) as { title?: string; when?: string; calendar?: string } | undefined
      const verb = obj?.created ? 'Added' : obj?.updated ? 'Changed' : 'Deleted'
      return ok([under(done ? `${verb} ${done.title ?? ''}, ${done.when ?? ''} (${done.calendar ?? ''})${typeof obj?.applied_to === 'string' ? `, ${obj.applied_to}` : ''}` : 'Done')])
    }
    case 'use_skill':
      return ok([under(`Read the skill${/Files: (.*)/.exec(result)?.[1] ? ` (${/Files: (.*)/.exec(result)![1]})` : ''}`)])
    default: {
      const first = obj ? Object.entries(obj).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ') : result.split('\n')[0]
      return ok([under(oneLine(first || 'Done', Math.max(20, w - 8)))])
    }
  }
}

/** A tool call still under way. */
export function runningLines(call: ToolCall, state: 'running' | 'approval' | 'question' | 'client', w: number, blink: boolean): Line[] {
  const text = state === 'approval' ? 'Waiting for you to allow it…' : state === 'question' ? 'Waiting for your answers…' : state === 'client' ? 'Running in this terminal…' : 'Running…'
  return [header(call, blink ? 'muted' : 'bold', w), under(text)]
}
