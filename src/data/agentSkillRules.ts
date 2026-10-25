// Always-on skills and skill rules for the Agents app, shared by the window and the server (which
// imports it: it is in the Dockerfile's COPY list). Pure data and pure functions only: rules are
// conditions and an action, never code, and nothing here runs anything the user wrote.
//
// How a thread's always-on set is worked out (activeItems):
// 1. The skills marked "Always on" in Settings, when the place the thread runs in is ticked under
//    "Applies to" (Agents threads, Spotlight quick answers, the terminal's agents command).
// 2. The thread's project adds or removes skills on top of that.
// 3. Every rule whose conditions all match adds its skill or its instruction text.
// 4. What the user switched off in the thread itself (its chips) stays off.
// "Always on" is the simplest rule there is (every thread → this skill), kept as its own list so
// Settings can show it as a switch on each skill.

export type SkillSurface = 'threads' | 'quick' | 'terminal'
export const SURFACES: { id: SkillSurface; label: string }[] = [
  { id: 'threads', label: 'Agents threads' },
  { id: 'quick', label: 'Spotlight quick answers' },
  { id: 'terminal', label: 'Terminal agents command' },
]
type Mode = 'quick' | 'deep'
type Permission = 'default' | 'auto' | 'acceptEdits' | 'plan' | 'bypass'
const MODES: Mode[] = ['quick', 'deep']
const PERMISSIONS: Permission[] = ['default', 'auto', 'acceptEdits', 'plan', 'bypass']

/** What a rule waits for: every condition given must match (none given: every thread). */
export type RuleWhen = { project?: number; mode?: Mode; permission?: Permission; surface?: SkillSurface }
/** What it does: turns a skill on, or adds instruction text. Exactly one of the two. */
export type RuleThen = { skill: string } | { text: string }
export type SkillRule = { id: string; on: boolean; when: RuleWhen; then: RuleThen }
export type SkillConfig = {
  /** Skills that are always on, in this order */
  always: string[]
  /** Where always-on skills apply */
  scope: Record<SkillSurface, boolean>
  /** Per project (by id): skills added to, or taken from, the always-on ones in its threads */
  projects: Record<string, { on: string[]; off: string[] }>
  rules: SkillRule[]
}

/** How much always-on text goes into a system prompt at most, in bytes: what is past it is left out. */
export const ALWAYS_CAP = 24 * 1024
export const MAX_ALWAYS = 20
export const MAX_RULES = 20
export const MAX_RULE_TEXT = 2000
const MAX_PROJECTS = 100
/** What a thread may switch off in itself: skill names, and rule ids as rule:<id> */
export const MAX_THREAD_OFF = 60

const SKILL_NAME = /^[A-Za-z0-9][\w.-]{0,63}$/
const RULE_ID = /^[a-z0-9]{1,24}$/
export const isSkillName = (v: unknown): v is string => typeof v === 'string' && SKILL_NAME.test(v)
/** What a thread's chips switch off: a skill by its name, an instruction rule as rule:<id>. */
export const isOffKey = (v: unknown): v is string => typeof v === 'string' && (SKILL_NAME.test(v) || (v.startsWith('rule:') && RULE_ID.test(v.slice(5))))

export const emptyConfig = (): SkillConfig => ({ always: [], scope: { threads: true, quick: false, terminal: false }, projects: {}, rules: [] })

/**
 * Reads a config. Strict (a save from Settings): the first thing wrong is an error, so bad input is
 * refused, not half kept. Lenient (reading what is stored): what is wrong is left out.
 */
