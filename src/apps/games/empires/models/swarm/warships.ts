import { circle, part, sym } from '../kit.ts'
import type { ModelDef, ModelSpec } from '../spec.ts'
import type { Part } from '../types.ts'
import { band, blade, blobby, core, glands, nodeSeat, sparks, spine, tendril } from './craft.ts'
import { engineSac } from './mounts.ts'

// The Swarm's warships at their size (sizes.ts): living war organisms grown round a segmented spine
// and a violet core. Each hull is layered like the reference sheet's: dark tissue, dark purple chitin
// over it, then pale chitin blades, each an overlapping armour segment tapering to a claw point, laid
// one over another down the flanks; weapon nodes on their hardpoints (data/swarm.ts, whose layouts
// are as written) in collars of dark chitin on plates that stay on the hull; engine sacs; and tendrils,
// claw tips and limbs that tear away as it is battered.

/** Lit facing for a blade on the left side, swept out and back (mirrored for the right). */
const OUT: [number, number] = [-0.45, 0.05]
const FWD: [number, number] = [-0.4, -0.3]
const AFT: [number, number] = [-0.4, 0.3]

/** The dark purple chitin under a hull's plates, both halves as one outline through `pts` (the left
 * side, nose to tail). */
const underbody = (pts: [number, number][], z = 0.4): Part => part('under', blobby([...pts, ...pts.map(([x, y]) => [-x, y] as [number, number]).reverse()], 3), 'metal', z, { lift: 0.5 })

/**
 * Harvester frigate: a claw-shaped war organism. A segmented spine from an armoured head (the spore
 * cannon on it) to three engine sacs; layered blades down each flank, the shoulder ones carrying the
 * tendril lances, the hind ones the acid sprayers; a great hooked claw sweeping forward from each
 * shoulder; the violet core in the middle in its green membrane; hind limbs and tendrils.
 */
export const frigate: ModelDef = (c): ModelSpec => {
  const parts: Part[] = [
    underbody([[0, -48], [-8, -40], [-17, -28], [-23, -12], [-24, 6], [-22, 24], [-16, 38], [-6, 44]]),
    // Hind limbs and tendrils, under everything.
    ...sym(part('limb', blobby([[-18, 10], [-28, 18], [-30, 34], [-26, 46], [-27, 34], [-25, 22], [-17, 16]], 3), 'metal', 0.6, { lift: 0.6, detach: { hull: 0.5 } }), { detach: { hull: 0.42 } }),
    ...sym(tendril('tendril', [[-5, 38], [-10, 46], [-8, 53]], 2.4), { detach: { hull: 0.3 } }),
    // The claws: a heavy root on the shoulder and a hooked tip that can be torn off.
    ...sym(blade('claw', [[-16, -14], [-24, -20], [-29, -30]], 9, 'hull', 1.2, FWD, {}, false)),
    ...sym(blade('clawTip', [[-29, -29], [-28.6, -40], [-23, -47], [-16, -49]], 6, 'hull', 1.3, FWD, { detach: { hull: 0.45 } }), { slope: [0.4, -0.3], detach: { hull: 0.36 } }),
    engineSac('sac0', -8.7, 34, 48, 7, 0, 1, { detach: { hull: 0.18 } }),
    engineSac('sac1', 0, 35, 50, 8, 1, 1),
    engineSac('sac2', 8.7, 34, 48, 7, 2, 1, { detach: { hull: 0.12 } }),
    // Blades down each flank, from the tail forward, each overlapping the one behind it.
    ...sym(blade('tail', [[-4, 24], [-12, 34], [-13, 45]], 9, 'hull2', 1.5, AFT)),
    ...sym(blade('hind', [[-5, 6], [-17, 16], [-23, 34]], 14, 'hull', 1.6, OUT, { details: [glands([[-13, 13], [-20, 26]], 0.8)] })),
    ...sym(blade('mid', [[-6, -12], [-19, -4], [-25, 12]], 11, 'hull2', 1.7, OUT)),
    ...sym(blade('shoulder', [[-5, -32], [-17, -24], [-24, -8]], 14, 'hull', 1.8, OUT, { details: [glands([[-12, -28]], 0.8)] })),
    ...sym(blade('head', [[-2, -50], [-7, -42], [-9, -28]], 8, 'hull', 1.9, FWD, {}, false)),
    ...spine('seg', [[-36, 4.6, 9], [-25, 5.4, 11], [-12, 6, 11], [10, 6, 11], [22, 5.6, 11], [33, 4.6, 9]], 'hull', 2),
    // The core between the shoulder and hind blades.
    part('coreBed', blobby([[0, -18], [-8, -10], [-8, 4], [0, 10], [8, 4], [8, -10]], 3), 'metal', 2.1, { lift: 0.6 }),
    ...core('core', 0, -4, 4.4, 8, 2.2),
    // The weapon nodes' collars.
    ...[0, 1].map((i) => nodeSeat(`seatLance${i}`, c, i, 4.2, 2.6)),
    nodeSeat('seatSpore', c, 2, 4.2, 2.6),
    ...[3, 4].map((i) => nodeSeat(`seatAcid${i}`, c, i, 3.4, 2.6)),
  ]
  return { parts, breakStyle: 'bands', mount: (i) => ({ detach: i >= 3 }) }
}

