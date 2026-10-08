import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Terminal } from '../apps/Terminal'
import { profile } from '../data/profile'
import { bootDone, finishShutdown, powerOn, usePower } from './powerState'
import type { WinState } from './wm'

// The screens around the desktop: the boot log (which can be paused into a text console), the
// shutdown log, and the powered-off screen.

const platform = typeof navigator !== 'undefined' ? navigator.platform || 'the web' : 'the web'

// [kind, text, delay before the line in ms]. Kernel lines fly by, systemd takes its time.
type LogLine = ['k' | 'ok' | 'warn' | 'start' | 'info', string, number]
const BOOT: LogLine[] = [
  ['k', `[    0.000000] Linux version 6.42.0-mvl (menno@arch) (gcc 15.2.1) #1 SMP PREEMPT_DYNAMIC`, 0],
  ['k', `[    0.000000] Command line: BOOT_IMAGE=/vmlinuz-mvl root=/dev/cv rw quiet splash=no`, 30],
  ['k', `[    0.000000] DMI: ${platform}, BIOS curiosity 1.0 19/09/1996`, 30],
  ['k', '[    0.004211] Memory: 30 years available, 0 wasted', 30],
  ['k', '[    0.017302] smpboot: Allowing 1 human CPU, coffee-powered', 30],
  ['k', '[    0.041337] ACPI: Interpreter enabled, sleep states: S0 (coding) S3 (gaming)', 30],
  ['k', '[    0.083120] PCI: Using configuration type 1 for base access', 30],
  ['k', '[    0.120954] NET: Registered PF_TAILSCALE protocol family', 30],
  ['k', '[    0.162008] usb 1-1: new high-speed USB device: Mechanical Keyboard (very clicky)', 30],
  ['k', '[    0.210447] nvme0n1: p1 p2 p3 (projects, contributions, games)', 30],
  ['k', '[    0.264113] EXT4-fs (nvme0n1p2): mounted filesystem /home/menno ro, for your safety', 30],
  ['k', '[    0.301772] Run /sbin/init as init process', 40],
  ['info', '', 60],
  ['info', 'Welcome to MvL OS (Arch, Omarchy flavour)!', 120],
  ['info', '', 60],
  ['ok', 'Created slice Slice /system/getty.', 70],
  ['ok', 'Reached target Local Encrypted Volumes.', 60],
  ['ok', 'Listening on Journal Socket.', 60],
  ['start', 'Starting Journal Service...', 80],
  ['ok', 'Started Journal Service.', 110],
  ['start', 'Starting Load Kernel Module caffeine...', 70],
  ['ok', 'Finished Load Kernel Module caffeine.', 120],
  ['ok', 'Mounted /home/menno/Projects.', 70],
  ['ok', 'Reached target Local File Systems.', 60],
  ['start', 'Starting Network Manager...', 90],
  ['ok', 'Started Network Manager.', 140],
  ['start', 'Starting Tailscale node agent...', 80],
  ['ok', 'Started Tailscale node agent.', 150],
  ['ok', 'Reached target Network is Online.', 70],
  ['start', 'Starting Fetch recent activity from api.github.com...', 90],
  ['start', 'Starting Fetch recent activity from git.mvl.sh...', 60],
  ['ok', 'Finished Fetch recent activity from git.mvl.sh.', 160],
  ['ok', 'Finished Fetch recent activity from api.github.com.', 90],
  ['start', 'Starting Pepper cluster agent...', 80],
  ['ok', 'Started Pepper cluster agent.', 130],
  ['ok', 'Started Minecraft status probe for cloud.mvl.sh.', 90],
  ['ok', 'Started Boltwarden vault (locked, nice try).', 90],
  ['ok', 'Loaded projects: boltwarden savuvo pepper golinks omasoloist.', 100],
]

// The graphical session: the end of a normal boot, or what `exit` starts from the text console.
const GUI: LogLine[] = [
  ['start', 'Starting Hyprland compositor (react-wm)...', 90],
  ['ok', 'Started Hyprland compositor (react-wm).', 170],
  ['ok', 'Reached target Graphical Interface.', 110],
]

