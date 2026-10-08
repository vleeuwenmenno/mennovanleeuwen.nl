import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { WinState } from '../../../os/wm'
import { useGameKeys } from '../shared'
import { makeActor, ArenaScene } from './arena'
import type { Rand } from './character'
import type { Gladiator } from './character'
import { act, attackCost, ATTACKS, blockers, choose, hitChance, inReach, newFight, spellChance, spellCost, startTurn, STATUS_NAMES, type Action, type AttackType, type Ev, type Fight, type Snap } from './combat'
import { POTIONS, spell, type PotionId } from './data'
import { kitOf } from './render'
import { IMPACT } from './rig'
import type { GladiatorSound } from './sound'
import { Bar } from './ui'

// One bout in the arena. The rules engine decides each turn at once; this screen then plays the
// events back on a timeline: swings, impacts, blood, numbers and crowd noise, bars updating when
// the blow lands. The player picks actions from the bar below; the computer thinks for a beat.

export type FightResultView = { title: string; lines: ReactNode[]; good: boolean }

type Props = {
  win: WinState
  you: Gladiator
  foe: Gladiator
  arena: string
  skill: number
  label: string
  hp?: [number, number]
  hardcore: boolean
  sound: GladiatorSound
  /** Called once when the bout ends; returns what to show on the results card. */
  onEnd: (won: boolean, peakFavour: number, hpLeft: number, spared: boolean, potions: Gladiator['potions']) => FightResultView
  onLeave: () => void
}

type Phase = 'intro' | 'player' | 'busy' | 'mercy' | 'over'
type Hud = { snaps: [Snap, Snap]; phase: Phase; log: string[]; turn: 0 | 1 }

const POTION_KEYS: Record<PotionId, string> = { health: 'h', stamina: 'j', mana: 'k' }
const SPELL_KEYS = ['6', '7', '8', '9', '0', '-']

