// Checks visual blocks (src/data/visual/): `node scripts/visual-check.ts`. Good specs of every
// type read and normalise as expected (loose JSON included), bad ones give errors that name the
// field, the text version (terminal, shared pages) says what the picture shows, the layout keeps
// nodes apart, and every example in the Agents prompt is itself a valid spec.

import { parseLoose, parseVisual, visualBlockText, validateVisual, type Visual, type VisualResult } from '../src/data/visual/spec.ts'
import { layered } from '../src/data/visual/layout.ts'
import { VISUAL_PROMPT } from '../src/data/visual/prompt.ts'
import { parseMarkdown } from '../src/data/markdown/parse.ts'

let failed = 0
let passed = 0
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) passed++
  else {
    failed++
    console.log(`FAIL ${name}${detail === undefined ? '' : `\n  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
  }
}
const good = (name: string, src: string): Visual[] => {
  const r = parseVisual(src)
  check(`${name}: reads`, r.ok, r.ok ? undefined : r.errors)
  return r.ok ? r.visuals : []
}
const bad = (name: string, src: string, path: string | RegExp, message?: RegExp): VisualResult => {
  const r = parseVisual(src)
  check(`${name}: is an error`, !r.ok, r.ok ? r.visuals : undefined)
  if (!r.ok) {
    const hit = r.errors.find((e) => (typeof path === 'string' ? e.path === path : path.test(e.path)) && (!message || message.test(e.message)))
    check(`${name}: names ${path}`, !!hit, r.errors)
  }
  return r
}

// --- loose JSON ----------------------------------------------------------------------------------
{
  const r = parseLoose(`{
    // a comment
    type: 'flow', /* another */
    edges: ["a -> b", "b -> c",],
    title: "x" "y": 2
  }`)
  check('loose: comments, single quotes, bare keys, trailing commas', r.ok && (r.value as { type: string }).type === 'flow', r)
  check('loose: a missing comma is forgiven', r.ok && (r.value as Record<string, unknown>).y === 2, r)
  const e = parseLoose('{\n  "type": "flow",\n  "edges": ["a -> b"\n')
  check('loose: an unclosed list says where', !e.ok && e.line === 4, e)
  const s = parseLoose('{"a": "no end\n}')
  check('loose: an unclosed string names line 1', !s.ok && s.line === 1 && /quote/.test(s.message), s)
  check('loose: bare words are strings, icon:slug included', (() => {
    const v = parseLoose('{type: grid, result: icon:stick}')
    return v.ok && (v.value as Record<string, string>).result === 'icon:stick'
  })())
  check('loose: __proto__ is ignored', (() => {
    const v = parseLoose('{"__proto__": {"x": 1}}')
    return v.ok && ({} as Record<string, unknown>).x === undefined && Object.getPrototypeOf(v.value) === Object.prototype
  })())
  const deep = parseLoose('['.repeat(60) + ']'.repeat(60))
  check('loose: deep nesting is refused, not a stack overflow', !deep.ok)
}

