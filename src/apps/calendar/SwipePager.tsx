import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { toUi } from '../../os/uiScale'
import { lockAxis, LOCK_PX, settleDir, velocityOf } from './swipe'

// Swipe sideways on a touch screen to turn the Calendar's page: the page follows the finger with the
// real previous and next pages beside it, and lets go with a snap on to the next one or back. At rest
// only the current page is in the DOM; a swipe adds its two neighbours until it has settled.
//
// Pointer positions come in screen pixels and everything drawn is in page pixels (Settings → Appearance → UI
// scale), so every position goes through toUi first.
//
// Vertical drags are left to the browser (the hours scroll), and taps are the views' own: a swipe
// also swallows the click that would follow it. The page the swipe settles on is the one the
// view's own arrows go to: the parent decides, through `onTurn`.

// What scrolls up and down in a page: the hours, the year.
const SCROLLERS = '.ca-tg-scroll, .ca-year'
const SETTLE_MS = 240
const EASE = 'cubic-bezier(0.22, 0.8, 0.26, 1)'

type Phase = 'idle' | 'drag' | 'settle'
type Gesture = { id: number; x: number; y: number; axis: 'x' | 'y' | null; dx: number; width: number; samples: { t: number; x: number }[] }

type Props = {
  /** Identifies the page shown, and the two beside it: pages with the same key keep their DOM across a turn. */
  pageKey: string
  /** Pages of one group (a view) keep the hours' scroll when the page changes without a swipe (the arrows, Today). */
  group: string
  prevKey: string
  nextKey: string
  /** Off: the pages never move (mouse only, a window too small to bother, ...). */
  enabled: boolean
  /** A swipe settled on the next (1) or previous (-1) page. */
  onTurn: (dir: -1 | 1) => void
  /** The page: 0 the one shown, ±1 a neighbour (for show only). */
  render: (offset: -1 | 0 | 1) => ReactNode
}