export function parseSkillConfig(raw: unknown, strict = false): { config: SkillConfig; error: string | null } {
  const config = emptyConfig()
  let error: string | null = null
  const bad = (why: string) => {
    error ??= why
  }
  const v = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : (raw === undefined || raw === null ? {} : (bad('Send the settings as an object'), {}))
  const names = (list: unknown, what: string): string[] => {
    if (list === undefined) return []
    if (!Array.isArray(list)) return bad(`${what} must be a list of skill names`), []
    const out: string[] = []
    for (const n of list) {
      if (!isSkillName(n)) bad(`${what}: ${JSON.stringify(n).slice(0, 70)} is not a skill name`)
      else if (!out.includes(n)) out.push(n)
    }
    if (out.length > MAX_ALWAYS) bad(`${what}: ${MAX_ALWAYS} skills at most`)
    return out.slice(0, MAX_ALWAYS)
  }
  config.always = names(v.always, 'Always on')
  if (v.scope !== undefined) {
    if (!v.scope || typeof v.scope !== 'object') bad('Applies to must be an object')
    else {
      const s = v.scope as Record<string, unknown>
      for (const { id } of SURFACES) {
        if (s[id] === undefined) continue
        if (typeof s[id] !== 'boolean') bad(`Applies to: ${id} must be true or false`)
        else config.scope[id] = s[id]
      }
    }
  }
  if (v.projects !== undefined) {
    if (!v.projects || typeof v.projects !== 'object' || Array.isArray(v.projects)) bad('Projects must be an object')
    else {
      const entries = Object.entries(v.projects as Record<string, unknown>)
      if (entries.length > MAX_PROJECTS) bad(`${MAX_PROJECTS} projects at most`)
      for (const [id, p] of entries.slice(0, MAX_PROJECTS)) {
        if (!/^[1-9]\d{0,9}$/.test(id)) {
          bad(`Project ${JSON.stringify(id).slice(0, 30)} is not a project id`)
          continue
        }
        if (!p || typeof p !== 'object') {
          bad(`Project ${id} must be an object`)
          continue
        }
        const on = names((p as { on?: unknown }).on, `Project ${id} on`)
        const off = names((p as { off?: unknown }).off, `Project ${id} off`).filter((n) => !on.includes(n))
        if (on.length || off.length) config.projects[id] = { on, off }
      }
    }
  }
  if (v.rules !== undefined) {
    if (!Array.isArray(v.rules)) bad('Rules must be a list')
    else {
      if (v.rules.length > MAX_RULES) bad(`${MAX_RULES} rules at most`)
      for (const r of v.rules.slice(0, MAX_RULES)) {
        const rule = parseRule(r)
        if (typeof rule === 'string') bad(rule)
        else if (config.rules.some((x) => x.id === rule.id)) bad(`Two rules have the id ${rule.id}`)
        else config.rules.push(rule)
      }
    }
  }
  return { config, error: strict ? error : null }
}

/** One rule, or what is wrong with it. */
function parseRule(r: unknown): SkillRule | string {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return 'A rule must be an object'
  const x = r as Record<string, unknown>
  if (typeof x.id !== 'string' || !RULE_ID.test(x.id)) return 'A rule needs an id (letters and digits, up to 24)'
  if (x.on !== undefined && typeof x.on !== 'boolean') return `Rule ${x.id}: on must be true or false`
  const w = x.when ?? {}
  if (!w || typeof w !== 'object' || Array.isArray(w)) return `Rule ${x.id}: when must be an object`
  const wv = w as Record<string, unknown>
  for (const k of Object.keys(wv)) if (!['project', 'mode', 'permission', 'surface'].includes(k)) return `Rule ${x.id}: unknown condition ${k.slice(0, 30)}`
  const when: RuleWhen = {}
  if (wv.project !== undefined && wv.project !== null) {
    if (!Number.isSafeInteger(wv.project) || (wv.project as number) < 1) return `Rule ${x.id}: project must be a project id`
    when.project = wv.project as number
  }
  if (wv.mode !== undefined && wv.mode !== null) {
    if (!MODES.includes(wv.mode as Mode)) return `Rule ${x.id}: mode must be quick or deep`
    when.mode = wv.mode as Mode
  }
  if (wv.permission !== undefined && wv.permission !== null) {
    if (!PERMISSIONS.includes(wv.permission as Permission)) return `Rule ${x.id}: permission must be one of ${PERMISSIONS.join(', ')}`
    when.permission = wv.permission as Permission
  }
  if (wv.surface !== undefined && wv.surface !== null) {
    if (!SURFACES.some((s) => s.id === wv.surface)) return `Rule ${x.id}: surface must be threads, quick or terminal`
    when.surface = wv.surface as SkillSurface
  }
  const t = x.then
  if (!t || typeof t !== 'object' || Array.isArray(t)) return `Rule ${x.id}: then must say a skill or a text`
  const tv = t as Record<string, unknown>
  const keys = Object.keys(tv)
  if (keys.length !== 1 || (keys[0] !== 'skill' && keys[0] !== 'text')) return `Rule ${x.id}: then is either {skill} or {text}`
  let then: RuleThen
  if (keys[0] === 'skill') {
    if (!isSkillName(tv.skill)) return `Rule ${x.id}: ${JSON.stringify(tv.skill).slice(0, 70)} is not a skill name`
    then = { skill: tv.skill }
  } else {
    if (typeof tv.text !== 'string' || !tv.text.trim()) return `Rule ${x.id}: the instruction is empty`
    if (tv.text.length > MAX_RULE_TEXT) return `Rule ${x.id}: the instruction is over ${MAX_RULE_TEXT} characters`
    then = { text: tv.text.trim() }
  }
  return { id: x.id, on: x.on !== false, when, then }
}

