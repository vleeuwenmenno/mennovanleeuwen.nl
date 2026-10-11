import { sessionGet, sessionPut } from '../session'
import { loadSave, type Galaxy } from './galaxy'
import type { BattleSnap } from './snapshot'

// What an Empires At War window keeps so that a reload carries on where it was: the campaign it
// had open, a battle being fought (a skirmish, or a campaign's battle), and being in the
// multiplayer screens. All of it belongs to the window's session (see ../session.ts) and goes
// when the window is closed. The campaigns themselves are save games (galaxy.ts) and stay.

/** A skirmish in progress: its lobby setup (to rebuild the screen) and the snapshot. */
export const saveSkirmish = <S>(session: string | undefined, v: { setup: S; snap: BattleSnap } | null) => sessionPut(session, 'empires.skirmish', v)
export const loadSkirmish = <S>(session: string | undefined) => sessionGet<{ setup: S; snap: BattleSnap }>(session, 'empires.skirmish')

/** A campaign's battle in progress, by save slot: which planet it's over, and the snapshot. */
export const saveCampaignBattle = (session: string | undefined, save: string, v: { planet: number; snap: BattleSnap } | null) => sessionPut(session, `empires.battle.${save}`, v)
export const loadCampaignBattle = (session: string | undefined, save: string) => sessionGet<{ planet: number; snap: BattleSnap }>(session, `empires.battle.${save}`)

/** The campaign open in this window, to come straight back to after a reload. */
export const setResume = (session: string | undefined, id: string | null) => sessionPut(session, 'empires.resume', id)
export function resumeGalaxy(session: string | undefined): Galaxy | null {
  const id = sessionGet<string>(session, 'empires.resume')
  return id ? loadSave(id) : null
}

/** Whether this window was in the multiplayer screens: a reload goes straight back to them (and
 * the server puts the player back in their lobby or battle). Per tab, like the player's token, so
 * two tabs are two players. */
export const mpActive = {
  get: (session: string | undefined) => sessionGet<boolean>(session, 'empires.mp', 'tab') === true,
  set: (session: string | undefined, on: boolean) => sessionPut(session, 'empires.mp', on || null, 'tab'),
}