// Instead of the graphical session, when P was pressed: stop at multi-user and log in on tty1.
function consoleLines(): LogLine[] {
  const last = new Date().toLocaleString('en-GB', { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })
  return [
    ['ok', 'Reached target Multi-User System.', 110],
    ['warn', 'Graphical session held back on request. Starting a shell on tty1.', 160],
    ['info', '         Type exit to start the desktop; reboot and shutdown work too.', 0],
    ['info', '', 200],
    ['info', 'MvL OS 1.0 mvlos tty1', 0],
    ['info', '', 0],
    ['info', `mvlos login: ${profile.handle} (automatic login)`, 300],
    ['info', `Last login: ${last} on tty1`, 120],
  ]
}


const kernelTime = () => `[${(performance.now() / 1000).toFixed(6).padStart(12)}]`

const SHUTDOWN = (reboot: boolean): LogLine[] => [
  ['start', `Stopping Session 1 of User ${profile.handle}...`, 0],
  ['start', 'Stopping Hyprland compositor (react-wm)...', 60],
  ['ok', 'Stopped Hyprland compositor (react-wm).', 140],
  ['ok', 'Stopped Minecraft status probe for cloud.mvl.sh.', 70],
  ['ok', 'Stopped Pepper cluster agent.', 90],
  ['ok', 'Stopped Boltwarden vault (it was locked anyway).', 80],
  ['ok', `Stopped Session 1 of User ${profile.handle}.`, 110],
  ['ok', 'Removed slice User Slice of UID 1000.', 70],
  ['start', 'Stopping Tailscale node agent...', 60],
  ['ok', 'Stopped Tailscale node agent.', 150],
  ['ok', 'Stopped Network Manager.', 90],
  ['ok', 'Reached target Network is Offline.', 70],
  ['start', 'Unmounting /home/menno/Projects...', 60],
  ['ok', 'Unmounted /home/menno/Projects.', 130],
  ['ok', 'Stopped Journal Service.', 90],
  ['ok', 'Reached target System Shutdown.', 80],
  ['ok', `Reached target System ${reboot ? 'Reboot' : 'Power Off'}.`, 120],
  ['k', `${kernelTime()} reboot: ${reboot ? 'Restarting system' : 'Power down'}`, 220],
]

/** One line of boot or shutdown log, systemd style. */
function Line({ line: [kind, text] }: { line: LogLine }) {
  return (
    <div className={kind === 'k' ? 'boot-k' : undefined}>
      {kind === 'ok' && (
        <>
          [<span className="t-green">  OK  </span>]{' '}
        </>
      )}
      {kind === 'warn' && (
        <>
          [<span className="t-yellow">  !!  </span>]{' '}
        </>
      )}
      {kind === 'start' ? `         ${text}` : text || ' '}
    </div>
  )
}

/** Prints `lines` one by one at their own pace; `paused` holds it where it is. */
function useLog(lines: LogLine[], paused = false) {
  const [n, setN] = useState(0)
  useEffect(() => {
    if (paused || n >= lines.length) return
    const t = setTimeout(() => setN(n + 1), lines[n][2])
    return () => clearTimeout(t)
  }, [n, paused, lines])
  return [n, n >= lines.length] as const
}

/** Keeps the newest line in view once the screen is full, like a real console. */
function useFollow(dep: unknown) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [dep])
  return ref
}

// The text console is a terminal without a window around it.
const CONSOLE_WIN: WinState = { pid: -1, app: 'terminal', x: 0, y: 0, w: 0, h: 0, z: 0, minimized: false, maximized: false, props: {}, openedAt: 0 }

