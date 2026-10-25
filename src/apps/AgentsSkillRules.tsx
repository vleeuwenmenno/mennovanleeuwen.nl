import { useEffect, useState } from 'react'
import { listProjects, loadSkillConfig, saveSkillConfig, updateThread, useAgentSettings, useSkillConfig, type Mode, type Permission, type Project, type Skill, type Thread } from '../data/agents'
import { activeItems, ALWAYS_CAP, MAX_RULE_TEXT, MAX_RULES, ruleLabel, SURFACES, type RuleWhen, type SkillConfig, type SkillRule } from '../data/agentSkillRules'
import { Select } from '../os/Select'

// Always-on skills in the Agents app (src/data/agentSkillRules.ts): the chips in a thread's
// composer, and the parts of Settings → Agents → Skills that set them up (where they apply, per
// project, and rules).

const Toggle = ({ on, onChange, label, disabled }: { on: boolean; onChange: (on: boolean) => void; label: string; disabled?: boolean }) => (
  <button role="switch" aria-checked={on} aria-label={label} className={`set-toggle ${on ? 'is-on' : ''}`} disabled={disabled} onClick={() => onChange(!on)} />
)

const PERMISSION_NAME: Record<Permission, string> = { default: 'Ask first', auto: 'Auto', acceptEdits: 'Edits allowed', plan: 'Plan', bypass: 'Bypass' }
const MODE_NAME: Record<Mode, string> = { quick: 'Quick', deep: 'Deep research' }

/**
 * The always-on skills and instructions of a thread (or of the new thread being written), as a row
 * of chips over the message box: tapping one switches it off in this thread only, or back on.
 */
export function AlwaysChips({ thread, draft, onThread, onError }: { thread: Thread | null; draft: { projectId: number | null; mode: Mode; permission: Permission; off: string[]; setOff: (off: string[]) => void }; onThread: (t: Thread) => void; onError: (e: string) => void }) {
  const config = useSkillConfig()
  const settings = useAgentSettings()
  if (!config) return null
  const off = thread ? (thread.skillsOff ?? []) : draft.off
  const items = activeItems(config, {
    surface: thread?.quick ? 'quick' : 'threads',
    projectId: thread ? thread.projectId : draft.projectId,
    mode: thread?.mode ?? draft.mode,
    permission: thread?.permission ?? draft.permission,
    off,
    disabled: settings.skillsOff,
  })
  if (!items.length) return null
  const flip = (key: string) => {
    const next = off.includes(key) ? off.filter((k) => k !== key) : [...off, key]
    if (thread) updateThread(thread.id, { skillsOff: next }).then(onThread, (e: Error) => onError(e.message))
    else draft.setOff(next)
  }
  return (
    <div className="agt-always" role="group" aria-label="Always-on skills in this thread">
      {items.map((i) => (
        <button
          key={i.key}
          type="button"
          className={`agt-chip agt-always-chip ${i.off ? 'is-off' : 'is-on'}`}
          aria-pressed={!i.off}
          title={`${i.kind === 'skill' ? `The ${i.name} skill` : `Your instruction: ${i.text}`} is ${i.off ? 'off' : 'on'} in this thread${i.from === 'project' ? ' (from its project)' : i.from === 'rule' ? ' (from a rule)' : ''}. Tap to turn it ${i.off ? 'back on' : 'off'} here only.`}
          onClick={() => flip(i.key)}
        >
          <span className="agt-chip-label">{i.kind === 'skill' ? i.name : `“${i.name}”`}</span>
        </button>
      ))}
    </div>
  )
}

/** A project for the next Skills settings to show (the project menu's "Always-on skills…"). */
let pendingProject: number | null = null
export const showProjectSkills = (id: number) => void (pendingProject = id)

/** Bytes of the always-on skills Settings lists, against the cap. */
const alwaysBytes = (config: SkillConfig, skills: Skill[]) => config.always.reduce((n, name) => n + (skills.find((s) => s.name === name && s.enabled)?.size ?? 0), 0)

/** Saves a change to the config, saying why when the server refuses it. */
function useSave() {
  const [error, setError] = useState<string | null>(null)
  const save = (next: SkillConfig) => {
    setError(null)
    saveSkillConfig(next).catch((e: Error) => setError(e.message))
  }
  return { save, error }
}

/** The Always on switch for one skill in Settings' list. */
export function AlwaysToggle({ skill }: { skill: Skill }) {
  const config = useSkillConfig()
  const { save } = useSave()
  if (!config || !skill.enabled) return null
  const on = config.always.includes(skill.name)
  return (
    <label className="agt-always-switch" title="Put its whole SKILL.md in every thread’s instructions, so it is followed all the time">
      <span className="muted">Always on</span>
      <Toggle on={on} onChange={(v) => save({ ...config, always: v ? [...config.always, skill.name] : config.always.filter((n) => n !== skill.name) })} label={`Always use ${skill.name}`} />
    </label>
  )
}

