import { useEffect, useRef, useState } from 'react'
import type { WinState } from '../../os/wm'
import {
  addHall, advanceTournament, rules, enterTournament, foeGladiator, newSave, readStore, refreshOffers, saveSlot, settle, tournamentFoe, type Foe, type FightKind, type Mode, type Save,
} from './gladiator/career'
import type { Gladiator as G } from './gladiator/character'
import { league, LEAGUES, type Difficulty, type LeagueId } from './gladiator/data'
import { FightScreen, type FightResultView } from './gladiator/Fight'
import { CreatorScreen, HallScreen, TitleScreen } from './gladiator/Menus'
import type { AmbiencePlace } from './gladiator/ambience'
import { gladiatorStore } from './gladiator/saves'
import { GladiatorSound } from './gladiator/sound'
import { Apothecary, ArenaBoard, Bracket, GearShop, Hub, MageShop, PLACE_BG, Sheet, TopBar, Training, type Place } from './gladiator/Town'
import { Gold } from './gladiator/ui'
import './gladiator/gladiator.css'

// Gladiator: a Swords and Sandals style arena game. This file holds the screens together: the
// title and save slots, the creator, the town and its shops, and the fights, with saves going to
// localStorage after every change.

type Screen =
  | { s: 'title' }
  | { s: 'hall' }
  | { s: 'create'; slot: number }
  | { s: 'town'; place: Place }
  | { s: 'fight'; foe: Foe; kind: FightKind; key: number }

const AMBIENCE: Record<Place, AmbiencePlace> = {
  hub: 'town',
  arena: 'arena',
  tournament: 'arena',
  forge: 'forge',
  armoury: 'armoury',
  mage: 'mage',
  apothecary: 'apothecary',
  training: 'training',
  gladiator: 'training',
}
const SKILL: Record<LeagueId, number> = { pits: 0.45, city: 0.65, colosseum: 0.85 }
const ROUND_NAMES = ['quarter-final', 'semi-final', 'final']

/** Cinzel for the Roman headings, loaded only once the game is opened. */
function useDisplayFont() {
  useEffect(() => {
    if (document.getElementById('gl-font')) return
    const l = document.createElement('link')
    l.id = 'gl-font'
    l.rel = 'stylesheet'
    l.href = 'https://fonts.googleapis.com/css2?family=Cinzel:wght@600;800&display=swap'
    document.head.appendChild(l)
  }, [])
}