function Boot() {
  // P asks for a text console: the boot still runs to the end, then logs in on tty1 instead of
  // starting the desktop. `exit` there starts the graphical session after all.
  const [wantConsole, setWantConsole] = useState(false)
  const [resumed, setResumed] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const main = useMemo(() => [...BOOT, ...(wantConsole ? consoleLines() : GUI)], [wantConsole])
  const [n, mainDone] = useLog(main)
  const [g, guiDone] = useLog(GUI, !resumed)
  const consoleOpen = wantConsole && mainDone
  const finished = wantConsole ? resumed && guiDone : mainDone
  const ref = useFollow(n + g)

  useEffect(() => {
    if (!finished) return
    const t = setTimeout(() => setLeaving(true), 450)
    return () => clearTimeout(t)
  }, [finished])

  useEffect(() => {
    if (!leaving) return
    const t = setTimeout(bootDone, 300)
    return () => clearTimeout(t)
  }, [leaving])

  // Too late once the desktop has started coming up.
  const canPause = !wantConsole && n < BOOT.length
  const pause = () => canPause && setWantConsole(true)

  // P asks for the console; any other key skips the boot. Once asked, keys wait for the console.
  const pauseRef = useRef(pause)
  pauseRef.current = pause
  useEffect(() => {
    if (wantConsole) return
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (e.key.toLowerCase() === 'p') {
        e.preventDefault()
        pauseRef.current()
      } else bootDone()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [wantConsole])

  return (
    <div
      ref={ref}
      className={`boot ${leaving ? 'is-leaving' : ''} ${consoleOpen && !resumed ? 'is-paused' : ''} ${consoleOpen ? 'has-console' : ''}`}
      onClick={() => !wantConsole && bootDone()}
    >
      <pre>
        {main.slice(0, n).map((l, i) => (
          <Line key={i} line={l} />
        ))}
        {consoleOpen && (
          <>
            <Terminal win={CONSOLE_WIN} onLogout={() => setResumed(true)} />
            {resumed && <div>logout</div>}
            {GUI.slice(0, g).map((l, i) => (
              <Line key={`g${i}`} line={l} />
            ))}
          </>
        )}
        {!(consoleOpen && !resumed) && !finished && <span className="boot-cursor">_</span>}
      </pre>
      {canPause && (
        <button
          className="boot-hint"
          onClick={(e) => {
            e.stopPropagation()
            pause()
          }}
        >
          <span className="boot-hint-main">
            <kbd>P</kbd> drop to a shell after boot
          </span>
          <span className="boot-hint-skip">click or any other key skips</span>
        </button>
      )}
      {wantConsole && !consoleOpen && (
        <div className="boot-hint is-armed" aria-live="polite">
          <span className="boot-hint-main">
            <kbd>P</kbd> shell on tty1 once boot finishes
          </span>
        </div>
      )}
    </div>
  )
}

function Shutdown({ reboot }: { reboot: boolean }) {
  const [lines] = useState(() => SHUTDOWN(reboot))
  const [n, finished] = useLog(lines)
  const ref = useFollow(n)
  useEffect(() => {
    if (!finished) return
    const t = setTimeout(finishShutdown, reboot ? 700 : 500)
    return () => clearTimeout(t)
  }, [finished, reboot])
  return (
    <div ref={ref} className="boot">
      <pre>
        {lines.slice(0, n).map((l, i) => (
          <Line key={i} line={l} />
        ))}
      </pre>
    </div>
  )
}

function PoweredOff() {
  useEffect(() => {
    // Ignore the key that is still being released from typing the command.
    const t = setTimeout(() => window.addEventListener('keydown', powerOn), 400)
    return () => {
      clearTimeout(t)
      window.removeEventListener('keydown', powerOn)
    }
  }, [])
  return (
    <div className="boot powered-off">
      <button className="power-btn" onClick={powerOn} aria-label="Power on">
        <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
          <path d="M12 3v8" />
          <path d="M6.3 6.8a8 8 0 1 0 11.4 0" />
        </svg>
      </button>
      <p>MvL OS is powered off. Press any key or the button to power on.</p>
    </div>
  )
}

/** Whatever covers the desktop right now: boot log, shutdown log, the off screen, or nothing. */
export function PowerScreens() {
  const power = usePower()
  if (power.phase === 'boot') return <Boot key={power.run} />
  if (power.phase === 'down') return <Shutdown reboot={power.then === 'boot'} />
  if (power.phase === 'off') return <PoweredOff />
  return null
}
