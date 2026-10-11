import { agentSettings, setAgentSettings } from './agents'
import { whereIs } from './mounts'
import { parseSf } from './seafile'
import { HOME } from '../terminal/vfs'

// Where the agents' files are in Seafile, worked out from /etc/fstab (only the browser has the
// mount table) and kept in the synced settings for the server: ~/AGENTS.md, the system prompt, and
// ~/.agents/skills, the user's skills folder. Null where home is not on Seafile.

/** Where a terminal path is in Seafile: library and path, or null (not on Seafile, or not known yet). */
export function seafileAt(abs: string): { repo: string; path: string } | null | undefined {
  const w = whereIs(abs)
  if (w.kind === 'missing' && w.loading) return undefined
  const at = w.kind === 'sf' ? parseSf(w.sf) : null
  return at ? { repo: at.repo, path: at.p } : null
}

/** Tells the server where ~/AGENTS.md and ~/.agents/skills are, when that changed. */
export function syncAgentPlaces() {
  const prompt = seafileAt(`${HOME}/AGENTS.md`)
  const skills = seafileAt(`${HOME}/.agents/skills`)
  if (prompt === undefined || skills === undefined) return
  const skillsFolder = skills ? { ...skills, label: '~/.agents/skills' } : null
  const now = agentSettings()
  if (JSON.stringify(prompt) !== JSON.stringify(now.promptFile)) setAgentSettings({ promptFile: prompt })
  if (JSON.stringify(skillsFolder) !== JSON.stringify(now.skillsFolder)) setAgentSettings({ skillsFolder })
}
