import { FACTIONS, isShip } from './data'
import { Floating, fmt, pingClass } from './Hud'
import type { RosterSeat, SeatStatus } from './protocol'
import { relColor } from './render'
import type { Owner, World } from './sim'
import { useCoarse } from './Touch'

// The players in the battle, our side first: how each is doing in the fight (fleet, kills,
// losses, credits earned, score) and, online, whether they're still there and their ping. Opened
// from the top bar or with Tab.

/** One number to rank by: a tenth of the credits earned, and ten points a kill. */
export const score = (w: World, o: Owner) => Math.round(w.players[o].stats.earned / 10 + w.players[o].stats.killed * 10)

const STATUS: Record<Exclude<SeatStatus, 'playing'>, string> = {
  away: 'Reconnecting…',
  left: 'Gave up (AI)',
  dropped: 'Disconnected (AI)',
  ai: 'AI',
}

export function Scoreboard({ w, me, names, roster, onClose }: { w: World; me: Owner; names: string[]; roster?: RosterSeat[] | null; onClose: () => void }) {
  const myTeam = w.players[me].team
  // The column notes are tooltips for a mouse; fingers get them spelled out under the table.
  const coarse = useCoarse()
  const fleets = w.players.map(() => 0)
  for (const u of w.units) if (!u.dead && isShip(u.t)) fleets[u.owner]++
  const sides = [myTeam, ...w.players.map((p) => p.team).filter((t, i, all) => t !== myTeam && all.indexOf(t) === i)]
  return (
    <Floating id="players" title="Players" at={{ left: 12, top: 56 }} onClose={onClose} className="ew-score">
      <table>
        <thead>
          <tr>
            <th>Player</th>
            {roster && <th>Ping</th>}
            <th data-tip="Ships in the fight now">Fleet</th>
            <th>Kills</th>
            <th>Losses</th>
            <th>Earned</th>
            <th data-tip="A tenth of the credits earned, plus ten points a kill">Score</th>
          </tr>
        </thead>
        {sides.map((team) => (
          <tbody key={team}>
            <tr className="ew-score-side">
              <th colSpan={roster ? 7 : 6}>{team === myTeam ? 'Our side' : 'Enemy side'}</th>
            </tr>
            {w.players.map((p, i) => {
              if (p.team !== team) return null
              const r = roster?.[i]
              return (
                <tr key={i} className={`${p.alive ? '' : 'is-out'} ${i === me ? 'is-me' : ''}`}>
                  <td>
                    <i className="ew-dot" style={{ background: relColor(w, me, i) }} />
                    <img src={FACTIONS[p.faction].emblem} alt="" />
                    {names[i]}
                    {i === me && <small className="ew-muted"> (you)</small>}
                  </td>
                  {roster && (
                    <td className={r?.status === 'playing' ? `ew-ping ${pingClass(r.ping)}` : r?.status === 'ai' ? 'ew-muted' : 'ew-score-gone'}>
                      {!r ? '' : r.status === 'playing' ? `${r.ping} ms` : STATUS[r.status]}
                    </td>
                  )}
                  <td>{p.alive ? fleets[i] : 'Out'}</td>
                  <td>{p.stats.killed}</td>
                  <td>{p.stats.lost}</td>
                  <td>{fmt(p.stats.earned)}</td>
                  <td>
                    <b>{fmt(score(w, i))}</b>
                  </td>
                </tr>
              )
            })}
          </tbody>
        ))}
      </table>
      {coarse && <p className="ew-muted ew-small ew-score-note">Fleet: ships in the fight now. Score: a tenth of the credits earned, plus ten points a kill.</p>}
    </Floating>
  )
}
