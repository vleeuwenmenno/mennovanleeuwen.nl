import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import { parseVisual, type Card, type Direction, type FlowEdge, type FlowNode, type Grid, type ListRow, type Series, type TimelineEvent, type TreeNode, type VItem, type Visual } from './spec.ts'
import { edgeMid, edgePath, layered } from './layout.ts'
import { AppIcon, hasAppIcon } from '../../os/icons'
import { useIsMobile } from '../../os/useIsMobile'
import { useTheme } from '../../os/theme'
import { PALETTE_VARS, SCENE_LIMITS, SCENE_PALETTE, serializeSvg, type ScenePalette } from './svg.ts'
import './visual.css'

// Draws a ```visual block (spec.ts reads it). Loaded on demand by MarkdownPreview, so the
// Markdown everywhere else costs nothing extra. Everything is HTML and a little SVG coloured
// through the theme's CSS variables; nothing redraws per frame (zooming a flow sets two styles).
// A scene (a model's own SVG, cleaned by svg.ts) is the one exception to "HTML we write": it shows
// as an <img> of a data: URL, where no script runs and nothing outside loads.

/** Categorical colours in a fixed order (never cycled past the series limit, spec.ts LIMITS.series). */
const HUES = ['var(--blue)', 'var(--orange)', 'var(--green)', 'var(--magenta)', 'var(--cyan)', 'var(--yellow)', 'var(--red)', 'var(--fg)']
const hueOf = (s: string) => {
  let h = 0
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) | 0
  return HUES[Math.abs(h) % 6]
}

/** Pictures (icon slugs, image:<id>) that came back missing, so they are not asked for again on every render. */
const missing = new Set<string>()
const labelOf = (it: VItem) => it.label || (it.icon ? it.icon.replace(/[_-]+/g, ' ') : it.app ?? '')
/** Where a picture is served: a found picture (find_image) or an icon library one. */
const pictureUrl = (key: string) => (key.startsWith('image:') ? `/api/agents/images/${encodeURIComponent(key.slice(6))}` : `/api/agents/icons/${encodeURIComponent(key)}`)

/**
 * An item's picture: a found picture (image:<id>), else the icon library's (falling back to the
 * emoji, then the first letter in a tinted tile), an app's icon, or the emoji. `always` gives a
 * letter tile even when the item asked for no picture (a grid slot). `photo` fills the square
 * (cropped), for a list's pictures; elsewhere the whole picture fits inside.
 */
function VIcon({ it, size, always = false, photo = false }: { it: VItem; size: number; always?: boolean; photo?: boolean }) {
  const keys = [it.image && `image:${it.image}`, it.icon].filter((k): k is string => !!k)
  const first = () => keys.find((k) => !missing.has(k))
  const [key, setKey] = useState(first)
  useEffect(() => setKey(first()), [it.image, it.icon])
  const label = labelOf(it)
  if (key)
    return (
      <img
        className={`vis-img ${key.startsWith('image:') ? 'is-photo' : ''} ${photo ? 'is-cover' : ''}`}
        src={pictureUrl(key)}
        width={size}
        height={size}
        alt={label}
        loading="lazy"
        draggable={false}
        onError={() => {
          missing.add(key)
          setKey(first())
        }}
      />
    )
  if (it.app && hasAppIcon(it.app)) return <AppIcon app={it.app} size={size} tone />
  if (it.emoji)
    return (
      <span className="vis-emoji" style={{ fontSize: Math.round(size * 0.78), width: size, height: size }} aria-hidden>
        {it.emoji}
      </span>
    )
  if (!it.icon && !it.image && !it.app && !always) return null
  const letter = [...label.trim()][0]?.toUpperCase() ?? '?'
  return (
    <span className="vis-letter" style={{ width: size, height: size, fontSize: Math.round(size * 0.5), ['--hue' as string]: hueOf(label) }} aria-hidden>
      {letter}
    </span>
  )
}
const hasPicture = (it: VItem) => !!(it.icon || it.image || it.app || it.emoji)

/** Text width in px for the monospace UI face (0.6em a character, CJK a full em). */
function textW(s: string, px = 13) {
  let w = 0
  for (const ch of s) w += /[ᄀ-ᇿ⺀-꓏가-힯豈-﫿︰-﹏＀-￯]|\p{Extended_Pictographic}/u.test(ch) ? px : px * 0.6
  return w
}

// --- flow and tree ----------------------------------------------------------------------------

type Drawn = { id: string; it: VItem; shape: FlowNode['shape']; group?: string }
const PAD = 10
const MAX_LABEL = 176

function nodeSize(n: Drawn) {
  const lw = textW(n.it.label)
  const nw = n.it.note ? textW(n.it.note, 11) : 0
  const icon = hasPicture(n.it) || n.it.icon ? 30 : 0
  const inner = Math.min(MAX_LABEL, Math.max(lw, nw, 24))
  const lines = Math.min(3, Math.max(1, Math.ceil(lw / MAX_LABEL)))
  let w = Math.ceil(inner + 22 + icon)
  let h = Math.max(icon ? 42 : 36, lines * 17 + 18 + (n.it.note ? 15 : 0))
  if (n.shape === 'diamond') {
    w = Math.ceil(w * 1.5)
    h = Math.max(64, Math.ceil(h * 1.7))
  } else if (n.shape === 'circle') {
    const d = Math.max(56, Math.ceil(Math.max(w * 0.9, h)))
    w = h = d
  }
  return { w, h }
}

/**
 * A picture that fits its box: scaled down to the width (not below half size, scrolling past
 * that), or up to `grow` times. Ctrl+wheel and pinch zoom, a mouse drags it, − ⤢ + buttons zoom and
 * fit. The children are drawn at W × H and scaled with a transform; `sized` children (a picture)
 * fill the scaled box instead, so they stay sharp.
 */
