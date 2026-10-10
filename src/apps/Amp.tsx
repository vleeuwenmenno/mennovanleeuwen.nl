import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { readTags, type AudioTags } from '../data/audioTags'
import { folderOf, formatTime, nameOf, useMedia, useSiblings } from '../data/media'
import { download, isSf, parseSf } from '../data/seafile'
import { Select } from '../os/Select'
import { useWM, type WinState } from '../os/wm'

// Omamp, the music player: Winamp's three windows (the player, the equalizer and the playlist)
// stacked in one, drawn in the desktop's own palette. The music streams through this site
// (/api/seafile/stream) so the page's audio graph can hear it: a spectrum analyser in the
// display, a ten band equalizer with a preamp, and balance. The playlist is the music in the
// file's folder. Keys, as in Winamp: Z X C V B for previous, play, pause, stop and next, the
// arrows to seek and for volume, S for shuffle and R for repeat.

const PREFS = 'mvlos.amp'
const BANDS = [60, 170, 310, 600, 1000, 3000, 6000, 12000, 14000, 16000]
const BAND_LABELS = ['60', '170', '310', '600', '1K', '3K', '6K', '12K', '14K', '16K']
const PRESETS: Record<string, number[]> = {
  Flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  Rock: [5, 3, -3, -5, -2, 2, 5, 7, 7, 7],
  Pop: [-1, 3, 5, 5, 3, -1, -2, -2, -1, -1],
  Dance: [6, 4, 1, 0, 0, -3, -4, -4, 0, 0],
  Classical: [0, 0, 0, 0, 0, 0, -4, -4, -4, -6],
  'Full bass': [6, 6, 6, 3, 1, -3, -6, -7, -8, -8],
  'Full treble': [-6, -6, -6, -2, 2, 7, 10, 10, 10, 11],
  Vocal: [-2, -3, -3, 1, 4, 4, 3, 1, 0, -2],
  Headphones: [3, 7, 3, -2, -1, 1, 3, 6, 8, 9],
}
type Repeat = 'off' | 'all' | 'one'
type Vis = 'bars' | 'scope' | 'off'
type Prefs = { volume: number; balance: number; eq: boolean; preamp: number; bands: number[]; showEq: boolean; showPl: boolean; shuffle: boolean; repeat: Repeat; vis: Vis; remaining: boolean }
const DEFAULTS: Prefs = { volume: 0.8, balance: 0, eq: false, preamp: 0, bands: PRESETS.Flat, showEq: true, showPl: true, shuffle: false, repeat: 'all', vis: 'bars', remaining: false }

function loadPrefs(): Prefs {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(PREFS) ?? '{}') }
  } catch {
    return DEFAULTS
  }
}

/** Where the audio element loads a Seafile file from: through this site, for the audio graph. */
const streamOf = (path: string) => {
  const at = parseSf(path)
  return at ? `/api/seafile/stream?repo=${encodeURIComponent(at.repo)}&p=${encodeURIComponent(at.p)}` : null
}
const baseName = (path: string) => nameOf(path).replace(/\.[^.]+$/, '')
const extOf = (path: string) => (nameOf(path).match(/\.([^.]+)$/)?.[1] ?? '').toUpperCase()
const display = (path: string, tags?: AudioTags) => (tags?.title ? (tags.artist ? `${tags.artist} – ${tags.title}` : tags.title) : baseName(path))

export const ampTitle = (w: WinState) => (w.props.path ? baseName(w.props.path) : 'Omamp')

