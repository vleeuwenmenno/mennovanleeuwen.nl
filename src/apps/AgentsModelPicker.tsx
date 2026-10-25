import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { agentSettings, setAgentSettings, tokenCount, useAgentSettings, type ModelInfo } from '../data/agents'
import { MAKERS, makerOf, modelMatch, modelName, PROVIDER_NAMES, type MakerId, type ModelName } from '../data/agentModelNames'
import { useIsMobile } from '../os/useIsMobile'
import './AgentsModelPicker.css'

// The Agents composer's model picker: a rail of makers on the left (favourites first), a search
// box, and the models as rows with their pretty name (src/data/agentModelNames.ts), the provider
// under it (Ollama Cloud, ChatGPT, OpenAI API), what they can do and a star. Starred models are
// synced with the account (the agents settings' favoriteModels); Ctrl+1…9 picks the first nine
// while the picker or the composer has focus (Alt+1…9 stays the workspaces'). On a phone it is a
// sheet from the bottom, and the rail a row of chips.

type Row = { info: ModelInfo; n: ModelName }

/** The models as named rows, in rail order: by maker, then by name. */
export function namedModels(models: ModelInfo[]): Row[] {
  const order = new Map(MAKERS.map((m, i) => [m.id, i]))
  return models
    .map((info) => ({ info, n: modelName(info.name, info.label) }))
    .sort((a, b) => (order.get(a.n.maker)! - order.get(b.n.maker)!) || a.n.name.localeCompare(b.n.name, undefined, { numeric: true }) || a.n.raw.localeCompare(b.n.raw))
}

/** The favourites that are offered now, in the order they were starred: Ctrl+1…9 picks these. */
export function favouriteModels(models: ModelInfo[], favs = agentSettings().favoriteModels): ModelInfo[] {
  return favs.flatMap((f) => models.filter((m) => m.name === f))
}