export function Gladiator({ win }: { win: WinState }) {
  useDisplayFont()
  const sound = useRef<GladiatorSound>(null as unknown as GladiatorSound)
  if (!sound.current) sound.current = new GladiatorSound()
  const snd = sound.current
  const [store, setStore] = useState(readStore)
  const [slot, setSlot] = useState(0)
  const [save, setSave] = useState<Save | null>(null)
  const saveRef = useRef(save)
  saveRef.current = save
  const [screen, setScreen] = useState<Screen>({ s: 'title' })
  const [audio, setAudio] = useState({ muted: snd.muted, music: snd.musicOn })

  useEffect(() => () => snd.dispose(), [snd])
  // Saves arriving from another device (signed in): refresh the slots, and if the run being
  // played was continued elsewhere more recently, pick it up, unless a bout is under way.
  const screenRef = useRef(screen)
  screenRef.current = screen
  const slotRef = useRef(slot)
  slotRef.current = slot
  useEffect(
    () =>
      gladiatorStore.onRemote((s) => {
        setStore(readStore())
        const cur = saveRef.current
        const theirs = s.slots[slotRef.current]
        if (!cur || !theirs || screenRef.current.s === 'fight') return
        if ((theirs.updated ?? 0) > (cur.updated ?? 0)) {
          saveRef.current = theirs
          setSave(theirs)
        }
      }),
    [],
  )
  useEffect(() => {
    if (screen.s !== 'fight') snd.startMusic('town')
  }, [screen.s, snd])
  // Each place has its own background sound, crossfaded as you walk between them.
  const place = screen.s === 'town' ? screen.place : null
  useEffect(() => {
    snd.setAmbience(screen.s === 'fight' ? null : place ? AMBIENCE[place] : screen.s === 'create' ? 'training' : 'title')
  }, [screen.s, place, snd])

  const commit = (next: Save) => {
    const stamped = { ...next, updated: Date.now() }
    saveRef.current = stamped
    setSave(stamped)
    saveSlot(slot, stamped)
  }
  const update = (fn: (s: Save) => Save) => commit(fn(saveRef.current!))
  const go = (place: Place) => {
    snd.ui()
    setScreen({ s: 'town', place })
  }
  const toTitle = () => {
    setStore(readStore())
    setSave(null)
    setScreen({ s: 'title' })
  }

  // --- Fights ----------------------------------------------------------------------------------

  const fight = (foe: Foe, kind: FightKind) => {
    snd.wake()
    setScreen({ s: 'fight', foe, kind, key: Date.now() })
  }

  const onEnd = (foe: Foe, kind: FightKind, won: boolean, peak: number, hpLeft: number, spared: boolean, potions: G['potions']): FightResultView => {
    // Whatever was drunk in the arena is gone.
    const before = { ...saveRef.current!, g: { ...saveRef.current!.g, potions } }
    const foeName = foeGladiator(before, foe).name
    let { save: next, result } = settle(before, foe, kind, won, peak, spared)
    if (kind === 'tournament' && before.tournament) next = { ...next, tournament: advanceTournament(next, before.tournament, won, hpLeft) }
    else if (kind !== 'champion') next = refreshOffers(next)
    const hall = { name: next.g.name, level: next.g.level, mode: next.mode, difficulty: next.difficulty ?? ('normal' as const), wins: next.record.wins, losses: next.record.losses, fame: next.fame, date: Date.now(), look: next.g.look, gear: next.g.gear }
    if (result.dead) addHall({ ...hall, fate: 'fell', by: foeName })
    if (next.emperor && !before.emperor) addHall({ ...hall, fate: 'emperor' })
    commit(next)

    const lines = [
      result.gold ? (
        <>
          Gold {result.gold > 0 ? '+' : '−'}
          <Gold n={Math.abs(result.gold)} />
        </>
      ) : null,
      `Experience +${result.xp}`,
      result.fame ? `Fame ${result.fame > 0 ? '+' : ''}${result.fame}` : null,
      result.levels ? <b className="gl-levelup">Level up! You are now level {next.g.level}. Spend your points under Your Gladiator.</b> : null,
      ...result.notes,
      spared ? 'The crowd spared you. Live to fight another day.' : null,
    ].filter(Boolean)
    if (result.levels) setTimeout(() => snd.fanfare(true), 900)
    return { title: won ? 'Victory!' : result.dead ? 'You have fallen' : 'Defeat', lines, good: won }
  }

  const leaveFight = (kind: FightKind) => {
    const s = saveRef.current!
    if (s.dead) return toTitle()
    setScreen({ s: 'town', place: kind === 'tournament' ? 'tournament' : kind === 'champion' ? 'hub' : 'arena' })
  }

  // --- Screens ---------------------------------------------------------------------------------

  let body: React.ReactNode = null
  let bg = 'title'
  const sfx = { coins: () => snd.coins(), ui: () => snd.ui(), fanfare: () => snd.fanfare() }

  if (screen.s === 'title') {
    body = (
      <TitleScreen
        slots={store.slots}
        hall={store.hall}
        onHall={() => setScreen({ s: 'hall' })}
        onImported={() => setStore(readStore())}
        onNew={(i) => (snd.wake(), setScreen({ s: 'create', slot: i }))}
        onLoad={(i) => {
          snd.wake()
          setSlot(i)
          const s = store.slots[i]!
          saveRef.current = s
          setSave(s)
          setScreen({ s: 'town', place: 'hub' })
        }}
        onDelete={(i) => {
          saveSlot(i, null)
          setStore(readStore())
        }}
      />
    )
  } else if (screen.s === 'hall') {
    body = <HallScreen hall={store.hall} onBack={() => setScreen({ s: 'title' })} />
  } else if (screen.s === 'create') {
    bg = 'training'
    body = (
      <CreatorScreen
        onBack={() => setScreen({ s: 'title' })}
        onDone={(g: G, mode: Mode, difficulty: Difficulty) => {
          setSlot(screen.slot)
          const s = newSave(g, mode, difficulty)
          saveRef.current = s
          setSave(s)
          saveSlot(screen.slot, s)
          snd.fanfare()
          setScreen({ s: 'town', place: 'hub' })
        }}
      />
    )
  } else if (screen.s === 'fight' && save) {
    const t = save.tournament
    const L = league(screen.kind === 'tournament' && t ? t.league : screen.foe.champion ?? save.league)
    const foeG = foeGladiator(save, screen.foe)
    const skill = Math.max(0.2, Math.min(1.2, SKILL[L.id] + rules(save).skill + (screen.kind === 'rival' ? 0.1 : screen.kind === 'champion' ? 0.15 : 0)))
    const round = t ? ROUND_NAMES[t.rounds.length - 1] : ''
    const label = screen.kind === 'tournament' ? `${L.name} · Tournament ${round}` : screen.kind === 'champion' ? `${L.name} · Champion bout` : screen.kind === 'rival' ? `${L.name} · Grudge match` : `${L.name} · Exhibition`
    const { foe, kind } = screen
    body = (
      <FightScreen
        key={screen.key}
        win={win}
        you={save.g}
        foe={foeG}
        arena={L.arena}
        skill={skill}
        label={label}
        hp={kind === 'tournament' && t ? [t.hp, 1] : undefined}
        hardcore={save.mode === 'hardcore'}
        sound={snd}
        onEnd={(won, peak, hpLeft, spared, potions) => onEnd(foe, kind, won, peak, hpLeft, spared, potions)}
        onLeave={() => leaveFight(kind)}
      />
    )
    bg = ''
  } else if (screen.s === 'town' && save) {
    const place = screen.place
    bg = place === 'arena' ? league(save.league).arena : place === 'tournament' && save.tournament ? league(save.tournament.league).arena : PLACE_BG[place]
    const back = () => go('hub')
    let inner: React.ReactNode
    switch (place) {
      case 'hub':
        inner = <Hub save={save} go={go} />
        break
      case 'arena':
        inner = (
          <ArenaBoard
            save={save}
            onBack={back}
            onFight={fight}
            onLeague={(l) => (snd.ui(), update((s) => refreshOffers(s, l)))}
            onReroll={() => update((s) => refreshOffers({ ...s, gold: s.gold - 5 }))}
            onTournament={(l) => {
              if (!save.tournament || save.tournament.out || !tournamentFoe(save.tournament)) {
                snd.coins()
                update((s) => enterTournament(s, l))
              }
              go('tournament')
            }}
          />
        )
        break
      case 'forge':
      case 'armoury':
        inner = <GearShop key={place} save={save} update={update} kind={place} onBack={back} sound={sfx} />
        break
      case 'mage':
        inner = <MageShop save={save} update={update} onBack={back} sound={sfx} />
        break
      case 'apothecary':
        inner = <Apothecary save={save} update={update} onBack={back} sound={sfx} />
        break
      case 'training':
        inner = <Training save={save} update={update} onBack={back} onSheet={() => go('gladiator')} sound={sfx} />
        break
      case 'gladiator':
        inner = <Sheet save={save} update={update} onBack={back} sound={sfx} />
        break
      case 'tournament':
        inner = save.tournament ? (
          <Bracket
            save={save}
            onBack={back}
            onFight={() => {
              const next = tournamentFoe(save.tournament!)
              if (next) fight(next.foe, 'tournament')
            }}
            onClaim={() => {
              const t = save.tournament!
              const L = league(t.league)
              const won = t.rounds[t.rounds.length - 1][0] === 'you' && t.rounds[t.rounds.length - 1].length === 1
              if (won) {
                snd.coins(10)
                snd.fanfare(true)
              }
              const idx = LEAGUES.findIndex((l) => l.id === t.league)
              update((s) => ({
                ...s,
                tournament: null,
                gold: s.gold + (won ? L.prize : 0),
                fame: s.fame + (won ? 10 * (idx + 1) : 0),
                tourneyWins: won ? { ...s.tourneyWins, [t.league]: s.tourneyWins[t.league] + 1 } : s.tourneyWins,
              }))
              go(won ? 'arena' : 'hub')
            }}
          />
        ) : (
          <Hub save={save} go={go} />
        )
        break
    }
    body = (
      <>
        <TopBar save={save} onMenu={toTitle} />
        {inner}
      </>
    )
  }

  return (
    <div
      className={`gl-root ${screen.s === 'fight' ? 'is-fight' : ''}`}
      style={bg ? { backgroundImage: `url(/games/gladiator/${bg}.webp)` } : undefined}
      onPointerDown={() => snd.wake()}
    >
      <div className="gl-audio">
        <button onClick={() => (snd.wake(), snd.setMusic(!snd.musicOn), setAudio({ ...audio, music: snd.musicOn }))} title={audio.music ? 'Music on' : 'Music off'} aria-label="Toggle music">
          {audio.music ? '♫' : '♪̸'}
        </button>
        <button onClick={() => (snd.wake(), snd.setMuted(!snd.muted), setAudio({ ...audio, muted: snd.muted }))} title={audio.muted ? 'Sound off (M)' : 'Sound on (M)'} aria-label="Toggle sound">
          {audio.muted ? '🔇' : '🔊'}
        </button>
      </div>
      {body}
    </div>
  )
}
