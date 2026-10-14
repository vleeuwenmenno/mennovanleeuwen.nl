// Checks Empires At War's control groups (empires/groups.ts) and their keys (empires/settings.ts),
// without a browser: setting a group, adding to it, selecting it, units that die or change hands
// dropping out, the bar's order and pictures, a double press, and which key presses mean what
// (Shift turns the number row into symbols, so groups go by where the key is).
//
//   node scripts/empires-groups.ts
//
// Exits 1 on any failure.

import { DOUBLE_MS, DoublePress, addToGroup, freeGroup, groupInfo, members, pruneGroups, setGroup, type Groups } from '../src/apps/games/empires/groups.ts'
import { MAPS } from '../src/apps/games/empires/maps.ts'
import { newWorld } from '../src/apps/games/empires/sim.ts'

// settings.ts reads localStorage when it loads: none here, so the defaults.
const { DEFAULT_KEYS, groupKeyOf, modOf } = await import('../src/apps/games/empires/settings.ts')

let failed = false
const check = (what: string, ok: boolean) => {
  console.log(ok ? 'PASS' : 'FAIL', what)
  if (!ok) failed = true
}

const w = newWorld(MAPS[0], [
  { faction: 'republic', team: 0, spawn: 0 },
  { faction: 'droid', team: 1, spawn: 1 },
])
const me = 0
const ours = w.units.filter((u) => u.owner === me && !u.dead)
const ships = ours.filter((u) => u.t.tier !== 'station' && u.t.tier !== 'mine' && u.t.tier !== 'defense')
const station = ours.find((u) => u.t.tier === 'station')!
check(`a new battle gives us ships to group (${ships.length}) and a station`, ships.length >= 3 && !!station)

const groups: Groups = new Map()
const ids = (key: string) => members(w, me, groups, key).map((u) => u.id)

// Set, add, select.
setGroup(groups, '1', [ships[0].id, ships[1].id])
check('Ctrl+1 sets group 1 to the selection', ids('1').join() === [ships[0].id, ships[1].id].join())
setGroup(groups, '1', [ships[2].id])
check('Ctrl+1 again replaces it', ids('1').join() === String(ships[2].id))
const added = addToGroup(groups, '1', [ships[0].id, ships[2].id])
check('Shift+1 adds the selection, without doubling what is already in it', added === 1 && ids('1').length === 2)
addToGroup(groups, '4', [ships[1].id])
check('Shift+number on an empty group starts it', ids('4').join() === String(ships[1].id))
setGroup(groups, '5', [station.id])
check('a structure goes in a group too (the station)', ids('5').join() === String(station.id))
setGroup(groups, '0', [ships[0].id])
check('group 0 is a group', ids('0').length === 1)

// The bar: keyboard order (1 to 9, then 0), counts, and the picture of the main unit.
const bar = groupInfo(w, me, groups)
check(`the bar shows groups in keyboard order (${bar.map((g) => g.key).join(' ')})`, bar.map((g) => g.key).join() === '1,4,5,0')
check('with their sizes and pictures', bar[0].count === 2 && bar.every((g) => !!g.sprite) && bar[2].sprite === station.t.sprite)
check('touch\'s "+ Group" picks the first free key', freeGroup(bar) === '2')

// Dead units and units no longer ours drop out; an empty group goes.
ships[0].dead = true
w.byId.delete(ships[0].id)
check('a unit that dies drops out of its groups', ids('1').join() === String(ships[2].id) && groupInfo(w, me, groups).find((g) => g.key === '1')?.count === 1)
check('and a group left empty goes', ids('0').length === 0 && !groups.has('0'))
ships[1].owner = 1
pruneGroups(w, me, groups)
check('a unit that changes hands drops out too', !groups.has('4'))
setGroup(groups, '1', [])
check('setting a group to nothing clears it', !groups.has('1'))

// A double press within DOUBLE_MS looks at the group; slower, or another key, doesn't.
const dp = new DoublePress()
check('a single press is not a double', !dp.hit('3', 1000))
check(`a second press within ${DOUBLE_MS} ms is`, dp.hit('3', 1000 + DOUBLE_MS - 50))
check('a third press starts over', !dp.hit('3', 1000 + DOUBLE_MS))
check('a slow second press is not a double', !dp.hit('3', 2000 + DOUBLE_MS + 50))
dp.hit('3', 5000)
check('nor a different key', !dp.hit('4', 5100))

// Keys.
const ev = (key: string, code: string, m: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean } = {}) => ({ key, code, ctrlKey: !!m.ctrl, shiftKey: !!m.shift, altKey: !!m.alt, metaKey: !!m.meta })
const keys = { ...DEFAULT_KEYS }
check('1 is group 1, 0 is group 0', groupKeyOf(keys, ev('1', 'Digit1')) === '1' && groupKeyOf(keys, ev('0', 'Digit0')) === '0')
check('Shift+1 (which types "!") is still group 1', groupKeyOf(keys, ev('!', 'Digit1', { shift: true })) === '1')
check('the keypad numbers work as well', groupKeyOf(keys, ev('7', 'Numpad7')) === '7')
check('a letter is no group', groupKeyOf(keys, ev('q', 'KeyQ')) === null)
check('Ctrl sets, Shift adds, nothing selects', modOf(ev('1', 'Digit1', { ctrl: true })) === 'ctrl' && modOf(ev('!', 'Digit1', { shift: true })) === 'shift' && modOf(ev('1', 'Digit1')) === '')
check('Cmd counts as Ctrl (a Mac)', modOf(ev('1', 'Digit1', { meta: true })) === 'ctrl')
check('Ctrl+Shift is a modifier of its own', modOf(ev('!', 'Digit1', { ctrl: true, shift: true })) === 'ctrl+shift')
check('Alt is never one (the OS workspaces)', modOf(ev('1', 'Digit1', { alt: true })) === null)
const rebound = { ...keys, group1: 'z', stop: '1' }
check('group 1 rebound to Z: Z is group 1, and 1 no longer is', groupKeyOf(rebound, ev('z', 'KeyZ')) === '1' && groupKeyOf(rebound, ev('1', 'Digit1')) === null)

console.log(failed ? 'FAILED' : 'all passed')
process.exit(failed ? 1 : 0)
