import { useEffect, useState } from 'react'
import { MC_ADDRESS, useMinecraft } from '../../data/minecraft'

// Not a game. A convincing-enough boot sequence, a loading bar that stalls at 87%, and then the
// truth. The server address at the end is real, though.

type Phase = 'studio' | 'world' | 'joke'

const WORLD_STEPS = ['Loading terrain', 'Building world', 'Preparing spawn area']

export function Minecraft() {
  const [phase, setPhase] = useState<Phase>('studio')
  const [progress, setProgress] = useState(0)
  const [run, setRun] = useState(0)
  const [copied, setCopied] = useState(false)
  const { status } = useMinecraft()

  useEffect(() => {
    setPhase('studio')
    setProgress(0)
    const timers: ReturnType<typeof setTimeout>[] = []
    const at = (ms: number, fn: () => void) => timers.push(setTimeout(fn, ms))
    // Studio splash: bar fills.
    for (let i = 1; i <= 10; i++) at(i * 190, () => setProgress(i * 10))
    at(2300, () => {
      setPhase('world')
      setProgress(0)
    })
    // World loading: brisk to 87%, then nothing, for comic effect.
    const curve = [4, 11, 19, 26, 34, 41, 52, 60, 68, 74, 79, 83, 86, 87]
    curve.forEach((p, i) => at(2500 + i * 170, () => setProgress(p)))
    at(2500 + curve.length * 170 + 1900, () => setPhase('joke'))
    return () => timers.forEach(clearTimeout)
  }, [run])

  if (phase === 'studio')
    return (
      <div className="mc-boot mc-studio">
        <div className="mc-studio-logo">
          <span className="mc-studio-mark">M</span>
          <span>MVL STUDIOS</span>
        </div>
        <div className="mc-bar mc-bar-white">
          <span style={{ width: `${progress}%` }} />
        </div>
      </div>
    )

  if (phase === 'world') {
    const step = WORLD_STEPS[Math.min(WORLD_STEPS.length - 1, Math.floor(progress / 34))]
    return (
      <div className="mc-boot mc-world">
        <p className="mc-title">MINECRAFT</p>
        <p className="mc-step">{step}</p>
        <div className="mc-bar mc-bar-green">
          <span style={{ width: `${progress}%` }} />
        </div>
        <p className="mc-percent">{progress}%</p>
      </div>
    )
  }

  return (
    <div className="mc-boot mc-world mc-joke-wrap">
      <div className="mc-joke">
        <p className="mc-joke-title">Dude, seriously?</p>
        <p>You were about to play Minecraft in a browser tab, inside a fake operating system, on someone's CV.</p>
        <p>
          Go play it on your PC. <span className="muted">Like a normal person.</span>
        </p>
        <div className="mc-joke-server">
          <span className={`live-dot ${status?.online ? 'is-live' : status ? 'is-down' : ''}`} />
          <span>
            The server is real though: <code>{MC_ADDRESS}</code>
            {status?.online && (
              <span className="muted">
                {' '}
                · {status.players.online}/{status.players.max} online · Java {status.version}
              </span>
            )}
          </span>
        </div>
        <div className="actions">
          <button
            className="btn btn-primary"
            onClick={() =>
              navigator.clipboard
                ?.writeText(MC_ADDRESS)
                .then(() => setCopied(true))
                .catch(() => {})
            }
          >
            {copied ? 'Copied ✓ now go' : 'Copy server address'}
          </button>
          <button className="btn" onClick={() => setRun((r) => r + 1)}>
            Try again (it won't help)
          </button>
        </div>
      </div>
    </div>
  )
}