function Zoomable({ W, H, maxH, grow = 1, sized = false, children, extra }: { W: number; H: number; maxH: number; grow?: number; sized?: boolean; children: ReactNode; /** More buttons; the row then sits under the picture rather than on it */ extra?: ReactNode }) {
  const view = useRef<HTMLDivElement>(null)
  const sizer = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLDivElement>(null)
  const scale = useRef(1)
  const zoomed = useRef(false)
  const apply = (s: number) => {
    scale.current = s
    if (sizer.current) {
      sizer.current.style.width = `${Math.ceil(W * s)}px`
      sizer.current.style.height = `${Math.ceil(H * s)}px`
    }
    if (canvas.current) canvas.current.style.transform = `scale(${s})`
  }
  const fit = () => {
    const w = view.current?.clientWidth || W
    let s = Math.min(grow, w / W, maxH / H)
    if (s < 0.5) s = Math.max(0.5, Math.min(grow, w / W))
    apply(s)
  }
  /** Zoom to `s`, keeping the point at (cx, cy) in the view where it is. */
  const zoomTo = (s: number, cx?: number, cy?: number) => {
    const v = view.current
    if (!v) return
    s = Math.min(2.5, Math.max(0.25, s))
    zoomed.current = true
    const px = cx ?? v.clientWidth / 2
    const py = cy ?? v.clientHeight / 2
    const ax = (v.scrollLeft + px) / scale.current
    const ay = (v.scrollTop + py) / scale.current
    apply(s)
    v.scrollLeft = ax * s - px
    v.scrollTop = ay * s - py
  }
  useLayoutEffect(() => {
    zoomed.current = false
    fit()
    const v = view.current
    if (!v || typeof ResizeObserver === 'undefined') return
    let last = v.clientWidth
    const ro = new ResizeObserver(() => {
      if (v.clientWidth === last) return
      last = v.clientWidth
      if (!zoomed.current) fit()
    })
    ro.observe(v)
    return () => ro.disconnect()
  }, [W, H, maxH, grow])

  // Ctrl+wheel and pinch zoom (both need a listener that may cancel), mouse drag to pan.
  useEffect(() => {
    const v = view.current
    if (!v) return
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      const r = v.getBoundingClientRect()
      zoomTo(scale.current * Math.exp(-e.deltaY * 0.0025), e.clientX - r.left, e.clientY - r.top)
    }
    let pinch: { d: number; s: number } | null = null
    const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY)
    const tstart = (e: TouchEvent) => {
      if (e.touches.length === 2) pinch = { d: dist(e.touches), s: scale.current }
    }
    const tmove = (e: TouchEvent) => {
      if (!pinch || e.touches.length !== 2) return
      e.preventDefault()
      const r = v.getBoundingClientRect()
      const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - r.left
      const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2 - r.top
      zoomTo(pinch.s * (dist(e.touches) / pinch.d), cx, cy)
    }
    const tend = (e: TouchEvent) => {
      if (e.touches.length < 2) pinch = null
    }
    v.addEventListener('wheel', wheel, { passive: false })
    v.addEventListener('touchstart', tstart, { passive: true })
    v.addEventListener('touchmove', tmove, { passive: false })
    v.addEventListener('touchend', tend)
    v.addEventListener('touchcancel', tend)
    return () => {
      v.removeEventListener('wheel', wheel)
      v.removeEventListener('touchstart', tstart)
      v.removeEventListener('touchmove', tmove)
      v.removeEventListener('touchend', tend)
      v.removeEventListener('touchcancel', tend)
    }
  }, [W, H])
  const drag = useRef<{ x: number; y: number; l: number; t: number; id: number } | null>(null)
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    const v = view.current
    if (e.pointerType !== 'mouse' || e.button !== 0 || !v || (v.scrollWidth <= v.clientWidth && v.scrollHeight <= v.clientHeight)) return
    drag.current = { x: e.clientX, y: e.clientY, l: v.scrollLeft, t: v.scrollTop, id: e.pointerId }
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    const v = view.current
    if (!d || !v || d.id !== e.pointerId) return
    if (!v.classList.contains('is-dragging') && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) {
      v.classList.add('is-dragging')
      v.setPointerCapture(e.pointerId)
    }
    if (v.classList.contains('is-dragging')) {
      v.scrollLeft = d.l - (e.clientX - d.x)
      v.scrollTop = d.t - (e.clientY - d.y)
    }
  }
  const endDrag = () => {
    drag.current = null
    view.current?.classList.remove('is-dragging')
  }

  return (
    <div className="vis-diagram">
      <div className="vis-view" ref={view} style={{ maxHeight: maxH }} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag} data-no-touch-menu>
        <div className="vis-sizer" ref={sizer} style={{ width: W, height: H }}>
          {sized ? (
            children
          ) : (
            <div className="vis-canvas" ref={canvas} style={{ width: W, height: H }}>
              {children}
            </div>
          )}
        </div>
      </div>
      <div className={`vis-zoom ${extra ? 'is-below' : ''}`}>
        {extra}
        <button type="button" onClick={() => zoomTo(scale.current / 1.25)} title="Zoom out" aria-label="Zoom out">
          −
        </button>
        <button
          type="button"
          onClick={() => {
            zoomed.current = false
            fit()
          }}
          title="Fit"
          aria-label="Fit to the width"
        >
          ⤢
        </button>
        <button type="button" onClick={() => zoomTo(scale.current * 1.25)} title="Zoom in" aria-label="Zoom in">
          +
        </button>
      </div>
    </div>
  )
}

