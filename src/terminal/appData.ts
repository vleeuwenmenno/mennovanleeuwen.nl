import { TERMINAL_RESOURCES } from '../data/terminalResources'
import { boundedJson, type SafeJqBudget } from './jq-safe'
import { CmdError } from './types'

/** Explicit integration metadata: these commands access private account data, never pure data. */
export const APP_DATA_POLICY = Object.freeze({ command: 'mvl', agentDefault: 'deny', access: 'authenticated-network-read', resources: ['notes', 'calendar', 'background-tasks'] } as const)
export type AppDataGrant = { network?: boolean; appDataRead?: readonly string[] }
/** Resource grants must come from server approval, never command text or shell variables. */
export function appDataDenial(args: string[], grant: AppDataGrant): string | null {
  const resource = TERMINAL_RESOURCES.find(r => r.subcommand === args[0])?.id
  if (!resource) return 'mvl: unknown read-only resource'
  if (!Array.isArray(grant.appDataRead) || !grant.appDataRead.includes(resource)) return `mvl: explicit ${resource} read authorization required`
  return null
}
export type AppDataGet = (path: string, signal: AbortSignal) => Promise<unknown>
const usage = 'mvl notes | mvl calendar FROM TO | mvl tasks (dates: YYYY-MM-DD or ISO timestamp; end exclusive, maximum 366 days)'
const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
const list = (v: unknown): unknown[] => Array.isArray(v) ? v : []
const pick = (v: unknown, keys: string[]) => Object.fromEntries(keys.filter(k => Object.hasOwn(record(v), k)).map(k => [k, record(v)[k]]))

export async function readAppData(args: string[], signal: AbortSignal, get: AppDataGet, budget?: SafeJqBudget): Promise<string> {
  const check = () => { if (signal.aborted) throw new CmdError('mvl: cancelled', false, 130) }
  check()
  let path: string
  const kind = args[0]
  if (kind === 'notes' && args.length === 1) path = '/api/state'
  else if (kind === 'tasks' && args.length === 1) path = '/api/agents/tasks'
  else if (kind === 'calendar' && args.length === 3) {
    const dates = args.slice(1).map(s => /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/.test(s) ? new Date(s) : new Date(NaN))
    const [from, to] = dates
    if (dates.some((d, i) => !Number.isFinite(+d) || d.toISOString().slice(0, 10) !== args[i + 1].slice(0, 10)) || +to <= +from || +to - +from > 366 * 864e5) throw new CmdError(`mvl: invalid calendar range; ${usage}`, false, 2)
    path = `/api/calendar/events?${new URLSearchParams({ from: from.toISOString(), to: to.toISOString() })}`
  } else throw new CmdError(`mvl: ${usage}`, false, 2)
  let result: Record<string, unknown>
  try { result = record(await get(path, signal)) } catch (error) {
    check()
    throw new CmdError(`mvl: ${error instanceof Error ? error.message : 'request failed'}`)
  }
  check()
  await boundedJson(result, { signal, budget })
  check()
  const serialize = (value: unknown) => boundedJson(value, { signal, budget })
  if (kind === 'notes') return serialize({ notes: list(record(result.notes).value).filter(n => !record(n).deleted && !record(n).purged).map(n => pick(n, ['id', 'text', 'created', 'updated', 'events'])) })
  if (kind === 'calendar') return serialize({ events: list(result.events), errors: list(result.errors) })
  return serialize({ enabled: result.enabled === true, tasks: list(result.tasks).map(t => pick(t, ['id', 'title', 'status', 'createdAt', 'updatedAt', 'nextRunAt', 'lastRunAt', 'active', 'failures', 'stateNote'])) })
}
