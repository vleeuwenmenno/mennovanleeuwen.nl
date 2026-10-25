// Checks visual blocks (src/data/visual/): `node scripts/visual-check.ts`. Good specs of every
// type read and normalise as expected (loose JSON included), bad ones give errors that name the
// field, the text version (terminal, shared pages) says what the picture shows, the layout keeps
// nodes apart, every example in the Agents prompt is itself a valid spec, and the scene kind's SVG
// sanitizer (svg.ts) lets no script, handler, outside reference or loading CSS through.

import { parseLoose, parseVisual, visualBlockText, validateVisual, type Visual, type VisualResult } from '../src/data/visual/spec.ts'
import { layered } from '../src/data/visual/layout.ts'
import { VISUAL_PROMPT } from '../src/data/visual/prompt.ts'
import { parseMarkdown } from '../src/data/markdown/parse.ts'
import { resolveColours, sanitizeSvg, serializeSvg, SCENE_LIMITS, SCENE_PALETTE, type ScenePalette } from '../src/data/visual/svg.ts'

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

// --- list, and found pictures (image:<id>) --------------------------------------------------------
{
  const ID = 'w0123456789abcdef01234567'
  const [l] = good('list', JSON.stringify({ type: 'list', title: 'JP', items: [
    { image: `image:${ID}`, title: 'Calbee Jagabee うすしお味', text: 'Potato sticks', fields: { Quantity: 'Lots!', Where: 'Konbini' }, note: 'Big bags' },
    { image: '🍵', name: 'Matcha', fields: [['Quantity', 2]], checked: true, price: '¥980' },
    { icon: 'iron_ingot', title: 'Iron', fields: [{ label: 'Use', value: 'Tools' }, 'Where: Mines'] },
    'icon:stick Stick',
    {},
  ] }))
  if (l?.type === 'list') {
    check('list: numbered by default, the empty item left out', l.numbered && l.items.length === 4, l.items.length)
    check('list: a found picture, the title as written, text, fields, note', l.items[0].picture?.image === ID && l.items[0].title === 'Calbee Jagabee うすしお味' && l.items[0].text === 'Potato sticks' && l.items[0].fields.map((f) => f.join('=')).join() === 'Quantity=Lots!,Where=Konbini' && l.items[0].note === 'Big bags', l.items[0])
    check('list: an emoji picture, name as title, pairs, checked, price as a field', l.items[1].picture?.emoji === '🍵' && l.items[1].title === 'Matcha' && l.items[1].checked === true && l.items[1].fields.map((f) => f.join('=')).join() === 'Quantity=2,Price=¥980', l.items[1])
    check('list: icon pictures, {label, value} and "Label: value" fields', l.items[2].picture?.icon === 'iron_ingot' && l.items[2].fields.map((f) => f.join('=')).join() === 'Use=Tools,Where=Mines', l.items[2])
    check('list: a string item', l.items[3].title === 'Stick' && l.items[3].picture?.icon === 'stick', l.items[3])
  }
  const lt = visualBlockText(JSON.stringify({ type: 'list', items: [{ image: `image:${ID}`, title: 'Jagabee', text: 'Sticks', fields: { Quantity: 'Lots!' }, note: 'Big', checked: false }] }))
  check('list: text version', lt?.join('\n') === '1. [ ] Jagabee\n   Sticks\n   Quantity: Lots!\n   Note: Big', lt)
  check('list: "numbered": false', good('unnumbered', '{"type":"list","numbered":false,"items":["a"]}')[0]?.type === 'list' && visualBlockText('{"type":"list","numbered":false,"items":["a"]}')?.[0] === '• a')
  check('list: guessed from items, and "shopping_list" is a list', good('list guessed', '{"items":[{"title":"a"}]}')[0]?.type === 'list' && good('list alias', '{"type":"shopping_list","items":["a"]}')[0]?.type === 'list')
  check('list: the old "list" written with cards still reads', (() => {
    const [x] = good('list with cards', '{"type":"list","cards":[{"label":"Iron","text":"Smelt"}]}')
    return x?.type === 'list' && x.items[0].title === 'Iron' && x.items[0].text === 'Smelt'
  })())
  bad('list without items', '{"type":"list","title":"x"}', 'items')
  bad('list of empty items', '{"type":"list","items":[{}]}', 'items', /no items/)
  // image:<id> wherever icon:<slug> goes.
  const [cards] = good('cards with a found picture', `{"type":"cards","cards":[{"label":"Jagabee","image":"image:${ID}","icon":"chips"}]}`)
  check('cards: image:<id> beside an icon keeps both (the icon is the fallback)', cards?.type === 'cards' && cards.cards[0].image === ID && cards.cards[0].icon === 'chips', cards)
  const [tab] = good('table with a found picture', `{"type":"table","columns":["Item"],"rows":[["image:${ID} Jagabee"]]}`)
  check('table: "image:<id> Label" cells', tab?.type === 'table' && tab.rows[0][0]?.image === ID && tab.rows[0][0]?.label === 'Jagabee', tab)
  const [grid] = good('grid with a found picture', `{"type":"grid","slots":["image:${ID}"],"result":"Chips"}`)
  check('grid: image:<id> slots', grid?.type === 'grid' && grid.grids[0].slots[0]?.image === ID)
  const [bogus] = good('a bad image id is no picture', '{"type":"list","items":[{"image":"image:../../x","title":"x"},{"image":"image:<id>","title":"y"}]}')
  check('list: an image id outside [A-Za-z0-9_-]{6,64} is ignored', bogus?.type === 'list' && !bogus.items[0].picture && !bogus.items[1].picture, bogus)
}