/**
 * A layered diagram that fits its box: scaled down to the width (not below half size), scrolling
 * past that. Ctrl+wheel and pinch zoom, a mouse drags it, buttons zoom and fit.
 */
function Diagram({ nodes, edges, groups, dir: asked, arrows }: { nodes: Drawn[]; edges: FlowEdge[]; groups: { id: string; label: string }[]; dir: Direction; arrows: boolean }) {
  const mobile = useIsMobile()
  // A phone is narrow and tall: a diagram that runs sideways runs down there instead.
  const dir: Direction = mobile && asked === 'right' ? 'down' : mobile && asked === 'left' ? 'up' : asked
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '')
  const layout = useMemo(() => {
    const sized = nodes.map((n) => ({ id: n.id, ...nodeSize(n) }))
    return layered(sized, edges, dir, { rankGap: edges.some((e) => e.label) ? 56 : 44, nodeGap: 22 })
  }, [nodes, edges, dir])
  const groupBoxes = useMemo(
    () =>
      groups.flatMap((g) => {
        const members = nodes.filter((n) => n.group === g.id).map((n) => layout.nodes.get(n.id)!)
        if (!members.length) return []
        const x0 = Math.min(...members.map((b) => b.x - b.w / 2)) - 10
        const y0 = Math.min(...members.map((b) => b.y - b.h / 2)) - 22
        const x1 = Math.max(...members.map((b) => b.x + b.w / 2)) + 10
        const y1 = Math.max(...members.map((b) => b.y + b.h / 2)) + 10
        return [{ ...g, x0, y0, x1, y1 }]
      }),
    [groups, nodes, layout],
  )
  // Room for the group labels above the top row and for self-loops.
  const top = Math.max(0, ...groupBoxes.map((g) => -g.y0)) + PAD
  const left = Math.max(0, ...groupBoxes.map((g) => -g.x0)) + PAD
  const W = Math.ceil(Math.max(layout.width, ...groupBoxes.map((g) => g.x1)) + left + PAD + 20)
  const H = Math.ceil(Math.max(layout.height, ...groupBoxes.map((g) => g.y1)) + top + PAD)
  const maxH = mobile ? Math.round(window.innerHeight * 0.6) : 520


  const at = (id: string) => {
    const b = layout.nodes.get(id)!
    return { ...b, x: b.x + left, y: b.y + top }
  }
  const shift = (p: { x: number; y: number }) => ({ x: p.x + left, y: p.y + top })
  const byId = new Map(nodes.map((n) => [n.id, n]))
  return (
    <Zoomable W={W} H={H} maxH={maxH}>
            {groupBoxes.map((g) => (
              <div key={g.id} className="vis-group" style={{ left: g.x0 + left, top: g.y0 + top, width: g.x1 - g.x0, height: g.y1 - g.y0 }}>
                <span>{g.label}</span>
              </div>
            ))}
            <svg className="vis-edges" width={W} height={H} aria-hidden>
              {arrows && (
                <defs>
                  <marker id={`${uid}a`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse" markerUnits="userSpaceOnUse">
                    <path d="M0,0 L10,5 L0,10 z" className="vis-arrowhead" />
                  </marker>
                </defs>
              )}
              {layout.edges.map((e, i) => {
                const edge = edges[i]
                if (e.self) {
                  const b = at(edge.from)
                  const x = b.x + b.w / 2
                  const y = b.y
                  return <path key={i} className={`vis-edge ${edge.dashed ? 'is-dashed' : ''}`} d={`M${x},${y - 8} C${x + 28},${y - 26} ${x + 28},${y + 26} ${x},${y + 8}`} markerEnd={arrows ? `url(#${uid}a)` : undefined} />
                }
                return <path key={i} className={`vis-edge ${edge.dashed ? 'is-dashed' : ''}`} d={edgePath(e.points.map(shift), dir)} markerEnd={arrows ? `url(#${uid}a)` : undefined} />
              })}
            </svg>
            {layout.edges.map((e, i) => {
              const label = edges[i].label
              if (!label) return null
              const m = e.self ? { x: at(edges[i].from).x + at(edges[i].from).w / 2 + 24, y: at(edges[i].from).y } : shift(edgeMid(e.points))
              return (
                <span key={i} className="vis-edge-label" style={{ left: m.x, top: m.y }}>
                  {label}
                </span>
              )
            })}
            {[...layout.nodes.keys()].map((id) => {
                const n = byId.get(id)!
                const b = at(id)
                const tip = [n.it.label, n.it.note].filter(Boolean).join(' — ')
                return (
                  <div key={id} className={`vis-node is-${n.shape}`} style={{ left: b.x - b.w / 2, top: b.y - b.h / 2, width: b.w, height: b.h }} title={tip}>
                    {n.shape === 'diamond' && (
                      <svg className="vis-diamond" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
                        <polygon points="50,1 99,50 50,99 1,50" vectorEffect="non-scaling-stroke" />
                      </svg>
                    )}
                    <VIcon it={n.it} size={24} />
                    <span className="vis-node-text">
                      <span className="vis-node-label">{n.it.count !== undefined && n.it.count !== 1 ? `${n.it.count}× ` : ''}{n.it.label}</span>
                      {n.it.note && <span className="vis-node-note">{n.it.note}</span>}
                    </span>
                  </div>
                )
              })}
    </Zoomable>
  )
}

function FlowView({ v }: { v: Extract<Visual, { type: 'flow' }> }) {
  const nodes = useMemo(() => v.nodes.map((n): Drawn => ({ id: n.id, it: n, shape: n.shape, group: n.group })), [v])
  return <Diagram nodes={nodes} edges={v.edges} groups={v.groups} dir={v.direction} arrows />
}

