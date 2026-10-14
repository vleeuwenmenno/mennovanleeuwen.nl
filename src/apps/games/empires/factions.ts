import { FACTION_IDS, FACTIONS, type FactionId } from './data.ts'
import { useSettings } from './settings.ts'

// Which factions a player can pick: in the skirmish and multiplayer lobbies, for a Galactic
// Conquest campaign, and which the Codex shows. A faction still being made (FactionInfo `preview`:
// the Swarm, until its rework is done) is only offered with the Swarm preview on: the
// `swarmPreview` setting, whose toggle is under Settings → Developer in dev builds only (in any
// build it can be set by hand: `swarmPreview: true` in the localStorage entry
// `mvlos.empires.settings`). The battle itself and the server take every faction (data.ts
// FACTIONS): the preview only hides it from the menus.

/** The factions to offer, with the preview on or off. */
export const pickable = (preview: boolean): FactionId[] => FACTION_IDS.filter((f) => preview || !FACTIONS[f].preview)

/** The factions to offer now, following the setting; `keep` is also offered (a slot set to a
 * preview faction elsewhere, say by a host with the preview on, still shows what it is). */
export function usePickable(keep: readonly FactionId[] = []): FactionId[] {
  const { swarmPreview } = useSettings()
  const out = pickable(swarmPreview)
  return FACTION_IDS.filter((f) => out.includes(f) || keep.includes(f))
}