// --- flow --------------------------------------------------------------------------------------
{
  const [f] = good('flow', JSON.stringify({ type: 'flow', direction: 'LR', nodes: [{ id: 'a', label: 'Start', shape: 'round' }, { id: 'b', label: 'OK?', shape: 'diamond', group: 'g' }], edges: ['a -> b', { from: 'b', to: 'a', label: 'no' }, ['b', 'Done', 'yes']] }))
  if (f?.type === 'flow') {
    check('flow: direction LR is right', f.direction === 'right')
    check('flow: an edge to an unknown name makes the node', f.nodes.some((n) => n.id === 'Done' && n.label === 'Done'), f.nodes)
    check('flow: three edges, labels kept', f.edges.length === 3 && f.edges[1].label === 'no' && f.edges[2].label === 'yes', f.edges)
    check('flow: shapes', f.nodes[0].shape === 'round' && f.nodes[1].shape === 'diamond')
    check('flow: groups from nodes', f.groups.length === 1 && f.groups[0].id === 'g')
  }
  const [chain] = good('flow chain', '{"edges": ["icon:oak_log Log -> 4x Planks -> Stick: craft"]}')
  if (chain?.type === 'flow') {
    check('flow: type guessed from edges', chain.type === 'flow')
    check('flow: a chain is two edges, the label on the last', chain.edges.length === 2 && chain.edges[1].label === 'craft' && !chain.edges[0].label, chain.edges)
    check('flow: an icon in an edge end', chain.nodes[0].icon === 'oak_log' && chain.nodes[0].label === 'Log', chain.nodes[0])
    check('flow: a count in an edge end', chain.nodes[1].count === 4 && chain.nodes[1].label === 'Planks', chain.nodes[1])
  }
  const [byLabel] = good('flow by label', '{"type":"flow","nodes":[{"id":"x","label":"Mix"}],"edges":[{"source":"Mix","target":["Bake","Cool"]}]}')
  if (byLabel?.type === 'flow') check('flow: edges find nodes by label, source/target aliases, a list of targets', byLabel.edges.length === 2 && byLabel.edges[0].from === 'x', byLabel.edges)
  bad('flow without nodes', '{"type":"flow"}', 'nodes')
  bad('flow edge without to', '{"type":"flow","edges":[{"from":"a"}]}', 'edges[0].to')
  bad('flow edge as nonsense', '{"type":"flow","edges":["just words"]}', 'edges[0]')
  bad('flow nodes not a list', '{"type":"flow","nodes":3}', 'nodes')
  const many = { type: 'flow', edges: Array.from({ length: 400 }, (_, i) => `n${i} -> n${i + 1}`) }
  const r = validateVisual(many)
  check('flow: over the limits it draws the first ones, with a warning', r.ok && r.visuals[0].type === 'flow' && r.visuals[0].nodes.length <= 150 && r.warnings.length > 0, r.ok ? r.warnings : r.errors)
}

// --- grids -------------------------------------------------------------------------------------
{
  const [g] = good('grid pattern', '{"type":"grid","title":"Crafting table","pattern":["PP","PP"],"key":{"P":"icon:oak_planks Oak planks"},"via":"Crafting grid","result":"icon:crafting_table"}')
  if (g?.type === 'grid') {
    const one = g.grids[0]
    check('grid: 2×2 from a pattern', one.rows === 2 && one.cols === 2 && one.slots.every((s) => s?.icon === 'oak_planks' && s.label === 'Oak planks'), one)
    check('grid: result label from the slug', one.result[0]?.icon === 'crafting_table' && one.result[0].label === 'Crafting table', one.result)
    check('grid: the block title is not repeated on its only grid', g.title === 'Crafting table' && !one.title)
  }
  const [pick] = good('grid slots', '{"type":"grid","slots":[["icon:iron_ingot","icon:iron_ingot","icon:iron_ingot"],[null,"icon:stick",null],[".","icon:stick",""]],"result":{"label":"Iron pickaxe","icon":"iron_pickaxe","emoji":"⛏️"}}')
  if (pick?.type === 'grid') {
    const one = pick.grids[0]
    check('grid: null, "." and "" are empty slots', one.slots.filter((s) => s === null).length === 4, one.slots)
    check('grid: result emoji as fallback', one.result[0].emoji === '⛏️' && one.result[0].icon === 'iron_pickaxe')
  }
  const [chain] = good('grid chain', '{"type":"grid","grids":[{"slots":["Iron ore","Coal"],"cols":1,"via":"Furnace","result":"Iron ingot"},{"ingredients":["Flour","Water","Salt","Yeast"],"via":"Knead 10 min","result":"2x 🍞 Dough"}]}')
  if (chain?.type === 'grid') {
    check('grid: two grids in a chain', chain.grids.length === 2)
    check('grid: flat slots with cols', chain.grids[0].rows === 2 && chain.grids[0].cols === 1)
    check('grid: flat ingredients wrap at 3', chain.grids[1].cols === 3 && chain.grids[1].rows === 2)
    check('grid: a count and an emoji in a string', chain.grids[1].result[0].count === 2 && chain.grids[1].result[0].emoji === '🍞' && chain.grids[1].result[0].label === 'Dough', chain.grids[1].result)
  }
  bad('grid with nothing', '{"type":"grid"}', 'slots')
  bad('grid slots not a list', '{"type":"grid","slots":"PPP"}', 'slots')
  const r = parseVisual('{"type":"grid","pattern":["AB"],"key":{"A":"Apple"},"result":"Pie"}')
  check('grid: a letter missing from the key is a warning, not an error', r.ok && r.warnings.some((w) => w.path === 'key'), r)
}

