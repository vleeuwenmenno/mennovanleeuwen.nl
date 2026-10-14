// Injected into every page `pnpm check:perf` opens, before the page's own scripts. Nothing here
// ships: it is a test harness (scripts/perf/check.ts), not part of the app.
//
// - A clock the check steps by hand: performance.now(), requestAnimationFrame and the timers run
//   on it. Until `__perf.manual()` it follows real time (menus and loading work as usual); after,
//   time only moves when `__perf.frames(n)` steps it, a fixed 1/60 s a frame, so every run draws
//   the same frames at the same moments on any machine, however slow.
// - Math.random from a fixed seed (reseeded by `manual`).
// - Counters: canvas calls, new canvases, React commits, frames asked for, timer callbacks.
;(() => {
  if (window.__perf) return
  try {
    localStorage.setItem('mvlos.empires.muted', '1')
  } catch {}

  const real = {
    now: performance.now.bind(performance),
    raf: window.requestAnimationFrame.bind(window),
    setTimeout: window.setTimeout.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
  }

  // Seeded random (mulberry32).
  let seed = 1
  Math.random = () => {
    if (counting) add('random')
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  // --- The clock ---
  let manual = false
  let offset = 0 // following real time: now = real + offset
  let frozen = 0 // stepped by hand: now = frozen
  const START = 1_000_000 // where the stepped clock starts (ms)
  let base = 0
  let frameNo = 0
  const now = () => (manual ? frozen : real.now() + offset)
  performance.now = now

  // The date: a fixed day (a calendar shows the same month on any day the check runs), on the
  // same clock. And the same machine everywhere, for what reads it.
  const RealDate = Date
  const DAY = RealDate.UTC(2026, 0, 15, 9, 0, 0)
  const at0 = real.now()
  let dateShift = 0 // keeps the date running on when the stepped clock starts at its own time
  const today = () => Math.floor(DAY + (now() - at0) + dateShift)
  window.Date = class extends RealDate {
    constructor(...a) {
      if (a.length) super(...a)
      else super(today())
    }
    static now() {
      return today()
    }
  }
  for (const [k, v] of [['hardwareConcurrency', 8], ['deviceMemory', 8]]) Object.defineProperty(Navigator.prototype, k, { configurable: true, get: () => v })

  const C = {} // counters, by name
  let stepped = 0 // frames stepped by hand
  let commitLog = [] // the frame of each React commit while counting (to find what renders)
  const add = (k, n = 1) => (C[k] = (C[k] || 0) + n)
  let counting = false

  // Frames: callbacks wait here for the next frame, real or stepped.
  let frames = new Map()
  let rafSeq = 0
  let pumping = 0
  let frameMs = [] // the main thread's time per stepped frame (callbacks, style and layout, ms)
  const runFrame = (t) => {
    const list = frames
    frames = new Map()
    for (const fn of list.values()) {
      if (counting) add('rafCallbacks')
      try {
        fn(t)
      } catch (e) {
        real.setTimeout(() => {
          throw e
        })
      }
    }
  }
  const pump = () => {
    if (pumping || manual) return
    pumping = real.raf(() => {
      pumping = 0
      if (!manual) runFrame(now())
    })
  }
  window.requestAnimationFrame = (fn) => {
    const id = ++rafSeq
    frames.set(id, fn)
    pump()
    return id
  }
  window.cancelAnimationFrame = (id) => {
    frames.delete(id)
  }

  // Timers, on the same clock. Following real time each has a real timer under it; stepped, they
  // fire in order as `frames` passes their time.
  const timers = new Map()
  let timerSeq = 0
  const arm = (id, t) => {
    t.handle = real.setTimeout(() => fire(id), Math.max(0, t.due - now()))
  }
  const fire = (id) => {
    const t = timers.get(id)
    if (!t) return
    if (t.every !== null) {
      t.due = Math.max(t.due + t.every, manual ? t.due + t.every : now())
      if (!manual) arm(id, t)
    } else timers.delete(id)
    if (counting && !t.vite) add(t.every !== null ? 'intervalFires' : 'timeoutFires')
    if (counting && window.__perfTimerFrom && t.from) window.__perfTimerFrom[t.from] = (window.__perfTimerFrom[t.from] || 0) + 1
    t.fn(...t.args)
  }
  const schedule = (every) =>
    function (fn, ms, ...args) {
      if (typeof fn !== 'function') return real.setTimeout(fn, ms) // a string: not used by the app
      const id = ++timerSeq + 1_000_000
      const d = Math.max(every ? 1 : 0, Number(ms) || 0)
      const stack = new Error().stack || ''
      // Vite's own client (its reconnect timers) is the dev server's, not the app's: not counted.
      const t = { fn, args, due: now() + d, delay: d, every: every ? d : null, handle: 0, from: '', vite: stack.includes('/@vite/') }
      // Debugging timers: set window.__perfTimerFrom = {} to count each one's fires by where it
      // was set.
      if (window.__perfTimerFrom) t.from = stack.split('\n').slice(2, 4).map((l) => l.trim()).join(' < ')
      timers.set(id, t)
      if (!manual) arm(id, t)
      return id
    }
  const unschedule = (id) => {
    const t = timers.get(id)
    if (!t) return real.clearTimeout(id)
    real.clearTimeout(t.handle)
    timers.delete(id)
  }
  window.setTimeout = schedule(false)
  window.setInterval = schedule(true)
  window.clearTimeout = unschedule
  window.clearInterval = unschedule

  /** A turn of the event loop: React renders, effects and promises settle. */
  const ch = new MessageChannel()
  const waiting = []
  ch.port1.onmessage = () => waiting.shift()?.()
  const turn = () => new Promise((r) => (waiting.push(r), ch.port2.postMessage(0)))

  // --- Counting ---
  // Canvas: each call on a 2D context, split by whether its canvas is on the page or off screen
  // (a cache being drawn).
  const CALLS = ['fill', 'stroke', 'fillRect', 'strokeRect', 'clearRect', 'drawImage', 'save', 'restore', 'fillText', 'strokeText', 'createRadialGradient', 'createLinearGradient', 'createConicGradient', 'createPattern', 'getImageData', 'putImageData', 'clip']
  for (const proto of [window.CanvasRenderingContext2D?.prototype, window.OffscreenCanvasRenderingContext2D?.prototype]) {
    if (!proto) continue
    for (const m of CALLS) {
      const orig = proto[m]
      if (typeof orig !== 'function') continue
      proto[m] = function (...a) {
        if (counting) add((this.canvas && this.canvas.isConnected ? 'on.' : 'off.') + m)
        // The pixel snapshots leave text out: fonts differ between machines.
        if (P.noText && (m === 'fillText' || m === 'strokeText')) return
        return orig.apply(this, a)
      }
    }
    for (const [prop, on] of [['filter', (v) => v && v !== 'none'], ['shadowBlur', (v) => Number(v) > 0]]) {
      const d = Object.getOwnPropertyDescriptor(proto, prop)
      if (!d || !d.set) continue
      Object.defineProperty(proto, prop, {
        configurable: true,
        get: d.get,
        set(v) {
          if (counting && on(v)) add(`set.${prop}`)
          d.set.call(this, v)
        },
      })
    }
  }
  const ce = Document.prototype.createElement
  Document.prototype.createElement = function (tag, ...rest) {
    if (counting && String(tag).toLowerCase() === 'canvas') add('newCanvas')
    return ce.call(this, tag, ...rest)
  }
  if (window.OffscreenCanvas) {
    const O = window.OffscreenCanvas
    window.OffscreenCanvas = function (w, h) {
      if (counting) add('newCanvas')
      return new O(w, h)
    }
    window.OffscreenCanvas.prototype = O.prototype
  }

  // React: a minimal devtools hook, counting commits.
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    renderers: new Map(),
    supportsFiber: true,
    isDisabled: false,
    inject(r) {
      const id = this.renderers.size + 1
      this.renderers.set(id, r)
      return id
    },
    checkDCE() {},
    onScheduleFiberRoot() {},
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    onCommitFiberRoot() {
      if (counting) {
        add('commits')
        commitLog.push(stepped)
      }
    },
  }

  // Hidden: the page as a background tab sees it.
  let hidden = null
  for (const [prop, val] of [['hidden', () => hidden], ['visibilityState', () => (hidden ? 'hidden' : 'visible')]]) {
    const d = Object.getOwnPropertyDescriptor(Document.prototype, prop)
    Object.defineProperty(Document.prototype, prop, {
      configurable: true,
      get() {
        return hidden === null ? d.get.call(this) : val()
      },
    })
  }

  const P = (window.__perf = {
    noText: false,
    /** From here on the clock only moves when stepped, and Math.random starts again from `s`. */
    manual(s = 1) {
      if (!manual) {
        // A fixed start (not however long the page took to load), and frames at fixed times
        // from it: the same floating-point steps every run (a game adding up 1/60 s frames
        // until a tick is due sees exactly the same sums).
        const was = now()
        base = Math.max(START, Math.ceil(was / START) * START)
        frozen = base
        dateShift -= base - was
        frameNo = 0
        manual = true
        // Timers set before now start over from here, as if just set: how much of their time had
        // run out depended on how long loading took.
        for (const t of timers.values()) {
          real.clearTimeout(t.handle)
          t.due = frozen + t.delay
        }
      }
      seed = s
    },
    /** Back to real time (timers re-armed). */
    auto() {
      if (!manual) return
      offset = frozen - real.now()
      manual = false
      for (const [id, t] of timers) arm(id, t)
      if (frames.size) pump()
    },
    /** Steps n frames of 1/60 s, calling `each(i)` before each (a camera path, input), and lets the
     * page settle after each. */
    async frames(n, each) {
      for (let i = 0; i < n; i++) {
        // Timed: the frame's input, its timers, its callbacks and the style and layout they leave
        // (which the browser does before painting). Not timed: the turns of the event loop between
        // them, where the browser may also paint on its own real-time schedule.
        let busy = 0
        let s = real.now()
        if (each) each(i)
        const target = base + (++frameNo * 1000) / 60
        // Timers due before the frame, in the order they're due.
        for (let guard = 0; guard < 10000; guard++) {
          let id = -1
          let due = Infinity
          for (const [k, t] of timers) if (t.due <= target && t.due < due) (id = k), (due = t.due)
          if (id < 0) break
          frozen = Math.max(frozen, due)
          fire(id)
          busy += real.now() - s
          await turn()
          s = real.now()
        }
        frozen = target
        stepped++
        // A hidden page gets no frames, only its timers.
        if (!hidden) {
          runFrame(frozen)
          document.documentElement.getBoundingClientRect()
        }
        busy += real.now() - s
        if (counting && !hidden) frameMs.push(busy)
        // React renders and effects, promises.
        await turn()
        await turn()
        await turn()
        // Debugging a count that differs between runs: set window.__perfTrace = [] to get the
        // counters after every frame, and find the first frame where two runs part.
        if (counting && window.__perfTrace) window.__perfTrace.push(JSON.stringify(C))
      }
    },
    /** Runs what's due without moving the clock or drawing a frame: timers set for now
     * (setTimeout 0), promises, React. For waiting on loading (which runs on real time) without
     * the frames in between depending on how long it took. */
    async settle() {
      for (let guard = 0; guard < 10000; guard++) {
        let id = -1
        let due = Infinity
        for (const [k, t] of timers) if (t.due <= frozen && t.due < due) (id = k), (due = t.due)
        if (id < 0) break
        fire(id)
        await turn()
      }
      await turn()
    },
    setHidden(h) {
      hidden = h
      document.dispatchEvent(new Event('visibilitychange'))
    },
    count(on) {
      counting = on
    },
    reset() {
      for (const k of Object.keys(C)) delete C[k]
      frameMs = []
      commitLog = []
    },
    read() {
      return { counts: { ...C }, frameMs: [...frameMs], commitLog: [...commitLog] }
    },
    liveTimers() {
      let intervals = 0
      let timeouts = 0
      for (const t of timers.values()) if (!t.vite) t.every !== null ? intervals++ : timeouts++
      return { intervals, timeouts, frameCallbacks: frames.size }
    },
    turn,
    realSleep: (ms) => new Promise((r) => real.setTimeout(r, ms)),
  })
})()