/** Settings → Agents → Skills, under the list: where always-on skills apply, per project, rules. */
export function AlwaysOnSettings({ skills }: { skills: Skill[] | null }) {
  const config = useSkillConfig()
  const { save, error } = useSave()
  const [projects, setProjects] = useState<Project[]>([])
  const [project, setProject] = useState<number | null>(null)
  useEffect(() => {
    void loadSkillConfig(true).catch(() => {})
    listProjects().then(
      (list) => {
        setProjects(list)
        const wanted = pendingProject
        pendingProject = null
        setProject(list.some((p) => p.id === wanted) ? wanted : (list[0]?.id ?? null))
      },
      () => {},
    )
  }, [])
  if (!config || !skills) return null
  const usable = skills.filter((s) => s.enabled)
  const size = alwaysBytes(config, skills)
  const over = size > ALWAYS_CAP
  const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`
  const p = project !== null ? (config.projects[String(project)] ?? { on: [], off: [] }) : null
  const setProjectSkill = (name: string, how: 'default' | 'on' | 'off') => {
    if (project === null || !p) return
    const next = { on: p.on.filter((n) => n !== name), off: p.off.filter((n) => n !== name) }
    if (how === 'on') next.on.push(name)
    if (how === 'off') next.off.push(name)
    const projectsNext = { ...config.projects }
    if (next.on.length || next.off.length) projectsNext[String(project)] = next
    else delete projectsNext[String(project)]
    save({ ...config, projects: projectsNext })
  }
  const setRule = (id: string, patch: Partial<SkillRule>) => save({ ...config, rules: config.rules.map((r) => (r.id === id ? { ...r, ...patch } : r)) })
  const addRule = () => {
    const id = Math.random().toString(36).slice(2, 10) || 'rule'
    save({ ...config, rules: [...config.rules, { id, on: true, when: {}, then: usable[0] ? { skill: usable[0].name } : { text: 'Answer in English.' } }] })
  }
  return (
    <>
      <h4 className="set-subhead">Always on</h4>
      <p className="muted set-help">
        A skill that is always on is followed in every reply, not just when a task calls for it: its whole SKILL.md goes into the thread’s instructions. In a thread, its chip over the message box turns it off there only. Saying “stop caveman” (or whatever the skill says) works too.
      </p>
      <ul className="set-list">
        <li className="set-row set-row-stack">
          <span className="set-row-text">
            <strong>Applies to</strong>
            <span className="muted">{config.always.length ? `${config.always.join(', ')} · ${kb(size)} of ${kb(ALWAYS_CAP)}` : 'No skill is always on yet: switch one on in the list above'}</span>
          </span>
          <span className="agt-always-scope">
            {SURFACES.map((s) => (
              <label key={s.id} className="set-check">
                <input type="checkbox" checked={config.scope[s.id]} onChange={(e) => save({ ...config, scope: { ...config.scope, [s.id]: e.target.checked } })} />
                {s.label}
              </label>
            ))}
          </span>
        </li>
      </ul>
      {over && (
        <p className="t-yellow set-help" role="status">
          The always-on skills come to {kb(size)}, over the {kb(ALWAYS_CAP)} a thread takes: the last ones are left out until you switch some off. Each one also takes room in the model’s context window (Context, in a thread, shows how much).
        </p>
      )}

      <h4 className="set-subhead">Per project</h4>
      {projects.length ? (
        <ul className="set-list">
          <li className="set-row">
            <span className="set-row-text">
              <strong>Project</strong>
              <span className="muted">Turn skills on or off for the threads in one project</span>
            </span>
            <Select className="set-select" value={project} onChange={(v) => setProject(v)} aria-label="Project" options={projects.map((x) => ({ value: x.id, label: x.name }))} />
          </li>
          {p &&
            usable.map((s) => {
              const how = p.on.includes(s.name) ? 'on' : p.off.includes(s.name) ? 'off' : 'default'
              const usual = config.always.includes(s.name) && config.scope.threads
              return (
                <li key={s.name} className="set-row">
                  <span className="set-row-text">
                    <strong>{s.name}</strong>
                    <span className="muted">{how === 'default' ? (usual ? 'On, like everywhere' : 'Off, like everywhere') : how === 'on' ? 'Always on in this project' : 'Off in this project'}</span>
                  </span>
                  <Select
                    className="set-select"
                    value={how}
                    onChange={(v) => setProjectSkill(s.name, v)}
                    aria-label={`${s.name} in this project`}
                    options={[
                      { value: 'default' as const, label: `As everywhere (${usual ? 'on' : 'off'})` },
                      { value: 'on' as const, label: 'Always on here' },
                      { value: 'off' as const, label: 'Off here' },
                    ]}
                  />
                </li>
              )
            })}
        </ul>
      ) : (
        <p className="muted set-help">No projects yet. Make one in the Agents sidebar to give its threads skills of their own.</p>
      )}

      <h4 className="set-subhead">Rules</h4>
      <p className="muted set-help">When a thread matches, a rule turns a skill on or adds an instruction of yours, checked again on every message (so switching a thread to Plan, say, brings a Plan rule in). Rules are settings, not scripts: nothing runs.</p>
      <ul className="set-list">
        {config.rules.map((r) => (
          <RuleRow key={r.id} rule={r} skills={usable} projects={projects} onChange={(patch) => setRule(r.id, patch)} onRemove={() => save({ ...config, rules: config.rules.filter((x) => x.id !== r.id) })} />
        ))}
        {!config.rules.length && (
          <li className="set-row">
            <span className="set-row-text muted">None yet. For example: when the mode is Deep research, turn on a report-writing skill; in a work project, add “Answer in Dutch”.</span>
          </li>
        )}
      </ul>
      <div className="agt-rule-add">
        <button className="btn btn-small" onClick={addRule} disabled={config.rules.length >= MAX_RULES}>
          Add a rule
        </button>
      </div>
      {error && <p className="t-red copyable">{error}</p>}
    </>
  )
}

/** One condition per rule in this editor (the stored rule can hold several; all must match). */
type WhenKey = 'any' | `project:${number}` | `mode:${Mode}` | `permission:${Permission}` | `surface:${string}`
const whenKey = (w: RuleWhen): WhenKey => (w.project !== undefined ? `project:${w.project}` : w.mode ? `mode:${w.mode}` : w.permission ? `permission:${w.permission}` : w.surface ? `surface:${w.surface}` : 'any')
const whenOf = (k: WhenKey): RuleWhen => {
  const [kind, v] = k.split(':')
  if (kind === 'project') return { project: Number(v) }
  if (kind === 'mode') return { mode: v as Mode }
  if (kind === 'permission') return { permission: v as Permission }
  if (kind === 'surface') return { surface: v as RuleWhen['surface'] }
  return {}
}

function RuleRow({ rule, skills, projects, onChange, onRemove }: { rule: SkillRule; skills: Skill[]; projects: Project[]; onChange: (patch: Partial<SkillRule>) => void; onRemove: () => void }) {
  const isText = 'text' in rule.then
  const [text, setText] = useState('text' in rule.then ? rule.then.text : '')
  useEffect(() => setText('text' in rule.then ? rule.then.text : ''), [rule.then])
  const several = Object.keys(rule.when).length > 1
  const whenOptions: { value: WhenKey; label: string }[] = [
    { value: 'any', label: 'Every thread' },
    ...projects.map((p) => ({ value: `project:${p.id}` as WhenKey, label: `In project ${p.name}` })),
    ...(['quick', 'deep'] as Mode[]).map((m) => ({ value: `mode:${m}` as WhenKey, label: `Mode is ${MODE_NAME[m]}` })),
    ...(Object.keys(PERMISSION_NAME) as Permission[]).map((m) => ({ value: `permission:${m}` as WhenKey, label: `Permission is ${PERMISSION_NAME[m]}` })),
    ...SURFACES.map((s) => ({ value: `surface:${s.id}` as WhenKey, label: `In ${s.label}` })),
  ]
  const thenValue = 'skill' in rule.then ? `skill:${rule.then.skill}` : 'text'
  const thenOptions = [...skills.map((s) => ({ value: `skill:${s.name}`, label: `Turn on ${s.name}` })), ...('skill' in rule.then && !skills.some((s) => s.name === (rule.then as { skill: string }).skill) ? [{ value: thenValue, label: `Turn on ${rule.then.skill} (not found)` }] : []), { value: 'text', label: 'Add an instruction' }]
  return (
    <li className={`set-row set-row-stack agt-rule ${rule.on ? '' : 'is-off'}`}>
      <span className="agt-rule-line">
        <span className="muted">When</span>
        {several ? (
          <span className="muted">several conditions</span>
        ) : (
          <Select className="set-select" value={whenKey(rule.when)} onChange={(k) => onChange({ when: whenOf(k) })} aria-label="When" options={whenOptions} />
        )}
        <span className="muted">→</span>
        <Select className="set-select" value={thenValue} onChange={(v) => onChange({ then: v === 'text' ? { text: text.trim() || 'Answer in English.' } : { skill: v.slice(6) } })} aria-label="Then" options={thenOptions} />
        <span className="nb-spacer" />
        <Toggle on={rule.on} onChange={(on) => onChange({ on })} label={rule.on ? 'Rule on' : 'Rule off'} />
        <button className="btn btn-small" onClick={onRemove} aria-label="Remove this rule">
          Remove
        </button>
      </span>
      {isText && (
        <textarea
          className="agt-rule-text"
          value={text}
          maxLength={MAX_RULE_TEXT}
          rows={2}
          aria-label="Instruction"
          placeholder="An instruction for the agent, like: Answer in Dutch."
          onChange={(e) => setText(e.target.value)}
          onBlur={() => text.trim() && text.trim() !== ('text' in rule.then ? rule.then.text : '') && onChange({ then: { text: text.trim() } })}
        />
      )}
      {isText && <span className="muted set-help">Its chip in a thread reads “{ruleLabel(text || '…')}”.</span>}
    </li>
  )
}