/**
 * Devourer cruiser: a long armoured spine with lateral structures. A clawed head with mandibles and
 * whiskers; forward blades carrying the light tendril lances, great mid blades sweeping out with the
 * heavy lances at their roots, hind blades with the spore cannon nodes, tail blades; the violet core
 * between the forward and mid blades; two engine sacs; tendrils trailing from the tail. The blades'
 * tips and the tendrils tear away as it is battered; the engine sacs go with their hardpoints.
 */
export const cruiser: ModelDef = (c): ModelSpec => {
  const parts: Part[] = [
    underbody([[0, -50], [-6, -42], [-12, -28], [-16, -8], [-19, 10], [-19, 28], [-12, 40], [-5, 46]]),
    ...sym(tendril('tendril', [[-6, 36], [-14, 44], [-13, 53]], 3), { detach: { hull: 0.32 } }),
    ...sym(tendril('whisker', [[-5, -40], [-15, -44], [-19, -52]], 2), { detach: { hull: 0.6 } }),
    engineSac('sac0', -5, 36, 50, 7, 0, 1.2, { detach: { hp: 6 } }),
    engineSac('sac1', 5, 36, 50, 7, 1, 1.2, { detach: { hp: 7 } }),
    // Tips that tear away, under the blades they grow from.
    ...sym(blade('midTip', [[-21, 12], [-25, 22], [-24, 32]], 5, 'hull', 1.1, OUT, { detach: { hull: 0.38 } }, false), { detach: { hull: 0.28 } }),
    ...sym(blade('foreTip', [[-17, -12], [-22, -6], [-23, 2]], 4, 'hull', 1.1, OUT, { detach: { hull: 0.48 } }, false), { detach: { hull: 0.4 } }),
    // Blades from the tail forward.
    ...sym(blade('tail', [[-4, 28], [-10, 38], [-11, 47]], 8, 'hull2', 1.5, AFT)),
    ...sym(blade('hind', [[-5, 14], [-15, 22], [-20, 34]], 12, 'hull', 1.6, OUT, { details: [glands([[-12, 20], [-17, 30]], 0.8)] })),
    ...sym(blade('mid', [[-5, -4], [-15, 4], [-22, 14]], 13, 'hull2', 1.7, OUT, { details: [glands([[-19, 10]], 0.9)] })),
    ...sym(blade('fore', [[-5, -28], [-13, -22], [-18, -12]], 11, 'hull', 1.8, OUT)),
    ...sym(blade('head', [[-2, -50], [-6, -42], [-7, -32]], 7, 'hull', 1.9, FWD, {}, false)),
    ...sym(blade('mandible', [[-4, -44], [-9, -49], [-6, -53]], 3, 'hull2', 1.85, FWD, {}, false)),
    ...spine('seg', [[-38, 4, 8], [-28, 5, 10], [-17, 5.6, 10], [6, 6, 10], [17, 5.6, 10], [28, 5, 10], [37, 4, 8]], 'hull', 2),
    part('coreBed', blobby([[0, -16], [-6, -10], [-6, 2], [0, 8], [6, 2], [6, -10]], 3), 'metal', 2.1, { lift: 0.6 }),
    ...core('core', 0, -4, 3.4, 6.4, 2.2),
    ...[0, 1].map((i) => nodeSeat(`seatHeavy${i}`, c, i, 3.4, 2.7)),
    ...[2, 3].map((i) => nodeSeat(`seatLight${i}`, c, i, 2.8, 2.7)),
    ...[4, 5].map((i) => nodeSeat(`seatSpore${i}`, c, i, 3.2, 2.7)),
  ]
  return { parts, breakStyle: 'bands', cuts: 3 }
}

/**
 * Leviathan dreadnought: the reference sheet's Hive Dreadnought. A spine array of vertebrae from a
 * crowning spike to the engine sacs, flanked by tall horns and, at their roots, the two spore cannon
 * nodes; a great hive core in the middle in its green membrane, an inner rim of plates round it
 * carrying the four tendril lances; great claw blades sweeping out and down each flank, layered
 * upper, middle and lower, the acid sprayers on them and green biomass vents in their seams; brood
 * chambers on the lower blades; long tendrils hanging off the flanks and the tail; three engine sacs.
 */