export function SwipePager({ pageKey, group, prevKey, nextKey, enabled, onTurn, render }: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const [phase, setPhaseState] = useState<Phase>('idle')
  const phaseRef = useRef<Phase>('idle')
  const gesture = useRef<Gesture | null>(null)
  const settling = useRef<{ off: () => void } | null>(null)
  const swallow = useRef(0)
  const turn = useRef(onTurn)
  turn.current = onTurn
  const setPhase = (p: Phase) => {
    phaseRef.current = p
    setPhaseState(p)
  }

  /** Back to the page at rest, now: the track's inline styles go before the next paint (see the layout effect). */
  const finish = (dir: -1 | 0 | 1) => {
    settling.current?.off()
    settling.current = null
    gesture.current = null
    setPhase('idle')
    if (dir) turn.current(dir)
  }

  /** Slides to the next (1) or previous (-1) page, or back (0). */
  const settle = (dir: -1 | 0 | 1) => {
    const track = trackRef.current
    const g = gesture.current
    if (!track || !g) return finish(0)
    const target = -g.width - dir * g.width
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
    // Already there, or no animation wanted: snap.
    if (reduced || Math.abs(g.dx - -dir * g.width) < 1) return finish(dir)
    setPhase('settle')
    track.style.transition = `transform ${SETTLE_MS}ms ${EASE}`
    track.style.transform = `translate3d(${target}px,0,0)`
    const done = () => finish(dir)
    const onEnd = (e: TransitionEvent) => e.target === track && e.propertyName === 'transform' && done()
    track.addEventListener('transitionend', onEnd)
    const timer = setTimeout(done, SETTLE_MS + 80)
    settling.current = {
      off: () => {
        track.removeEventListener('transitionend', onEnd)
        clearTimeout(timer)
      },
    }
  }

  // At rest again: the track back to its place, its neighbours gone.
  useLayoutEffect(() => {
    if (phase !== 'idle') return
    const track = trackRef.current
    if (!track) return
    track.style.transform = ''
    track.style.transition = ''
  }, [phase, pageKey])

  // A swipe's neighbours are new: hours scrolled to where the page in view is, so the day doesn't jump.
  useLayoutEffect(() => {
    if (phase !== 'drag') return
    const scrolled = trackRef.current?.querySelector<HTMLElement>(`.ca-page[data-offset="0"] :is(${SCROLLERS})`)?.scrollTop
    if (scrolled === undefined) return
    trackRef.current?.querySelectorAll<HTMLElement>(`.ca-page:not([data-offset="0"]) :is(${SCROLLERS})`).forEach((el) => (el.scrollTop = scrolled))
  }, [phase])

  // The window resized, the view changed or swiping went off in the middle of a swipe: drop it where it is.
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const abort = () => {
      if (phaseRef.current !== 'idle') finish(0)
      gesture.current = null
    }
    const ro = new ResizeObserver(() => {
      const g = gesture.current
      if (g && Math.abs(root.clientWidth - g.width) > 0.5 && phaseRef.current !== 'idle') abort()
    })
    ro.observe(root)
    window.addEventListener('resize', abort)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', abort)
    }
  }, [])
  useEffect(() => {
    if (!enabled && phaseRef.current !== 'idle') finish(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled])
  useEffect(() => () => settling.current?.off(), [])

  // The page changed under a swipe (an arrow, Today, another view, a window open on another day): the swipe is off,
  // and nothing turns on its account.
  const shownKey = useRef(pageKey)
  useEffect(() => {
    if (shownKey.current === pageKey) return
    shownKey.current = pageKey
    if (phaseRef.current !== 'idle') finish(0)
    gesture.current = null
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageKey])

  // Paging by the arrows or keys shows another page's hours at the same scroll as the one before.
  const scrolled = useRef<{ group: string; top: number } | null>(null)
  const was = useRef({ key: pageKey, group })
  useLayoutEffect(() => {
    const before = was.current
    was.current = { key: pageKey, group }
    if (before.key === pageKey || before.group !== group || !scrolled.current || scrolled.current.group !== group) return
    const el = trackRef.current?.querySelector<HTMLElement>(`.ca-page[data-offset="0"] :is(${SCROLLERS})`)
    if (el) el.scrollTop = scrolled.current.top
  }, [pageKey, group])
  const noteScroll = (ev: { target: EventTarget }) => {
    const el = ev.target instanceof HTMLElement && ev.target.matches(SCROLLERS) ? ev.target : null
    if (el && el.closest('.ca-page')?.getAttribute('data-offset') === '0') scrolled.current = { group, top: el.scrollTop }
  }

  const down = (ev: ReactPointerEvent<HTMLDivElement>) => {
    if (!enabled || ev.pointerType !== 'touch' || phaseRef.current === 'settle') return
    const g = gesture.current
    // A second finger is not a swipe, and not a tap either: the views under it never hear of it
    // (held still and lifted, it would make a new event), and the click after it is swallowed.
    if (!ev.isPrimary) {
      if (!g) return
      ev.stopPropagation()
      swallow.current = performance.now() + 400
      // Settling back may end the gesture on the spot (no animation wanted): keep what is needed first.
      const swiping = g.axis === 'x' && phaseRef.current === 'drag'
      g.axis = 'y'
      if (swiping) settle(0)
      return
    }
    if (g) return
    gesture.current = { id: ev.pointerId, x: toUi(ev.clientX), y: toUi(ev.clientY), axis: null, dx: 0, width: rootRef.current?.clientWidth ?? 0, samples: [{ t: ev.timeStamp, x: toUi(ev.clientX) }] }
  }

  const move = (ev: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current
    if (!g || ev.pointerId !== g.id || g.axis === 'y' || phaseRef.current === 'settle') return
    const x = toUi(ev.clientX)
    const dx = x - g.x
    if (!g.axis) {
      const axis = lockAxis(dx, toUi(ev.clientY) - g.y)
      if (!axis) return
      g.axis = axis
      if (axis === 'y' || g.width <= 0) {
        g.axis = 'y'
        return
      }
      // The neighbours are in the DOM before the first move is drawn.
      flushSync(() => setPhase('drag'))
    }
    g.samples.push({ t: ev.timeStamp, x })
    if (g.samples.length > 12) g.samples.shift()
    // The finger's first few pixels, the ones that decided it was a swipe, don't count: no jump.
    const eased = dx - Math.sign(dx) * LOCK_PX
    g.dx = Math.max(-g.width, Math.min(g.width, eased))
    if (trackRef.current) trackRef.current.style.transform = `translate3d(${g.dx - g.width}px,0,0)`
  }

  const up = (ev: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current
    if (!g || ev.pointerId !== g.id) return
    if (g.axis !== 'x' || phaseRef.current !== 'drag') {
      gesture.current = null
      return
    }
    // The lift counts: a quick flick that is held still before letting go is not a flick.
    g.samples.push({ t: ev.timeStamp, x: toUi(ev.clientX) })
    swallow.current = performance.now() + 400
    settle(settleDir(g.dx, g.width, velocityOf(g.samples)))
  }

  const cancel = (ev: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current
    if (!g || ev.pointerId !== g.id) return
    if (g.axis === 'x' && phaseRef.current === 'drag') {
      swallow.current = performance.now() + 400
      settle(0)
    } else gesture.current = null
  }

  // What a swipe ended on is not a tap: no click for the day, the event or the button under the finger.
  const click = (ev: { stopPropagation: () => void; preventDefault: () => void }) => {
    if (performance.now() > swallow.current) return
    ev.stopPropagation()
    ev.preventDefault()
  }

  const pages: { key: string; offset: -1 | 0 | 1 }[] = phase === 'idle' ? [{ key: pageKey, offset: 0 }] : [{ key: prevKey, offset: -1 }, { key: pageKey, offset: 0 }, { key: nextKey, offset: 1 }]

  return (
    <div ref={rootRef} className="ca-pager" onPointerDownCapture={down} onPointerMove={move} onPointerUp={up} onPointerCancel={cancel} onClickCapture={click} onScrollCapture={noteScroll}>
      <div ref={trackRef} className={`ca-pager-track ${phase === 'idle' ? '' : 'is-paged'} ${phase === 'settle' ? 'is-settling' : ''}`}>
        {pages.map((p) => (
          <div key={p.key} className="ca-page" data-offset={p.offset} aria-hidden={p.offset !== 0 || undefined} inert={p.offset !== 0}>
            {render(p.offset)}
          </div>
        ))}
      </div>
    </div>
  )
}