export function FightScreen(p: Props) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const rnd: Rand = Math.random
  const fightRef = useRef<Fight | null>(null)
  if (!fightRef.current) fightRef.current = newFight(p.you, p.foe, rnd, { hp: p.hp })
  const fight = fightRef.current
  const sceneRef = useRef<ArenaScene | null>(null)
  if (!sceneRef.current) {
    const sc = new ArenaScene()
    sc.setBackground(p.arena)
    sc.actors = [makeActor(kitOf(p.you.look, p.you.gear), fight.f[0].x, 1, 3), makeActor(kitOf(p.foe.look, p.foe.gear), fight.f[1].x, -1, 7)]
    sceneRef.current = sc
  }
  const scene = sceneRef.current
  const tl = useRef({ now: 0, q: [] as { at: number; fn: () => void }[] })
  const snapNow = (): [Snap, Snap] => fight.f.map((x) => ({ hp: x.hp, sta: x.sta, mana: x.mana, favour: x.favour, x: x.x, statuses: x.statuses.map((s) => s.id) })) as [Snap, Snap]
  const [hud, setHud] = useState<Hud>({ snaps: snapNow(), phase: 'intro', log: [], turn: fight.turn })
  const [menu, setMenu] = useState<null | 'spells' | 'potions'>(null)
  const [result, setResult] = useState<FightResultView | null>(null)
  const [mercy, setMercy] = useState<null | 'asking' | 'up' | 'down'>(null)
  const ended = useRef(false)
  const snd = p.sound

  const at = (t: number, fn: () => void) => tl.current.q.push({ at: t, fn })
  const show = (snaps: [Snap, Snap], text?: string) =>
    setHud((h) => ({ ...h, snaps, log: text ? [...h.log.slice(-3), text] : h.log }))
  const pan = (x: number) => Math.max(-1, Math.min(1, (x - scene.cam.x) / 640))
  const actor = (who: 0 | 1) => scene.actors[who]
  const applyStatus = (snaps: [Snap, Snap]) => {
    scene.actors.forEach((a, i) => {
      a.statuses = snaps[i].statuses
      a.wounds = 1 - snaps[i].hp / fight.f[i].d.maxHp
      a.puppet.tired = Math.max(0, Math.min(1, (0.35 - snaps[i].hp / fight.f[i].d.maxHp) * 3))
    })
    const heat = Math.max(snaps[0].favour, snaps[1].favour) / 100
    snd.crowd(0.25 + heat * 0.6)
    snd.intensity = 0.3 + heat * 0.7
  }

  /** Lays a turn's events out on the timeline; returns when (in timeline ms) they're done. */
  const schedule = (evs: Ev[], done: () => void) => {
    let c = Math.max(tl.current.now, ...tl.current.q.map((x) => x.at))
    for (const ev of evs) c += playEvent(ev, c)
    at(c, done)
  }

  const playEvent = (ev: Ev, c: number): number => {
    const fx = (fn: () => void, d = 0) => at(c + d, fn)
    const sync = () => {
      show(ev.snap, ev.text)
      applyStatus(ev.snap)
    }
    switch (ev.t) {
      case 'turn':
        fx(() => {
          sync()
          scene.front = ev.who
          setHud((h) => ({ ...h, turn: ev.who }))
        })
        return 60
      case 'move': {
        const a = actor(ev.who)
        const d = Math.abs(ev.to - ev.from)
        const dur = Math.max(320, Math.min(900, d * 3.2))
        const forward = Math.sign(ev.to - ev.from) === a.facing
        fx(() => {
          a.puppet.play(forward ? 'walk' : 'walkBack', 80)
          scene.slide(a, ev.to, dur)
          for (let t = 0; t < dur - 100; t += 260) setTimeout(() => snd.step(pan(a.x)), t)
        })
        fx(() => {
          a.puppet.play('guard', 140)
          scene.dust(a.x, 4)
          sync()
        }, dur)
        return dur + 80
      }
      case 'attack': {
        const a = actor(ev.who)
        const hit = IMPACT[ev.type]
        fx(() => {
          if (ev.riposte) show(ev.snap, ev.text)
          a.puppet.play(ev.type, 70)
          scene.front = ev.who
          snd.grunt('effort', ev.who ? 0.92 : 1.05, pan(a.x))
        })
        fx(() => snd.whoosh(ev.type === 'power' ? 1 : ev.type === 'normal' ? 0.6 : 0.35, pan(a.x)), Math.max(0, hit - 130))
        return hit
      }
      case 'hit': {
        const a = actor(ev.who)
        const b = actor((1 - ev.who) as 0 | 1)
        const target = fight.f[1 - ev.who]
        fx(() => {
          sync()
          const dir = a.facing
          const pt = { x: b.chest.x - dir * 18, y: b.chest.y - 20 }
          if (ev.blocked) {
            b.puppet.play('block', 50)
            scene.sparks(pt.x, pt.y, -dir, 14)
            snd.block(pan(b.x))
          } else {
            b.puppet.play('hit', 40)
            b.flash = 1
            scene.blood(pt.x, pt.y, dir, Math.min(26, 4 + ev.dmg * (ev.crit ? 1.4 : 0.8)))
            const armoured = !!(target.g.gear.body || target.g.gear.head)
            if (armoured && Math.random() < 0.6) {
              scene.sparks(pt.x, pt.y, -dir, 8)
              snd.clang(ev.type === 'power' ? 0.9 : 0.5, pan(b.x))
            }
            snd.thud(ev.type === 'power' || ev.crit ? 1 : 0.55, pan(b.x))
            snd.grunt('pain', ev.who ? 1.05 : 0.95, pan(b.x))
          }
          scene.text(ev.crit ? `${ev.dmg}!` : String(ev.dmg), b.head.x, b.head.y - 30, ev.crit ? '#ffd23a' : ev.blocked ? '#d8d8d8' : '#ff5a4a', ev.crit ? 48 : 36)
          if (ev.crit) scene.text('CRITICAL', b.head.x, b.head.y - 76, '#ffd23a', 24)
          if (ev.blocked) scene.text('BLOCKED', b.head.x, b.head.y - 76, '#e8e8e8', 22)
          if (ev.stun) scene.text('STUNNED', b.head.x, b.head.y - 100, '#ffe04a', 24)
          scene.shake = Math.min(16, 3 + ev.dmg * 0.25 + (ev.crit ? 6 : 0))
          scene.hitstop = ev.crit || ev.type === 'power' ? 90 : 40
          if (ev.push) scene.slide(b, ev.snap[1 - ev.who].x, 260)
          if (ev.push > 20) setTimeout(() => scene.dust(b.x, 6), 200)
          if (ev.crit || ev.type === 'power') snd.cheer(ev.crit ? 0.8 : 0.4)
        })
        return 420
      }
      case 'miss': {
        const b = actor((1 - ev.who) as 0 | 1)
        fx(() => {
          sync()
          b.puppet.play('dodge', 50)
          scene.text('MISS', b.head.x, b.head.y - 40, '#cfcfcf', 28)
          if (ev.type === 'power') snd.gasp()
        })
        return 420
      }
      case 'cast': {
        const a = actor(ev.who)
        fx(() => {
          a.puppet.play('cast', 60)
          scene.front = ev.who
          snd.spell(ev.spell, 'cast', pan(a.x))
          snd.grunt('shout', ev.who ? 0.95 : 1.05, pan(a.x))
          scene.burst('magic', a.tip.x, a.tip.y, 12, spell(ev.spell).colour, 120)
        })
        return 420
      }
      case 'spell': {
        const a = actor(ev.who)
        const b = actor((1 - ev.who) as 0 | 1)
        const colour = spell(ev.spell).colour
        if (ev.spell === 'heal') {
          fx(() => {
            sync()
            scene.burst('heal', a.chest.x, a.chest.y, 30, colour, 160, -60)
            scene.text(`+${ev.heal}`, a.head.x, a.head.y - 30, '#8cf28a', 38)
            snd.spell('heal', 'hit', pan(a.x))
          })
          return 700
        }
        const travel = ev.spell === 'thunder' ? 120 : Math.max(220, (Math.abs(a.x - b.x) / 900) * 1000)
        const land = () => {
          sync()
          if (ev.missed) {
            b.puppet.play('dodge', 50)
            scene.text('DODGED', b.head.x, b.head.y - 40, '#cfcfcf', 26)
            return
          }
          if (ev.dmg) {
            b.puppet.play('hit', 40)
            b.flash = 1
            scene.text(String(ev.dmg), b.head.x, b.head.y - 30, colour, 38)
            scene.shake = 8
          }
          if (ev.spell === 'fireball') scene.burst('fire', b.chest.x, b.chest.y, 40, '#ff8a2a', 260)
          if (ev.spell === 'frost') scene.burst('frost', b.chest.x, b.chest.y, 30, '#cdf4ff', 240)
          if (ev.spell === 'weaken') scene.burst('magic', b.chest.x, b.chest.y, 30, '#b48cff', 120)
          if (ev.spell === 'blind') {
            scene.burst('star', b.head.x, b.head.y, 14, '#fff6b0', 200)
            scene.screenFlash = { color: '#fffbe0', a: 0.5 }
          }
          if (ev.spell === 'thunder') scene.burst('spark', b.chest.x, b.chest.y, 30, '#d6e8ff', 400)
          snd.spell(ev.spell, 'hit', pan(b.x))
          if (ev.dmg) snd.grunt('pain', 1, pan(b.x))
          snd.cheer(0.4)
        }
        fx(() => {
          if (ev.spell === 'thunder') {
            scene.bolt(b.chest.x, b.chest.y + 40)
            land()
          } else {
            const target = ev.missed ? { x: b.chest.x - a.facing * -60, y: b.chest.y - 80 } : b.chest
            scene.projectile(ev.spell, a.tip, target, () => {})
          }
        })
        if (ev.spell !== 'thunder') fx(land, travel)
        return travel + 420
      }
      case 'taunt': {
        const a = actor(ev.who)
        fx(() => {
          a.puppet.play('taunt', 80)
          a.bubble = { text: ev.line, until: performance.now() + 2000 }
          snd.grunt('shout', ev.who ? 0.9 : 1.1, pan(a.x))
        })
        fx(() => {
          sync()
          if (ev.ok) {
            snd.cheer(0.6)
            scene.text('CROWD +', a.head.x, a.head.y - 90, '#ffd23a', 24)
          } else snd.boo()
        }, 700)
        return 1150
      }
      case 'rest': {
        const a = actor(ev.who)
        fx(() => a.puppet.play('rest', 120))
        fx(() => {
          sync()
          scene.text('+STAMINA', a.head.x, a.head.y - 20, '#9fe07a', 24)
          snd.boo()
        }, 500)
        return 1100
      }
      case 'potion': {
        const a = actor(ev.who)
        const pot = POTIONS.find((x) => x.id === ev.id)!
        fx(() => {
          a.potion = pot.colour
          a.puppet.play('drink', 80)
          snd.drink()
        })
        fx(() => {
          a.potion = null
          sync()
          scene.burst('heal', a.chest.x, a.chest.y, 24, pot.colour, 140, -60)
        }, 700)
        return 900
      }
      case 'dot': {
        const a = actor(ev.who)
        fx(() => {
          sync()
          a.flash = 0.7
          scene.burst('fire', a.chest.x, a.chest.y, 20, '#ff8a2a', 160)
          scene.text(String(ev.dmg), a.head.x, a.head.y - 30, '#ff9a3a', 30)
          snd.spell('fireball', 'hit', pan(a.x))
        })
        return 520
      }
      case 'stunned': {
        const a = actor(ev.who)
        fx(() => {
          sync()
          a.puppet.play('stunned', 80)
          scene.text('STUNNED', a.head.x, a.head.y - 60, '#ffe04a', 28)
        })
        fx(() => a.puppet.play('guard', 200), 900)
        return 1000
      }
      case 'frenzy': {
        const a = actor(ev.who)
        fx(() => {
          sync()
          scene.burst('heal', a.chest.x, a.chest.y, 50, '#ffd84a', 300)
          scene.petals(70)
          scene.text('FRENZY!', a.head.x, a.head.y - 70, '#ffd23a', 44)
          snd.cheer(1)
          snd.fanfare()
        })
        return 900
      }
      case 'secondWind': {
        const a = actor(ev.who)
        fx(() => {
          sync()
          scene.burst('heal', a.chest.x, a.chest.y, 40, '#8cf28a', 240)
          scene.text('SECOND WIND', a.head.x, a.head.y - 60, '#8cf28a', 30)
          snd.cheer(0.6)
        })
        return 800
      }
      case 'ko': {
        const a = actor(ev.who)
        const w = actor((1 - ev.who) as 0 | 1)
        fx(() => {
          sync()
          a.puppet.play('ko', 40)
          scene.timeScale = 0.35
          scene.blood(a.chest.x, a.chest.y, -a.facing, 30)
          snd.grunt('pain', 0.8, pan(a.x))
          snd.cheer(1)
        })
        fx(() => {
          scene.timeScale = 1
          snd.fall(pan(a.x))
          scene.dust(a.x - a.facing * 40, 14, 60)
          scene.shake = 10
        }, 380)
        fx(() => {
          w.puppet.play('victory', 200)
          scene.petals(110)
          snd.cheer(1)
        }, 900)
        return 1800
      }
    }
  }

  // --- Turn flow -------------------------------------------------------------------------------

  const finish = () => {
    if (ended.current) return
    ended.current = true
    const won = fight.winner === 0
    const me = fight.f[0]
    const end = (spared: boolean) => {
      setResult(p.onEnd(won, me.tally.peakFavour, me.hp / me.d.maxHp, spared, { ...me.potions }))
      setHud((h) => ({ ...h, phase: 'over' }))
      snd.stopMusic()
      if (won) snd.fanfare(true)
    }
    if (!won && p.hardcore) {
      // The crowd decides: their favour is your life.
      setHud((h) => ({ ...h, phase: 'mercy' }))
      setMercy('asking')
      const spared = Math.random() < 0.12 + me.favour * 0.006 + me.tally.peakFavour * 0.002
      setTimeout(() => {
        setMercy(spared ? 'up' : 'down')
        if (spared) snd.cheer(1)
        else snd.boo()
      }, 1800)
      setTimeout(() => end(spared), 3400)
    } else end(false)
  }

  const nextTurn = () => {
    if (fight.winner !== null) return finish()
    const canAct = startTurn(fight, rnd)
    const evs = fight.events.splice(0)
    schedule(evs, () => {
      if (fight.winner !== null) return finish()
      if (!canAct) return nextTurn()
      if (fight.turn === 0) setHud((h) => ({ ...h, phase: 'player' }))
      else {
        setHud((h) => ({ ...h, phase: 'busy' }))
        at(tl.current.now + 380, () => {
          act(fight, choose(fight, rnd, p.skill), rnd)
          schedule(fight.events.splice(0), nextTurn)
        })
      }
    })
  }

  const doAction = (a: Action) => {
    if (hud.phase !== 'player' || fight.turn !== 0) return
    const why = blockers(fight, 0)
    const key = a.kind === 'attack' ? a.type : a.kind === 'spell' ? `spell:${a.id}` : a.kind === 'potion' ? `potion:${a.id}` : a.kind
    if (why[key]) return
    snd.wake()
    setMenu(null)
    setHud((h) => ({ ...h, phase: 'busy' }))
    act(fight, a, rnd)
    schedule(fight.events.splice(0), nextTurn)
  }

  const yieldFight = () => {
    if (hud.phase !== 'player') return
    fight.f[0].hp = 0
    fight.winner = 1
    setHud((h) => ({ ...h, phase: 'busy' }))
    const a = actor(0)
    a.puppet.play('rest', 200)
    snd.boo()
    at(tl.current.now + 900, () => {
      actor(1).puppet.play('victory', 200)
      finish()
    })
  }

  // --- Main loop -------------------------------------------------------------------------------

  useEffect(() => {
    const c = canvas.current!
    const ctx = c.getContext('2d')!
    let raf = 0
    let last = performance.now()
    snd.startMusic('arena')
    snd.crowd(0.3)
    snd.gong()
    const t0 = setTimeout(() => {
      setHud((h) => ({ ...h, phase: 'busy' }))
      nextTurn()
    }, 1900)
    const loop = (now: number) => {
      const dt = Math.min(50, now - last)
      last = now
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const w = Math.round(c.clientWidth * dpr)
      const h = Math.round(c.clientHeight * dpr)
      if (c.width !== w || c.height !== h) {
        c.width = w
        c.height = h
      }
      const stopped = scene.hitstop > 0
      scene.update(dt, now)
      if (!stopped) {
        tl.current.now += dt * scene.timeScale
        // Run whatever is due, in order; handlers may queue more.
        for (let guard = 0; guard < 50; guard++) {
          const q = tl.current.q
          let i = -1
          for (let j = 0; j < q.length; j++) if (q[j].at <= tl.current.now && (i < 0 || q[j].at < q[i].at)) i = j
          if (i < 0) break
          const [item] = q.splice(i, 1)
          item.fn()
        }
      }
      scene.draw(ctx, c.width, c.height, now)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(t0)
      snd.crowd(0)
    }
    // The fight is set up once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // --- Input -----------------------------------------------------------------------------------

  const me = fight.f[0]
  const why = hud.phase === 'player' ? blockers(fight, 0) : null
  const enabled = (key: string) => !!why && why[key] === null

  useGameKeys(p.win, (e) => {
    const k = e.key.toLowerCase()
    if (k === 'm') {
      snd.setMuted(!snd.muted)
      return
    }
    if (hud.phase !== 'player') return
    if (k === 'arrowright' || k === 'd') doAction({ kind: 'advance' })
    else if (k === 'arrowleft' || k === 'a') doAction({ kind: 'retreat' })
    else if (k === '1') doAction({ kind: 'attack', type: 'quick' })
    else if (k === '2') doAction({ kind: 'attack', type: 'normal' })
    else if (k === '3') doAction({ kind: 'attack', type: 'power' })
    else if (k === 't' || k === '4') doAction({ kind: 'taunt' })
    else if (k === 'r' || k === '5') doAction({ kind: 'rest' })
    else if (SPELL_KEYS.includes(k)) {
      const id = me.g.spells[SPELL_KEYS.indexOf(k)]
      if (id) doAction({ kind: 'spell', id })
    } else {
      const pot = (Object.keys(POTION_KEYS) as PotionId[]).find((id) => POTION_KEYS[id] === k)
      if (pot) doAction({ kind: 'potion', id: pot })
    }
  })

  const fighterHud = (i: 0 | 1) => {
    const f = fight.f[i]
    const s = hud.snaps[i]
    return (
      <div className={`gl-hud-side ${i ? 'is-right' : ''} ${hud.turn === i && hud.phase !== 'intro' ? 'is-turn' : ''}`}>
        <div className="gl-hud-name">
          <strong>{f.g.name}</strong>
          <span>Lv {f.g.level}</span>
        </div>
        <Bar kind="hp" value={s.hp} max={f.d.maxHp} label={`${Math.ceil(s.hp)} / ${f.d.maxHp}`} />
        <Bar kind="sta" value={s.sta} max={f.d.maxSta} label={`${Math.floor(s.sta)}`} />
        {f.d.maxMana > 8 && f.g.spells.length > 0 && <Bar kind="mana" value={s.mana} max={f.d.maxMana} label={`${Math.floor(s.mana)}`} />}
        <div className="gl-favour" title="Crowd favour: at full, a frenzy">
          <Bar kind="favour" value={s.favour} max={100} />
        </div>
        <div className="gl-statuses">
          {s.statuses.map((id) => (
            <span key={id} className={`gl-status is-${id}`}>
              {STATUS_NAMES[id]}
            </span>
          ))}
        </div>
      </div>
    )
  }

  const attackBtn = (type: AttackType, key: string) => {
    const ok = enabled(type)
    const chance = Math.round(hitChance(fight, 0, type) * 100)
    return (
      <button className={`gl-act is-${type}`} disabled={!ok} onClick={() => doAction({ kind: 'attack', type })} title={why?.[type] ?? ATTACKS[type].text}>
        <strong>{ATTACKS[type].name}</strong>
        <small>{inReach(fight, 0) ? `${chance}% · ${attackCost(me, type)} sta` : 'out of reach'}</small>
        <kbd>{key}</kbd>
      </button>
    )
  }

  return (
    <div className="gl-fight">
      <div className="gl-stage">
        <canvas ref={canvas} className="gl-canvas" />
        <div className="gl-hud">
          {fighterHud(0)}
          <div className="gl-hud-mid">{p.label}</div>
          {fighterHud(1)}
        </div>
        {hud.phase === 'intro' && (
          <div className="gl-intro">
            <span>{p.you.name}</span>
            <em>versus</em>
            <span>
              {p.foe.name}
              {p.foe.title ? <small>{p.foe.title}</small> : null}
            </span>
          </div>
        )}
        {mercy && !result && (
          <div className={`gl-mercy is-${mercy}`}>
            <span>{mercy === 'asking' ? 'The crowd decides your fate…' : mercy === 'up' ? 'Thumbs up! You live.' : 'Thumbs down.'}</span>
            <i>{mercy === 'asking' ? '👍 👎' : mercy === 'up' ? '👍' : '👎'}</i>
          </div>
        )}
        {result && (
          <div className={`gl-result ${fight.winner === 0 ? 'is-right' : 'is-left'}`}>
            <div className={`gl-panel gl-result-box ${result.good ? 'is-good' : 'is-bad'}`}>
              <h2>{result.title}</h2>
              {result.lines.map((l, i) => (
                <div key={i} className="gl-result-line">
                  {l}
                </div>
              ))}
              <button className="gl-btn is-primary" onClick={p.onLeave} autoFocus>
                Continue
              </button>
            </div>
          </div>
        )}
      </div>
      <div className="gl-log" aria-live="polite">
        {hud.log.slice(-2).map((l, i, a) => (
          <span key={hud.log.length - a.length + i} className={i === a.length - 1 ? 'is-new' : ''}>
            {l}
          </span>
        ))}
      </div>
      <div className={`gl-actions ${hud.phase === 'player' ? '' : 'is-waiting'}`}>
        <button className="gl-act is-move" disabled={!enabled('retreat')} onClick={() => doAction({ kind: 'retreat' })} title={why?.retreat ?? 'Step back'}>
          <strong>◀ Back</strong>
          <small>{Math.round(me.d.move)} · 3 sta</small>
          <kbd>←</kbd>
        </button>
        <button className="gl-act is-move" disabled={!enabled('advance')} onClick={() => doAction({ kind: 'advance' })} title={why?.advance ?? 'Close in'}>
          <strong>Advance ▶</strong>
          <small>{Math.round(me.d.move)} · 3 sta</small>
          <kbd>→</kbd>
        </button>
        {attackBtn('quick', '1')}
        {attackBtn('normal', '2')}
        {attackBtn('power', '3')}
        <button className="gl-act is-taunt" disabled={!enabled('taunt')} onClick={() => doAction({ kind: 'taunt' })} title={why?.taunt ?? 'Win the crowd, rattle your foe'}>
          <strong>Taunt</strong>
          <small>crowd · 5 sta</small>
          <kbd>T</kbd>
        </button>
        <button className="gl-act is-rest" disabled={!enabled('rest')} onClick={() => doAction({ kind: 'rest' })} title="Recover stamina; the crowd hates it">
          <strong>Rest</strong>
          <small>+stamina</small>
          <kbd>R</kbd>
        </button>
        {me.g.spells.length > 0 && (
          <button className={`gl-act is-magic ${menu === 'spells' ? 'is-open' : ''}`} disabled={hud.phase !== 'player'} onClick={() => setMenu(menu === 'spells' ? null : 'spells')}>
            <strong>Magic</strong>
            <small>{Math.floor(hud.snaps[0].mana)} mana</small>
          </button>
        )}
        <button className={`gl-act is-potion ${menu === 'potions' ? 'is-open' : ''}`} disabled={hud.phase !== 'player' || POTIONS.every((x) => me.potions[x.id] <= 0)} onClick={() => setMenu(menu === 'potions' ? null : 'potions')}>
          <strong>Potions</strong>
          <small>{POTIONS.reduce((a, x) => a + me.potions[x.id], 0)} left</small>
        </button>
        <button className="gl-act is-yield" disabled={hud.phase !== 'player'} onClick={yieldFight} title={p.hardcore ? 'Ask the crowd for mercy' : 'Give up this fight'}>
          <strong>Yield</strong>
          <small>{p.hardcore ? 'beg mercy' : 'give up'}</small>
        </button>
      </div>
      {menu === 'spells' && (
        <div className="gl-submenu">
          {me.g.spells.map((id, i) => {
            const sp = spell(id)
            const key = `spell:${id}`
            return (
              <button key={id} className="gl-act is-magic" disabled={!enabled(key)} onClick={() => doAction({ kind: 'spell', id })} title={why?.[key] ?? sp.text}>
                <strong style={{ color: sp.colour }}>{sp.name}</strong>
                <small>
                  {spellCost(me, id)} mana{id !== 'heal' ? ` · ${Math.round(spellChance(fight, 0) * 100)}%` : ''}
                </small>
                <kbd>{SPELL_KEYS[i]}</kbd>
              </button>
            )
          })}
        </div>
      )}
      {menu === 'potions' && (
        <div className="gl-submenu">
          {POTIONS.map((pt) => {
            const key = `potion:${pt.id}`
            return (
              <button key={pt.id} className="gl-act is-potion" disabled={!enabled(key)} onClick={() => doAction({ kind: 'potion', id: pt.id })} title={why?.[key] ?? pt.text}>
                <strong style={{ color: pt.colour }}>{pt.name}</strong>
                <small>{me.potions[pt.id]} left</small>
                <kbd>{POTION_KEYS[pt.id].toUpperCase()}</kbd>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

