import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist'
import { download, fileLink, isSf, libraryName, parseSf } from '../data/seafile'
import { folderOf, nameOf } from '../data/media'
import { useWM, type WinState } from '../os/wm'
import { prettyPath } from '../terminal/vfs'

// PDF, after macOS Preview's PDF view, on Mozilla's pdf.js (loaded when a PDF opens): the pages
// one under the other in their own scrolling area, drawn as they come into view, with text you
// can select and search (Ctrl+F, every match highlighted, Enter for the next). A sidebar with the
// pages or the table of contents, the page number to type in, fit width, fit page or a zoom of
// your own (Ctrl+wheel or a pinch zoom towards the pointer), rotate, a night mode and full screen.

type Fit = 'width' | 'page' | 'free'
type Size = { w: number; h: number }
type Match = { page: number; index: number }
type OutlineItem = { title: string; dest: unknown; items: OutlineItem[] }

const GAP = 14 // px between pages
const PAD = 16
const MIN = 0.25
const MAX = 6
const PREFS = 'mvlos.pdf'

let lib: Promise<typeof import('pdfjs-dist')> | null = null
/** pdf.js and its worker, fetched the first time a PDF opens. */
function pdfjs() {
  lib ??= Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]).then(([m, worker]) => {
    m.GlobalWorkerOptions.workerSrc = worker.default
    return m
  })
  return lib
}

function loadPrefs(): { sidebar: boolean; night: boolean } {
  try {
    return { sidebar: true, night: false, ...JSON.parse(localStorage.getItem(PREFS) ?? '{}') }
  } catch {
    return { sidebar: true, night: false }
  }
}

export const pdfTitle = (w: WinState) => (w.props.path ? nameOf(w.props.path) : 'PDF')

