import { analyzeMsh } from './analysis'
import { childrenOf, nestedEnd, type Node } from './parse'

// Conservative static facts from the real msh grammar. A function is a dynamic scope, not a
// JavaScript closure. Nothing here expands a word, evaluates an expression or reads a file.
export type SymbolKind = 'function' | 'parameter' | 'local' | 'global' | 'dynamic'
export type SymbolDef = { id: string; name: string; kind: SymbolKind; path: string; start: number; end: number; line: number; column: number; owner: string | null; conditional: boolean; available: number; signature?: string }
export type SymbolRef = { name: string; start: number; end: number; owner: string | null; kind: 'variable' | 'command' | 'positional'; declaration?: string }
export type SourceRef = { word: string | null; start: number; line: number; conditional: boolean; cwdUnknown: boolean }
export type SymbolFile = { path: string; text: string; definitions: SymbolDef[]; references: SymbolRef[]; sources: SourceRef[]; scopes: { owner: string; start: number; end: number }[]; uncertain: boolean; problems: string[] }
export type SymbolProject = { entry: string; cwd: string; files: Map<string, SymbolFile>; links: { from: string; to: string; source: SourceRef }[]; notes: string[] }
export type Resolution = { reference: SymbolRef; definitions: SymbolDef[]; reliable: boolean; note: string }
export const SYMBOL_LIMITS = { files: 16, characters: 512_000, symbols: 4096, depth: 8 } as const

/** Only fully literal shell words. Single-quoted metacharacters remain literal data. */
export function literalWord(raw: string): string | null {
  let result = '', quote = ''
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]
    if (quote === "'") { if (c === "'") quote = ''; else result += c; continue }
    if (c === '"') { quote = quote ? '' : '"'; continue }
    if (!quote && c === "'") { quote = c; continue }
    if (c === '\\') { if (i + 1 >= raw.length) return null; const n = raw[++i]; if (n !== '\n') result += quote === '"' && !/[$`"\\]/.test(n) ? '\\' + n : n; continue }
    if (c === '$' || c === '`' || (!quote && /[~*?\[\]{}]/.test(c))) return null
    result += c
  }
  return quote ? null : result
}

