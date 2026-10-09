import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { download, isSf } from '../data/seafile'
import { folderOf, formatTime, nameOf, useMedia, useSiblings } from '../data/media'
import { useWM, type WinState } from '../os/wm'

// Player, for video and audio, after QuickTime: the picture fills the window (which takes the
// video's shape when it opens), and a floating bar with play, skip, the timeline (hover for the
// time, drag to scrub, what is buffered), volume, speed, loop, picture in picture and full screen.
// The bar hides while it plays and the pointer rests. Keys: Space or K, J and L, the arrows,
// M, F, 0 to 9, comma and full stop for single frames, < and > for speed.

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2]
const PREFS = 'mvlos.player'
const BAR = 34 // a window's title bar, for fitting the window to the video

function loadPrefs(): { volume: number; muted: boolean } {
  try {
    return { volume: 1, muted: false, ...JSON.parse(localStorage.getItem(PREFS) ?? '{}') }
  } catch {
    return { volume: 1, muted: false }
  }
}

export const playerTitle = (w: WinState) => (w.props.path ? nameOf(w.props.path) : 'Player')

export function Player({ win }: { win: WinState }) {
  const wm = useWM()
  const [path, setPathState] = useState(win.props.path ?? '')
  useEffect(() => {
    if (win.props.path) setPathState(win.props.path)
  }, [win.props.path, win.props.t])
  // Going to the next file: the window's title (and the saved layout) follow.
  const setPath = (p: string) => {
    setPathState(p)
    wm.setProps(win.pid, { path: p })
  }

  const media = useMedia(path)
  const siblings = useSiblings(path, ['video', 'audio'])
  const index = siblings.indexOf(path)
  const audio = media.kind === 'audio'

  const video = useRef<HTMLVideoElement>(null)
  const root = useRef<HTMLDivElement>(null)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [buffered, setBuffered] = useState(0)
  const [prefs, setPrefsState] = useState(loadPrefs)
  const [rate, setRate] = useState(1)
  const [loop, setLoop] = useState(false)
  const [full, setFull] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [idle, setIdle] = useState(false)
  const [menu, setMenu] = useState(false)
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const fitted = useRef<string | null>(null)
  useEffect(() => {
    if (!menu) return
    const close = (e: PointerEvent) => !(e.target as HTMLElement).closest('.pl-menu-wrap') && setMenu(false)
    window.addEventListener('pointerdown', close, true)
    return () => window.removeEventListener('pointerdown', close, true)
  }, [menu])

  const setPrefs = (p: Partial<{ volume: number; muted: boolean }>) =>
    setPrefsState((old) => {
      const next = { ...old, ...p }
      try {
        localStorage.setItem(PREFS, JSON.stringify(next))
      } catch {
        /* not kept */
      }
      return next
    })

  useEffect(() => {
    setError(null)
    setTime(0)
    setDuration(0)
    setBuffered(0)
  }, [path])

  useEffect(() => {
    const v = video.current
    if (!v) return
    v.volume = prefs.volume
    v.muted = prefs.muted
  }, [prefs, media.url])
  useEffect(() => {
    if (video.current) video.current.playbackRate = rate
  }, [rate, media.url])

  // The time line follows every frame while playing, not just the browser's few timeupdates.
  useEffect(() => {
    if (!playing) return
    let frame = 0
    const tick = () => {
      if (video.current) setTime(video.current.currentTime)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [playing])

  // --- the bar hides while playing and the pointer rests ------------------------------------

  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wake = useCallback(() => {
    setIdle(false)
    if (idleTimer.current) clearTimeout(idleTimer.current)
    idleTimer.current = setTimeout(() => setIdle(true), 2500)
  }, [])
  useEffect(() => () => void (idleTimer.current && clearTimeout(idleTimer.current)), [])
  const barHidden = idle && playing && !menu && !audio

  // --- controls --------------------------------------------------------------------------------

  const say = (text: string) => {
    setFlash(text)
    wake()
  }
  useEffect(() => {
    if (!flash) return
    const t = setTimeout(() => setFlash(null), 700)
    return () => clearTimeout(t)
  }, [flash])

  const toggle = () => {
    const v = video.current
    if (!v || error) return
    if (v.paused || v.ended) v.play().catch(() => {})
    else v.pause()
  }
  const seek = (t: number) => {
    const v = video.current
    if (!v || !isFinite(v.duration)) return
    v.currentTime = Math.max(0, Math.min(v.duration, t))
    setTime(v.currentTime)
  }
  const skip = (by: number) => {
    seek((video.current?.currentTime ?? 0) + by)
    say(`${by > 0 ? '+' : '−'}${Math.abs(by)} s`)
  }
  const volume = (v: number) => {
    const next = Math.max(0, Math.min(1, Math.round(v * 100) / 100))
    setPrefs({ volume: next, muted: next === 0 })
    say(`Volume ${Math.round(next * 100)}%`)
  }
  const speed = (by: number) => {
    const i = SPEEDS.indexOf(rate)
    const next = SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, (i < 0 ? 2 : i) + by))]
    setRate(next)
    say(`${next}×`)
  }
  const step = (frames: number) => {
    const v = video.current
    if (!v) return
    v.pause()
    seek(v.currentTime + frames / 30)
  }
  const go = (by: number) => siblings.length > 1 && setPath(siblings[((index < 0 ? 0 : index) + by + siblings.length) % siblings.length])

  // --- full screen and picture in picture ------------------------------------------------------

  useEffect(() => {
    const on = () => setFull(document.fullscreenElement === root.current)
    document.addEventListener('fullscreenchange', on)
    return () => document.removeEventListener('fullscreenchange', on)
  }, [])
  const toggleFull = () => (document.fullscreenElement ? document.exitFullscreen() : root.current?.requestFullscreen())?.catch(() => {})
  const canPip = !audio && typeof document !== 'undefined' && 'pictureInPictureEnabled' in document && document.pictureInPictureEnabled
  const togglePip = () => {
    const v = video.current
    if (!v) return
    ;(document.pictureInPictureElement ? document.exitPictureInPicture() : v.requestPictureInPicture()).catch(() => {})
  }

  // --- the window takes the video's shape when it opens ----------------------------------------

  const onMeta = () => {
    const v = video.current
    if (!v) return
    setDuration(v.duration)
    if (audio || fitted.current === path || win.maximized || win.snap || !v.videoWidth) return
    fitted.current = path
    const maxW = Math.min(window.innerWidth - 40, 960)
    const maxH = window.innerHeight - 140
    let w = Math.max(480, Math.min(maxW, v.videoWidth))
    let h = (w * v.videoHeight) / v.videoWidth
    if (h > maxH) {
      h = maxH
      w = Math.max(480, (h * v.videoWidth) / v.videoHeight)
    }
    const x = Math.max(10, Math.min(win.x, window.innerWidth - w - 10))
    const y = Math.max(38, Math.min(win.y, window.innerHeight - h - BAR - 80))
    wm.setGeometry(win.pid, { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h + BAR) })
  }

  const onError = () => {
    const code = video.current?.error?.code
    setError(code === 4 ? 'This browser cannot play this file (its format or codec). Download it to play it elsewhere.' : code === 2 ? 'The file stopped coming in (the network?).' : 'It could not be played.')
  }

  // Focusing the window lets the keys work straight away.
  useEffect(() => {
    if (wm.focusedPid === win.pid && !root.current?.contains(document.activeElement)) root.current?.focus({ preventScroll: true })
  }, [wm.focusedPid, win.pid])

  // Nothing scrolls in here.
  useEffect(() => {
    const el = root.current
    if (!el) return
    const stop = (e: WheelEvent) => e.preventDefault()
    el.addEventListener('wheel', stop, { passive: false })
    return () => el.removeEventListener('wheel', stop)
  }, [])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('input, select')) return
    const k = e.key
    const v = video.current
    if (k === ' ' || k.toLowerCase() === 'k') toggle()
    else if (k.toLowerCase() === 'j') skip(-10)
    else if (k.toLowerCase() === 'l') skip(10)
    else if (k === 'ArrowLeft') skip(-5)
    else if (k === 'ArrowRight') skip(5)
    else if (k === 'ArrowUp') volume(prefs.volume + 0.1)
    else if (k === 'ArrowDown') volume(prefs.volume - 0.1)
    else if (k.toLowerCase() === 'm') setPrefs({ muted: !prefs.muted })
    else if (k.toLowerCase() === 'f') toggleFull()
    else if (k === 'Home') seek(0)
    else if (k === 'End') seek(duration)
    else if (/^[0-9]$/.test(k)) seek((duration * Number(k)) / 10)
    else if (k === ',' && v?.paused) step(-1)
    else if (k === '.' && v?.paused) step(1)
    else if (k === '<') speed(-1)
    else if (k === '>') speed(1)
    else if (k.toLowerCase() === 'n') go(1)
    else if (k.toLowerCase() === 'p') go(-1)
    else return
    e.preventDefault()
    e.stopPropagation()
    wake()
  }

  // --- the timeline ----------------------------------------------------------------------------

  const track = useRef<HTMLDivElement>(null)
  const timeAt = (clientX: number) => {
    const r = track.current!.getBoundingClientRect()
    const f = Math.max(0, Math.min(1, (clientX - r.left) / r.width))
    return { x: f * r.width, t: f * (duration || 0) }
  }
  const scrubbing = useRef(false)
  const onTrackDown = (e: React.PointerEvent) => {
    if (!duration) return
    scrubbing.current = true
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    seek(timeAt(e.clientX).t)
  }
  const onTrackMove = (e: React.PointerEvent) => {
    if (!duration) return
    const at = timeAt(e.clientX)
    setHover(at)
    if (scrubbing.current) seek(at.t)
  }

  const save = () => (isSf(path) ? download(path).catch(() => {}) : undefined)
  const played = duration ? (time / duration) * 100 : 0
  const loaded = duration ? (buffered / duration) * 100 : 0
  const vol = prefs.muted ? 0 : prefs.volume

  return (
    <div ref={root} className={`pl ${barHidden ? 'is-idle' : ''} ${audio ? 'is-audio' : ''} ${full ? 'is-full' : ''}`} tabIndex={0} onKeyDown={onKeyDown} onPointerMove={wake} onPointerLeave={() => playing && setIdle(true)}>
      {media.unplayable || media.error ? (
        <div className="pl-empty">
          <p className="pl-big">{media.name || 'Player'}</p>
          <p className="muted">{media.unplayable ?? media.error}</p>
        </div>
      ) : (
        <>
          {media.url && (
            <video
              ref={video}
              key={media.url}
              className="pl-video"
              src={media.url}
              autoPlay
              playsInline
              loop={loop}
              preload="metadata"
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onEnded={() => {
                setPlaying(false)
                if (audio && !loop && siblings.length > 1 && index < siblings.length - 1) go(1)
              }}
              onLoadedMetadata={onMeta}
              onDurationChange={() => setDuration(video.current?.duration ?? 0)}
              onTimeUpdate={() => !playing && setTime(video.current?.currentTime ?? 0)}
              onProgress={() => {
                const v = video.current
                if (!v) return
                for (let i = 0; i < v.buffered.length; i++) if (v.buffered.start(i) <= v.currentTime + 0.5) setBuffered(v.buffered.end(i))
              }}
              onError={onError}
              onClick={toggle}
              onDoubleClick={toggleFull}
            />
          )}
          {audio && (
            <div className="pl-art" onClick={toggle}>
              <svg viewBox="0 0 48 48" width="96" height="96" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M19 34a5 5 0 1 1-5-5h5V12l17-4v20a5 5 0 1 1-5-5h5" />
              </svg>
              <strong>{media.name}</strong>
            </div>
          )}
          {!media.url && !error && <div className="pl-loading">Loading…</div>}
          {error && (
            <div className="pl-empty">
              <p className="pl-big">{media.name}</p>
              <p className="muted">{error}</p>
              {isSf(path) && (
                <button className="btn btn-small" onClick={save}>
                  Download
                </button>
              )}
            </div>
          )}
          {flash && <div className="pl-flash">{flash}</div>}
          {!playing && !error && media.url && !audio && (
            <button className="pl-big-play" onClick={toggle} aria-label="Play">
              <svg viewBox="0 0 24 24" width="34" height="34" aria-hidden>
                <path d="M8 5l12 7-12 7z" fill="currentColor" />
              </svg>
            </button>
          )}

          <div className="pl-bar" onPointerDown={(e) => e.stopPropagation()}>
            <div className="pl-row pl-time">
              <span>{formatTime(time)}</span>
              <div
                ref={track}
                className="pl-track"
                role="slider"
                aria-label="Time"
                aria-valuemin={0}
                aria-valuemax={Math.round(duration)}
                aria-valuenow={Math.round(time)}
                aria-valuetext={`${formatTime(time)} of ${formatTime(duration)}`}
                onPointerDown={onTrackDown}
                onPointerMove={onTrackMove}
                onPointerUp={() => (scrubbing.current = false)}
                onPointerLeave={() => setHover(null)}
              >
                <div className="pl-buffered" style={{ width: `${loaded}%` }} />
                <div className="pl-played" style={{ width: `${played}%` }} />
                <div className="pl-knob" style={{ left: `${played}%` }} />
                {hover && (
                  <span className="pl-hover" style={{ left: hover.x }}>
                    {formatTime(hover.t)}
                  </span>
                )}
              </div>
              <span>−{formatTime(Math.max(0, duration - time))}</span>
            </div>
            <div className="pl-row">
              <div className="pl-volume">
                <Btn label={prefs.muted ? 'Unmute (M)' : 'Mute (M)'} onClick={() => setPrefs({ muted: !prefs.muted })}>
                  <path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor" stroke="none" />
                  {vol > 0 && <path d="M16 9a4 4 0 0 1 0 6" />}
                  {vol > 0.5 && <path d="M18.5 6.5a8 8 0 0 1 0 11" />}
                  {vol === 0 && <path d="M16 9l5 6M21 9l-5 6" />}
                </Btn>
                <input type="range" min={0} max={1} step={0.01} value={vol} onChange={(e) => setPrefs({ volume: Number(e.target.value), muted: Number(e.target.value) === 0 })} aria-label="Volume" style={{ ['--v' as string]: `${vol * 100}%` }} />
              </div>
              <span className="spacer" />
              {siblings.length > 1 && (
                <Btn label="Previous (P)" onClick={() => go(-1)}>
                  <path d="M6 5v14M19 5l-10 7 10 7z" fill="currentColor" />
                </Btn>
              )}
              <Btn label="Back 10 seconds (J)" onClick={() => skip(-10)}>
                <path d="M11 6L5 12l6 6M19 6l-6 6 6 6" />
              </Btn>
              <button className="pl-play" onClick={toggle} aria-label={playing ? 'Pause (Space)' : 'Play (Space)'} title={playing ? 'Pause (Space)' : 'Play (Space)'}>
                <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden>
                  {playing ? <path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor" /> : <path d="M8 5l12 7-12 7z" fill="currentColor" />}
                </svg>
              </button>
              <Btn label="Forward 10 seconds (L)" onClick={() => skip(10)}>
                <path d="M13 6l6 6-6 6M5 6l6 6-6 6" />
              </Btn>
              {siblings.length > 1 && (
                <Btn label="Next (N)" onClick={() => go(1)}>
                  <path d="M18 5v14M5 5l10 7-10 7z" fill="currentColor" />
                </Btn>
              )}
              <span className="spacer" />
              <div className="pl-menu-wrap">
                <button className={`pl-speed ${rate !== 1 ? 'is-on' : ''}`} onClick={() => setMenu((m) => !m)} title="Speed and more" aria-haspopup="menu" aria-expanded={menu}>
                  {rate}×
                </button>
                {menu && (
                  <div className="pl-menu" role="menu">
                    {SPEEDS.map((s) => (
                      <button key={s} role="menuitemradio" aria-checked={rate === s} onClick={() => (setRate(s), setMenu(false))}>
                        <span>{rate === s ? '✓' : ''}</span>
                        {s === 1 ? 'Normal speed' : `${s}×`}
                      </button>
                    ))}
                    <hr />
                    <button role="menuitemcheckbox" aria-checked={loop} onClick={() => (setLoop(!loop), setMenu(false))}>
                      <span>{loop ? '✓' : ''}</span>Loop
                    </button>
                    <button role="menuitem" onClick={() => (wm.openNew('files', { path: folderOf(path), select: path }), setMenu(false))}>
                      <span />
                      Show in Files
                    </button>
                    {isSf(path) && (
                      <button role="menuitem" onClick={() => (save(), setMenu(false))}>
                        <span />
                        Download
                      </button>
                    )}
                  </div>
                )}
              </div>
              {canPip && (
                <Btn label="Picture in picture" onClick={togglePip}>
                  <rect x="3" y="5" width="18" height="14" rx="2" />
                  <rect x="12" y="11" width="7" height="6" rx="1" fill="currentColor" stroke="none" />
                </Btn>
              )}
              <Btn label={full ? 'Exit full screen (F)' : 'Full screen (F)'} onClick={toggleFull}>
                {full ? <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" /> : <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />}
              </Btn>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function Btn({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button className="pl-btn" onClick={onClick} title={label} aria-label={label}>
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {children}
      </svg>
    </button>
  )
}
