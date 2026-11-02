// Checks that the Agents Tools menu's categories (TOOL_CATEGORIES) file every tool group exactly once.
//
//   node scripts/agents-tool-categories.ts
//
// Exits 1 on any failure.

import { readFileSync } from 'node:fs'

// src/data/agents.ts has extensionless imports node cannot load, so its two tables are read as text.
const src = readFileSync(new URL('../src/data/agents.ts', import.meta.url), 'utf8')
const block = (start: string) => src.slice(src.indexOf(start), src.indexOf('\n]\n', src.indexOf(start)))
const ids = [...block('export const TOOL_GROUPS').matchAll(/\{ id: '(\w+)', name:/g)].map((m) => m[1])
const TOOL_CATEGORIES = [...block('export const TOOL_CATEGORIES').matchAll(/\{ name: '([^']+)', groups: \[([^\]]*)\] \}/g)].map((m) => ({ name: m[1], groups: [...m[2].matchAll(/'(\w+)'/g)].map((g) => g[1]) }))
const filed = TOOL_CATEGORIES.flatMap((c) => c.groups)
if (!ids.length || !filed.length) { console.error('FAIL could not read the tables'); process.exit(1) }
const missing = ids.filter((id) => !filed.includes(id))
const unknown = filed.filter((id) => !ids.includes(id))
const twice = filed.filter((id, i) => filed.indexOf(id) !== i)
const empty = TOOL_CATEGORIES.filter((c) => !c.groups.length).map((c) => c.name)
const problems = [
  ...missing.map((id) => `${id} is in no category`),
  ...unknown.map((id) => `${id} is not a tool group`),
  ...twice.map((id) => `${id} is in two categories`),
  ...empty.map((n) => `category ${n} is empty`),
]
if (problems.length) {
  for (const p of problems) console.error(`FAIL ${p}`)
  process.exit(1)
}
console.log(`ok: ${ids.length} tool groups in ${TOOL_CATEGORIES.length} categories`)