/** Where and how a thread runs, as the rules see it. */
export type ThreadFacts = { surface: SkillSurface; projectId: number | null; mode: Mode; permission: Permission; /** Switched off in the thread */ off: string[]; /** Skills switched off in Settings (not there for the agents at all) */ disabled: string[] }
/** One always-on item in a thread: a skill, or a rule's instruction text. `key` is what its chip switches off. */
export type ActiveItem = { key: string; kind: 'skill' | 'text'; name: string; text?: string; from: 'always' | 'project' | 'rule'; off: boolean }

export const ruleMatches = (r: SkillRule, t: ThreadFacts) =>
  r.on && (r.when.project === undefined || r.when.project === t.projectId) && (r.when.mode === undefined || r.when.mode === t.mode) && (r.when.permission === undefined || r.when.permission === t.permission) && (r.when.surface === undefined || r.when.surface === t.surface)

/** What is always on in a thread, in order, with what the thread switched off marked `off`. */
export function activeItems(config: SkillConfig, t: ThreadFacts): ActiveItem[] {
  const out: ActiveItem[] = []
  const add = (item: Omit<ActiveItem, 'off'>) => {
    if (out.some((x) => x.key === item.key)) return
    if (item.kind === 'skill' && t.disabled.includes(item.name)) return
    out.push({ ...item, off: t.off.includes(item.key) })
  }
  const project = t.projectId !== null ? config.projects[String(t.projectId)] : undefined
  if (config.scope[t.surface]) for (const name of config.always) if (!project?.off.includes(name)) add({ key: name, kind: 'skill', name, from: 'always' })
  for (const name of project?.on ?? []) add({ key: name, kind: 'skill', name, from: 'project' })
  for (const r of config.rules) {
    if (!ruleMatches(r, t)) continue
    if ('skill' in r.then) add({ key: r.then.skill, kind: 'skill', name: r.then.skill, from: 'rule' })
    else add({ key: `rule:${r.id}`, kind: 'text', name: ruleLabel(r.then.text), text: r.then.text, from: 'rule' })
  }
  return out
}

/** A short name for an instruction rule's chip: its first words. */
export const ruleLabel = (text: string) => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > 28 ? `${line.slice(0, 27).trimEnd()}…` : line
}

const bytes = (s: string) => new TextEncoder().encode(s).length

/**
 * The always-on part of a system prompt: each skill's whole SKILL.md and each instruction, in order,
 * until ALWAYS_CAP; what does not fit is left out (and named in `left`).
 */
export function alwaysOnPrompt(items: { kind: 'skill' | 'text'; name: string; text: string }[]): { text: string; used: string[]; left: string[]; bytes: number } {
  const used: string[] = []
  const left: string[] = []
  const parts: string[] = []
  let size = 0
  for (const it of items) {
    const part = it.kind === 'skill' ? `<active_skill name="${it.name}">\n${it.text.trim()}\n</active_skill>` : `<user_instruction>\n${it.text.trim()}\n</user_instruction>`
    const n = bytes(part)
    if (size + n > ALWAYS_CAP) {
      left.push(it.name)
      continue
    }
    size += n
    used.push(it.name)
    parts.push(part)
  }
  if (!parts.length) return { text: '', used, left, bytes: 0 }
  const head =
    'Always-on skills and instructions: the user turned these on for every conversation like this one. They are active now, not just available: follow each of them in every reply, for the whole conversation, without being asked again and without mentioning them. Only the user can turn one off: when they ask to stop one (for example "stop caveman" or "normal mode"), follow that skill\'s own rules for it. Your other instructions and the tools\' rules still come first where they conflict.'
  const text = [head, ...parts, left.length ? `(Left out for size: ${left.join(', ')}.)` : ''].filter(Boolean).join('\n\n')
  return { text, used, left, bytes: bytes(text) }
}
