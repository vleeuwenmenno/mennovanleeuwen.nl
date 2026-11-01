import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { xedLayout } from '../data/appPrefs'
import { fitLayout, sameFit, LEFT_DEFAULT, RIGHT_DEFAULT } from '../data/xedLayout'
import { useSplitter } from '../os/useSplitter'

// Xed's side panels: which are open, how wide, docked or as a sheet. The layout follows the width
// of Xed's own body (a ResizeObserver on it, not the viewport) through `fitLayout`
// (src/data/xedLayout.ts); the preferences (widths and toggles) are `xedLayout` in appPrefs.
//
// Docked panels are open or closed by the preference. A sheet is transient: `sheet` names the one
// open (never both), and it closes by itself when its side has room to dock again.

type Side = 'left' | 'right'

export function useXedLayout() {
  const pref = xedLayout.use()
  const body = useRef<HTMLDivElement>(null)
  const width = useRef(1280)
  const [, redraw] = useState(0)
  const fit = fitLayout({ width: width.current, ...pref })
  const drawn = useRef(fit)
  drawn.current = fit

  // Drawn again only when the fit really changes, so resizing a window with room to spare is free.
  useLayoutEffect(() => {
    const el = body.current
    if (!el) return
    const measure = () => {
      width.current = el.clientWidth
      if (!sameFit(drawn.current, fitLayout({ width: width.current, ...xedLayout.get() }))) redraw((n) => n + 1)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const [sheet, setSheet] = useState<Side | null>(null)
  useEffect(() => {
    if (sheet && fit[sheet].as === 'dock') setSheet(null)
  }, [sheet, fit])
  const sheetOn = (side: Side) => fit[side].as === 'sheet' && sheet === side
  const open = (side: Side) => (fit[side].as === 'dock' ? (side === 'left' ? pref.showLeft : pref.showRight) : sheetOn(side))
  const leftOpen = open('left')
  const rightOpen = open('right')

  // The Agents panel is mounted the first time it opens and stays (hidden) after that.
  const [rightMounted, setRightMounted] = useState(() => xedLayout.get().showRight)
  useEffect(() => {
    if (rightOpen) setRightMounted(true)
  }, [rightOpen])

  const setOpen = (side: Side, on: boolean) => {
    if (fit[side].as === 'dock') xedLayout.patch(side === 'left' ? { showLeft: on } : { showRight: on })
    else setSheet((s) => (on ? side : s === side ? null : s))
  }

  const useSide = (side: Side) => {
    const s = fit[side]
    return useSplitter({
      edge: side === 'left' ? 'right' : 'left',
      value: s.width,
      min: s.min,
      max: s.max,
      label: side === 'left' ? 'Resize the project panel' : 'Resize the Agents panel',
      onPreview: (v) => body.current?.style.setProperty(`--xed-${side}`, `${v}px`),
      onCommit: (v) => xedLayout.patch(side === 'left' ? { left: v } : { right: v }),
      onReset: () => xedLayout.patch(side === 'left' ? { left: LEFT_DEFAULT } : { right: RIGHT_DEFAULT }),
    })
  }

  return {
    fit,
    body,
    bodyStyle: { '--xed-left': `${fit.left.width}px`, '--xed-right': `${fit.right.width}px` } as CSSProperties,
    leftOpen,
    rightOpen,
    leftSheet: sheetOn('left'),
    rightSheet: sheetOn('right'),
    rightMounted: rightMounted || rightOpen,
    setOpen,
    closeSheet: () => setSheet(null),
    leftSplit: useSide('left'),
    rightSplit: useSide('right'),
  }
}
