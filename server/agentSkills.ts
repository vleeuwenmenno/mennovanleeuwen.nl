import type { User } from './auth.ts'
import { HttpError } from './http.ts'
import { readState, writeState } from './state.ts'
import { parseSkillConfig, type SkillConfig } from '../src/data/agentSkillRules.ts'

// Always-on skills and skill rules (src/data/agentSkillRules.ts), kept with the account's synced
// state under their own key. Settings saves them through PUT /api/agents/skill-config, which
// refuses anything that does not validate; reading drops whatever is wrong, so a copy written
// some other way can never put more than the rules allow into a prompt.

const KEY = 'agentskills'

export function skillConfig(user: User): SkillConfig {
  return parseSkillConfig(readState(user)[KEY]?.value).config
}

export function saveSkillConfig(user: User, body: unknown): SkillConfig {
  const { config, error } = parseSkillConfig(body, true)
  if (error) throw new HttpError(400, error)
  writeState(user, KEY, { value: config })
  return config
}