// --- tree, timeline ------------------------------------------------------------------------------
{
  const [t] = good('tree', '{"type":"tree","root":{"label":"Animals","children":["Cats",{"label":"Dogs","children":[{"label":"Corgi","emoji":"🐕"}]}]}}')
  if (t?.type === 'tree') check('tree: nested children, string children', t.roots[0].children.length === 2 && t.roots[0].children[1].children[0].emoji === '🐕')
  good('tree guessed from children', '{"label":"Root","children":["a","b"]}')
  bad('tree without root', '{"type":"tree"}', 'root')
  const [tl] = good('timeline', '{"type":"timeline","events":[{"date":"1969","label":"Moon landing","note":"Apollo 11"},"Later"]}')
  if (tl?.type === 'timeline') check('timeline: date alias, string events', tl.events[0].when === '1969' && tl.events[1].label === 'Later')
  bad('timeline without events', '{"type":"timeline"}', 'events')
}

// --- charts --------------------------------------------------------------------------------------
{
  const [c] = good('chart data list', '{"type":"chart","chart":"bar","data":[{"label":"Mon","value":3},{"label":"Tue","value":"5.5 h"}],"unit":"h"}')
  if (c?.type === 'chart') check('chart: values from strings with units', c.series[0].values[1] === 5.5 && c.labels[1] === 'Tue', c)
  const [m] = good('chart series', '{"type":"chart","chart":"line","labels":["Q1","Q2","Q3"],"series":[{"name":"A","values":[1,2,3]},{"name":"B","values":[3,null,1]}]}')
  if (m?.type === 'chart') check('chart: two series, a gap kept as null', m.series.length === 2 && m.series[1].values[1] === null && m.chart === 'line')
  const [o] = good('chart data object', '{"type":"pie","data":{"Rent":900,"Food":300}}')
  if (o?.type === 'chart') check('chart: "type": "pie" is a pie chart', o.chart === 'pie' && o.labels.join() === 'Rent,Food')
  const [w] = good('chart wide rows', '{"type":"chart","data":[{"month":"Jan","apples":3,"pears":4},{"month":"Feb","apples":5,"pears":1}]}')
  if (w?.type === 'chart') check('chart: rows with several value fields are several series', w.series.length === 2 && w.series[0].name === 'apples', w.series)
  bad('chart without numbers', '{"type":"chart","data":[{"label":"x","value":"lots"}]}', 'data', /no numbers/)
  bad('chart without data', '{"type":"chart"}', 'series')
}

