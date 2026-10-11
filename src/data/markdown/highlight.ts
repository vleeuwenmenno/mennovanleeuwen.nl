// Syntax highlighting for fenced code blocks in MarkdownPreview: a compact tokenizer, not a
// grammar. Each language is a short list of rules (comments, strings, numbers, keywords, ...)
// joined into one regular expression, so a block is coloured in a single linear pass, cheap
// enough to run again on every streamed chunk. The token classes are styled with the theme's
// colours in styles.css (.hl-*). A language it does not know comes back as one plain token.

export type Token = { text: string; cls?: string }

type Rule = [cls: string, re: RegExp]

const words = (s: string) => new RegExp(`\\b(?:${s.trim().split(/\s+/).join('|')})\\b`)

// Pieces several languages share.
const DQ = /"(?:[^"\\\n]|\\.)*"?/
const SQ = /'(?:[^'\\\n]|\\.)*'?/
const BT = /`(?:[^`\\]|\\.)*`?/
const SLASH_COMMENT = /\/\/.*/
// Comments and strings that may span lines run to the end of the code when left open (while a
// block streams in); (?![\s\S]) is the end of the input, as $ is the end of a line here.
const BLOCK_COMMENT = /\/\*[\s\S]*?(?:\*\/|(?![\s\S]))/
const HASH_COMMENT = /#.*/
const NUMBER = /\b(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)(?:n|u8|u16|u32|u64|usize|i32|i64|f32|f64)?\b/
const CALL = /\b[A-Za-z_$][\w$]*(?=\s*\()/
const TYPE = /\b[A-Z][A-Za-z0-9_]*\b/

const JS_KEYWORDS = words(`
  as async await break case catch class const continue debugger default delete do else enum export extends
  finally for from function get if implements import in instanceof interface let new of package private
  protected public readonly return satisfies set static super switch this throw try type typeof var void
  while with yield keyof declare namespace abstract override infer is asserts unique`)
const JS_LITERALS = words('true false null undefined NaN Infinity')
const JS: Rule[] = [
  ['com', SLASH_COMMENT],
  ['com', BLOCK_COMMENT],
  ['str', BT],
  ['str', DQ],
  ['str', SQ],
  ['kw', JS_KEYWORDS],
  ['lit', JS_LITERALS],
  ['num', NUMBER],
  ['fn', CALL],
  ['type', TYPE],
]
// JSX and TSX add tag names, so <Button> and </div> read as tags.
const JSX: Rule[] = [...JS.slice(0, 5), ['tag', /(?<=<\/?)[A-Za-z][\w.]*(?=[\s/>])/], ...JS.slice(5)]

const JSON_RULES: Rule[] = [
  ['attr', /"(?:[^"\\\n]|\\.)*"(?=\s*:)/],
  ['str', DQ],
  ['lit', words('true false null')],
  ['num', /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/],
  ['com', SLASH_COMMENT],
]

const PYTHON: Rule[] = [
  ['com', HASH_COMMENT],
  ['str', /[rRbBfFuU]{0,2}(?:"""[\s\S]*?(?:"""|(?![\s\S]))|'''[\s\S]*?(?:'''|(?![\s\S])))/],
  ['str', /[rRbBfFuU]{0,2}(?:"(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?)/],
  ['meta', /@[\w.]+/],
  ['kw', words('and as assert async await break class continue def del elif else except finally for from global if import in is lambda match case nonlocal not or pass raise return try while with yield')],
  ['lit', words('True False None self cls')],
  ['num', NUMBER],
  ['fn', CALL],
  ['type', TYPE],
]

const GO: Rule[] = [
  ['com', SLASH_COMMENT],
  ['com', BLOCK_COMMENT],
  ['str', BT],
  ['str', DQ],
  ['str', SQ],
  ['kw', words('break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var')],
  ['lit', words('true false nil iota')],
  ['type', words('bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr any')],
  ['num', NUMBER],
  ['fn', CALL],
  ['type', TYPE],
]

const RUST: Rule[] = [
  ['com', SLASH_COMMENT],
  ['com', BLOCK_COMMENT],
  ['str', /b?r#*"[\s\S]*?(?:"#*|(?![\s\S]))/],
  ['str', DQ],
  // A char literal ('a', '\n'), not a lifetime ('a).
  ['str', /'(?:[^'\\\n]|\\.[^']*)'/],
  ['meta', /#!?\[[^\]\n]*\]?/],
  ['meta', /'[a-z_]\w*/],
  ['kw', words('as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return Self self static struct super trait type unsafe use where while')],
  ['lit', words('true false None Some Ok Err')],
  ['fn', /\b[a-z_]\w*!/],
  ['num', NUMBER],
  ['fn', CALL],
  ['type', TYPE],
]

const C_LIKE: Rule[] = [
  ['com', SLASH_COMMENT],
  ['com', BLOCK_COMMENT],
  ['meta', /^[ \t]*#[ \t]*\w+/m],
  ['str', DQ],
  ['str', SQ],
  ['kw', words(`
    abstract auto break case catch char class const continue default delete do double else enum extern final
    float for friend goto if import inline int long namespace new override package private protected public
    register return short signed sizeof static struct super switch template this throw try typedef typename
    union unsigned using virtual void volatile while boolean byte extends implements instanceof interface
    var val fun when object is in out internal suspend data sealed open lateinit companion init`)],
  ['lit', words('true false null nullptr NULL')],
  ['num', NUMBER],
  ['fn', CALL],
  ['type', TYPE],
]

const SHELL: Rule[] = [
  // A # starts a comment only at the start of a word ("a#b" is not one).
  ['com', /(?<![^\s;|&(])#.*/],
  ['str', /"(?:[^"\\]|\\.)*"?/],
  ['str', /'[^']*'?/],
  ['var', /\$(?:\{[^}\n]*\}?|\(|[\w@#?$!*-]+)/],
  ['kw', words('if then else elif fi for while until do done case esac in function return local export set unset end begin switch not and or source alias exit break continue')],
  // A command's flags: -x, --long-flag.
  ['attr', /(?<=\s)--?[A-Za-z][\w-]*/],
  // The command at the start of a line, or after a pipe or ;, and a prompt's $.
  ['fn', /(?<=^[ \t]*(?:\$ )?|[|;&][ \t]*|\b(?:sudo|then|do|else)[ \t]+)[A-Za-z_.][\w.-]*/m],
  ['num', /\b\d+\b/],
]

const CSS: Rule[] = [
  ['com', BLOCK_COMMENT],
  ['str', DQ],
  ['str', SQ],
  ['kw', /@[\w-]+/],
  ['attr', /(?<=[{;\s])-{0,2}[a-zA-Z][\w-]*(?=\s*:(?!:))/],
  ['num', /#[\da-fA-F]{3,8}\b|-?\b\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|vmin|vmax|s|ms|deg|fr|ch|ex|pt)?\b/],
  ['fn', /\b[\w-]+(?=\()/],
  ['tag', /[.#][A-Za-z_-][\w-]*|::?[\w-]+/],
  ['lit', words('important inherit initial unset none auto')],
]

const HTML: Rule[] = [
  ['com', /<!--[\s\S]*?(?:-->|(?![\s\S]))/],
  ['meta', /<![A-Za-z][^>]*>?/],
  ['tag', /<\/?[A-Za-z][\w:-]*|\/?>/],
  ['attr', /\b[A-Za-z_:][\w:.-]*(?==)/],
  ['str', DQ],
  ['str', SQ],
  ['lit', /&[#\w]+;/],
]

const YAML: Rule[] = [
  ['com', /(?<![^\s])#.*/],
  ['meta', /^---$|^\.\.\.$/m],
  ['attr', /(?<=^[ \t]*(?:- )?)[^\s#:'"][^:#\n]*(?=:(?:\s|$))/m],
  ['str', DQ],
  ['str', SQ],
  ['lit', words('true false null yes no on off')],
  ['num', /(?<=[\s:[,-])-?\d+(?:\.\d+)?\b/],
  ['meta', /[&*][\w-]+|![\w!]+/],
]

const TOML: Rule[] = [
  ['com', HASH_COMMENT],
  ['type', /^[ \t]*\[\[?[^\]\n]*\]\]?/m],
  ['str', /"""[\s\S]*?(?:"""|(?![\s\S]))|'''[\s\S]*?(?:'''|(?![\s\S]))/],
  ['str', DQ],
  ['str', SQ],
  ['attr', /^[ \t]*[\w.-]+(?=[ \t]*=)/m],
  ['lit', words('true false')],
  ['num', /\b\d[\d_:.TZ+-]*\b/],
]

const SQL_RULES: Rule[] = [
  ['com', /--.*/],
  ['com', BLOCK_COMMENT],
  ['str', SQ],
  ['str', DQ],
  ['kw', words(`
    select from where and or not insert into values update set delete create table drop alter add column
    index primary key foreign references join left right inner outer full cross on as group by order having
    limit offset union all distinct case when then else end is null like in between exists returning with
    default unique check constraint view begin commit rollback transaction asc desc if replace cascade`)],
  ['type', words('int integer bigint smallint text varchar char boolean bool date timestamp timestamptz json jsonb uuid serial real float double numeric decimal blob')],
  ['num', NUMBER],
  ['fn', CALL],
]

const DIFF: Rule[] = [
  ['meta', /^(?:diff|index|---|\+\+\+) .*$/m],
  ['fn', /^@@.*$/m],
  ['add', /^\+.*$/m],
  ['del', /^-.*$/m],
]

const MARKDOWN: Rule[] = [
  ['str', /^[ \t]*(?:```|~~~).*$/m],
  ['kw', /^#{1,6}[ \t].*$/m],
  ['com', /^[ \t]*>.*$/m],
  ['tag', /^[ \t]*(?:[-*+]|\d+[.)])(?=[ \t])/m],
  ['str', /`[^`\n]+`/],
  ['type', /\*\*[^*\n]+\*\*|__[^_\n]+__/],
  ['meta', /\*[^*\s][^*\n]*\*|\b_[^_\s][^_\n]*_\b/],
  ['fn', /!?\[[^\]\n]*\]\([^)\n]*\)/],
]

const INI: Rule[] = [
  ['com', /^[ \t]*[;#].*/m],
  ['type', /^[ \t]*\[[^\]\n]*\]/m],
  ['attr', /^[ \t]*[\w.-]+(?=[ \t]*=)/m],
  ['str', DQ],
  ['num', /\b\d+(?:\.\d+)?\b/],
]

const DOCKERFILE: Rule[] = [
  ['com', HASH_COMMENT],
  ['kw', /^[ \t]*(?:FROM|RUN|CMD|LABEL|EXPOSE|ENV|ADD|COPY|ENTRYPOINT|VOLUME|USER|WORKDIR|ARG|ONBUILD|STOPSIGNAL|HEALTHCHECK|SHELL|AS)\b/],
  ['str', DQ],
  ['str', SQ],
  ['var', /\$(?:\{[^}\n]*\}|\w+)/],
]

const LANGS: Record<string, Rule[]> = {
  js: JS, javascript: JS, jsx: JSX, mjs: JS, cjs: JS, ts: JS, typescript: JS, tsx: JSX, mts: JS,
  json: JSON_RULES, jsonc: JSON_RULES, json5: JSON_RULES,
  py: PYTHON, python: PYTHON, python3: PYTHON,
  go: GO, golang: GO,
  rs: RUST, rust: RUST,
  c: C_LIKE, h: C_LIKE, cpp: C_LIKE, 'c++': C_LIKE, cc: C_LIKE, hpp: C_LIKE, java: C_LIKE, kotlin: C_LIKE, kt: C_LIKE,
  cs: C_LIKE, csharp: C_LIKE, swift: C_LIKE, dart: C_LIKE, php: C_LIKE, scala: C_LIKE,
  sh: SHELL, bash: SHELL, zsh: SHELL, fish: SHELL, shell: SHELL, console: SHELL, terminal: SHELL, msh: SHELL, ps1: SHELL, powershell: SHELL,
  css: CSS, scss: CSS, less: CSS,
  html: HTML, xml: HTML, svg: HTML, vue: HTML, svelte: HTML,
  yaml: YAML, yml: YAML,
  toml: TOML,
  ini: INI, conf: INI, cfg: INI, env: INI, dotenv: INI,
  sql: SQL_RULES, postgres: SQL_RULES, postgresql: SQL_RULES, sqlite: SQL_RULES, mysql: SQL_RULES,
  diff: DIFF, patch: DIFF,
  md: MARKDOWN, markdown: MARKDOWN,
  dockerfile: DOCKERFILE, docker: DOCKERFILE,
}

/** SQL keywords and Dockerfile instructions are written in either case; the rest is case-sensitive. */
const IGNORE_CASE = new Set([SQL_RULES, DOCKERFILE])

// Each language's rules joined into one expression with a named group per rule, built on first use.
const compiled = new Map<Rule[], RegExp>()
function compile(rules: Rule[]) {
  let re = compiled.get(rules)
  if (!re) {
    re = new RegExp(rules.map(([, r], i) => `(?<r${i}>${r.source})`).join('|'), `gm${IGNORE_CASE.has(rules) ? 'i' : ''}`)
    compiled.set(rules, re)
  }
  return re
}

/** The languages highlight() knows, by the names a fence's info string may use. */
export const knownLanguage = (lang: string) => lang.toLowerCase() in LANGS

/** Splits code into coloured tokens; unknown languages (and very big blocks) come back whole. */
export function highlight(code: string, lang: string): Token[] {
  const rules = LANGS[lang.toLowerCase()]
  if (!rules || code.length > 200_000) return [{ text: code }]
  const re = compile(rules)
  const out: Token[] = []
  let last = 0
  re.lastIndex = 0
  for (let m = re.exec(code); m; m = re.exec(code)) {
    if (!m[0]) {
      // A rule that matched nothing (a lookbehind at the very end); step past it.
      re.lastIndex++
      continue
    }
    if (m.index > last) out.push({ text: code.slice(last, m.index) })
    const groups = m.groups!
    let cls: string | undefined
    for (let i = 0; i < rules.length; i++) {
      if (groups[`r${i}`] !== undefined) {
        cls = rules[i][0]
        break
      }
    }
    out.push({ text: m[0], cls })
    last = m.index + m[0].length
  }
  if (last < code.length) out.push({ text: code.slice(last) })
  return out
}
