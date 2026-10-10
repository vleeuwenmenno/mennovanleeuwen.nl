import type { HardpointKind } from './data'

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
}

export const HP_NAME: Record<HardpointKind, string> = { turret: 'Turbolaser', shield: 'Shield generator', engine: 'Engines', hangar: 'Hangar' }
export const HP_COLOR: Record<HardpointKind, string> = { turret: '#ffb347', shield: '#59c8ff', engine: '#ffe066', hangar: '#7dffa0' }
