// Moving and copying files into a folder when names meet: what is already there is found first,
// the caller asks once (replace, keep both, or skip), and each item then goes the way that answer
// says. Like launcherFiles.ts, the files themselves go through a port, so scripts/launchers-check.ts
// runs this very code against stand-ins for the browser's files and Seafile.

export type Clash = 'replace' | 'keep' | 'skip'

export type TransferPort = {
  /** The names in a folder right now (asked fresh). */
  names: (dir: string) => Promise<Set<string>>
  /** Moves or copies into a folder under the same names (the place's own move, or carrying the bytes over). */
  transfer: (op: 'move' | 'copy', paths: string[], into: string) => Promise<void>
  /** Moves or copies one file or folder to a new path (another name, in another folder or the same). */
  transferAs: (op: 'move' | 'copy', from: string, to: string) => Promise<void>
  /** Deletes (into Seafile's trash; for good from the browser). */
  remove: (paths: string[]) => Promise<void>
}

/** Where each item went, and what was left out. Kept for undoing a move. */
export type TransferResult = { op: 'move' | 'copy'; moved: { from: string; to: string }[]; skipped: string[] }

export const nameOfPath = (p: string) => p.split('/').pop() || ''
export const folderOfPath = (p: string) => p.replace(/\/[^/]*$/, '') || '/'
const join = (dir: string, name: string) => (dir === '/' ? `/${name}` : `${dir}/${name}`)

/** "notes.txt" in a folder that has it: "notes 2.txt", then "notes 3.txt". Folders get "Photos 2". */
export function freeName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name
  const dot = name.lastIndexOf('.')
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
  for (let n = 2; ; n++) if (!taken.has(`${stem} ${n}${ext}`)) return `${stem} ${n}${ext}`
}

/**
 * Moves or copies `paths` into `into`. Names already there (other than an item's own, for a copy
 * into its own folder) go to `ask` once, with all of them; null cancels the lot. Replace deletes
 * what is there first, keep both gives the newcomer a free name ("notes 2.txt"), skip leaves it.
 * A copy into the folder it is already in always keeps both. Answers null when cancelled.
 */
export async function transferInto(port: TransferPort, op: 'move' | 'copy', paths: string[], into: string, ask: (names: string[]) => Promise<Clash | null>): Promise<TransferResult | null> {
  const here = await port.names(into)
  const result: TransferResult = { op, moved: [], skipped: [] }
  // Moving something into the folder it is in is nothing to do.
  const todo = paths.filter((p) => !(op === 'move' && folderOfPath(p) === into))
  const own = (p: string) => folderOfPath(p) === into
  const clashes = todo.filter((p) => here.has(nameOfPath(p)) && !own(p))
  let choice: Clash = 'keep'
  if (clashes.length) {
    const answer = await ask(clashes.map(nameOfPath))
    if (!answer) return null
    choice = answer
  }
  const plain: string[] = []
  const renamed: [string, string][] = []
  const replace: string[] = []
  const planned = new Set(here)
  for (const p of todo) {
    const name = nameOfPath(p)
    const clash = here.has(name)
    if (clash && own(p)) {
      // A copy next to itself.
      const to = freeName(name, planned)
      planned.add(to)
      renamed.push([p, join(into, to)])
    } else if (!clash) {
      plain.push(p)
      planned.add(name)
    } else if (choice === 'skip') result.skipped.push(p)
    else if (choice === 'replace') {
      replace.push(join(into, name))
      plain.push(p)
    } else {
      const to = freeName(name, planned)
      planned.add(to)
      renamed.push([p, join(into, to)])
    }
  }
  if (replace.length) await port.remove(replace)
  if (plain.length) await port.transfer(op, plain, into)
  for (const p of plain) result.moved.push({ from: p, to: join(into, nameOfPath(p)) })
  for (const [from, to] of renamed) {
    await port.transferAs(op, from, to)
    result.moved.push({ from, to })
  }
  return result
}

/**
 * Undoes a move: each item goes back to where it came from, under its old name (a name taken
 * there since keeps both). Answers what was put back.
 */
export async function undoMove(port: TransferPort, last: TransferResult): Promise<number> {
  if (last.op !== 'move') return 0
  let n = 0
  const taken = new Map<string, Set<string>>()
  for (const { from, to } of last.moved) {
    const dir = folderOfPath(from)
    if (!taken.has(dir)) taken.set(dir, await port.names(dir))
    const names = taken.get(dir)!
    const name = freeName(nameOfPath(from), names)
    names.add(name)
    if (folderOfPath(to) === dir && nameOfPath(to) === name) continue
    await port.transferAs('move', to, join(dir, name))
    n++
  }
  return n
}
