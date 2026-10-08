import { useEffect, useRef, useState } from 'react'

// The D51 steam locomotive from the classic `sl`, driving right to left across the terminal.
// Like the original, it cannot be interrupted: the prompt comes back when the train has left.

const ENGINE = [
  '      ====        ________                ___________ ',
  '  _D _|  |_______/        \\__I_I_____===__|_________| ',
  '   |(_)---  |   H\\________/ |   |        =|___ ___|   ',
  '   /     |  |   H  |  |     |   |         ||_| |_||   ',
  '  |      |  |   H  |__--------------------| [___] |   ',
  '  | ________|___H__/__|_____/[][]~\\_______|       |   ',
  '  |/ |   |-----------I_____I [][] []  D   |=======|__ ',
]

// Three wheel positions; cycling them makes the coupling rods turn.
const WHEELS = [
  [
    '__/ =| o |=-~~\\  /~~\\  /~~\\  /~~\\ ____Y___________|__ ',
    ' |/-=|___|=    ||    ||    ||    |_____/~\\___/        ',
    '  \\_/      \\O=====O=====O=====O_/      \\_/            ',
  ],
  [
    '__/ =| o |=-~~\\  /~~\\  /~~\\  /~~\\ ____Y___________|__ ',
    ' |/-=|___|=O=====O=====O=====O   |_____/~\\___/        ',
    '  \\_/      \\__/  \\__/  \\__/  \\__/      \\_/            ',
  ],
  [
    '__/ =| o |=-O=====O=====O=====O \\ ____Y___________|__ ',
    ' |/-=|___|=    ||    ||    ||    |_____/~\\___/        ',
    '  \\_/      \\__/  \\__/  \\__/  \\__/      \\_/            ',
  ],
]

const COAL = [
  '                              ',
  '    _________________         ',
  '   _|                \\_____A  ',
  ' =|                        |  ',
  ' -|                        |  ',
  '__|________________________|_ ',
  '|__________________________|_ ',
  '   |_D__D__D_|  |_D__D__D_|   ',
  '    \\_/   \\_/    \\_/   \\_/    ',
  '                              ',
]

// Smoke trails behind the chimney (to the right, since the train drives left).
const SMOKE = [
  ['           (@@) (  ) (@)  ( )  @@    ()', '        (   )', '      (@@@@)', '     (  )'],
  ['           (  ) (@@) ( )  (@)  ()    @@', '        (@@@)', '      (    )', '     (@@)'],
]

const TRAIN_WIDTH = ENGINE[0].length + COAL[0].length
const STEP_MS = 32

function frame(tick: number) {
  const smoke = SMOKE[Math.floor(tick / 4) % SMOKE.length].map((l) => l.padEnd(TRAIN_WIDTH))
  const wheels = WHEELS[tick % WHEELS.length]
  const body = [...ENGINE, ...wheels].map((l, i) => l + COAL[i])
  return [...smoke, ...body].join('\n')
}

export function SlTrain({ onDone }: { onDone?: () => void }) {
  const box = useRef<HTMLDivElement>(null)
  const probe = useRef<HTMLSpanElement>(null)
  const [tick, setTick] = useState(0)
  const [cols, setCols] = useState<number | null>(null)
  const [done, setDone] = useState(false)
  const doneRef = useRef(onDone)
  doneRef.current = onDone

  useEffect(() => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setDone(true)
      doneRef.current?.()
      return
    }
    const charW = (probe.current?.getBoundingClientRect().width ?? 80) / 10
    const width = Math.ceil((box.current?.clientWidth ?? 600) / charW)
    setCols(width)
    const total = width + TRAIN_WIDTH
    const start = performance.now()
    let raf = 0
    const loop = (now: number) => {
      const t = Math.floor((now - start) / STEP_MS)
      if (t >= total) {
        setDone(true)
        doneRef.current?.()
        return
      }
      setTick(t)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])

  if (done) return <span className="t-muted">You typed sl. The train was the punishment.</span>

  return (
    <div className="sl-track" ref={box} aria-label="A steam locomotive drives past">
      <span ref={probe} className="sl-probe" aria-hidden>
        0000000000
      </span>
      {cols !== null && (
        <pre className="sl-train" style={{ transform: `translateX(${cols - tick}ch)` }} aria-hidden>
          {frame(tick)}
        </pre>
      )}
    </div>
  )
}