/** Ctrl+1…9 (no other modifier): the favourite's index, else null. */
export function favouriteKey(e: { ctrlKey: boolean; altKey: boolean; metaKey: boolean; shiftKey: boolean; code: string }): number | null {
  if (!e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return null
  const d = /^Digit([1-9])$/.exec(e.code)
  return d ? Number(d[1]) - 1 : null
}

const toggleFavourite = (name: string) => {
  const favs = agentSettings().favoriteModels
  setAgentSettings({ favoriteModels: favs.includes(name) ? favs.filter((f) => f !== name) : [...favs, name] })
}

/** A maker's letter mark, drawn in the text colour (no logos). */
export function MakerMark({ maker, size = 22 }: { maker: MakerId | 'favourites' | 'all'; size?: number }) {
  if (maker === 'favourites' || maker === 'all')
    return (
      <span className="amp-mark is-glyph" style={{ width: size, height: size }} aria-hidden>
        {maker === 'favourites' ? <Star on /> : <svg viewBox="0 0 16 16" width={size * 0.6} height={size * 0.6}><path d="M2 3h12M2 8h12M2 13h12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>}
      </span>
    )
  const m = makerOf(maker)
  return (
    <span className={`amp-mark ${m.mark.length > 2 ? 'is-long' : ''}`} style={{ width: size, height: size }} aria-hidden>
      {m.mark}
    </span>
  )
}

function Star({ on }: { on: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
      <path d="M8 1.6l1.9 4 4.4.5-3.3 3 .9 4.3L8 11.2l-3.9 2.2.9-4.3-3.3-3 4.4-.5z" fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  )
}

/** "sees · 128k · thinks": what a model can do, as small badges. */
function Badges({ info }: { info: ModelInfo }) {
  return (
    <span className="amp-badges">
      {info.vision && <span className="amp-badge" title="Can see pictures">sees</span>}
      {!!info.efforts?.length && <span className="amp-badge" title="Thinks before it answers; the effort can be set">thinks</span>}
      {info.contextLength && <span className="amp-badge" title={`Context window: ${info.contextLength.toLocaleString()} tokens`}>{tokenCount(info.contextLength)}</span>}
    </span>
  )
}

type Props = {
  models: ModelInfo[]
  /** The thread's model ('' for a draft on the usual one) */
  value: string
  /** For a draft: the "usual one" row, with what it is now */
  usual?: { hint: string } | null
  onPick: (name: string | null) => void
  onClose: () => void
  /** Whether the list is still loading, or failed */
  status?: string | null
  /** The pill it opens from: on a desktop it sits above it, right edges lined up */
  anchor: HTMLElement | null
}

export function ModelPicker({ models, value, usual, onPick, onClose, status, anchor }: Props) {
  const mobile = useIsMobile()
  const settings = useAgentSettings()
  const favs = settings.favoriteModels
  const rows = useMemo(() => namedModels(models), [models])
  const favRows = useMemo(() => favs.flatMap((f) => rows.filter((r) => r.info.name === f)), [favs, rows])
  const makers = useMemo(() => MAKERS.filter((m) => rows.some((r) => r.n.maker === m.id)), [rows])
  const current = rows.find((r) => r.info.name === value)
  const [rail, setRail] = useState<MakerId | 'favourites' | 'all'>('all')
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const box = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  // Where it sits (fixed, over everything like a menu): above the pill, or below when there is more room there.
  const [place, setPlace] = useState<React.CSSProperties>({ visibility: 'hidden' })
  useLayoutEffect(() => {
    if (mobile || !anchor) return setPlace({})
    const fit = () => {
      const r = anchor.getBoundingClientRect()
      const vh = window.visualViewport?.height ?? window.innerHeight
      const vw = window.innerWidth
      const width = Math.min(540, vw - 16)
      const left = Math.max(8, Math.min(r.right - width, vw - width - 8))
      const above = r.top > vh - r.bottom
      const room = (above ? r.top : vh - r.bottom) - 14
      setPlace({ left, width, maxHeight: Math.max(220, Math.min(480, room)), ...(above ? { bottom: window.innerHeight - r.top + 6 } : { top: r.bottom + 6 }) })
    }
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [anchor, mobile])

  // What shows: a search looks through every maker, best first; else the rail's choice.
  const shown: Row[] = useMemo(() => {
    const q = query.trim()
    if (q)
      return rows
        .map((r) => ({ r, s: modelMatch(r.n, q) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .map((x) => x.r)
    if (rail === 'favourites') return favRows
    if (rail === 'all') return rows
    return rows.filter((r) => r.n.maker === rail)
  }, [query, rail, rows, favRows])
  const withUsual = !!usual && !query.trim() && (rail === 'all' || rail === 'favourites')
  const count = shown.length + (withUsual ? 1 : 0)

  useEffect(() => setActive(0), [query, rail])
  // Opened on the current model: its maker's rail, scrolled to it.
  useLayoutEffect(() => {
    const at = withUsual && !value ? 0 : shown.findIndex((r) => r.info.name === value) + (withUsual ? 1 : 0)
    if (at >= 0) setActive(at)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    // A phone's keyboard would cover half the sheet: the search box waits for a tap there.
    const take = () => (!mobile && !window.matchMedia('(pointer: coarse)').matches ? search.current : box.current)?.focus()
    take()
    // The window puts focus back where it was after a click in it (the composer): take it again.
    const later = setTimeout(() => box.current && !box.current.contains(document.activeElement) && take(), 80)
    return () => clearTimeout(later)
  }, [mobile])
  useEffect(() => {
    list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active, shown])
  // A press outside closes it.
  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node) && !(e.target as Element).closest?.('.agt-model-pill')) onClose()
    }
    document.addEventListener('pointerdown', away, true)
    return () => document.removeEventListener('pointerdown', away, true)
  }, [onClose])

  const pickAt = (i: number) => {
    if (withUsual && i === 0) return onPick(null)
    const r = shown[i - (withUsual ? 1 : 0)]
    if (r) onPick(r.info.name)
  }
  const onKey = (e: React.KeyboardEvent) => {
    const fav = favouriteKey(e)
    if (fav !== null) {
      e.preventDefault()
      e.stopPropagation()
      const m = favRows[fav]
      if (m) onPick(m.info.name)
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      return onClose()
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (count) setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : -1) + count) % count)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      return pickAt(active)
    }
  }

  const railItems: { id: MakerId | 'favourites' | 'all'; name: string; n: number }[] = [
    ...(favRows.length ? [{ id: 'favourites' as const, name: 'Favourites', n: favRows.length }] : []),
    { id: 'all', name: 'All models', n: rows.length },
    ...makers.map((m) => ({ id: m.id, name: m.name, n: rows.filter((r) => r.n.maker === m.id).length })),
  ]

  const rowFor = (r: Row, i: number, showMaker: boolean) => {
    const index = i + (withUsual ? 1 : 0)
    const favAt = favRows.findIndex((f) => f.info.name === r.info.name)
    const fav = favAt >= 0
    return (
      <div
        key={r.info.name}
        role="option"
        aria-selected={r.info.name === value}
        data-active={index === active}
        className={`amp-row ${index === active ? 'is-active' : ''} ${r.info.name === value ? 'is-current' : ''}`}
        onPointerMove={() => setActive(index)}
        onClick={() => onPick(r.info.name)}
        title={r.n.raw}
      >
        {showMaker && <MakerMark maker={r.n.maker} size={20} />}
        <span className="amp-row-text">
          <span className="amp-row-name">
            {r.n.name}
            {r.n.variant && <span className="amp-variant">{r.n.variant}</span>}
          </span>
          <span className="amp-row-sub">
            {PROVIDER_NAMES[r.n.provider]}
            <span className="amp-raw"> · {r.n.raw}</span>
          </span>
        </span>
        <Badges info={r.info} />
        {fav && favAt < 9 && <kbd className="amp-kbd" title={`Ctrl+${favAt + 1} picks it`}>Ctrl+{favAt + 1}</kbd>}
        <button
          type="button"
          className={`amp-star ${fav ? 'is-on' : ''}`}
          aria-label={fav ? `Remove ${r.n.name} from favourites` : `Add ${r.n.name} to favourites`}
          aria-pressed={fav}
          title={fav ? 'Favourite: Ctrl+number picks it' : 'Add to favourites'}
          onClick={(e) => {
            e.stopPropagation()
            toggleFavourite(r.info.name)
          }}
        >
          <Star on={fav} />
        </button>
      </div>
    )
  }

  // With every maker shown (no search), the list has a heading per maker.
  const grouped = !query.trim() && rail === 'all'
  let lastMaker: MakerId | null = null

  return createPortal(
    <>
      {mobile && <div className="amp-backdrop" onClick={onClose} />}
      <div ref={box} className={`amp ${mobile ? 'is-sheet' : ''}`} style={place} role="dialog" aria-label="Choose a model" tabIndex={-1} onKeyDown={onKey}>
        <div className="amp-search">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
            <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input
            ref={search}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search models…"
            aria-label="Search models"
            aria-controls="amp-list"
            spellCheck={false}
            autoComplete="off"
          />
          {mobile && (
            <button type="button" className="amp-close" onClick={onClose} aria-label="Close">
              ✕
            </button>
          )}
        </div>
        <div className="amp-body">
          <div className="amp-rail" role="tablist" aria-label="Makers">
            {railItems.map((m) => (
              <button
                key={m.id}
                type="button"
                role="tab"
                aria-selected={!query.trim() && rail === m.id}
                className={`amp-rail-item ${!query.trim() && rail === m.id ? 'is-on' : ''}`}
                title={`${m.name} (${m.n})`}
                onClick={() => {
                  setQuery('')
                  setRail(m.id)
                }}
              >
                <MakerMark maker={m.id} size={mobile ? 20 : 24} />
                {mobile && <span className="amp-rail-name">{m.name}</span>}
              </button>
            ))}
          </div>
          <div ref={list} className="amp-list" id="amp-list" role="listbox" aria-label="Models">
            {withUsual && (
              <div role="option" aria-selected={!value} data-active={active === 0} className={`amp-row ${active === 0 ? 'is-active' : ''} ${!value ? 'is-current' : ''}`} onPointerMove={() => setActive(0)} onClick={() => onPick(null)}>
                <span className="amp-row-text">
                  <span className="amp-row-name">The usual one</span>
                  <span className="amp-row-sub">{usual!.hint}</span>
                </span>
              </div>
            )}
            {!query.trim() && rail !== 'all' && rail !== 'favourites' && <div className="amp-heading">{makerOf(rail).name}</div>}
            {rail === 'favourites' && !query.trim() && <div className="amp-heading">Favourites</div>}
            {shown.map((r, i) => {
              const head = grouped && r.n.maker !== lastMaker
              lastMaker = r.n.maker
              return (
                <div key={r.info.name} className="amp-group">
                  {head && <div className="amp-heading">{makerOf(r.n.maker).name}</div>}
                  {rowFor(r, i, !!query.trim())}
                </div>
              )
            })}
            {!shown.length && <p className="amp-empty muted">{status ?? (query.trim() ? `No model matches “${query.trim()}”.` : rail === 'favourites' ? 'Star a model to keep it here.' : 'No models.')}</p>}
          </div>
        </div>
        <div className="amp-foot">
          <span className="amp-foot-model">{current ? <>{current.n.name}{current.n.variant && <span className="amp-variant">{current.n.variant}</span>}</> : value || 'The usual one'}</span>
          <span className="amp-foot-hint muted">{favRows.length ? `Ctrl+1…${Math.min(9, favRows.length)} picks a favourite` : '☆ stars a favourite'}</span>
        </div>
      </div>
    </>,
    document.body,
  )
}
