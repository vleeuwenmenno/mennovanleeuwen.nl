import { generatedImage } from '../../data/agentImages'
import { calendarTime, compactionText, toolLabel, type AgentMessage, type Todo, type ToolCall } from '../../data/agents'
import { diffCounts, diffLines } from './diff'
import { markdown } from './markdown'
import { clipLine, count, seg, width, wrap, type Line } from './text'

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

/**
 * Where the thread was compacted: a rule across the screen saying how, then the summary itself
 * (verbose, or /summary) or a line saying where to find it. The messages above stay on screen.
 */
export function compactLines(m: AgentMessage, w: number, full: boolean): Line[] {
  const c = m.compact
  const head: Line = [seg('── ', 'accent'), seg(`✻ ${compactionText(c)}`, 'accent'), ...(c?.instructions ? [seg(` · ${oneLine(c.instructions, 60)}`, 'muted')] : []), seg(' ')]
  // The rule stops a little short: a line as wide as the screen wraps when ✻ is drawn two cells wide.
  const out: Line[] = [clipLine([...head, seg('─'.repeat(Math.max(0, w - width(head) - 2)), 'accent')], w)]
  const was = c ? `${c.messages} ${c.messages === 1 ? 'message' : 'messages'}, about ${count(c.before)} tokens, now ${count(c.after)}` : ''
  if (full) out.push(...markdown(m.content.trim(), w - 2).map((l) => [seg('  '), ...l]))
  else out.push(...wrap([seg(`The agent works from a summary of what is above${was ? ` (${was})` : ''}. /summary shows it.`, 'muted')], w, [seg('  ⎿  ', 'muted')], [seg('     ')]))
  return out
}