// --- cards, table, several, errors ----------------------------------------------------------------
{
  const [c] = good('cards', '{"type":"cards","cards":[{"label":"Iron","icon":"iron_ingot","text":"Smelt ore","value":"x3","tags":["metal"]},"🍎 Apple"]}')
  if (c?.type === 'cards') check('cards: fields and a string card', c.cards[0].value === 'x3' && c.cards[0].tags[0] === 'metal' && c.cards[1].emoji === '🍎')
  const [t] = good('table', '{"type":"table","columns":["Item","Use"],"rows":[["icon:stick Stick","Tools"],[12, null]]}')
  if (t?.type === 'table') check('table: icon cells, numbers, empty cells', t.rows[0][0]?.icon === 'stick' && t.rows[1][0]?.label === '12' && t.rows[1][1] === null)
  const [o] = good('table of objects', '{"type":"table","rows":[{"name":"a","n":1},{"name":"b","n":2}]}')
  if (o?.type === 'table') check('table: object rows make the columns', o.columns.join() === 'name,n' && o.rows[1][1]?.label === '2')
  const several = good('several in a list', '[{"type":"flow","edges":["a -> b"]},{"type":"cards","cards":["x"]}]')
  check('several: two visuals', several.length === 2)
  check('several: {"visuals": [...]}', good('several in visuals', '{"visuals":[{"type":"cards","cards":["x"]}]}').length === 1)
  bad('unknown type', '{"type":"sankey","nodes":["a"]}', 'type', /Unknown type "sankey"/)
  bad('no type at all', '{"hello":1}', 'type', /Missing/)
  bad('not an object', '"flow"', '(spec)')
  bad('empty', '   ', '(spec)', /empty/)
  bad('json error', '{"type": "flow", "edges": [}', /^line 1, column \d+$/)
  bad('error in the second of several', '[{"type":"cards","cards":["x"]},{"type":"flow","edges":[{"from":"a"}]}]', '[1].edges[0].to')
  check('aliases: "kind": "flowchart"', good('kind alias', '{"kind":"flowchart","links":[["a","b"]]}')[0]?.type === 'flow')
}

// --- text version --------------------------------------------------------------------------------
{
  const flow = visualBlockText('{"type":"flow","title":"Bread","nodes":[{"id":"m","label":"Mix"},{"id":"b","label":"Bake"},{"id":"x","label":"Alone"}],"edges":[{"from":"m","to":"b","label":"1 h"}]}')
  check('text: flow is "a → b" lines', !!flow && flow[0] === 'Bread' && flow[1] === 'Mix → Bake  (1 h)' && flow.includes('Alone'), flow)
  const grid = visualBlockText('{"type":"grid","pattern":["PP","PP"],"key":{"P":"icon:oak_planks Oak planks"},"via":"Craft","result":"4x Crafting table"}')
  check('text: grid rows of [slots] with the result', !!grid && grid.length === 2 && grid[0].startsWith('[Oak planks] [Oak planks]') && grid[0].includes('─ Craft ─▶ 4× Crafting table'), grid)
  const tree = visualBlockText('{"type":"tree","root":{"label":"A","children":[{"label":"B","children":["C"]},"D"]}}')
  check('text: tree with branches', !!tree && tree.join('\n') === 'A\n├─ B\n│  └─ C\n└─ D', tree)
  const chart = visualBlockText('{"type":"chart","data":{"a":1,"b":2},"unit":"kg"}')
  check('text: a bar chart as bars', !!chart && chart[1].includes('█'.repeat(20)) && chart[1].endsWith('2 kg'), chart)
  const pie = visualBlockText('{"type":"chart","chart":"pie","data":{"a":1,"b":3}}')
  check('text: a pie with percentages', !!pie && pie[1] === 'b: 3 (75%)', pie)
  check('text: an invalid block has none', visualBlockText('{"type":"nope"}') === null)
}

