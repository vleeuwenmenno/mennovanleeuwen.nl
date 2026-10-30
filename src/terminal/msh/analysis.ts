import { lex, parse, type Token } from './parse'
import { commandLines } from './debug'

export type Diagnostic = { filename: string; line: number; column: number; expression: string; message: string }
export function diagnostic(src: string, filename: string, error: unknown): Diagnostic {
  const offset = Math.max(0, Math.min(src.length, Number((error as { offset?: number })?.offset) || 0))
  const prefix = src.slice(0, offset)
  return { filename, line: prefix.split('\n').length, column: offset - prefix.lastIndexOf('\n'), expression: src.slice(offset).split('\n')[0].slice(0, 200) || '<end of file>', message: error instanceof Error ? error.message : String(error) }
}
export const formatDiagnostic = (d: Diagnostic) => `${d.filename}:${d.line}:${d.column}: ${d.message} [${d.expression}]`
/** The editor and execution share the real msh lexer and parser, including heredocs. */
/** `commands`: the lines with a command the debugger can stop at (null when the file does not parse). */
export function analyzeMsh(src: string, filename: string): { tokens: Token[]; diagnostics: Diagnostic[]; commands: ReadonlySet<number> | null } {
  if (src.length > 512_000) return { tokens: [], diagnostics: [{ filename, line: 1, column: 1, expression: '', message: 'Analysis limited to 512 KB' }], commands: null }
  let tokens: Token[] = []
  try { tokens = lex(src); return { tokens, diagnostics: [], commands: commandLines(parse(src, filename)) } }
  catch (error) { return { tokens, diagnostics: [diagnostic(src, filename, error)], commands: null } }
}