export const capital: ModelDef = (c): ModelSpec => {
  const parts: Part[] = [
    underbody([[0, -46], [-10, -36], [-24, -22], [-31, -4], [-29, 14], [-24, 30], [-16, 42], [-6, 46]]),
    // Long tendrils hanging off the flanks and the tail, under everything.
    ...sym(tendril('tendrilA', [[-27, 14], [-32, 28], [-31, 40], [-28, 52]], 3.4), { detach: { hull: 0.55 } }),
    ...sym(tendril('tendrilB', [[-20, 30], [-24, 40], [-22, 48], [-19, 53]], 3), { detach: { hull: 0.4 } }),
    ...sym(tendril('tendrilC', [[-6, 42], [-11, 48], [-10, 53]], 2.4), { detach: { hull: 0.25 } }),
    engineSac('sac0', -9.9, 36, 49, 8, 0, 1.2, { detach: { hull: 0.16 } }),
    engineSac('sac1', 0, 37, 51, 10, 1, 1.2, { detach: { hp: 10 } }),
    engineSac('sac2', 9.9, 36, 49, 8, 2, 1.2, { detach: { hull: 0.1 } }),
    // Outer horns that tear off, then the great claw blades from the tail forward.
    ...sym(blade('hook', [[-22, -26], [-28, -36], [-27, -48]], 6, 'hull', 1.2, FWD, { detach: { hull: 0.5 } }, false), { slope: [0.4, -0.3], detach: { hull: 0.45 } }),
    ...sym(blade('lower', [[-8, 16], [-19, 24], [-23, 38], [-19, 50]], 13, 'hull', 1.5, AFT, { details: [glands([[-14, 22], [-21, 34]], 1)] })),
    ...sym(blade('middle', [[-9, -6], [-22, 2], [-30, 16], [-30, 30]], 15, 'hull2', 1.6, OUT, { details: [glands([[-19, 2], [-27, 14]], 1)] })),
    ...sym(blade('upper', [[-8, -30], [-22, -24], [-31, -10], [-32, 6]], 16, 'hull', 1.7, OUT, { details: [glands([[-18, -26], [-27, -14]], 1)] })),
    // Biomass vents in the seams between the blades.
    ...sym(part('ventHigh', band([[-12, -9], [-21, -9], [-28, -3]], 1.8, 0.6), 'aid', 1.65, { glow: true, noOutline: true })),
    ...sym(part('ventLow', band([[-11, 13], [-19, 14], [-25, 21]], 1.6, 0.5), 'aid', 1.55, { glow: true, noOutline: true })),
    // Tall horns either side of the crown, the spore nodes' shoulders at their roots.
    ...sym(blade('horn', [[-7, -26], [-12, -40], [-10, -52]], 7, 'hull', 1.8, FWD, {}, false)),
    ...sym(part('shoulder', blobby([[-2, -38], [-8, -38], [-10, -31], [-8, -26], [-2, -26]], 3), 'hull2', 1.9, { lift: 1, slope: [-0.45, -0.2] })),
    // The spine array and its crown.
    ...spine('seg', [[-42, 4, 8], [-34, 5, 9], [24, 5.6, 9], [32, 5, 9], [40, 4, 7]], 'hull', 2),
    ...sym(blade('crown', [[-2, -36], [-2.6, -46], [0, -53]], 5, 'hull', 2.05, FWD, {}, false)),
    // The inner rim round the hive core, carrying the lances, and the core itself.
    ...sym(blade('rim', [[-4, -28], [-14, -18], [-16, 2], [-12, 20]], 9, 'hull2', 2.1, OUT, { details: [sparks([[-12, -4], [-13, 10]], 0.8)] }, false)),
    part('coreBed', blobby([[0, -26], [-9, -16], [-10, 2], [-7, 18], [0, 24], [7, 18], [10, 2], [9, -16]], 3), 'metal', 2.2, { lift: 0.8 }),
    ...core('core', 0, -1, 6, 12.4, 2.3),
    // Weapon node collars.
    ...[0, 1, 2, 3].map((i) => nodeSeat(`seatLance${i}`, c, i, 4.2, 2.6)),
    ...[4, 5, 6, 7].map((i) => nodeSeat(`seatAcid${i}`, c, i, 3, 2.6)),
    ...[8, 9].map((i) => nodeSeat(`seatSpore${i}`, c, i, 4, 2.6)),
    ...[11, 12].map((i) => nodeSeat(`seatBrood${i}`, c, i, 4.8, 2.6)),
    part('marks', [], 'glow', 2.7, { glow: true, noOutline: true, details: [sparks(circle(0, -1, 15, 8), 0.7)] }),
  ]
  return { parts, breakStyle: 'bands', cuts: 3 }
}