// --- layout -------------------------------------------------------------------------------------
{
  const nodes = Array.from({ length: 12 }, (_, i) => ({ id: `n${i}`, w: 60 + (i % 3) * 20, h: 36 }))
  const edges = [
    ...Array.from({ length: 11 }, (_, i) => ({ from: `n${Math.floor(i / 2)}`, to: `n${i + 1}` })),
    { from: 'n11', to: 'n0' }, // a cycle
    { from: 'n0', to: 'n11' }, // skips ranks
    { from: 'n3', to: 'n3' }, // a self loop
  ]
  for (const dir of ['down', 'right', 'up', 'left'] as const) {
    const l = layered(nodes, edges, dir)
    const boxes = [...l.nodes.values()]
    check(`layout ${dir}: every node placed, finite`, boxes.length === 12 && boxes.every((b) => Number.isFinite(b.x) && Number.isFinite(b.y)))
    let overlap = 0
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]
        const b = boxes[j]
        if (Math.abs(a.x - b.x) < (a.w + b.w) / 2 - 0.5 && Math.abs(a.y - b.y) < (a.h + b.h) / 2 - 0.5) overlap++
      }
    check(`layout ${dir}: no nodes overlap`, overlap === 0, overlap)
    check(`layout ${dir}: inside its size`, boxes.every((b) => b.x - b.w / 2 >= -0.5 && b.y - b.h / 2 >= -0.5 && b.x + b.w / 2 <= l.width + 0.5 && b.y + b.h / 2 <= l.height + 0.5), { w: l.width, h: l.height })
    check(`layout ${dir}: one route per edge, the self loop marked`, l.edges.length === edges.length && l.edges[edges.length - 1].self)
  }
  const down = layered(nodes, edges, 'down')
  const first = down.edges[0].points
  check('layout: edges start at the bottom of their node going down', Math.abs(first[0].y - (down.nodes.get('n0')!.y + 18)) < 0.01, first)
  const skip = down.edges[12].points
  check('layout: an edge across ranks runs through dummy points', skip.length > 2, skip.length)
  const t0 = performance.now()
  const big = Array.from({ length: 150 }, (_, i) => ({ id: `b${i}`, w: 100, h: 36 }))
  layered(big, Array.from({ length: 300 }, (_, i) => ({ from: `b${i % 150}`, to: `b${(i * 7 + 3) % 150}` })), 'down')
  const ms = performance.now() - t0
  check('layout: 150 nodes and 300 edges in under 400 ms', ms < 400, `${Math.round(ms)} ms`)
}

// --- Markdown and the prompt -----------------------------------------------------------------------
{
  const open = parseMarkdown('Here:\n\n```visual\n{"type": "fl')
  const closed = parseMarkdown('```visual\n{}\n```\n')
  const b = open[1]
  check('markdown: an unclosed fence is open', b?.type === 'code' && b.lang === 'visual' && b.open === true, open)
  check('markdown: a closed fence is not', closed[0]?.type === 'code' && !closed[0].open, closed)
  // Every {"type": ...} object in the prompt is a valid spec on its own.
  const examples: string[] = []
  for (let i = VISUAL_PROMPT.indexOf('{"type"'); i >= 0; i = VISUAL_PROMPT.indexOf('{"type"', i + 1)) {
    let depth = 0
    let j = i
    let inStr = false
    for (; j < VISUAL_PROMPT.length; j++) {
      const ch = VISUAL_PROMPT[j]
      if (inStr) {
        if (ch === '\\') j++
        else if (ch === '"') inStr = false
      } else if (ch === '"') inStr = true
      else if (ch === '{') depth++
      else if (ch === '}' && !--depth) break
    }
    examples.push(VISUAL_PROMPT.slice(i, j + 1))
  }
  check('prompt: has examples of every type', ['flow', 'grid', 'tree', 'timeline', 'chart', 'cards', 'table'].every((t) => examples.some((e) => e.includes(`"type":"${t}"`))), examples.length)
  for (const e of examples) {
    const r = parseVisual(e)
    check(`prompt example is valid: ${e.slice(0, 50)}…`, r.ok && !r.warnings.length, r.ok ? r.warnings : r.errors)
  }
  check('prompt: short (under 3000 characters)', VISUAL_PROMPT.length < 3000, VISUAL_PROMPT.length)
}

console.log(`${passed} passed, ${failed} failed`)
if (failed) process.exit(1)