function TreeView({ v }: { v: Extract<Visual, { type: 'tree' }> }) {
  const { nodes, edges } = useMemo(() => {
    const nodes: Drawn[] = []
    const edges: FlowEdge[] = []
    const walk = (n: TreeNode, parent: string | null) => {
      const id = `t${nodes.length}`
      nodes.push({ id, it: n, shape: parent === null ? 'round' : 'box' })
      if (parent) edges.push({ from: parent, to: id })
      n.children.forEach((k) => walk(k, id))
    }
    v.roots.forEach((r) => walk(r, null))
    return { nodes, edges }
  }, [v])
  return <Diagram nodes={nodes} edges={edges} groups={[]} dir={v.direction} arrows={false} />
}

// --- grids --------------------------------------------------------------------------------------

function Slot({ it, size, result = false }: { it: VItem | null; size: number; result?: boolean }) {
  if (!it) return <span className="vis-slot is-empty" style={{ width: size, height: size }} />
  const pic = hasPicture(it)
  const tip = [it.count !== undefined && it.count !== 1 ? `${it.count}×` : '', it.label, it.note ? `— ${it.note}` : ''].filter(Boolean).join(' ')
  return (
    <span className={`vis-slot ${result ? 'is-result' : ''} ${pic ? '' : 'is-text'}`} style={{ width: size, height: size }} title={tip}>
      {pic ? <VIcon it={it} size={Math.round(size * 0.72)} /> : <span className="vis-slot-text">{it.label}</span>}
      {it.count !== undefined && it.count !== 1 && <span className="vis-count">{it.count}</span>}
    </span>
  )
}

function GridView({ v }: { v: Extract<Visual, { type: 'grid' }> }) {
  const mobile = useIsMobile()
  const size = mobile ? 40 : 46
  return (
    <div className="vis-grids">
      {v.grids.map((g, i) => (
        <OneGrid key={i} g={g} size={size} />
      ))}
    </div>
  )
}

function OneGrid({ g, size }: { g: Grid; size: number }) {
  // Under the grid: what each picture is, since a finger gets no tooltip.
  const legend = useMemo(() => {
    const seen = new Map<string, VItem>()
    for (const it of [...g.slots, ...g.result]) if (it && hasPicture(it) && it.label && !seen.has(it.label)) seen.set(it.label, it)
    return [...seen.values()]
  }, [g])
  return (
    <figure className="vis-recipe">
      {g.title && <figcaption>{g.title}</figcaption>}
      <div className="vis-recipe-row">
        {g.rows > 0 && (
          <div className="vis-slots" style={{ gridTemplateColumns: `repeat(${g.cols}, ${size}px)` }}>
            {g.slots.map((s, i) => (
              <Slot key={i} it={s} size={size} />
            ))}
          </div>
        )}
        {g.result.length > 0 && (
          <>
            <span className="vis-arrow">
              {g.via && <span className="vis-via">{g.via}</span>}
              <svg width="44" height="14" viewBox="0 0 44 14" aria-hidden>
                <path d="M1 7h38M33 2l6 5-6 5" />
              </svg>
            </span>
            <div className="vis-results">
              {g.result.map((r, i) => (
                <Slot key={i} it={r} size={Math.round(size * 1.2)} result />
              ))}
            </div>
          </>
        )}
      </div>
      {legend.length > 0 && (
        <ul className="vis-legend">
          {legend.map((it) => (
            <li key={it.label}>
              <VIcon it={it} size={16} />
              {it.label}
            </li>
          ))}
        </ul>
      )}
    </figure>
  )
}

// --- timeline, cards, table ----------------------------------------------------------------------

function TimelineView({ v }: { v: Extract<Visual, { type: 'timeline' }> }) {
  return (
    <ol className={`vis-timeline ${v.events.some((e) => e.when) ? '' : 'no-when'}`}>
      {v.events.map((e: TimelineEvent, i) => (
        <li key={i}>
          {v.events.some((x) => x.when) && <span className="vis-when">{e.when ?? ''}</span>}
          <span className="vis-rail" aria-hidden>
            <span className="vis-dot" />
          </span>
          <span className="vis-event">
            <span className="vis-event-head">
              <VIcon it={e} size={20} />
              <strong>{e.label}</strong>
            </span>
            {e.note && <span className="vis-muted">{e.note}</span>}
          </span>
        </li>
      ))}
    </ol>
  )
}

