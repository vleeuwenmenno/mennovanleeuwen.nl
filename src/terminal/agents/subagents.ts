import { getThread, listSubagents, messageSubagent, stopSubagent, type AgentMessage, type Thread } from '../../data/agents'
import { findSubagent, overviewLine, parseSubagentsCommand, shortCount, shortDuration, SUBAGENT_STATUS_LABEL, type SubagentInfo } from '../../data/agentSubagents'
import { clipLine, seg, wrap, type Line } from './text'

// /subagents in the agents command: the helpers this thread's agent started (server/agents.ts), as
// lines, and messages to them; their cards come in on the thread's own stream (app.ts). The same
// API as the Agents app's Subagents strip; a subagent may be named by its id, a unique start of it
// (as listed) or its name.

export const SUBAGENTS_HELP = '/subagents [list] | show <id> | msg <id> <text> | stop <id>'

const tone = (s: SubagentInfo) => (s.status === 'idle' ? 'green' : s.status === 'failed' ? 'red' : s.status === 'running' ? 'accent' : 'muted')

/** A subagent's message in a thread: its result in its parent's (data, marked), or its parent agent's message in its own. */
export function subagentLines(m: AgentMessage, cols: number): Line[] {
  if (m.role === 'agent') return [[seg('▍ From the parent agent', 'magenta')], ...m.content.split('\n').flatMap((l) => wrap([seg(l)], cols, [seg('▍ ', 'magenta')]))]
  const meta = m.meta?.kind === 'subagent' ? m.meta : null
  const body = m.content.replace(/^Subagent "[^"]*" \(id [0-9a-f]+\): [^\n]*\n\n/, '')
  return [
    [seg(`▍ Subagent “${meta?.name ?? 'subagent'}”`, 'magenta'), seg(meta ? ` · ${overviewLine(meta)}` : ' · its result, as data', 'muted')],
    ...body.split('\n').slice(0, 40).flatMap((l) => wrap([seg(l)], cols, [seg('▍ ', 'magenta')])),
    ...(body.split('\n').length > 40 ? [[seg('▍ … /subagents show for the rest', 'muted')]] : []),
  ]
}

function listLines(list: SubagentInfo[], cols: number): Line[] {
  if (!list.length) return [[seg('No subagents in this thread yet: the agent starts them itself (spawn_agent) when parts of a job can run side by side.', 'muted')], []]
  const out: Line[] = [[seg('Subagents', 'bold'), seg(` · ${list.filter((s) => s.status === 'running').length} working · ${SUBAGENTS_HELP}`, 'muted')]]
  for (const s of list.slice(-20)) {
    out.push(clipLine([seg(`  ${s.id.slice(0, 8)} `, 'muted'), seg(`${SUBAGENT_STATUS_LABEL[s.status].padEnd(11)}`, tone(s)), seg(s.name, 'bold'), seg(` · ${shortCount(s.tokensIn + s.tokensOut)} tokens · ${s.toolCalls} calls · ${shortDuration(s.activeMs)}`, 'muted')], cols))
    const last = (s.lastOutput ?? s.instruction).replace(/\s+/g, ' ').trim()
    if (last) out.push(clipLine([seg(`           ${last}`, 'muted')], cols))
  }
  return [...out, []]
}

async function showLines(s: SubagentInfo, cols: number): Promise<Line[]> {
  const out: Line[] = [
    [seg(`Subagent “${s.name}”`, 'bold'), seg(` · ${s.id}`, 'muted')],
    [seg(`  ${SUBAGENT_STATUS_LABEL[s.status]}`, tone(s)), seg(` · ${s.model} · ${s.permission} · tools: ${s.tools.join(', ') || 'none'}${s.writeFiles ? ' · may change files' : ''}`, 'muted')],
    [seg(`  ${shortCount(s.tokensIn + s.tokensOut)} tokens · ${s.toolCalls} tool calls · ${shortDuration(s.activeMs)}`, 'muted')],
    [],
    [seg('Asked', 'bold')],
    ...s.instruction.split('\n').slice(0, 12).flatMap((l) => wrap([seg(l)], cols, [seg('  ')])),
  ]
  const { messages } = await getThread(s.id)
  const steps = messages.filter((m) => m.role === 'assistant').flatMap((m) => m.toolCalls ?? []).map((c) => c.name)
  if (steps.length) out.push([], [seg('Did', 'bold'), seg(` ${steps.length} tool calls: ${[...new Set(steps)].join(', ')}`, 'muted')])
  if (s.lastOutput) out.push([], [seg('Last answer', 'bold')], ...s.lastOutput.split('\n').slice(0, 30).flatMap((l) => wrap([seg(l)], cols, [seg('  ')])))
  if (s.error) out.push([], [seg(`Error: ${s.error}`, 'red')])
  return [...out, []]
}

/** Runs a /subagents line against a thread: list, show, msg or stop. */
export async function subagentsCommand(thread: Thread, line: string, cols: number): Promise<Line[]> {
  const cmd = parseSubagentsCommand(line)
  if (cmd.op === 'error') throw new Error(cmd.error)
  const { subagents } = await listSubagents(thread.id)
  if (cmd.op === 'list') return listLines(subagents, cols)
  const hit = findSubagent(subagents, cmd.ref)
  if (typeof hit === 'string') throw new Error(hit)
  if (cmd.op === 'show') return showLines(hit, cols)
  if (cmd.op === 'stop') {
    await stopSubagent(thread.id, hit.id)
    return [[seg(`Stopping “${hit.name}”: what it finished stays, and the agent gets its overview.`, 'muted')], []]
  }
  const r = await messageSubagent(thread.id, hit.id, cmd.text)
  return [[seg(`To “${hit.name}”: `, 'muted'), seg(cmd.text)], [seg(`  ${r.note}`, 'muted')], []]
}
