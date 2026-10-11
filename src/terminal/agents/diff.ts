// Line diffs for edit previews: which lines went, which came, with a little context.

export type DiffLine = { kind: ' ' | '-' | '+'; text: string; old?: number; new?: number }

/** The lines that differ between a and b (longest common subsequence), with `context` lines around. */
export function diffLines(a: string, b: string, context = 2): DiffLine[] {
  const x = a.split('\n')
  const y = b.split('\n')
  // Common start and end first: edits are usually small.
  let start = 0
  while (start < x.length && start < y.length && x[start] === y[start]) start++
  let endX = x.length
  let endY = y.length
  while (endX > start && endY > start && x[endX - 1] === y[endY - 1]) (endX--, endY--)
  const mx = x.slice(start, endX)
  const my = y.slice(start, endY)
  const ops: DiffLine[] = []
  if (mx.length * my.length > 4_000_000) {
    // Too big to compare line by line: all out, all in.
    mx.forEach((t) => ops.push({ kind: '-', text: t }))
    my.forEach((t) => ops.push({ kind: '+', text: t }))
  } else {
    const n = mx.length
    const m = my.length
    const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = mx[i] === my[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    let i = 0
    let j = 0
    while (i < n || j < m) {
      if (i < n && j < m && mx[i] === my[j]) (ops.push({ kind: ' ', text: mx[i] }), i++, j++)
      else if (i < n && (j >= m || lcs[i + 1][j] >= lcs[i][j + 1])) ops.push({ kind: '-', text: mx[i++] })
      else ops.push({ kind: '+', text: my[j++] })
    }
  }
  const all: DiffLine[] = [...x.slice(0, start).map((t) => ({ kind: ' ' as const, text: t })), ...ops, ...x.slice(endX).map((t) => ({ kind: ' ' as const, text: t }))]
  // Line numbers on both sides.
  let o = 1
  let w = 1
  for (const d of all) {
    if (d.kind !== '+') d.old = o++
    if (d.kind !== '-') d.new = w++
  }
  // Only the changes and a little around them.
  const keep = new Set<number>()
  all.forEach((d, k) => {
    if (d.kind !== ' ') for (let c = k - context; c <= k + context; c++) keep.add(c)
  })
  const out: DiffLine[] = []
  let prev = -2
  all.forEach((d, k) => {
    if (!keep.has(k)) return
    if (prev >= 0 && k > prev + 1) out.push({ kind: ' ', text: '…' })
    out.push(d)
    prev = k
  })
  return out
}

/** How many lines came and went. */
export const diffCounts = (d: DiffLine[]) => ({ added: d.filter((l) => l.kind === '+').length, removed: d.filter((l) => l.kind === '-').length })