function CardsView({ v }: { v: Extract<Visual, { type: 'cards' }> }) {
  return (
    <div className="vis-cards">
      {v.cards.map((c: Card, i) => (
        <div key={i} className="vis-card">
          <div className="vis-card-head">
            <VIcon it={c} size={32} />
            {c.label && <strong>{c.count !== undefined && c.count !== 1 ? `${c.count}× ` : ''}{c.label}</strong>}
            {c.value && <span className="vis-badge">{c.value}</span>}
          </div>
          {(c.text || c.note) && <p>{c.text ?? c.note}</p>}
          {c.text && c.note && <p className="vis-muted">{c.note}</p>}
          {c.tags.length > 0 && (
            <div className="vis-tags">
              {c.tags.map((t) => (
                <span key={t}>{t}</span>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

/**
 * A list: a picture on the left (a found photo, an icon or an emoji), a bold numbered title, a line
 * of text, bold label rows and a note, with thin lines between the rows. A checkbox, when the spec
 * gives `checked`, only changes what is shown here (the answer itself stays as written).
 */
function ListView({ v }: { v: Extract<Visual, { type: 'list' }> }) {
  const mobile = useIsMobile()
  const size = mobile ? 72 : 104
  const [ticked, setTicked] = useState<Record<number, boolean>>({})
  const anyPicture = v.items.some((it) => it.picture)
  return (
    <ol className={`vis-list ${anyPicture ? '' : 'no-pictures'}`}>
      {v.items.map((it: ListRow, i) => {
        const done = ticked[i] ?? it.checked
        return (
          <li key={i} className={done ? 'is-done' : ''}>
            {anyPicture && <span className="vis-list-pic" style={{ width: size, height: size }}>{it.picture ? <VIcon it={it.picture} size={size} photo always /> : null}</span>}
            <div className="vis-list-body">
              <div className="vis-list-head">
                {done !== undefined && (
                  <input type="checkbox" className="vis-list-check" checked={done} onChange={(e) => setTicked({ ...ticked, [i]: e.currentTarget.checked })} aria-label={`${it.title || `Item ${i + 1}`} done`} />
                )}
                <strong className="vis-list-title">
                  {v.numbered ? `${i + 1}. ` : ''}
                  {it.title}
                </strong>
                {it.value && <span className="vis-badge">{it.value}</span>}
              </div>
              {it.text && <p className="vis-list-text">{it.text}</p>}
              {it.fields.length > 0 && (
                <dl className="vis-list-fields">
                  {it.fields.map(([l, val], j) => (
                    <div key={j}>
                      <dt>{l}:</dt>
                      <dd>{val}</dd>
                    </div>
                  ))}
                </dl>
              )}
              {it.note && <p className="vis-list-note">{it.note}</p>}
              {it.tags.length > 0 && (
                <div className="vis-tags">
                  {it.tags.map((t) => (
                    <span key={t}>{t}</span>
                  ))}
                </div>
              )}
            </div>
          </li>
        )
      })}
    </ol>
  )
}

function Cell({ it }: { it: VItem | null }) {
  if (!it) return null
  return (
    <span className="vis-cell" title={it.note}>
      <VIcon it={it} size={18} />
      {it.count !== undefined && it.count !== 1 ? `${it.count}× ` : ''}
      {it.label}
    </span>
  )
}

function TableView({ v }: { v: Extract<Visual, { type: 'table' }> }) {
  const numeric = v.columns.map((_, j) => v.rows.length > 0 && v.rows.every((r) => !r[j] || (/^[-+]?[\d.,]+\s*\S{0,4}$/.test(r[j]!.label) && !hasPicture(r[j]!))))
  return (
    <div className="vis-table md-table">
      <table>
        {v.columns.some(Boolean) && (
          <thead>
            <tr>
              {v.columns.map((c, j) => (
                <th key={j} style={{ textAlign: numeric[j] ? 'right' : undefined }}>
                  {c}
                </th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {v.rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j} style={{ textAlign: numeric[j] ? 'right' : undefined }}>
                  <Cell it={c} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// --- charts ---------------------------------------------------------------------------------------

/** About `count` round tick values covering [lo, hi]. */
function ticks(lo: number, hi: number, count = 4): number[] {
  if (lo === hi) hi = lo + 1
  const raw = (hi - lo) / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw
  const out: number[] = []
  for (let t = Math.floor(lo / step) * step; t <= hi + step * 1e-9; t += step) out.push(Math.round(t / step) * step)
  if (out[out.length - 1] < hi) out.push(out[out.length - 1] + step)
  return out
}
const short = (n: number) => {
  const a = Math.abs(n)
  if (a >= 1e9) return `${+(n / 1e9).toFixed(1)}B`
  if (a >= 1e6) return `${+(n / 1e6).toFixed(1)}M`
  if (a >= 1e4) return `${+(n / 1e3).toFixed(1)}k`
  return String(+n.toFixed(2))
}
const full = (n: number | null, unit?: string) => (n === null ? '–' : `${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}${unit ? ` ${unit}` : ''}`)

/** A bar with 4px rounded ends away from the baseline. */
function barPath(x: number, w: number, y0: number, y1: number) {
  const top = Math.min(y0, y1)
  const h = Math.abs(y1 - y0)
  const r = Math.min(4, w / 2, h)
  if (h < 0.5) return ''
  if (y1 <= y0) return `M${x},${y0} V${top + r} Q${x},${top} ${x + r},${top} H${x + w - r} Q${x + w},${top} ${x + w},${top + r} V${y0} Z`
  return `M${x},${y0} V${y1 - r} Q${x},${y1} ${x + r},${y1} H${x + w - r} Q${x + w},${y1} ${x + w},${y1 - r} V${y0} Z`
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [w, setW] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setW(el.clientWidth)
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, w] as const
}

function Legend({ items }: { items: { name: string; color: string; extra?: string }[] }) {
  return (
    <ul className="vis-legend">
      {items.map((s, i) => (
        <li key={i}>
          <span className="vis-swatch" style={{ background: s.color }} />
          {s.name}
          {s.extra && <span className="vis-muted"> {s.extra}</span>}
        </li>
      ))}
    </ul>
  )
}

function ChartView({ v }: { v: Extract<Visual, { type: 'chart' }> }) {
  const [asTable, setAsTable] = useState(false)
  return (
    <div className="vis-chart">
      {asTable ? <ChartTable v={v} /> : v.chart === 'pie' ? <Pie v={v} /> : <XYChart v={v} />}
      <button type="button" className="vis-chart-toggle" onClick={() => setAsTable(!asTable)} aria-pressed={asTable}>
        {asTable ? 'Chart' : 'Table'}
      </button>
    </div>
  )
}

function ChartTable({ v }: { v: Extract<Visual, { type: 'chart' }> }) {
  const series = v.chart === 'pie' ? v.series.slice(0, 1) : v.series
  return (
    <div className="vis-table md-table">
      <table>
        <thead>
          <tr>
            <th>{v.x ?? ''}</th>
            {series.map((s, i) => (
              <th key={i} style={{ textAlign: 'right' }}>
                {s.name || v.y || 'Value'}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {v.labels.map((l, i) => (
            <tr key={i}>
              <td>{l}</td>
              {series.map((s, j) => (
                <td key={j} style={{ textAlign: 'right' }}>
                  {full(s.values[i], v.unit)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function XYChart({ v }: { v: Extract<Visual, { type: 'chart' }> }) {
  const mobile = useIsMobile()
  const [box, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const H = mobile ? 200 : 230
  const values = v.series.flatMap((s) => s.values.filter((x): x is number => x !== null))
  const lo = Math.min(0, ...values)
  const hi = Math.max(0, ...values)
  const ys = ticks(lo, hi)
  const y0 = ys[0]
  const y1 = ys[ys.length - 1]
  const labelW = Math.max(...ys.map((t) => textW(short(t), 11))) + 8
  const m = { l: Math.ceil(labelW) + (v.y ? 16 : 0), r: 8, t: 10, b: 24 + (v.x ? 16 : 0) }
  const W = Math.max(200, width)
  const pw = W - m.l - m.r
  const ph = H - m.t - m.b
  const n = v.labels.length
  const band = pw / Math.max(1, n)
  const sy = (x: number) => m.t + ph - ((x - y0) / (y1 - y0 || 1)) * ph
  const cx = (i: number) => m.l + band * i + band / 2
  // Every k-th x label, so they never collide.
  const longest = Math.max(...v.labels.map((l) => textW(l, 11)))
  const every = Math.max(1, Math.ceil((longest + 10) / band))
  const k = v.series.length
  const barW = Math.max(2, Math.min(36, (band * 0.72 - (k - 1) * 2) / k))
  const groupW = barW * k + (k - 1) * 2
  const markers = n <= 40
  const tipX = hover === null ? 0 : cx(hover)
  return (
    <div className="vis-xy" ref={box}>
      {width > 0 && (
        <svg
          width={W}
          height={H}
          className="vis-chart-svg"
          onPointerMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            const i = Math.floor((e.clientX - r.left - m.l) / band)
            setHover(i >= 0 && i < n ? i : null)
          }}
          onPointerLeave={(e) => e.pointerType === 'mouse' && setHover(null)}
          role="img"
          aria-label={v.title ?? 'Chart'}
        >
          {ys.map((t) => (
            <g key={t}>
              <line x1={m.l} x2={W - m.r} y1={sy(t)} y2={sy(t)} className={t === 0 ? 'vis-axis' : 'vis-grid'} />
              <text x={m.l - 6} y={sy(t)} dy="0.32em" textAnchor="end" className="vis-tick">
                {short(t)}
              </text>
            </g>
          ))}
          {v.labels.map((l, i) =>
            i % every ? null : (
              <text key={i} x={cx(i)} y={m.t + ph + 16} textAnchor="middle" className="vis-tick">
                {l.length > 14 && every === 1 ? `${l.slice(0, 13)}…` : l}
              </text>
            ),
          )}
          {v.x && (
            <text x={m.l + pw / 2} y={H - 4} textAnchor="middle" className="vis-axis-title">
              {v.x}
            </text>
          )}
          {v.y && (
            <text transform={`translate(11 ${m.t + ph / 2}) rotate(-90)`} textAnchor="middle" className="vis-axis-title">
              {v.y}
            </text>
          )}
          {hover !== null && <rect x={m.l + band * hover} y={m.t} width={band} height={ph} className="vis-band" />}
          {v.chart === 'bar'
            ? v.series.map((s, si) =>
                s.values.map((x, i) =>
                  x === null ? null : <path key={`${si}.${i}`} d={barPath(cx(i) - groupW / 2 + si * (barW + 2), barW, sy(Math.max(y0, Math.min(0, y1))), sy(x))} style={{ fill: HUES[si] }} className="vis-bar" />,
                ),
              )
            : v.series.map((s, si) => {
                const pts = s.values.map((x, i) => (x === null ? null : `${cx(i)},${sy(x)}`))
                // A gap in the data breaks the line.
                const d = pts.reduce<string>((acc, p, i) => (p === null ? acc : `${acc}${i === 0 || pts[i - 1] === null ? 'M' : 'L'}${p}`), '')
                return (
                  <g key={si}>
                    <path d={d} className="vis-line" style={{ stroke: HUES[si] }} />
                    {markers && s.values.map((x, i) => (x === null ? null : <circle key={i} cx={cx(i)} cy={sy(x)} r={hover === i ? 5 : 4} className="vis-marker" style={{ fill: HUES[si] }} />))}
                  </g>
                )
              })}
        </svg>
      )}
      {hover !== null && (
        <div className="vis-tip" style={{ left: Math.min(Math.max(tipX, 70), W - 70), top: 4 }}>
          <strong>{v.labels[hover]}</strong>
          {v.series.map((s, si) => (
            <span key={si}>
              {k > 1 && <span className="vis-swatch" style={{ background: HUES[si] }} />}
              {k > 1 && `${s.name}: `}
              {full(s.values[hover], v.unit)}
            </span>
          ))}
        </div>
      )}
      {k > 1 && <Legend items={v.series.map((s: Series, i) => ({ name: s.name, color: HUES[i] }))} />}
    </div>
  )
}

function Pie({ v }: { v: Extract<Visual, { type: 'chart' }> }) {
  const [hover, setHover] = useState<number | null>(null)
  const mobile = useIsMobile()
  const slices = useMemo(() => {
    const all = v.labels.map((l, i) => ({ name: l, value: Math.max(0, v.series[0].values[i] ?? 0) })).filter((s) => s.value > 0)
    // Past seven slices the smallest fold into "Other", so the colours stay in their fixed order.
    if (all.length <= 8) return all
    const sorted = all.slice().sort((a, b) => b.value - a.value)
    return [...sorted.slice(0, 7), { name: 'Other', value: sorted.slice(7).reduce((a, s) => a + s.value, 0) }]
  }, [v])
  const total = slices.reduce((a, s) => a + s.value, 0) || 1
  const R = mobile ? 72 : 84
  const size = R * 2 + 8
  let angle = -Math.PI / 2
  const arcs = slices.map((s, i) => {
    const a0 = angle
    const a1 = (angle += (s.value / total) * Math.PI * 2)
    const c = size / 2
    const p = (a: number, r: number) => `${c + Math.cos(a) * r},${c + Math.sin(a) * r}`
    const large = a1 - a0 > Math.PI ? 1 : 0
    const inner = R * 0.55
    const d = slices.length === 1 ? `M${p(0, R)} A${R},${R} 0 1 1 ${p(Math.PI, R)} A${R},${R} 0 1 1 ${p(0, R)} M${p(0, inner)} A${inner},${inner} 0 1 0 ${p(Math.PI, inner)} A${inner},${inner} 0 1 0 ${p(0, inner)} Z` : `M${p(a0, R)} A${R},${R} 0 ${large} 1 ${p(a1, R)} L${p(a1, inner)} A${inner},${inner} 0 ${large} 0 ${p(a0, inner)} Z`
    return <path key={i} d={d} className={`vis-slice ${hover === i ? 'is-hover' : ''}`} style={{ fill: HUES[i] }} onPointerEnter={() => setHover(i)} onPointerDown={() => setHover(i)} onPointerLeave={(e) => e.pointerType === 'mouse' && setHover(null)} />
  })
  const h = hover === null ? null : slices[hover]
  return (
    <div className="vis-pie">
      <svg width={size} height={size} role="img" aria-label={v.title ?? 'Pie chart'} fillRule="evenodd">
        {arcs}
        <text x={size / 2} y={size / 2} textAnchor="middle" dy="-0.2em" className="vis-pie-value">
          {h ? `${Math.round((h.value / total) * 100)}%` : full(total, v.unit)}
        </text>
        <text x={size / 2} y={size / 2} textAnchor="middle" dy="1.1em" className="vis-tick">
          {h ? (h.name.length > 14 ? `${h.name.slice(0, 13)}…` : h.name) : 'total'}
        </text>
      </svg>
      <Legend items={slices.map((s, i) => ({ name: s.name, color: HUES[i], extra: `${full(s.value, v.unit)} · ${Math.round((s.value / total) * 100)}%` }))} />
    </div>
  )
}

// --- scenes (a drawing in SVG) --------------------------------------------------------------------

/**
 * Icon pictures as data: URLs, for drawings: an <img> of an SVG loads nothing from outside, so
 * every picture goes inside it. One request per slug; a miss is not kept, so a later drawing asks again.
 */
const iconData = new Map<string, Promise<string | null>>()
function loadIcon(slug: string): Promise<string | null> {
  let p = iconData.get(slug)
  if (!p) {
    p = fetch(pictureUrl(slug))
      .then((r) => (r.ok ? r.blob() : null))
      .then(
        (b) =>
          b && /^image\/(png|jpeg|webp|gif)$/.test(b.type)
            ? new Promise<string | null>((done) => {
                const fr = new FileReader()
                fr.onload = () => done(typeof fr.result === 'string' ? fr.result : null)
                fr.onerror = () => done(null)
                fr.readAsDataURL(b)
              })
            : null,
      )
      .catch(() => null)
      .then((url) => {
        if (!url) iconData.delete(slug)
        return url
      })
    iconData.set(slug, p)
  }
  return p
}

/** The theme's colours for the scene palette, as the page computes them right now. */
function readPalette(host: HTMLElement): { colours: ScenePalette; font: string } {
  const probe = document.createElement('span')
  probe.style.display = 'none'
  host.appendChild(probe)
  const colours = {} as ScenePalette
  for (const k of SCENE_PALETTE) {
    probe.style.color = `var(${PALETTE_VARS[k]})`
    colours[k] = getComputedStyle(probe).color
  }
  probe.style.fontFamily = 'var(--ui)'
  const ui = getComputedStyle(probe).fontFamily
  probe.remove()
  return { colours, font: `${ui ? `${ui}, ` : ''}system-ui, sans-serif` }
}

const fileName = (title: string | undefined) => (title ?? 'drawing').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 60) || 'drawing'
function saveBlob(blob: Blob, name: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
}

function SceneView({ v }: { v: Extract<Visual, { type: 'scene' }> }) {
  const theme = useTheme()
  const mobile = useIsMobile()
  const host = useRef<HTMLDivElement>(null)
  const [look, setLook] = useState<{ colours: ScenePalette; font: string } | null>(null)
  const [icons, setIcons] = useState<Map<string, string | null> | null>(v.scene.icons.length ? null : new Map())
  const [broken, setBroken] = useState(false)
  const [saving, setSaving] = useState<string | null>(null)
  // The colours again whenever the theme or accent changes.
  const themeKey = `${theme.mode}${theme.name}${theme.accent}`
  useLayoutEffect(() => {
    if (host.current) setLook(readPalette(host.current))
  }, [themeKey])
  useEffect(() => {
    if (!v.scene.icons.length) return setIcons(new Map())
    let live = true
    // Wait for the pictures (at most a few seconds), so the drawing does not show tiles and then redraw.
    const timeout = new Promise<null>((done) => setTimeout(() => done(null), 4000))
    void Promise.all(v.scene.icons.map((slug) => Promise.race([loadIcon(slug), timeout]).then((url) => [slug, url] as const))).then((pairs) => live && setIcons(new Map(pairs)))
    return () => {
      live = false
    }
  }, [v])
  const svg = useMemo(() => (look && icons ? serializeSvg(v.scene, { colours: look.colours, icons, font: look.font }) : null), [v, look, icons])
  const src = useMemo(() => (svg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` : null), [svg])
  useEffect(() => setBroken(false), [src])
  const [, , vw, vh] = v.scene.viewBox
  const k = Math.min(1, SCENE_LIMITS.size / Math.max(vw, vh))
  const W = Math.max(1, Math.round(vw * k))
  const H = Math.max(1, Math.round(vh * k))
  const maxH = mobile ? Math.round(window.innerHeight * 0.6) : 560
  // A small drawing grows to a readable width (up to twice its size), a large one fits.
  const grow = Math.max(1, Math.min(2, 720 / W))

  const save = async (kind: 'svg' | 'png') => {
    if (!look || !icons) return
    setSaving(kind)
    try {
      // Saved with the theme's background behind it, so it reads outside this page too.
      const doc = serializeSvg(v.scene, { colours: look.colours, icons, font: look.font, background: look.colours.bg })
      if (kind === 'svg') return saveBlob(new Blob([doc], { type: 'image/svg+xml' }), `${fileName(v.title)}.svg`)
      const img = new Image()
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(doc)}`
      await img.decode()
      const s = Math.min(2, 4096 / Math.max(W, H))
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(W * s)
      canvas.height = Math.round(H * s)
      canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height)
      const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, 'image/png'))
      if (blob) saveBlob(blob, `${fileName(v.title)}.png`)
    } catch {
      /* nothing saved; the drawing itself still shows */
    } finally {
      setSaving(null)
    }
  }

  return (
    <div className="vis-scene" ref={host}>
      {broken ? (
        <p className="vis-scene-broken">This drawing could not be shown. Its spec is under Spec.</p>
      ) : src ? (
        <Zoomable
          W={W}
          H={H}
          maxH={maxH}
          grow={grow}
          sized
          extra={
            <>
              <button type="button" onClick={() => void save('svg')} disabled={!!saving} title="Save as SVG">
                SVG
              </button>
              <button type="button" onClick={() => void save('png')} disabled={!!saving} title="Save as PNG">
                PNG
              </button>
            </>
          }
        >
          <img className="vis-scene-img" src={src} alt={[v.title, v.caption, v.scene.labels.join(', ')].filter(Boolean).join(' — ') || 'Drawing'} draggable={false} onError={() => setBroken(true)} />
        </Zoomable>
      ) : (
        <div className="vis-pending vis-scene-wait" style={{ aspectRatio: `${W} / ${H}`, maxHeight: maxH }}>
          Drawing…
        </div>
      )}
      {v.caption && <p className="vis-caption">{v.caption}</p>}
    </div>
  )
}

// --- the block -------------------------------------------------------------------------------------

function One({ v }: { v: Visual }) {
  let body: ReactNode
  switch (v.type) {
    case 'flow':
      body = <FlowView v={v} />
      break
    case 'tree':
      body = <TreeView v={v} />
      break
    case 'grid':
      body = <GridView v={v} />
      break
    case 'timeline':
      body = <TimelineView v={v} />
      break
    case 'chart':
      body = <ChartView v={v} />
      break
    case 'cards':
      body = <CardsView v={v} />
      break
    case 'table':
      body = <TableView v={v} />
      break
    case 'list':
      body = <ListView v={v} />
      break
    case 'scene':
      body = <SceneView v={v} />
      break
  }
  return (
    <section className={`vis-one vis-kind-${v.type}`}>
      {v.title && <h4 className="vis-title">{v.title}</h4>}
      {body}
    </section>
  )
}

/**
 * A ```visual block. `open`: the fence is not closed yet (an answer still streaming in), so a spec
 * that does not read yet is "drawing", not an error.
 */
export function VisualBlock({ source, open = false }: { source: string; open?: boolean }) {
  const result = useMemo(() => parseVisual(source), [source])
  const [showSpec, setShowSpec] = useState(false)
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const copy = () =>
    void navigator.clipboard?.writeText(source).then(
      () => {
        setCopied(true)
        clearTimeout(timer.current)
        timer.current = setTimeout(() => setCopied(false), 1500)
      },
      () => {},
    )
  if (!result.ok && open) return <div className="vis vis-pending">Drawing…</div>
  if (!result.ok)
    return (
      <div className="vis vis-error" role="note">
        <p className="vis-error-head">This visual could not be drawn:</p>
        <ul>
          {result.errors.slice(0, 6).map((e, i) => (
            <li key={i}>
              <code>{e.path}</code> {e.message}
            </li>
          ))}
        </ul>
        <pre className="vis-source">{source}</pre>
      </div>
    )
  return (
    <div className="vis">
      {result.visuals.map((v, i) => (
        <Fragment key={i}>
          <One v={v} />
        </Fragment>
      ))}
      <div className="vis-tools">
        <button type="button" onClick={() => setShowSpec(!showSpec)} aria-pressed={showSpec} title="Show the spec this was drawn from">
          {showSpec ? 'Hide spec' : 'Spec'}
        </button>
        <button type="button" className={copied ? 'is-done' : ''} onClick={copy} title="Copy the spec">
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {showSpec && <pre className="vis-source">{source}</pre>}
    </div>
  )
}

export default VisualBlock