export function PdfViewer({ win }: { win: WinState }) {
  const wm = useWM()
  const path = win.props.path ?? ''
  const name = nameOf(path)
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sizes, setSizes] = useState<Size[]>([])
  const [fit, setFit] = useState<Fit>('width')
  const [zoom, setZoom] = useState(1)
  const [rotation, setRotation] = useState(0)
  const [page, setPage] = useState(1)
  const [prefs, setPrefsState] = useState(loadPrefs)
  const [tab, setTab] = useState<'pages' | 'outline'>('pages')
  const [outline, setOutline] = useState<OutlineItem[] | null>(null)
  const [full, setFull] = useState(false)
  const [box, setBox] = useState({ w: 0, h: 0 })
  const [find, setFind] = useState<{ query: string; matches: Match[]; current: number } | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const findInput = useRef<HTMLInputElement>(null)
  const texts = useRef<string[] | null>(null)
  const pendingScroll = useRef<{ x: number; y: number } | null>(null)

  const setPrefs = (p: Partial<{ sidebar: boolean; night: boolean }>) =>
    setPrefsState((old) => {
      const next = { ...old, ...p }
      try {
        localStorage.setItem(PREFS, JSON.stringify(next))
      } catch {
        /* not kept */
      }
      return next
    })

  // --- loading --------------------------------------------------------------------------------

  useEffect(() => {
    if (!path || !isSf(path)) return setError(path ? 'Only PDFs in Seafile open here.' : 'Nothing to show.')
    let live = true
    let task: { destroy: () => Promise<void> } | null = null
    setDoc(null)
    setError(null)
    setSizes([])
    setOutline(null)
    texts.current = null
    ;(async () => {
      const link = await fileLink(path, 'download')
      if (!live) return
      const res = await fetch(link)
      if (!res.ok) throw new Error(`Seafile answered ${res.status}`)
      const data = new Uint8Array(await res.arrayBuffer())
      const m = await pdfjs()
      const loading = m.getDocument({ data })
      task = loading
      const loaded = await loading.promise
      if (!live) return void loading.destroy()
      setDoc(loaded)
      // Every page's size first (cheap), so the scroll area is right before anything is drawn.
      const first = await loaded.getPage(1)
      const base = first.getViewport({ scale: 1 })
      setSizes(Array.from({ length: loaded.numPages }, () => ({ w: base.width, h: base.height })))
      for (let i = 2; i <= loaded.numPages && live; i++) {
        const v = (await loaded.getPage(i)).getViewport({ scale: 1 })
        if (v.width !== base.width || v.height !== base.height) setSizes((s) => s.map((x, k) => (k === i - 1 ? { w: v.width, h: v.height } : x)))
      }
      const o = (await loaded.getOutline().catch(() => null)) as OutlineItem[] | null
      if (live) setOutline(o?.length ? o : null)
    })().catch((e: Error) => live && setError(e.message === 'Locked' || /locked/i.test(e.message) ? 'The library is locked: unlock it in Files first.' : `This PDF could not be opened (${e.message}).`))
    return () => {
      live = false
      void task?.destroy()
    }
  }, [path])

  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // --- zoom -----------------------------------------------------------------------------------

  const turned = rotation % 180 !== 0
  const first = sizes[0] ? (turned ? { w: sizes[0].h, h: sizes[0].w } : sizes[0]) : { w: 612, h: 792 }
  const widest = sizes.reduce((m, s) => Math.max(m, turned ? s.h : s.w), first.w)
  const scale = fit === 'width' ? Math.max(MIN, (box.w - PAD * 2) / widest) : fit === 'page' ? Math.max(MIN, Math.min((box.w - PAD * 2) / first.w, (box.h - PAD * 2) / first.h)) : zoom
  const sized = useMemo(() => sizes.map((s) => (turned ? { w: s.h * scale, h: s.w * scale } : { w: s.w * scale, h: s.h * scale })), [sizes, scale, turned])
  const tops = useMemo(() => {
    const out: number[] = []
    let y = PAD
    for (const s of sized) {
      out.push(y)
      y += s.h + GAP
    }
    return out
  }, [sized])

  /** Zooms to `next`, keeping the document point under the pointer (or the middle) still. */
  const zoomTo = useCallback(
    (next: number, cx?: number, cy?: number) => {
      const el = scroller.current
      const s1 = Math.max(MIN, Math.min(MAX, next))
      if (!el) return
      const px = cx ?? el.clientWidth / 2
      const py = cy ?? el.clientHeight / 2
      const k = s1 / scale
      // Scrolled once the pages have their new size (before, the scroll area is too short for it).
      pendingScroll.current = { x: (el.scrollLeft + px) * k - px, y: (el.scrollTop + py) * k - py }
      setZoom(s1)
      setFit('free')
    },
    [scale],
  )
  useLayoutEffect(() => {
    const to = pendingScroll.current
    if (!to) return
    pendingScroll.current = null
    scroller.current?.scrollTo(to.x, to.y)
  }, [scale])

  // Ctrl+wheel and pinches zoom; plain scrolling scrolls the pages and nothing else.
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      const r = el.getBoundingClientRect()
      zoomTo(scale * Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025)), e.clientX - r.left, e.clientY - r.top)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomTo, scale])

  // --- pages ----------------------------------------------------------------------------------

  const onScroll = () => {
    const el = scroller.current
    if (!el || !tops.length) return
    const mid = el.scrollTop + el.clientHeight / 3
    let p = 1
    for (let i = 0; i < tops.length; i++) if (tops[i] <= mid) p = i + 1
    if (p !== page) setPage(p)
  }
  const goTo = (n: number, smooth = false) => {
    const p = Math.max(1, Math.min(sizes.length, n))
    scroller.current?.scrollTo({ top: tops[p - 1] - PAD / 2, behavior: smooth ? 'smooth' : 'auto' })
    setPage(p)
  }

  // --- finding --------------------------------------------------------------------------------

  const search = async (query: string) => {
    if (!doc || !query.trim()) return setFind((f) => (f ? { ...f, query, matches: [], current: 0 } : f))
    if (!texts.current) {
      const all: string[] = []
      for (let i = 1; i <= doc.numPages; i++) {
        const content = await (await doc.getPage(i)).getTextContent()
        all.push(content.items.map((it) => ('str' in it ? it.str : '')).join(' '))
      }
      texts.current = all
    }
    const q = query.toLowerCase()
    const matches: Match[] = []
    texts.current.forEach((t, p) => {
      const hay = t.toLowerCase()
      for (let i = hay.indexOf(q); i >= 0 && matches.length < 2000; i = hay.indexOf(q, i + q.length)) matches.push({ page: p + 1, index: i })
    })
    setFind({ query, matches, current: 0 })
    if (matches.length) goTo(matches[0].page)
  }
  const step = (by: number) =>
    setFind((f) => {
      if (!f || !f.matches.length) return f
      const current = (f.current + by + f.matches.length) % f.matches.length
      goTo(f.matches[current].page)
      return { ...f, current }
    })

  // --- full screen and keys -------------------------------------------------------------------

  useEffect(() => {
    const on = () => setFull(document.fullscreenElement === root.current)
    document.addEventListener('fullscreenchange', on)
    return () => document.removeEventListener('fullscreenchange', on)
  }, [])
  const toggleFull = () => (document.fullscreenElement ? document.exitFullscreen() : root.current?.requestFullscreen())?.catch(() => {})

  useEffect(() => {
    if (wm.focusedPid === win.pid && !root.current?.contains(document.activeElement)) scroller.current?.focus({ preventScroll: true })
  }, [wm.focusedPid, win.pid])

  const onKeyDown = (e: React.KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey
    const inField = (e.target as HTMLElement).closest('input')
    if (mod && e.key.toLowerCase() === 'f') {
      setFind((f) => f ?? { query: '', matches: [], current: 0 })
      requestAnimationFrame(() => findInput.current?.select())
    } else if (inField) return
    else if (mod && (e.key === '=' || e.key === '+')) zoomTo(scale * 1.2)
    else if (mod && e.key === '-') zoomTo(scale / 1.2)
    else if (mod && e.key === '0') zoomTo(1)
    else if (e.key === 'Home') goTo(1)
    else if (e.key === 'End') goTo(sizes.length)
    else if (e.key === 'ArrowRight' && fit === 'page') goTo(page + 1)
    else if (e.key === 'ArrowLeft' && fit === 'page') goTo(page - 1)
    else if (e.key.toLowerCase() === 'r' && !mod) setRotation((r) => (r + (e.shiftKey ? 270 : 90)) % 360)
    else if (e.key.toLowerCase() === 'f' && !mod) toggleFull()
    else return
    e.preventDefault()
  }

  const at = parseSf(path)
  const where = at ? `${libraryName(at.repo)}${at.p.split('/').slice(0, -1).join('/') || '/'}` : prettyPath(folderOf(path))
  const current = find?.matches[find.current]
  /** Which match on its page the current one is (0 for the first). */
  const nth = current && find ? find.matches.slice(0, find.current).filter((m) => m.page === current.page).length : -1

  return (
    <div ref={root} className={`pdf ${prefs.night ? 'is-night' : ''} ${full ? 'is-full' : ''}`} onKeyDown={onKeyDown}>
      <div className="pv-bar">
        <Tool label="Sidebar" on={prefs.sidebar} onClick={() => setPrefs({ sidebar: !prefs.sidebar })}>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M9 4v16" />
        </Tool>
        <span className="pdf-page">
          <input
            aria-label="Page"
            value={page}
            onChange={(e) => setPage(Number(e.target.value.replace(/\D/g, '')) || 1)}
            onKeyDown={(e) => e.key === 'Enter' && goTo(page)}
            onBlur={() => goTo(page)}
            inputMode="numeric"
          />
          <span className="muted">/ {sizes.length || '…'}</span>
        </span>
        <span className="spacer" />
        {find && (
          <span className="pdf-find">
            <input
              ref={findInput}
              autoFocus
              placeholder="Find in document"
              defaultValue={find.query}
              onChange={(e) => void search(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') step(e.shiftKey ? -1 : 1)
                if (e.key === 'Escape') setFind(null)
              }}
            />
            <span className="muted">{find.query ? (find.matches.length ? `${find.current + 1} of ${find.matches.length}` : 'none') : ''}</span>
            <button onClick={() => step(-1)} aria-label="Previous match">
              ‹
            </button>
            <button onClick={() => step(1)} aria-label="Next match">
              ›
            </button>
            <button onClick={() => setFind(null)} aria-label="Close search">
              ×
            </button>
          </span>
        )}
        {!find && (
          <Tool label="Find (Ctrl+F)" onClick={() => setFind({ query: '', matches: [], current: 0 })}>
            <circle cx="11" cy="11" r="6.5" />
            <path d="M16 16l4 4" />
          </Tool>
        )}
        <div className="pv-group" role="group" aria-label="Zoom">
          <Tool label="Zoom out (Ctrl −)" onClick={() => zoomTo(scale / 1.2)}>
            <circle cx="11" cy="11" r="6.5" />
            <path d="M8 11h6M16 16l4 4" />
          </Tool>
          <button className="pv-zoom" onClick={() => zoomTo(1)} title="Actual size (Ctrl 0)">
            {Math.round(scale * 100)}%
          </button>
          <Tool label="Zoom in (Ctrl +)" onClick={() => zoomTo(scale * 1.2)}>
            <circle cx="11" cy="11" r="6.5" />
            <path d="M8 11h6M11 8v6M16 16l4 4" />
          </Tool>
        </div>
        <Tool label="Fit width" on={fit === 'width'} onClick={() => setFit('width')}>
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="M7 12h10M9 10l-2 2 2 2M15 10l2 2-2 2" />
        </Tool>
        <Tool label="Fit page" on={fit === 'page'} onClick={() => setFit('page')}>
          <rect x="6" y="3" width="12" height="18" rx="1.5" />
          <path d="M12 7v10M10 9l2-2 2 2M10 15l2 2 2-2" />
        </Tool>
        <Tool label="Rotate (R)" onClick={() => setRotation((r) => (r + 90) % 360)}>
          <path d="M20 9a8 8 0 1 0-1.5 7" />
          <path d="M20 4v5h-5" />
        </Tool>
        <Tool label="Night mode" on={prefs.night} onClick={() => setPrefs({ night: !prefs.night })}>
          <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />
        </Tool>
        <Tool label={full ? 'Exit full screen (F)' : 'Full screen (F)'} onClick={toggleFull}>
          {full ? <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" /> : <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />}
        </Tool>
        <Tool label="Download" onClick={() => void download(path).catch(() => {})}>
          <path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 20h14" />
        </Tool>
      </div>

      <div className="pv-body">
        {prefs.sidebar && doc && (
          <aside className="pdf-side">
            {outline && (
              <div className="pdf-tabs" role="tablist">
                <button role="tab" aria-selected={tab === 'pages'} className={tab === 'pages' ? 'is-on' : ''} onClick={() => setTab('pages')}>
                  Pages
                </button>
                <button role="tab" aria-selected={tab === 'outline'} className={tab === 'outline' ? 'is-on' : ''} onClick={() => setTab('outline')}>
                  Contents
                </button>
              </div>
            )}
            {tab === 'outline' && outline ? (
              <Outline items={outline} doc={doc} onGo={(n) => goTo(n, true)} />
            ) : (
              <Thumbs doc={doc} count={sizes.length} current={page} onGo={(n) => goTo(n, true)} />
            )}
            <p className="pdf-where muted" title={where}>
              {where}
            </p>
          </aside>
        )}
        <div ref={scroller} className="pdf-scroll" tabIndex={0} onScroll={onScroll}>
          {error ? (
            <div className="pv-empty">
              <p className="pv-big">{name}</p>
              <p className="muted">{error}</p>
              {isSf(path) && (
                <button className="btn btn-small" onClick={() => void download(path).catch(() => {})}>
                  Download
                </button>
              )}
            </div>
          ) : !doc || !sizes.length ? (
            <div className="pv-loading">Opening {name}…</div>
          ) : (
            <div className="pdf-pages" style={{ width: Math.max(box.w, widest * scale + PAD * 2), height: (tops[tops.length - 1] ?? 0) + (sized[sized.length - 1]?.h ?? 0) + PAD }}>
              {sized.map((s, i) => (
                <Page
                  key={i}
                  doc={doc}
                  number={i + 1}
                  top={tops[i]}
                  size={s}
                  scale={scale}
                  rotation={rotation}
                  scroller={scroller}
                  query={find?.query ?? ''}
                  nth={current?.page === i + 1 ? nth : -1}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** One page: drawn (and its text laid over it) while it is in or near view. */
function Page({ doc, number, top, size, scale, rotation, scroller, query, nth }: { doc: PDFDocumentProxy; number: number; top: number; size: Size; scale: number; rotation: number; scroller: React.RefObject<HTMLDivElement | null>; query: string; nth: number }) {
  const el = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const text = useRef<HTMLDivElement>(null)
  const [near, setNear] = useState(false)
  const [drawn, setDrawn] = useState<string | null>(null)

  useEffect(() => {
    const node = el.current
    if (!node || !scroller.current) return
    const io = new IntersectionObserver(([e]) => setNear(e.isIntersecting), { root: scroller.current, rootMargin: '800px 0px' })
    io.observe(node)
    return () => io.disconnect()
  }, [scroller])

  const key = `${scale.toFixed(3)}:${rotation}`
  useEffect(() => {
    if (!near || drawn === key) return
    let task: RenderTask | null = null
    let live = true
    // A zoom settles before the page is drawn again at the new size.
    const t = setTimeout(async () => {
      const page: PDFPageProxy = await doc.getPage(number)
      if (!live || !canvas.current || !text.current) return
      const viewport = page.getViewport({ scale, rotation })
      const ratio = Math.min(2, window.devicePixelRatio || 1)
      const c = canvas.current
      c.width = Math.floor(viewport.width * ratio)
      c.height = Math.floor(viewport.height * ratio)
      task = page.render({ canvas: c, viewport, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined })
      await task.promise.catch(() => {})
      if (!live) return
      const m = await import('pdfjs-dist')
      const layer = text.current
      layer.replaceChildren()
      layer.style.setProperty('--total-scale-factor', String(scale))
      layer.style.setProperty('--scale-factor', String(scale))
      await new m.TextLayer({ textContentSource: page.streamTextContent(), container: layer, viewport }).render().catch(() => {})
      if (live) setDrawn(key)
    }, drawn ? 140 : 0)
    return () => {
      live = false
      clearTimeout(t)
      task?.cancel()
    }
  }, [near, key, drawn, doc, number, scale, rotation])

  // Matches of the search, marked word for word on the page's text (the current one stronger).
  useEffect(() => {
    const layer = text.current
    if (!layer) return
    const q = query.trim().toLowerCase()
    let n = 0
    for (const span of layer.querySelectorAll<HTMLElement>(':scope span:not(.markedContent)')) {
      const original = span.dataset.text ?? span.textContent ?? ''
      if (span.dataset.text !== undefined) {
        span.textContent = original
        delete span.dataset.text
      }
      if (!q || !original.toLowerCase().includes(q)) continue
      span.dataset.text = original
      const lower = original.toLowerCase()
      const parts: Node[] = []
      let from = 0
      for (let i = lower.indexOf(q); i >= 0; i = lower.indexOf(q, i + q.length)) {
        parts.push(document.createTextNode(original.slice(from, i)))
        const mark = document.createElement('mark')
        mark.textContent = original.slice(i, i + q.length)
        if (n++ === nth) mark.className = 'is-current'
        parts.push(mark)
        from = i + q.length
      }
      parts.push(document.createTextNode(original.slice(from)))
      span.replaceChildren(...parts)
    }
    if (nth >= 0 && q) layer.querySelector('mark.is-current')?.scrollIntoView({ block: 'center' })
  }, [query, nth, drawn])

  return (
    <div ref={el} className="pdf-page-box" style={{ top, width: size.w, height: size.h }} aria-label={`Page ${number}`}>
      <canvas ref={canvas} style={{ width: size.w, height: size.h }} />
      <div ref={text} className="textLayer" />
      {drawn === null && <span className="pdf-page-n">{number}</span>}
    </div>
  )
}

function Thumbs({ doc, count, current, onGo }: { doc: PDFDocumentProxy; count: number; current: number; onGo: (n: number) => void }) {
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    list.current?.querySelector('.is-current')?.scrollIntoView({ block: 'nearest' })
  }, [current])
  return (
    <div className="pdf-thumbs" ref={list}>
      {Array.from({ length: count }, (_, i) => (
        <button key={i} className={`pdf-thumb ${current === i + 1 ? 'is-current' : ''}`} onClick={() => onGo(i + 1)} aria-label={`Page ${i + 1}`}>
          <Thumb doc={doc} number={i + 1} root={list} />
          <span>{i + 1}</span>
        </button>
      ))}
    </div>
  )
}

function Thumb({ doc, number, root }: { doc: PDFDocumentProxy; number: number; root: React.RefObject<HTMLDivElement | null> }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [near, setNear] = useState(false)
  const [done, setDone] = useState(false)
  useEffect(() => {
    const c = canvas.current
    if (!c) return
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setNear(true), { root: root.current, rootMargin: '300px 0px' })
    io.observe(c)
    return () => io.disconnect()
  }, [root])
  useEffect(() => {
    if (!near || done) return
    let task: RenderTask | null = null
    let live = true
    doc.getPage(number).then((page) => {
      if (!live || !canvas.current) return
      const v1 = page.getViewport({ scale: 1 })
      const viewport = page.getViewport({ scale: 220 / v1.width })
      canvas.current.width = viewport.width
      canvas.current.height = viewport.height
      task = page.render({ canvas: canvas.current, viewport })
      task.promise.then(() => live && setDone(true)).catch(() => {})
    })
    return () => {
      live = false
      task?.cancel()
    }
  }, [near, done, doc, number])
  return <canvas ref={canvas} className={done ? '' : 'is-blank'} />
}

function Outline({ items, doc, onGo, depth = 0 }: { items: OutlineItem[]; doc: PDFDocumentProxy; onGo: (n: number) => void; depth?: number }) {
  const go = async (dest: unknown) => {
    try {
      const d = typeof dest === 'string' ? await doc.getDestination(dest) : (dest as unknown[])
      if (!d) return
      const index = await doc.getPageIndex(d[0] as Parameters<PDFDocumentProxy['getPageIndex']>[0])
      onGo(index + 1)
    } catch {
      /* a link outside the document */
    }
  }
  return (
    <ul className="pdf-outline" style={{ paddingLeft: depth ? 12 : 0 }}>
      {items.map((it, i) => (
        <li key={i}>
          <button onClick={() => go(it.dest)} title={it.title}>
            {it.title}
          </button>
          {it.items?.length > 0 && <Outline items={it.items} doc={doc} onGo={onGo} depth={depth + 1} />}
        </li>
      ))}
    </ul>
  )
}

function Tool({ label, onClick, on, children }: { label: string; onClick: () => void; on?: boolean; children: ReactNode }) {
  return (
    <button className={`pv-tool ${on ? 'is-on' : ''}`} onClick={onClick} title={label} aria-label={label} aria-pressed={on}>
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {children}
      </svg>
    </button>
  )
}
