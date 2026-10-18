import type { GroundMapDef, TilePt } from './types.ts'

// A ground map definition written out as TypeScript, as ground/maps.ts lists them: the editor's
// Export (Viewer.tsx) and anything that freezes a generated map into a hand-made one use it.

const round = (v: number) => Math.round(v * 2) / 2

/** The map definition as TypeScript, ready to paste into GROUND_MAPS in ground/maps.ts. */
export function mapToTs(d: GroundMapDef): string {
  const n = (v: number) => String(round(v))
  const p = (q: TilePt) => `[${n(q[0])}, ${n(q[1])}]`
  const ps = (list: TilePt[]) => `[${list.map(p).join(', ')}]`
  const f = d.features ?? {}
  const lines: string[] = []
  const list = (name: string, items: string[]) => items.length && lines.push(`      ${name}: [\n${items.map((i) => `        ${i},`).join('\n')}\n      ],`)
  list('plateaus', (f.plateaus ?? []).map((q) => `{ level: ${q.level}, pts: ${ps(q.pts)} }`))
  list('ramps', (f.ramps ?? []).map((q) => `{ from: ${p(q.from)}, to: ${p(q.to)}, width: ${n(q.width)} }`))
  list('rivers', (f.rivers ?? []).map((q) => `{ pts: ${ps(q.pts)}, width: ${n(q.width)} }`))
  list('bridges', (f.bridges ?? []).map((q) => `{ from: ${p(q.from)}, to: ${p(q.to)}, width: ${n(q.width)} }`))
  list('fords', (f.fords ?? []).map((q) => `{ at: ${p(q.at)}, radius: ${n(q.radius)} }`))
  list('roads', (f.roads ?? []).map((q) => `{ pts: ${ps(q.pts)}, width: ${n(q.width)} }`))
  list('forests', (f.forests ?? []).map(ps))
  if (f.deposits?.length) lines.push(`      deposits: ${ps(f.deposits)},`)
  if (f.ruins?.length) lines.push(`      ruins: ${ps(f.ruins)},`)
  if (f.spawns?.length) lines.push(`      spawns: ${ps(f.spawns)},`)
  const q = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
  return [
    '  {',
    `    id: ${q(d.id)},`,
    `    name: ${q(d.name)},`,
    `    blurb: ${q(d.blurb)},`,
    `    cols: ${d.cols},`,
    `    rows: ${d.rows},`,
    '    cell: 1,',
    `    sym: ${q(d.sym)},`,
    ...(d.mirror ? [`    mirror: ${q(d.mirror)},`] : []),
    `    seed: ${d.seed},`,
    "    biome: 'temperate',",
    '    sketch: [],',
    '    features: {',
    ...lines,
    '    },',
    '  },',
  ].join('\n')
}