export function Amp({ win }: { win: WinState }) {
  const wm = useWM()
  const [path, setPathState] = useState(win.props.path ?? '')
  // A track opened from Files (or the desktop) plays straight away.
  const autoplay = useRef(!!win.props.path)
  useEffect(() => {
    if (!win.props.path) return
    autoplay.current = true
    setPathState(win.props.path)
  }, [win.props.path, win.props.t])
  const setPath = useCallback(
    (p: string) => {
      setPathState(p)
      wm.setProps(win.pid, { path: p })
    },
    [wm, win.pid],
  )

  const media = useMedia(path)
  const siblings = useSiblings(path, ['audio'])
  const playlist = siblings.length ? siblings : path ? [path] : []
  const index = playlist.indexOf(path)
  const url = isSf(path) ? streamOf(path) : null

  const [prefs, setPrefsState] = useState(loadPrefs)
  const setPrefs = useCallback(
    (p: Partial<Prefs>) =>
      setPrefsState((old) => {
        const next = { ...old, ...p }
        try {
          localStorage.setItem(PREFS, JSON.stringify(next))
        } catch {
          /* not kept */
        }
        return next
      }),
    [],
  )

  const audio = useRef<HTMLAudioElement>(null)
  const root = useRef<HTMLDivElement>(null)
  const [playing, setPlaying] = useState(false)
  const [stopped, setStopped] = useState(true)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [tags, setTags] = useState<Record<string, AudioTags>>({})
  const [durations, setDurations] = useState<Record<string, number>>({})
  const [selected, setSelected] = useState<string | null>(null)
  const current = tags[path]

  useEffect(() => {
    setError(null)
    setTime(0)
    setDuration(0)
    setSelected(path)
    if (!isSf(path)) return
    let live = true
    readTags(path).then((t) => live && setTags((old) => ({ ...old, [path]: t })))
    return () => {
      live = false
    }
  }, [path])

  // --- the audio graph: preamp, ten bands, balance, then the analyser -------------------------

  const graph = useRef<{ ctx: AudioContext; pre: GainNode; bands: BiquadFilterNode[]; pan: StereoPannerNode; analyser: AnalyserNode } | null>(null)
  const ensureGraph = () => {
    if (graph.current || !audio.current) return graph.current
    try {
      const ctx = new AudioContext()
      const source = ctx.createMediaElementSource(audio.current)
      const pre = ctx.createGain()
      // Peaks centred on each slider's frequency, as Winamp's were: a slider at +6 is +6 dB there.
      const bands = BANDS.map((f) => {
        const b = ctx.createBiquadFilter()
        b.type = 'peaking'
        b.frequency.value = f
        b.Q.value = 1.4
        return b
      })
      const pan = ctx.createStereoPanner()
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 2048
      analyser.smoothingTimeConstant = 0.6
      ;[source, pre, ...bands, pan, analyser].reduce((a, b) => (a.connect(b), b))
      analyser.connect(ctx.destination)
      graph.current = { ctx, pre, bands, pan, analyser }
    } catch {
      /* no Web Audio: it still plays, without the equalizer and the spectrum */
    }
    return graph.current
  }
  // An element joins one audio graph for life: when the graph is closed under a live window (a
  // hot reload, React's double mount in development), the element is swapped for a fresh one.
  const [gen, setGen] = useState(0)
  const closed = useRef(false)
  useEffect(() => {
    if (closed.current) {
      closed.current = false
      graph.current = null
      setPlaying(false)
      setGen((g) => g + 1)
    }
    return () => {
      closed.current = true
      void graph.current?.ctx.close().catch(() => {})
    }
  }, [])

  useEffect(() => {
    const g = graph.current
    if (!g) return
    const db = (v: number) => (prefs.eq ? v : 0)
    g.pre.gain.value = Math.pow(10, db(prefs.preamp) / 20)
    g.bands.forEach((b, i) => (b.gain.value = db(prefs.bands[i])))
    g.pan.pan.value = prefs.balance
  }, [prefs.eq, prefs.preamp, prefs.bands, prefs.balance, playing])
  useEffect(() => {
    if (audio.current) audio.current.volume = prefs.volume
  }, [prefs.volume, url, gen])

  // --- controls --------------------------------------------------------------------------------

  const play = () => {
    const a = audio.current
    if (!a || !url) return
    ensureGraph()
    void graph.current?.ctx.resume().catch(() => {})
    setStopped(false)
    a.play().catch(() => {})
  }
  const pause = () => {
    const a = audio.current
    if (!a) return
    if (a.paused && !stopped) play()
    else a.pause()
  }
  const stop = () => {
    const a = audio.current
    if (!a) return
    a.pause()
    a.currentTime = 0
    setTime(0)
    setStopped(true)
  }
  const seek = (t: number) => {
    const a = audio.current
    if (!a || !isFinite(a.duration)) return
    a.currentTime = Math.max(0, Math.min(a.duration, t))
    setTime(a.currentTime)
  }
  const order = useMemo(() => shuffled(playlist, prefs.shuffle), [playlist.join('\n'), prefs.shuffle]) // eslint-disable-line react-hooks/exhaustive-deps
  /** The next (or previous) track, or null at the end of the list without repeat. */
  const neighbour = (by: number): string | null => {
    if (!order.length) return null
    const i = order.indexOf(path)
    const j = (i < 0 ? 0 : i) + by
    if (j < 0 || j >= order.length) return prefs.repeat === 'all' ? order[(j + order.length) % order.length] : null
    return order[j]
  }
  const go = (by: number) => {
    // Winamp's previous restarts the track when it is a few seconds in.
    if (by < 0 && (audio.current?.currentTime ?? 0) > 3) return seek(0)
    const next = neighbour(by) ?? order[by > 0 ? 0 : order.length - 1]
    if (!next) return
    autoplay.current = playing
    setPath(next)
  }
  const choose = (p: string) => {
    autoplay.current = true
    if (p === path) {
      seek(0)
      play()
    } else setPath(p)
  }
  const onEnded = () => {
    if (prefs.repeat === 'one') return seek(0), play()
    const next = neighbour(1)
    if (!next) return setStopped(true)
    autoplay.current = true
    setPath(next)
  }
  // A new track starts playing when the last one was (or it was asked for).
  useEffect(() => {
    if (url && autoplay.current) play()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url])

  const volume = (v: number) => setPrefs({ volume: Math.max(0, Math.min(1, Math.round(v * 100) / 100)) })
  const eject = () => wm.openNew('files', path ? { path: folderOf(path), select: path } : {})

  // The time follows the music ten times a second while playing.
  useEffect(() => {
    if (!playing) return
    let frame = 0
    const tick = () => {
      if (audio.current) setTime(Math.floor(audio.current.currentTime * 10) / 10)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [playing])

  // --- media keys and the system's now playing ---------------------------------------------------

  const actions = useRef({ play, pause, stop, go })
  actions.current = { play, pause, stop, go }
  useEffect(() => {
    const ms = navigator.mediaSession
    if (!ms || !path) return
    ms.metadata = new MediaMetadata({ title: current?.title ?? baseName(path), artist: current?.artist ?? '', album: current?.album ?? '', artwork: current?.cover ? [{ src: current.cover }] : [] })
    const set = (a: MediaSessionAction, h: MediaSessionActionHandler | null) => {
      try {
        ms.setActionHandler(a, h)
      } catch {
        /* not supported */
      }
    }
    set('play', () => actions.current.play())
    set('pause', () => audio.current?.pause())
    set('stop', () => actions.current.stop())
    set('previoustrack', () => actions.current.go(-1))
    set('nexttrack', () => actions.current.go(1))
    return () => (['play', 'pause', 'stop', 'previoustrack', 'nexttrack'] as MediaSessionAction[]).forEach((a) => set(a, null))
  }, [path, current])

  // The playing track stays in view in the playlist.
  useEffect(() => {
    root.current?.querySelector('.amp-list [data-current]')?.scrollIntoView({ block: 'nearest' })
  }, [path, prefs.showPl, playlist.length])

  // --- the playlist's lengths, read one file at a time -----------------------------------------

  useEffect(() => {
    const todo = playlist.filter((p) => durations[p] === undefined && isSf(p)).slice(0, 200)
    if (!todo.length) return
    let live = true
    const probe = new Audio()
    probe.preload = 'metadata'
    const next = (i: number) => {
      if (!live || i >= todo.length) return
      const p = todo[i]
      const done = (d: number) => {
        probe.onloadedmetadata = probe.onerror = null
        if (!live) return
        setDurations((old) => ({ ...old, [p]: d }))
        void readTags(p).then((t) => live && setTags((old) => (old[p] ? old : { ...old, [p]: t })))
        next(i + 1)
      }
      probe.onloadedmetadata = () => done(probe.duration)
      probe.onerror = () => done(NaN)
      probe.src = streamOf(p)!
    }
    next(0)
    return () => {
      live = false
      probe.removeAttribute('src')
      probe.load()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playlist.join('\n')])

  // --- keys --------------------------------------------------------------------------------------

  useEffect(() => {
    if (wm.focusedPid === win.pid && !root.current?.contains(document.activeElement)) root.current?.focus({ preventScroll: true })
  }, [wm.focusedPid, win.pid])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('input, select, button[aria-haspopup]')) return
    const k = e.key.toLowerCase()
    if (k === 'z') go(-1)
    else if (k === 'x') play()
    else if (k === 'c') pause()
    else if (k === ' ') (playing ? audio.current?.pause() : play())
    else if (k === 'v') stop()
    else if (k === 'b') go(1)
    else if (k === 'arrowleft') seek(time - 5)
    else if (k === 'arrowright') seek(time + 5)
    else if (k === 'arrowup') volume(prefs.volume + 0.05)
    else if (k === 'arrowdown') volume(prefs.volume - 0.05)
    else if (k === 's') setPrefs({ shuffle: !prefs.shuffle })
    else if (k === 'r') setPrefs({ repeat: nextRepeat(prefs.repeat) })
    else if (k === 'enter' && selected) choose(selected)
    else return
    e.preventDefault()
    e.stopPropagation()
  }

  // --- the window grows and shrinks with the equalizer and the playlist ------------------------

  const eqRef = useRef<HTMLDivElement>(null)
  const plRef = useRef<HTMLDivElement>(null)
  const plHeight = useRef(260)
  const toggle = (which: 'showEq' | 'showPl') => {
    const on = !prefs[which]
    if (!win.maximized && !win.snap) {
      const el = which === 'showEq' ? eqRef.current : plRef.current
      if (which === 'showPl' && el) plHeight.current = el.offsetHeight
      const by = which === 'showEq' ? (on ? 150 : -(el?.offsetHeight ?? 150)) : on ? plHeight.current : -plHeight.current
      wm.setGeometry(win.pid, { h: Math.max(220, Math.min(window.innerHeight - win.y - 20, win.h + by)) })
    }
    setPrefs({ [which]: on })
  }

  // --- what the display says -------------------------------------------------------------------

  const state = error ? 'error' : playing ? 'play' : stopped ? 'stop' : 'pause'
  const kbps = current?.bitrate ?? (media.size && duration ? Math.round((media.size * 8) / duration / 1000) : null)
  const khz = current?.sampleRate ? Math.round(current.sampleRate / 1000) : null
  const marquee = error ?? media.unplayable ?? media.error ?? (path ? `${index + 1}. ${display(path, current)}${duration ? ` (${formatTime(duration)})` : ''}` : 'Omamp · open a song in Files')
  const shown = prefs.remaining && duration ? Math.max(0, duration - time) : time
  const totalTime = playlist.reduce((s, p) => s + (isFinite(durations[p]) ? durations[p] : 0), 0)

  return (
    <div ref={root} className={`amp ${prefs.showPl ? '' : 'no-pl'}`} tabIndex={0} onKeyDown={onKeyDown}>
      <audio
        ref={audio}
        key={gen}
        src={url ?? undefined}
        preload="auto"
        onPlay={() => (setPlaying(true), setStopped(false))}
        onPause={() => setPlaying(false)}
        onEnded={onEnded}
        onLoadedMetadata={() => (setError(null), setDuration(audio.current?.duration ?? 0))}
        onDurationChange={() => setDuration(audio.current?.duration ?? 0)}
        onTimeUpdate={() => !playing && setTime(audio.current?.currentTime ?? 0)}
        onError={() => {
          const code = audio.current?.error?.code
          if (!url) return
          setError(code === 4 ? 'This browser cannot play this file (its format or codec).' : code === 2 ? 'The music stopped coming in (the network?).' : 'It could not be played.')
        }}
      />

      {/* --- the player ------------------------------------------------------------------------ */}
      <section className="amp-panel amp-main">
        <Strip title="Omamp" />
        <div className="amp-top">
          <div className="amp-lcd amp-clock" onClick={() => setPrefs({ remaining: !prefs.remaining })} title="Elapsed or remaining">
            <span className={`amp-state is-${state}`} aria-label={state}>
              {state === 'play' ? '▶' : state === 'pause' ? '❚❚' : state === 'stop' ? '■' : '!'}
            </span>
            <span className={`amp-time ${!playing && !stopped ? 'is-blink' : ''}`}>
              {prefs.remaining && duration ? '-' : ' '}
              {formatTime(shown).padStart(5, ' ')}
            </span>
            <Visualizer graph={graph} playing={playing} mode={prefs.vis} onClick={(e) => (e.stopPropagation(), setPrefs({ vis: prefs.vis === 'bars' ? 'scope' : prefs.vis === 'scope' ? 'off' : 'bars' }))} />
          </div>
          <div className="amp-info">
            <div className="amp-lcd amp-marquee" title={marquee}>
              <Marquee text={marquee} />
            </div>
            <div className="amp-specs">
              <span className="amp-lcd amp-small" title="Bit rate">
                <b>{kbps ?? '---'}</b> kbps
              </span>
              <span className="amp-lcd amp-small" title="Sample rate">
                <b>{khz ?? '--'}</b> kHz
              </span>
              <span className="amp-tag">{extOf(path) || '—'}</span>
              <span className={`amp-led ${current?.channels === 1 ? 'is-on' : ''}`}>mono</span>
              <span className={`amp-led ${current?.channels !== 1 && url ? 'is-on' : ''}`}>stereo</span>
            </div>
            <div className="amp-sliders">
              <label className="amp-range amp-vol" title={`Volume ${Math.round(prefs.volume * 100)}%`}>
                <input type="range" min={0} max={1} step={0.01} value={prefs.volume} onChange={(e) => volume(Number(e.target.value))} aria-label="Volume" style={{ ['--v' as string]: `${prefs.volume * 100}%` }} />
              </label>
              <label className="amp-range amp-bal" title={prefs.balance === 0 ? 'Balance: centre' : `Balance: ${Math.round(Math.abs(prefs.balance) * 100)}% ${prefs.balance < 0 ? 'left' : 'right'}`}>
                <input
                  type="range"
                  min={-1}
                  max={1}
                  step={0.02}
                  value={prefs.balance}
                  onChange={(e) => {
                    const v = Number(e.target.value)
                    setPrefs({ balance: Math.abs(v) < 0.08 ? 0 : v })
                  }}
                  onDoubleClick={() => setPrefs({ balance: 0 })}
                  aria-label="Balance"
                />
              </label>
              <span className="spacer" />
              <Toggle on={prefs.showEq} onClick={() => toggle('showEq')} label="Equalizer">
                EQ
              </Toggle>
              <Toggle on={prefs.showPl} onClick={() => toggle('showPl')} label="Playlist">
                PL
              </Toggle>
            </div>
          </div>
        </div>
        <Seek time={time} duration={duration} onSeek={seek} />
        <div className="amp-transport">
          <Btn label="Previous (Z)" onClick={() => go(-1)}>
            <path d="M6 5v14M19 5l-10 7 10 7z" fill="currentColor" />
          </Btn>
          <Btn label="Play (X)" onClick={play} active={playing}>
            <path d="M8 5l12 7-12 7z" fill="currentColor" />
          </Btn>
          <Btn label="Pause (C)" onClick={pause} active={!playing && !stopped}>
            <path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor" stroke="none" />
          </Btn>
          <Btn label="Stop (V)" onClick={stop}>
            <rect x="6" y="6" width="12" height="12" fill="currentColor" />
          </Btn>
          <Btn label="Next (B)" onClick={() => go(1)}>
            <path d="M18 5v14M5 5l10 7-10 7z" fill="currentColor" />
          </Btn>
          <Btn label="Open in Files" onClick={eject} className="amp-eject">
            <path d="M12 5l7 8H5zM5 17h14v2H5z" fill="currentColor" stroke="none" />
          </Btn>
          <span className="spacer" />
          <Toggle on={prefs.shuffle} onClick={() => setPrefs({ shuffle: !prefs.shuffle })} label="Shuffle (S)">
            Shuffle
          </Toggle>
          <Toggle on={prefs.repeat !== 'off'} onClick={() => setPrefs({ repeat: nextRepeat(prefs.repeat) })} label={`Repeat: ${prefs.repeat} (R)`}>
            {prefs.repeat === 'one' ? 'Rep 1' : 'Repeat'}
          </Toggle>
        </div>
      </section>

      {/* --- the equalizer --------------------------------------------------------------------- */}
      {prefs.showEq && (
        <section className="amp-panel amp-eq" ref={eqRef}>
          <Strip title="Equalizer" onClose={() => toggle('showEq')} />
          <div className="amp-eq-top">
            <Toggle on={prefs.eq} onClick={() => setPrefs({ eq: !prefs.eq })} label="Equalizer on or off">
              On
            </Toggle>
            <EqCurve bands={prefs.bands} preamp={prefs.preamp} on={prefs.eq} />
            <Select
              className="amp-presets"
              // With the equalizer off nothing is chosen, so picking any preset (even the last one) turns it on.
              value={prefs.eq ? (Object.keys(PRESETS).find((k) => PRESETS[k].every((v, i) => v === prefs.bands[i])) ?? null) : null}
              placeholder={prefs.eq ? 'Custom' : 'Presets'}
              options={Object.keys(PRESETS).map((k) => ({ value: k, label: k }))}
              onChange={(k) => setPrefs({ bands: PRESETS[k], eq: true })}
              aria-label="Presets"
            />
          </div>
          <div className={`amp-eq-bands ${prefs.eq ? '' : 'is-off'}`}>
            <Band label="Pre" value={prefs.preamp} onChange={(v) => setPrefs({ preamp: v })} />
            <div className="amp-eq-scale" aria-hidden>
              <span>+12</span>
              <span>0</span>
              <span>-12</span>
            </div>
            {BAND_LABELS.map((l, i) => (
              <Band key={l} label={l} value={prefs.bands[i]} onChange={(v) => setPrefs({ bands: prefs.bands.map((b, j) => (j === i ? v : b)), eq: true })} />
            ))}
          </div>
        </section>
      )}

      {/* --- the playlist ---------------------------------------------------------------------- */}
      {prefs.showPl && (
        <section className="amp-panel amp-pl" ref={plRef}>
          <Strip title="Playlist" onClose={() => toggle('showPl')} />
          <ol className="amp-lcd amp-list" role="listbox" aria-label="Playlist">
            {playlist.length === 0 && <li className="amp-empty">Open a song in Files: the rest of its folder lands here.</li>}
            {playlist.map((p, i) => (
              <li
                key={p}
                role="option"
                aria-selected={p === selected}
                className={`${p === path ? 'is-current' : ''} ${p === selected ? 'is-selected' : ''}`}
                onClick={() => setSelected(p)}
                onDoubleClick={() => choose(p)}
                data-current={p === path || undefined}
              >
                <span className="amp-n">{i + 1}.</span>
                <span className="amp-t">{display(p, tags[p])}</span>
                <span className="amp-d">{durations[p] !== undefined && isFinite(durations[p]) ? formatTime(durations[p]) : p === path && duration ? formatTime(duration) : ''}</span>
              </li>
            ))}
          </ol>
          <div className="amp-pl-foot">
            <span className="amp-lcd amp-small">
              {playlist.length} {playlist.length === 1 ? 'track' : 'tracks'}
              {totalTime ? ` · ${formatTime(totalTime)}` : ''}
            </span>
            <span className="spacer" />
            {current?.album && <span className="amp-album" title={current.album}>{current.album}{current.year ? ` (${current.year})` : ''}</span>}
            {isSf(path) && (
              <button className="amp-key" onClick={() => void download(path).catch(() => {})} title="Download this track">
                Save
              </button>
            )}
            <button className="amp-key" onClick={eject} title="Show in Files">
              Files
            </button>
          </div>
        </section>
      )}
    </div>
  )
}

const nextRepeat = (r: Repeat): Repeat => (r === 'off' ? 'all' : r === 'all' ? 'one' : 'off')

/** The list in a fixed random order, so going back and forth on shuffle stays on one path. */
function shuffled(list: string[], on: boolean): string[] {
  if (!on) return list
  const out = [...list]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

// --- pieces --------------------------------------------------------------------------------------

function Strip({ title, onClose }: { title: string; onClose?: () => void }) {
  return (
    <div className="amp-strip">
      <span className="amp-groove" />
      <span className="amp-strip-title">{title}</span>
      <span className="amp-groove" />
      {onClose && (
        <button className="amp-strip-x" onClick={onClose} aria-label={`Hide ${title.toLowerCase()}`} title={`Hide ${title.toLowerCase()}`}>
          ×
        </button>
      )}
    </div>
  )
}

function Btn({ label, onClick, children, active, className = '' }: { label: string; onClick: () => void; children: ReactNode; active?: boolean; className?: string }) {
  return (
    <button className={`amp-key amp-btn ${active ? 'is-active' : ''} ${className}`} onClick={onClick} title={label} aria-label={label}>
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden>
        {children}
      </svg>
    </button>
  )
}

function Toggle({ on, onClick, label, children }: { on: boolean; onClick: () => void; label: string; children: ReactNode }) {
  return (
    <button className={`amp-key amp-toggle ${on ? 'is-on' : ''}`} onClick={onClick} title={label} aria-label={label} aria-pressed={on}>
      <i className="amp-dot" />
      {children}
    </button>
  )
}

function Marquee({ text }: { text: string }) {
  const box = useRef<HTMLDivElement>(null)
  const inner = useRef<HTMLSpanElement>(null)
  const [scroll, setScroll] = useState(false)
  useEffect(() => {
    const check = () => setScroll(!!box.current && !!inner.current && inner.current.scrollWidth > box.current.clientWidth)
    check()
    const ro = new ResizeObserver(check)
    if (box.current) ro.observe(box.current)
    return () => ro.disconnect()
  }, [text])
  return (
    <div ref={box} className={`amp-marquee-box ${scroll ? 'is-scrolling' : ''}`}>
      <span ref={inner} style={scroll ? { animationDuration: `${Math.max(6, text.length / 4)}s` } : undefined}>
        {text}
        {scroll && <span aria-hidden>{'  ***  '}{text}{'  ***  '}</span>}
      </span>
    </div>
  )
}

function Seek({ time, duration, onSeek }: { time: number; duration: number; onSeek: (t: number) => void }) {
  const track = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<number | null>(null)
  const at = (x: number) => {
    const r = track.current!.getBoundingClientRect()
    return Math.max(0, Math.min(1, (x - r.left) / r.width)) * duration
  }
  const shown = drag ?? time
  const f = duration ? (shown / duration) * 100 : 0
  return (
    <div
      ref={track}
      className={`amp-seek ${duration ? '' : 'is-off'}`}
      role="slider"
      aria-label="Position"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(shown)}
      aria-valuetext={`${formatTime(shown)} of ${formatTime(duration)}`}
      onPointerDown={(e) => {
        if (!duration) return
        e.currentTarget.setPointerCapture(e.pointerId)
        setDrag(at(e.clientX))
      }}
      onPointerMove={(e) => drag !== null && setDrag(at(e.clientX))}
      onPointerUp={() => {
        if (drag !== null) onSeek(drag)
        setDrag(null)
      }}
    >
      <div className="amp-seek-fill" style={{ width: `${f}%` }} />
      <div className="amp-seek-knob" style={{ left: `${f}%` }} />
    </div>
  )
}

function Band({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <label className="amp-band" title={`${label}: ${value > 0 ? '+' : ''}${value} dB`}>
      <input type="range" min={-12} max={12} step={1} value={value} onChange={(e) => onChange(Number(e.target.value))} onDoubleClick={() => onChange(0)} aria-label={`${label} band`} style={{ ['--v' as string]: `${((value + 12) / 24) * 100}%` }} />
      <span>{label}</span>
    </label>
  )
}

/** Winamp's little curve of the bands. */
function EqCurve({ bands, preamp, on }: { bands: number[]; preamp: number; on: boolean }) {
  const w = 120
  const h = 24
  const y = (v: number) => h / 2 - (v / 12) * (h / 2 - 2)
  const pts = bands.map((v, i) => `${(i / (bands.length - 1)) * w},${y(v)}`).join(' ')
  return (
    <svg className={`amp-lcd amp-curve ${on ? '' : 'is-off'}`} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden>
      <line x1="0" x2={w} y1={y(preamp)} y2={y(preamp)} className="amp-curve-pre" />
      <polyline points={pts} />
    </svg>
  )
}

type Graph = { current: { analyser: AnalyserNode } | null }

/** The spectrum (bars with falling peaks) or the oscilloscope, in the display's colours. */
function Visualizer({ graph, playing, mode, onClick }: { graph: Graph; playing: boolean; mode: Vis; onClick: (e: React.MouseEvent) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = canvas.current
    const ctx = c?.getContext('2d')
    if (!c || !ctx) return
    const css = getComputedStyle(c)
    const color = (name: string) => css.getPropertyValue(name).trim() || '#9ece6a'
    const low = color('--green')
    const mid = color('--yellow')
    const high = color('--red')
    const peak = color('--fg-bright')
    const COUNT = 19
    const peaks = new Array(COUNT).fill(0)
    const levels = new Array(COUNT).fill(0)
    let frame = 0
    let freq: Uint8Array<ArrayBuffer> | null = null
    let wave: Uint8Array<ArrayBuffer> | null = null
    const draw = () => {
      const dpr = window.devicePixelRatio || 1
      const W = c.clientWidth
      const H = c.clientHeight
      if (c.width !== W * dpr) c.width = W * dpr
      if (c.height !== H * dpr) c.height = H * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, W, H)
      const a = graph.current?.analyser
      if (mode === 'bars') {
        if (a && playing) {
          freq ??= new Uint8Array(a.frequencyBinCount)
          a.getByteFrequencyData(freq)
        }
        const grad = ctx.createLinearGradient(0, H, 0, 0)
        grad.addColorStop(0, low)
        grad.addColorStop(0.55, mid)
        grad.addColorStop(1, high)
        const gap = 1
        const bw = (W - gap * (COUNT - 1)) / COUNT
        for (let i = 0; i < COUNT; i++) {
          // Bands spaced by octave, as the ear hears them.
          let v = 0
          if (freq && playing) {
            const from = Math.floor(Math.pow(freq.length / 2, i / COUNT))
            const to = Math.max(from + 1, Math.floor(Math.pow(freq.length / 2, (i + 1) / COUNT)))
            for (let k = from; k < to; k++) v = Math.max(v, freq[k])
            v /= 255
          }
          levels[i] = Math.max(v, levels[i] - 0.04)
          peaks[i] = levels[i] >= peaks[i] ? levels[i] : Math.max(0, peaks[i] - 0.012)
          const x = i * (bw + gap)
          const bh = Math.round(levels[i] * H)
          ctx.fillStyle = grad
          ctx.fillRect(x, H - bh, bw, bh)
          if (peaks[i] > 0.02) {
            ctx.fillStyle = peak
            ctx.fillRect(x, H - Math.round(peaks[i] * H) - 1, bw, 1)
          }
        }
      } else if (mode === 'scope') {
        ctx.strokeStyle = low
        ctx.lineWidth = 1
        ctx.beginPath()
        if (a && playing) {
          wave ??= new Uint8Array(a.fftSize)
          a.getByteTimeDomainData(wave)
          for (let x = 0; x < W; x++) {
            const v = wave[Math.floor((x / W) * wave.length)] / 255
            if (x) ctx.lineTo(x, v * H)
            else ctx.moveTo(x, v * H)
          }
        } else {
          ctx.moveTo(0, H / 2)
          ctx.lineTo(W, H / 2)
        }
        ctx.stroke()
      }
      // Keep drawing while the bars fall back after a pause.
      if (playing || levels.some((l) => l > 0) || peaks.some((p) => p > 0)) frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [graph, playing, mode])
  return <canvas ref={canvas} className="amp-vis" onClick={onClick} title="Visualizer: click for bars, scope or off" />
}
