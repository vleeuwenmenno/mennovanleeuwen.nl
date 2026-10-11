// Shell patterns: * ? [...] with \ escaping, for globbing, `case` and ${x#pattern}.

/** Whether a pattern has an unescaped wildcard. */
export function hasGlob(pat: string): boolean {
  for (let i = 0; i < pat.length; i++) {
    if (pat[i] === '\\') i++
    else if (pat[i] === '*' || pat[i] === '?') return true
    else if (pat[i] === '[' && pat.indexOf(']', i + 2) > 0) return true
  }
  return false
}

/** A pattern with its escapes taken out: what it means when nothing matched. */
export const unescapeGlob = (pat: string) => pat.replace(/\\(.)/g, '$1')

const CLASSES: Record<string, string> = {
  alpha: 'a-zA-Z',
  digit: '0-9',
  alnum: 'a-zA-Z0-9',
  upper: 'A-Z',
  lower: 'a-z',
  space: '\\s',
  blank: ' \\t',
  punct: '!-\\/:-@\\[-`{-~',
  xdigit: '0-9a-fA-F',
}

/** The regex source for a pattern; `greedy: false` makes * match as little as it can. */
export function globSource(pat: string, greedy = true): string {
  let re = ''
  for (let i = 0; i < pat.length; i++) {
    const ch = pat[i]
    if (ch === '\\' && i + 1 < pat.length) re += pat[++i].replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
    else if (ch === '*') re += greedy ? '[\\s\\S]*' : '[\\s\\S]*?'
    else if (ch === '?') re += '[\\s\\S]'
    else if (ch === '[') {
      const end = pat.indexOf(']', i + 2)
      if (end < 0) {
        re += '\\['
        continue
      }
      let body = pat.slice(i + 1, end)
      let neg = false
      if (body[0] === '!' || body[0] === '^') {
        neg = true
        body = body.slice(1)
      }
      const cls = body
        .replace(/\[:(\w+):\]/g, (m, name: string) => CLASSES[name] ?? m)
        .replace(/\\(?![sdwtnS])/g, '\\\\')
        .replace(/[\]^]/g, '\\$&')
      re += `[${neg ? '^' : ''}${cls}]`
      i = end
    } else re += ch.replace(/[.+^${}()|\]\\/]/g, '\\$&')
  }
  return re
}

/** Whether all of `text` matches the pattern. */
export function globMatch(pat: string, text: string): boolean {
  try {
    return new RegExp(`^${globSource(pat)}$`).test(text)
  } catch {
    return pat === text
  }
}