export function indexMsh(text: string, path: string): SymbolFile {
  const analysis = analyzeMsh(text, path)
  const file: SymbolFile = { path, text, definitions: [], references: [], sources: [], scopes: [], uncertain: false, problems: analysis.diagnostics.map(d => `${d.line}:${d.column}: ${d.message}`) }
  if (!analysis.tree) return file
  let cwdUnknown = false, count = 0
  const functionNames = new Set<string>()
  const collectFunctions = (node: Node) => { if (node.t === 'func') functionNames.add(node.name); for (const child of childrenOf(node)) collectFunctions(child) }
  collectFunctions(analysis.tree)
  const lines = [0]
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lines.push(i + 1)
  const location = (start: number) => {
    let low = 0, high = lines.length
    while (low + 1 < high) { const mid = (low + high) >>> 1; if (lines[mid] <= start) low = mid; else high = mid }
    return { line: low + 1, column: start - lines[low] + 1 }
  }
  const tokensFrom = function* (start: number) {
    let low = 0, high = analysis.tokens.length
    while (low < high) { const mid = (low + high) >>> 1; if (analysis.tokens[mid].start < start) low = mid + 1; else high = mid }
    for (let i = low; i < analysis.tokens.length; i++) yield analysis.tokens[i]
  }
  const add = (name: string, kind: SymbolKind, start: number, owner: string | null, conditional: boolean, signature?: string, available = start) => {
    if (++count > SYMBOL_LIMITS.symbols) { file.uncertain = true; return }
    file.definitions.push({ id: `${path}:${start}:${kind}`, name, kind, path, start, end: start + name.length, ...location(start), owner, conditional, signature, available })
  }
  const ref = (name: string, start: number, end: number, owner: string | null, kind: SymbolRef['kind']) => {
    if (++count <= SYMBOL_LIMITS.symbols) file.references.push({ name, start, end, owner, kind })
    else file.uncertain = true
  }
  // Expansion references are extracted only inside parser-provided words; single quotes and
  // escapes suppress them. Substitution bodies are deliberately unknown rather than guessed.
  const expansions = (start: number, end: number, owner: string | null) => {
    let quote = ''
    for (let i = start; i < end; i++) {
      const c = text[i]
      if (quote === "'") { if (c === "'") quote = ''; continue }
      if (c === '\\') { i++; continue }
      if (c === "'" && !quote) { quote = c; continue }
      if (c === '"') { quote = quote ? '' : '"'; continue }
      if (c === '`' || (c === '$' && text[i + 1] === '(')) {
        file.uncertain = true
        try { i = nestedEnd(text, i) - 1 } catch { break }
        continue
      }
      if (c !== '$') continue
      const rest = text.slice(i + 1, end)
      const m = /^(?:\{#?([A-Za-z_][A-Za-z0-9_]*|\d+|[@*#?])|([A-Za-z_][A-Za-z0-9_]*|\d|[@*#?]))/.exec(rest)
      if (!m) continue
      const name = m[1] ?? m[2]
      ref(name, i, i + 1 + m[0].length, owner, /^\d+$|^[@*#?]$/.test(name) ? 'positional' : 'variable')
      i += m[0].length
    }
  }
  const visit = (n: Node, owner: string | null, conditional: boolean) => {
    if (count > SYMBOL_LIMITS.symbols || !n) return
    if (n.t === 'func') {
      const head = tokensFrom(n.span?.start ?? 0)
      let token = head.next().value
      if (token?.k === 'word' && token.v === 'function') token = head.next().value
      const start = token?.start ?? n.span?.start ?? 0
      add(n.name, 'function', start, owner, conditional || owner !== null, `${n.name}(${n.params.map(p => p.name).join(', ')})`)
      const id = `${path}:${start}`
      file.scopes.push({ owner: id, start: n.span?.start ?? start, end: n.span?.end ?? start })
      for (const p of n.params) add(p.name, 'parameter', p.start, id, false)
      visit(n.body, id, false)
      return
    }
    if (n.t === 'simple') {
      const command = n.words[0]
      const shadowed = functionNames.has(command)
      if (shadowed && ['local', 'export', 'source', '.', 'cd'].includes(command)) file.uncertain = true
      const commandAt = n.wordsAt?.[0]
      if (commandAt && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(command)) ref(command, commandAt.start, commandAt.end, owner, 'command')
      if (command === 'eval' || command === 'alias' || command === 'unset' || command?.includes('$')) file.uncertain = true
      if (command === 'cd') cwdUnknown = true
      if (!shadowed && (command === 'source' || command === '.')) file.sources.push({ word: n.words[1] === undefined ? null : literalWord(n.words[1]), start: n.span?.start ?? 0, line: n.span?.line ?? 1, conditional: conditional || owner !== null, cwdUnknown })
      for (let i = 0; i < n.assigns.length; i++) {
        const [name] = n.assigns[i], at = n.assignsAt?.[i]
        if (!at) continue
        // Command-prefix assignments are temporary, not reliable global definitions.
        const known = file.definitions.find(d => d.owner === owner && d.name === name && (d.kind === 'local' || d.kind === 'parameter'))
        add(name, owner ? known?.kind ?? 'dynamic' : 'global', at.start, owner, conditional || !!command, undefined, n.span?.end ?? at.end)
        expansions(at.start + name.length + 1, at.end, owner)
      }
      for (let i = 0; i < n.words.length; i++) {
        const at = n.wordsAt?.[i]; if (!at) continue
        const m = /^(\w+)(?:=|$)/.exec(n.words[i])
        if (!shadowed && i && m && /^[A-Za-z_]/.test(m[1]) && ['local', 'export'].includes(command)) {
          add(m[1], command === 'local' ? 'local' : owner ? 'dynamic' : 'global', at.start, owner, conditional, undefined, n.span?.end ?? at.end)
        }
        expansions(at.start, at.end, owner)
      }
    } else if (n.t === 'for') {
      const head = tokensFrom((n.span?.start ?? 0) + 1)
      const token = head.next().value
      if (token) add(n.name, owner ? 'dynamic' : 'global', token.start, owner, true)
    }
    if ((n.t === 'for' || n.t === 'case') && n.span) {
      for (const t of tokensFrom(n.span.start + 1)) {
        if (t.start >= n.span.end) break
        if (t.k === 'word' && (t.v === 'do' || t.v === 'in' && n.t === 'case')) break
        if (t.k === 'word') expansions(t.start, t.end, owner)
      }
    }
    const branch = conditional || ['if', 'for', 'while', 'case', 'andor', 'pipeline', 'subshell'].includes(n.t)
    for (const child of childrenOf(n)) visit(child, owner, branch)
  }
  visit(analysis.tree, null, false)
  if (count > SYMBOL_LIMITS.symbols) file.problems.push(`Symbol analysis limited to ${SYMBOL_LIMITS.symbols} entries`)
  return file
}

export function symbolAt(file: SymbolFile, offset: number): SymbolRef | null {
  const r = file.references.find(r => r.start <= offset && offset < r.end)
  if (r) return r
  const d = file.definitions.find(d => d.start <= offset && offset <= d.end)
  return d ? { name: d.name, start: d.start, end: d.end, owner: d.owner, kind: d.kind === 'function' ? 'command' : 'variable', declaration: d.id } : null
}

export function resolveSymbol(project: SymbolProject, path: string, at: number): Resolution | null {
  const file = project.files.get(path)
  const reference = file && symbolAt(file, at)
  if (!file || !reference) return null
  if (reference.declaration) return { reference, definitions: file.definitions.filter(d => d.id === reference.declaration), reliable: true, note: 'Declaration in this source (static origin, not a runtime value).' }
  if (reference.kind === 'positional') return { reference, definitions: [], reliable: false, note: 'Positional argument of the current invocation; supplied by its caller. shift/set -- can change it.' }
  const sameKind = (d: SymbolDef) => reference.kind === 'command' ? d.kind === 'function' : d.kind !== 'function'
  const own = file.definitions.filter(d => d.name === reference.name && sameKind(d))
  if (reference.kind === 'variable' && reference.owner) {
    const local = own.filter(d => d.owner === reference.owner && (d.kind === 'parameter' || d.kind === 'local') && d.available <= reference.start)
    const parameter = local.find(d => d.kind === 'parameter')
    if (parameter) return { reference, definitions: [parameter], reliable: true, note: 'Named parameter, local to this invocation; positional arguments remain separate.' }
    if (local.length) {
      const first = local[0]
      return { reference, definitions: [first], reliable: !first.conditional && !file.uncertain, note: first.conditional ? 'Conditional local declaration; the caller may supply this binding.' : 'Function-local declaration (dynamic scope).' }
    }
  }
  const reachable = new Set([path])
  let uncertain = file.uncertain || project.notes.length > 0
  for (let round = 0; round < SYMBOL_LIMITS.depth; round++) for (const link of project.links) {
    if (reachable.has(link.from) && (link.from !== path || reference.owner || link.source.start < reference.start)) {
      reachable.add(link.to); uncertain ||= link.source.conditional || project.files.get(link.to)?.uncertain === true
    }
  }
  const candidates = [...reachable].flatMap(p => project.files.get(p)?.definitions ?? []).filter(d => d.name === reference.name && sameKind(d) && (reference.kind === 'command' || d.kind === 'global' || d.kind === 'dynamic') && (d.path !== path || reference.owner || d.available <= reference.start))
  const dynamic = reference.kind === 'variable' && !!reference.owner
  const reliable = !dynamic && !uncertain && candidates.length === 1 && !candidates[0].conditional && candidates[0].owner === null
  return { reference, definitions: candidates.slice(0, 32), reliable, note: dynamic
    ? 'Dynamic scope: a caller local may shadow these assignments. These are candidates, not a lexical binding.'
    : reliable ? 'Static definition in the indexed source.' : candidates.length ? 'Candidate definitions; execution order, conditional code or redefinition may change the binding.' : 'No static definition captured (builtin, external command, dynamic source/eval or caller binding).' }
}

export type Completion = { name: string; detail: string; start: number; end: number; caret: number }
export function completeSymbols(project: SymbolProject, path: string, offset: number, builtins: readonly string[]): Completion[] {
  const file = project.files.get(path)
  if (!file) return []
  const before = file.text.slice(0, offset), match = /[A-Za-z_][A-Za-z0-9_]*$/.exec(before)
  const prefix = match?.[0] ?? '', start = offset - prefix.length
  let end = offset
  while (end < file.text.length && /[A-Za-z0-9_]/.test(file.text[end])) end++
  const variable = /\$\{?$/.test(before.slice(0, start))
  const at = symbolAt(file, Math.max(0, offset - 1))
  const owner = at?.owner ?? file.scopes.filter(s => s.start <= offset && offset <= s.end).sort((a, b) => b.start - a.start)[0]?.owner ?? null
  // Ordinary arguments and quoted text are not command-name completion positions.
  if (!variable && at?.kind !== 'command' && !/(?:^|[;|&\n])\s*[A-Za-z_0-9]*$/.test(before)) return []
  const defs = [...project.files.values()].flatMap(f => f.definitions).filter(d => variable ? d.kind !== 'function' && (d.owner === null || d.owner === owner && d.start <= offset) : d.kind === 'function')
  const choices = new Map<string, string>()
  if (!variable) for (const name of builtins) choices.set(name, 'shell builtin')
  // Parameters and locals supersede global suggestions. Never offer a different function's locals.
  for (const d of defs.sort((a, b) => Number(a.owner !== null) - Number(b.owner !== null))) choices.set(d.name, `${d.signature ?? d.kind} · ${d.path}:${d.line}${d.conditional ? ' (candidate)' : ''}`)
  return [...choices].filter(([name]) => name.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b)).slice(0, 40).map(([name, detail]) => ({ name, detail, start, end, caret: offset }))
}

/** Cancellable, bounded source graph. The caller supplies authorized reads; no I/O is hidden here. */
export async function indexProject(entry: string, cwd: string, read: (path: string, signal: AbortSignal) => Promise<string | null>, signal: AbortSignal): Promise<SymbolProject> {
  const project: SymbolProject = { entry, cwd, files: new Map(), links: [], notes: [] }
  let total = 0
  const resolve = (word: string) => {
    const parts: string[] = []
    for (const part of (word.startsWith('/') ? word : `${cwd}/${word}`).split('/')) {
      if (!part || part === '.') continue
      if (part === '..') parts.pop(); else parts.push(part)
    }
    return '/' + parts.join('/')
  }
  const visit = async (path: string, depth: number) => {
    if (signal.aborted || project.files.has(path)) return
    if (project.files.size >= SYMBOL_LIMITS.files || depth > SYMBOL_LIMITS.depth) { project.notes.push('Source index limit reached'); return }
    let source: string | null
    try { source = await read(path, signal) }
    catch { if (!signal.aborted) project.notes.push(`${path}: unavailable or permission denied`); return }
    if (signal.aborted) return
    if (source === null) { project.notes.push(`${path}: open this source file to include it (not loaded locally)`); return }
    if (source.length + total > SYMBOL_LIMITS.characters) { project.notes.push('Source index limited to 512 KB'); return }
    total += source.length
    const file = indexMsh(source, path)
    project.files.set(path, file)
    for (const error of file.problems) project.notes.push(`${path}:${error}`)
    for (const source of file.sources) {
      if (signal.aborted) return
      if (source.word === null || (!source.word.startsWith('/') && source.cwdUnknown)) { project.notes.push(`${path}:${source.line}: dynamic source path or working directory`); continue }
      const target = resolve(source.word)
      if (cwd !== '/' && target !== cwd && !target.startsWith(cwd.replace(/\/$/, '') + '/')) { project.notes.push(`${path}:${source.line}: source outside the project; open it directly`); continue }
      project.links.push({ from: path, to: target, source })
      await visit(target, depth + 1)
    }
  }
  await visit(entry, 0)
  project.notes = [...new Set(project.notes)].slice(0, 32)
  return project
}
