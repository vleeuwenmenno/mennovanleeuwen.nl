import { childrenOf, lex, parse, type Node, type Parameter, type Token } from './parse'
import { commandLines } from './debug'

export type Diagnostic = { filename: string; line: number; column: number; expression: string; message: string }
export function diagnostic(src: string, filename: string, error: unknown): Diagnostic {
  const offset = Math.max(0, Math.min(src.length, Number((error as { offset?: number })?.offset) || 0))
  const prefix = src.slice(0, offset)
  return { filename, line: prefix.split('\n').length, column: offset - prefix.lastIndexOf('\n'), expression: src.slice(offset).split('\n')[0].slice(0, 200) || '<end of file>', message: error instanceof Error ? error.message : String(error) }
}
export const formatDiagnostic = (d: Diagnostic) => `${d.filename}:${d.line}:${d.column}: ${d.message} [${d.expression}]`
export type AnalysisToken = Token & { role?: 'parameter' }
function parameterTokens(tokens: Token[], tree: Node): AnalysisToken[] {
  const params: Parameter[] = []
  const visit = (n: Node) => { if (n.t === 'func') params.push(...n.params); childrenOf(n).forEach(visit) }
  visit(tree)
  params.sort((a, b) => a.start - b.start)
  let i = 0
  return tokens.flatMap((t): AnalysisToken[] => {
    if (i >= params.length || params[i].start >= t.end) return [t]
    const out: AnalysisToken[] = []
    let at = t.start
    while (i < params.length && params[i].start < t.end) {
      const p = params[i++]
      if (p.start > at) out.push({ k: 'op', v: ',', start: at, end: p.start })
      out.push({ k: 'word', v: p.name, start: p.start, end: p.end, role: 'parameter' })
      at = p.end
    }
    if (at < t.end) out.push({ k: 'op', v: ',', start: at, end: t.end })
    return out
  })
}
/** The editor and execution share the real msh lexer and parser, including heredocs. */
/** `commands`: the lines with a command the debugger can stop at (null when the file does not parse). */
export function analyzeMsh(src: string, filename: string): { tokens: AnalysisToken[]; diagnostics: Diagnostic[]; commands: ReadonlySet<number> | null } {
  if (src.length > 512_000) return { tokens: [], diagnostics: [{ filename, line: 1, column: 1, expression: '', message: 'Analysis limited to 512 KB' }], commands: null }
  let tokens: Token[] = []
  try { tokens = lex(src); const tree = parse(src, filename); return { tokens: parameterTokens(tokens, tree), diagnostics: [], commands: commandLines(tree) } }
  catch (error) { return { tokens, diagnostics: [diagnostic(src, filename, error)], commands: null } }
}