/** A tool call's name and argument, as its header line shows it. */
export function toolTitle(call: ToolCall): [string, string] {
  switch (call.name) {
    case 'read_image_learnings': return ['Image learnings', s(call, 'task')]
    case 'save_image_learning': return ['Save image observation', s(call, 'task')]
    case 'save_image_profile': return ['Save style profile', s(call, 'name')]
    case 'generate_image':
      return call.arguments?.operation === 'refine' ? ['Refine image', s(call, 'prompt') || 'Inherited prompt'] : call.arguments?.operation === 'upscale' ? ['Upscale image', s(call, 'upscale_model')] : [call.arguments?.source_image_id ? 'Edit image' : 'Generate image', s(call, 'prompt')]
    case 'view_generated_image':
      return ['Inspect image', String(call.arguments?.image_id ?? 'latest in this thread')]
    case 'list_image_attachments': return ['Image attachments', 'Source images']
    case 'list_image_models':
      return ['Image models', 'ComfyUI']
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
    case 'notes_for_event':
      return ['Event Notes', '']
    case 'events_for_note':
      return ['Note Events', '']
    case 'link_note_to_event':
      return ['Link Note', '']
    case 'unlink_note_from_event':
      return ['Unlink Note', '']
    case 'make_meeting_note':
      return ['Meeting Note', '']
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
    case 'generate_image': {
      const image = generatedImage(result)
      if (image) {
        const url = new URL(image.url, location.origin).href
        if (image.settings?.operation === 'upscale') {
          const settings = image.settings
          return ok([under(`Upscaled image · ${image.width} × ${image.height}`), ...wrap([seg(`  Model: ${settings.upscale_model}\n  Source: ${settings.source.name} (${settings.source.width} × ${settings.source.height})\n  Model input: ${settings.input_width} × ${settings.input_height}\n  Settings: ${new URL(image.url + '/metadata', location.origin).href}`)], w), ...wrap([{ t: url, link: url }], w)])
        }
        const label = image.settings?.operation === 'refine' ? 'Refined image' : image.settings?.hires ? 'Generated image with hires refinement' : 'Generated image'
        const hires = image.settings?.hires
        const stages = hires ? `\n  Hires: ${hires.base_width} × ${hires.base_height} to ${hires.width} × ${hires.height} · strength ${hires.denoise} · ${hires.steps} steps · CFG ${hires.cfg} · ${hires.sampler}/${hires.scheduler} · seed ${hires.seed}${hires.upscale_model ? ` · ${hires.upscale_model}` : ''}` : ''
        return ok([under(`${label} · ${image.width} × ${image.height}${image.seed === undefined ? '' : ` · seed ${image.seed}`}`), ...(image.settings ? wrap([seg(`  ${image.settings.preset} · ${image.settings.steps} steps · CFG ${image.settings.cfg} · ${image.settings.sampler}/${image.settings.scheduler} · denoise ${image.settings.denoise}${image.settings.source ? `\n  Source: ${image.settings.source.name} (${new URL(image.settings.source.url, location.origin).href})` : ''}\n  Model: ${image.settings.model}\n  Encoder: ${image.settings.clip || 'checkpoint'} · VAE: ${image.settings.vae || 'checkpoint'}${image.settings.upscale_model ? `\n  Upscaler: ${image.settings.upscale_model}` : ''}${stages}\n  Settings: ${new URL(image.url + '/metadata', location.origin).href}`)], w) : []), ...wrap([{ t: url, link: url }], w, [seg('  ⎿  ', 'muted')], [seg('     ')])])
      }
      return ok([under(oneLine(result))])
    }
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
      const summary = typeof obj?.summary === 'string' ? obj.summary : typeof obj?.said === 'string' ? `You wrote instead: ${obj.said}` : obj?.skipped ? 'You closed the form' : ''
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
    case 'notes_for_event': {
      const list = Array.isArray(obj?.notes) ? (obj.notes as { title?: string }[]) : []
      return ok([under(`${list.length} note${list.length === 1 ? '' : 's'} on ${String((obj?.event as { title?: string } | undefined)?.title ?? 'the event')}`), ...list.slice(0, max).map((n) => clipLine([seg('     '), seg(n.title ?? '')], w)), ...more(list.length - max, verbose)])
    }
    case 'events_for_note': {
      const list = Array.isArray(obj?.events) ? (obj.events as { title?: string; when?: string; deleted?: boolean }[]) : []
      return ok([under(`${list.length} event${list.length === 1 ? '' : 's'}`), ...list.slice(0, max).map((e) => clipLine([seg('     '), seg(e.when ?? '', 'muted'), seg(`  ${e.title ?? ''}`), ...(e.deleted ? [seg('  deleted', 'red')] : [])], w)), ...more(list.length - max, verbose)])
    }
    case 'link_note_to_event':
    case 'unlink_note_from_event':
    case 'make_meeting_note': {
      const done = (obj?.linked ?? obj?.unlinked ?? obj?.linked_to) as { note?: string; event?: string; title?: string; when?: string } | undefined
      const made = obj?.note && typeof obj.note === 'object' ? (obj.note as { title?: string }).title : null
      const text = call.name === 'make_meeting_note' ? `Made “${made ?? 'a note'}” for ${done?.title ?? 'the event'}, ${done?.when ?? ''}` : `${call.name === 'link_note_to_event' ? 'Linked' : 'Unlinked'} “${done?.note ?? ''}” ${call.name === 'link_note_to_event' ? 'to' : 'from'} ${done?.event ?? ''}, ${done?.when ?? ''}`
      return ok([under(text)])
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
/** `detail`: what a running call reports about itself (an image job's step and percentage), instead of "Running…". */
export function runningLines(call: ToolCall, state: 'running' | 'approval' | 'question' | 'client', w: number, blink: boolean, detail?: string): Line[] {
  const text = state === 'approval' ? 'Waiting for you to allow it…' : state === 'question' ? 'Waiting for your answers…' : state === 'client' ? 'Running in this terminal…' : detail ?? 'Running…'
  return [header(call, blink ? 'muted' : 'bold', w), under(text)]
}
