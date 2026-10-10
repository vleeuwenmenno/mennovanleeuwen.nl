import type { Hardpoint, HardpointKind } from './data'

// Line icons for hardpoints, as SVG path data on a 24x24 grid. The HUD draws them as inline SVG
// and the battlefield as Path2D, so both show the same symbols. Stroked, never filled.

export const HP_ICON: Record<HardpointKind, string> = {
  // A gun turret: round base, twin barrels.
  turret: 'M7 15a5 5 0 1 0 10 0a5 5 0 1 0 -10 0 M10 10.5V2.5 M14 10.5V2.5',
  // A heater shield.
  shield: 'M12 2.5l7.5 3v5.5c0 4.8-3.2 8.6-7.5 10.5c-4.3-1.9-7.5-5.7-7.5-10.5V5.5z',
  // A thruster nozzle with its flame.
  engine: 'M7.5 2.5h9l-1.5 7h-6z M12 21.5c-2.5-2.2-3.8-4.4-3.8-6.4c0-1.9 1.6-3.3 3.8-4.6c2.2 1.3 3.8 2.7 3.8 4.6c0 2-1.3 4.2-3.8 6.4z',
  // A hangar bay with its door open.
  hangar: 'M2.5 21V9.5L12 3.5l9.5 6V21 M7.5 21v-7h9v7',
  // Two tanks joined by a pipe.
  refinery: 'M3 9a3.5 3.5 0 0 1 7 0v9h-7z M14 9a3.5 3.5 0 0 1 7 0v9h-7z M10 13h4 M2 21h20',
  // A crane arm with its hook.
  dock: 'M3 21h18 M6 21V5h12 M18 5v6 M15.5 13.5a2.5 2.5 0 1 0 5 0',
  // A dish with its mast.
  sensor: 'M4 10a8 8 0 0 0 14 4z M11 12l6-6 M17 3.5v5h-5 M12 17v4 M8 21h8',
  // A drill bit pointing down.
  drill: 'M8 3h8v5H8z M7.5 8h9l-4.5 13z M9.5 12.5l5 1.5 M10.5 16l3 1',
}

export const HP_NAME: Record<HardpointKind, string> = { turret: 'Turbolaser', shield: 'Shield generator', engine: 'Engines', hangar: 'Hangar', refinery: 'Refinery', dock: 'Repair dock', sensor: 'Targeting array', drill: 'Drill rig' }
export const HP_COLOR: Record<HardpointKind, string> = { turret: '#ffb347', shield: '#59c8ff', engine: '#ffe066', hangar: '#7dffa0', refinery: '#e0b070', dock: '#c8a0ff', sensor: '#ff7fb0', drill: '#7ff0ff' }
/** One hardpoint's name: turrets go by the gun they carry. */
export const hpName = (h: Hardpoint) => (h.art === 'flak' ? 'Point defence' : h.art === 'ion' ? 'Ion cannon' : HP_NAME[h.kind])
