/** Grep's executable parser, shared by dispatch policy and filesystem preparation. A dash word
 * is an option only when it is a letter cluster; -- ends option parsing. All other words,
 * including -(a+)+$, are positional operands. */
export function parseGrepArgs(args: string[]) {
  const flags = new Set<string>()
  const rest: string[] = []
  let options = true
  for (const arg of args) {
    if (options && arg === '--') options = false
    else if (options && /^-[a-zA-Z]+$/.test(arg)) for (const flag of arg.slice(1)) flags.add(flag)
    else rest.push(arg)
  }
  const [pattern, ...files] = rest
  return { has: (flag: string) => flags.has(flag), pattern, files }
}

export function agentGrepRefusal(parsed: ReturnType<typeof parseGrepArgs>): string | null {
  if ((parsed.pattern?.length ?? 0) > 4096) return 'grep: agent patterns are limited to 4096 characters'
  if (!parsed.has('F') && /[.*+?^${}()|[\]\\]/.test(parsed.pattern ?? '')) return 'grep: agents use -F for patterns containing regex metacharacters (uninterruptible regex evaluation is unavailable)'
  if (parsed.has('r') || parsed.has('R')) return 'grep: recursive agent searches are unavailable; search individual files'
  return null
}