// --- scene: the SVG sanitizer -------------------------------------------------------------------
{
  const colours = Object.fromEntries(SCENE_PALETTE.map((k, i) => [k, `rgb(${i}, ${i}, ${i})`])) as ScenePalette
  const out = (svg: string, icons?: Map<string, string | null>) => {
    const r = sanitizeSvg(svg)
    return r.ok ? serializeSvg(r.scene, { colours, icons }) : `ERROR ${r.message}`
  }
  /** What must never be in a sanitized drawing (the root's own xmlns aside). */
  const DANGER = [/<script/i, /<foreignObject/i, /<iframe/i, /<a[\s>]/i, /<animate/i, /<set[\s>]/i, /<svg[^>]*<svg/is, /\son[a-z]+\s*=/i, /javascript:/i, /vbscript:/i, /https?:/i, /\/\/evil/i, /@import/i, /url\((?!#)/i, /data:(?!image\/png;base64,)/i, /<!ENTITY/i, /<!DOCTYPE/i, /<filter/i, /<mask/i, /xlink:href/i]
  const safe = (name: string, svg: string, keep?: RegExp) => {
    const o = out(svg)
    const body = o.replace(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/, '<svg')
    const hit = DANGER.find((d) => d.test(body))
    check(`sanitize: ${name}: nothing dangerous left`, !hit, `${hit} in ${o}`)
    if (keep) check(`sanitize: ${name}: the drawing is kept`, keep.test(o), o)
    return o
  }
  const R = '<rect width="10" height="10"/>'
  safe('onload on the root', `<svg onload="alert(1)" viewBox="0 0 10 10">${R}</svg>`, /<rect/)
  safe('handlers in any case', `<svg viewBox="0 0 10 10"><rect ONLOAD="alert(1)" onClick='alert(1)' onmouseover=alert(1) width="5" height="5"/></svg>`, /<rect width="5" height="5"\/>/)
  safe('a script element', `<svg viewBox="0 0 10 10"><script>alert(1)</script><script type="text/javascript"><![CDATA[ if (a<b) alert(1) ]]></script>${R}</svg>`, /<rect/)
  safe('script, upper case and namespaced', `<svg viewBox="0 0 10 10"><SCRIPT>alert(1)</SCRIPT><svg:script>alert(1)</svg:script>${R}</svg>`, /<rect/)
  safe('a javascript: link', `<svg viewBox="0 0 10 10"><a href="javascript:alert(1)"><text y="5">click</text></a><a xlink:href="javascript:alert(1)">${R}</a><rect width="2" height="2"/></svg>`, /<rect width="2"/)
  safe('an encoded javascript: link', `<svg viewBox="0 0 10 10"><use href="&#x6A;ava&#x09;script:alert(1)"/><use href="java\nscript:alert(1)"/>${R}</svg>`, /<rect/)
  safe('foreignObject', `<svg viewBox="0 0 10 10"><foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml"><img src="x" onerror="alert(1)"/></div></foreignObject>${R}</svg>`, /<rect/)
  safe('use to an outside file', `<svg viewBox="0 0 10 10"><use href="http://evil.example/x.svg#a"/><use xlink:href="//evil.example/x.svg#a"/><use href="data:image/svg+xml,&lt;svg onload=alert(1)&gt;"/>${R}</svg>`, /<rect/)
  safe('CSS url() in attributes', `<svg viewBox="0 0 10 10"><rect fill="url(http://evil.example/x)" stroke="url('//evil.example/y')" width="3" height="3"/><rect style="fill:url(http://evil.example/z);stroke:red" width="4" height="4"/></svg>`, /<rect width="3" height="3"\/><rect style="stroke:rgb\(7, 7, 7\)"/)
  safe('a style element that loads', `<svg viewBox="0 0 10 10"><style>@import url(http://evil.example/a.css);</style><style>rect{fill:url(//evil.example/b)}</style><style>rect{fill:u\\72l(http://evil.example/c)}</style><style>rect { background: image-set("http://evil.example/d" 1x) }</style>${R}</svg>`, /<rect/)
  const css = safe('a plain style element', `<svg viewBox="0 0 10 10"><style>.belt { fill: var(--accent); stroke: border } rect:hover{opacity:.5}</style><rect class="belt" width="10" height="10"/></svg>`)
  check('sanitize: a plain style element is kept, its variables resolved', css.includes('<style>.belt{fill:rgb(0, 0, 0);stroke:border}rect:hover{opacity:.5}</style>'), css)
  safe('a style element with a closing tag trick', `<svg viewBox="0 0 10 10"><style>rect{fill:red}</style><script>alert(1)</script></style>${R}</svg>`, /<rect/)
  safe('entities from a DOCTYPE are never expanded', `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x "<script>alert(1)</script>"><!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;">]><svg viewBox="0 0 10 10"><text y="5">&x;&lol2;</text></svg>`, /<text y="5">&amp;x;&amp;lol2;<\/text>/)
  safe('CDATA text is text', `<svg viewBox="0 0 10 10"><text y="5"><![CDATA[<script>alert(1)</script> & co]]></text></svg>`, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; co/)
  safe('a nested svg', `<svg viewBox="0 0 10 10"><svg onload="alert(1)"><rect width="1" height="1"/></svg><g><svg><script>alert(1)</script></svg></g>${R}</svg>`, /<rect width="10"/)
  safe('animation that sets an attribute', `<svg viewBox="0 0 10 10"><rect width="10" height="10"><animate attributeName="href" to="javascript:alert(1)"/><set attributeName="onmouseover" to="alert(1)"/></rect><animateTransform attributeName="transform"/></svg>`, /<rect width="10" height="10"\/>/)
  safe('images other than icon:<slug>', `<svg viewBox="0 0 10 10"><image href="https://evil.example/x.png" width="5" height="5"/><image href="data:image/svg+xml;base64,PHN2Zz4=" width="5"/><image xlink:href="data:image/png;base64,AAAA"/>${R}</svg>`, /<rect/)
  safe('a value that tries to close its quote', `<svg viewBox="0 0 10 10"><rect id='a"/><script>alert(1)</script>' fill='red" onload="alert(1)' class="x&quot; onload=&quot;alert(1)" width="10" height="10"/></svg>`, /<rect width="10" height="10"\/>/)
  safe('tags split in odd places', `<svg viewBox="0 0 10 10"><scr<script>ipt>alert(1)</script><<script>script>alert(1)<</script>/script>${R}</svg>`)
  safe('a comment holding a script', `<svg viewBox="0 0 10 10"><!-- <script>alert(1)</script> -->${R}</svg>`, /<rect/)
  safe('xml:base, xmlns and other namespaces', `<svg xmlns:x="http://evil.example" xml:base="http://evil.example/" viewBox="0 0 10 10"><rect x:href="http://evil.example" xml:base="http://evil.example/" width="10" height="10"/></svg>`, /<rect width="10" height="10"\/>/)
  safe('filter, mask, iframe, embed, object', `<svg viewBox="0 0 10 10"><filter id="f"><feImage href="http://evil.example/x"/></filter><mask id="m"/><iframe src="javascript:alert(1)"/><embed src="x"/><object data="x"/>${R}</svg>`, /<rect/)
  const loop = out(`<svg viewBox="0 0 10 10"><g id="a"><use href="#a"/><rect width="1" height="1"/></g><g id="b"><use href="#a"/></g><use href="#b"/><use href="#missing"/><use href="#r"/><rect id="r" width="2" height="2"/></svg>`)
  check('sanitize: a use of itself, of a use or of nothing is left out; a plain one kept', (loop.match(/<use/g) ?? []).length === 2 && loop.includes('<use href="#r"/>') && loop.includes('<g id="b"><use href="#a"/></g>'), loop)
  const st = out(`<svg viewBox="0 0 10 10"><rect style="fill: blue; position: fixed; stroke-width: 2; behavior: url(x.htc)" width="1" height="1"/></svg>`)
  check('sanitize: a style attribute keeps only allowed properties', st.includes('style="fill:rgb(12, 12, 12);stroke-width:2"'), st)
  // Theme colours, icons, size.
  const t = out(`<svg viewBox="0 0 100 50"><rect fill="accent" stroke="var(--fg)" width="5" height="5"/><circle fill="copper" stroke="var(--nope, #123456)" r="3"/><path stroke="Muted" d="M0 0L5 5"/></svg>`)
  check('scene: palette names and var(--x) are the theme colours, others pass', t.includes('fill="rgb(0, 0, 0)" stroke="rgb(1, 1, 1)"') && t.includes('fill="copper" stroke="#123456"') && t.includes('stroke="rgb(3, 3, 3)"'), t)
  check('scene: resolveColours leaves a gradient url alone', resolveColours('url(#g)', colours) === 'url(#g)')
  check('scene: the root carries the size and the foreground as the default fill', /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 100 50" width="100" height="50" fill="rgb\(1, 1, 1\)"/.test(t), t.slice(0, 200))
  const png = 'data:image/png;base64,iVBORw0KGgo='
  const ic = out(`<svg viewBox="0 0 100 50"><image href="icon:Fluid_Tank" x="2" y="3" width="20" height="20"/><image href="icon:gone" x="40" y="3" width="20" height="20"/></svg>`, new Map([['fluid_tank', png], ['gone', null]]))
  check('scene: an icon is inlined as a data: picture', ic.includes(`<image href="${png}" x="2" y="3" width="20" height="20"/>`), ic)
  check('scene: a missing icon is a dashed tile with its letter', /<rect x="40" y="3" width="20" height="20"[^>]*stroke-dasharray="4 3"\/><text[^>]*>G<\/text>/.test(ic), ic)
  const found = sanitizeSvg(`<svg viewBox="0 0 100 50"><image href="image:w0123456789abcdef01234567" x="1" y="1" width="30" height="30"/><image href="image:bad/../x" width="5"/><image href="image:gone12" x="50" width="20" height="20"/></svg>`)
  check('scene: <image href="image:<id>"> is a picture to inline, a bad id is dropped', found.ok && found.scene.icons.join() === 'image:w0123456789abcdef01234567,image:gone12', found)
  if (found.ok) {
    const s = serializeSvg(found.scene, { colours, icons: new Map([['image:w0123456789abcdef01234567', png], ['image:gone12', null]]) })
    check('scene: a found picture is inlined, a missing one is a tile without a letter', s.includes(`<image href="${png}" x="1" y="1" width="30" height="30"/>`) && /<rect x="50" y="0" width="20" height="20"[^>]*stroke-dasharray="4 3"\/><text[^>]*><\/text>/.test(s), s)
  }
  const placed = parseVisual('{"type":"scene","svg":"<svg viewBox=\'0 0 50 50\'><rect width=\'5\' height=\'5\'/></svg>","icons":[{"icon":"image:w0123456789abcdef01234567","x":1,"y":2,"size":20}]}')
  check('scene: an "icons" entry may be image:<id>', placed.ok && placed.visuals[0].type === 'scene' && placed.visuals[0].scene.icons.includes('image:w0123456789abcdef01234567'), placed)
  const evilIcon = out(`<svg viewBox="0 0 10 10"><image href="icon:x" width="5" height="5"/></svg>`, new Map([['x', 'data:image/svg+xml,<svg onload=alert(1)>']]))
  check('scene: an icon URL that is not a data: picture is not used', !evilIcon.includes('data:image/svg') && !/onload/.test(evilIcon), evilIcon)
  const saved = sanitizeSvg('<svg viewBox="5 5 20 10"><circle r="2"/></svg>')
  check('scene: a saved drawing has the background first', saved.ok && serializeSvg(saved.scene, { colours, background: colours.bg }).includes('font-size="14"><rect x="5" y="5" width="20" height="10" fill="rgb(4, 4, 4)"/><circle'), saved)
  const bare = sanitizeSvg('<rect width="10" height="10"/>')
  check('scene: shapes without an <svg> around them draw at 640 × 400', bare.ok && bare.scene.viewBox.join() === '0,0,640,400' && bare.warnings.length === 1, bare)
  const sized = sanitizeSvg('<svg width="300" height="120"><rect width="10" height="10"/></svg>')
  check('scene: width and height make the viewBox', sized.ok && sized.scene.viewBox.join() === '0,0,300,120', sized)
  const unsafeOnly = sanitizeSvg('<svg viewBox="0 0 10 10"><script>alert(1)</script><foreignObject/></svg>')
  check('scene: a drawing with only unsafe parts is an error that says what was left out', !unsafeOnly.ok && /Nothing safe to draw/.test(unsafeOnly.message) && /script/.test(unsafeOnly.message), unsafeOnly)
  check('scene: an empty drawing is an error', !sanitizeSvg('<svg viewBox="0 0 10 10"><defs><rect id="a" width="1" height="1"/></defs></svg>').ok)
  check('scene: too long is an error', !sanitizeSvg(`<svg>${'<rect/>'.repeat(SCENE_LIMITS.chars / 6 + 1)}</svg>`).ok)
  const many = sanitizeSvg(`<svg viewBox="0 0 10 10">${'<rect width="1" height="1"/>'.repeat(SCENE_LIMITS.elements + 10)}</svg>`)
  check('scene: past the element limit the rest is left out, with a warning', many.ok && many.scene.children.length === SCENE_LIMITS.elements && many.warnings.some((w) => /first/.test(w)), many.ok ? many.warnings : many)
  const deep = sanitizeSvg(`<svg viewBox="0 0 10 10">${'<g>'.repeat(200)}<rect width="1" height="1"/>${'</g>'.repeat(200)}<rect width="2" height="2"/></svg>`)
  check('scene: deep nesting is cut, not a stack overflow', deep.ok, deep)
  const t0 = performance.now()
  sanitizeSvg(`<svg viewBox="0 0 10 10">${'<path d="M0 0 L10 10 C 1 2 3 4 5 6" stroke="accent" fill="none"/>'.repeat(1500)}</svg>`)
  const ms = performance.now() - t0
  check('scene: a big drawing is sanitized in under 150 ms', ms < 150, `${Math.round(ms)} ms`)

  // The spec around it.
  const create = `{"type":"scene","title":"Spout over a belt","caption":"The threshold switch stops the belt.","svg":"<svg viewBox='0 0 300 120'><rect x='10' y='10' width='40' height='50' fill='panel' stroke='border'/><text x='30' y='80' text-anchor='middle'>Tank</text><path d='M50 30 H120' stroke='accent' stroke-dasharray='6 4'/><text x='200' y='80'>Belt</text></svg>","icons":[{"icon":"cog","x":250,"y":10,"size":24},{"icon":"Bad Slug!"}]}`
  const [s] = good('scene', create)
  if (s?.type === 'scene') {
    check('scene: title, caption, viewBox', s.title === 'Spout over a belt' && s.caption === 'The threshold switch stops the belt.' && s.scene.viewBox.join() === '0,0,300,120', s)
    check('scene: the icons list adds icon pictures', s.scene.icons.includes('cog'), s.scene.icons)
  }
  const r = parseVisual(create)
  check('scene: a bad icon is a warning', r.ok && r.warnings.some((w) => w.path === 'icons[1]'), r.ok ? r.warnings : r)
  check('scene: text version is the title, caption and labels', JSON.stringify(visualBlockText(create)) === JSON.stringify(['Spout over a belt', 'The threshold switch stops the belt.', '(drawing: Tank · Belt)']), visualBlockText(create))
  check('scene: no labels is "(drawing)"', visualBlockText(`{"type":"scene","svg":"<rect width='4' height='4'/>"}`)?.at(-1) === '(drawing)')
  check('scene: svg as a list of lines, type guessed', good('scene lines', `{"svg":["<svg viewBox='0 0 10 10'>","<circle r='4' cx='5' cy='5'/>","</svg>"]}`)[0]?.type === 'scene')
  check('scene: a backtick string with new lines', good('scene backticks', '{type: "drawing", svg: `<svg viewBox="0 0 10 10">\n  <circle r="4" cx="5" cy="5"/>\n</svg>`}')[0]?.type === 'scene')
  bad('scene without svg', '{"type":"scene","title":"x"}', 'svg', /Missing/)
  bad('scene with only a script', `{"type":"scene","svg":"<script>alert(1)</script>"}`, 'svg', /Nothing safe/)
  bad('scene svg not a string', '{"type":"scene","svg":42}', 'svg')
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
  check('prompt: has examples of every type', ['flow', 'grid', 'tree', 'timeline', 'chart', 'cards', 'list', 'table', 'scene'].every((t) => examples.some((e) => e.includes(`"type":"${t}"`))), examples.length)
  for (const e of examples) {
    const r = parseVisual(e)
    check(`prompt example is valid: ${e.slice(0, 50)}…`, r.ok && !r.warnings.length, r.ok ? r.warnings : r.errors)
  }
  check('prompt: short (under 4000 characters)', VISUAL_PROMPT.length < 4000, VISUAL_PROMPT.length)
}

console.log(`${passed} passed, ${failed} failed`)
if (failed) process.exit(1)
