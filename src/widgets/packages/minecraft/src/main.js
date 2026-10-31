import { column, row, box, text, action, image, details, card, badge, icon, progress, divider } from '@mvlos/widget';

// Minecraft: one server. Name and online badge, players and who is on, world time, version chips,
// and the two explicit actions (copy the address, open the server window).
const PHASE = { day: ['sun', 'warning'], dusk: ['sunset', 'warning'], night: ['moon', 'accent'], dawn: ['sunrise', 'warning'] };

export function render(input) {
  const m = input.minecraft;
  if (!m) return column({ gap: 'md' }, text('Minecraft', 'normal', { size: 'lg', weight: 'bold' }), text('Checking…', 'muted'));
  const state = m.state === 'loading' ? ['Checking…', 'muted'] : m.state === 'error' ? ['Unknown', 'muted'] : m.online ? ['Online', 'success'] : ['Offline', m.state === 'ready' ? 'danger' : 'muted'];
  const chips = [m.software || (m.version ? 'Java' : ''), m.version, m.difficulty, m.latency !== null ? `${m.latency} ms` : ''].filter(Boolean);
  const phase = m.world ? PHASE[m.world.phase] || ['sun', 'warning'] : null;
  const named = m.players ? m.players.totalNamed - m.players.list.length : 0;
  return card(m.open, column({ gap: 'md' },
    row({ gap: 'sm', align: 'center' },
      icon('cube', 'accent', { size: 'lg' }),
      text('Minecraft', 'normal', { size: 'lg', weight: 'bold' }),
      badge(state[0], state[1])),
    ...(m.online && m.motd && m.motd !== 'A Minecraft Server' ? [text(m.motd, 'muted', { clamp: 2 })] : []),
    action(`${m.address} · Copy`, m.copy, { hint: 'Copy server address', children: [icon('copy', 'muted', { size: 'sm' })] }),
    ...(m.online ? [
      divider(),
      row({ gap: 'sm', align: 'baseline' },
        text(String(m.players.online), 'normal', { size: 'xl', weight: 'bold' }),
        text(`/ ${m.players.max}`, 'muted', { size: 'md' }),
        text('players', 'muted', { size: 'sm' })),
      progress(m.players.max ? Math.min(1, m.players.online / m.players.max) : 0, 'accent'),
      row({ gap: 'sm', align: 'center' },
        ...(m.players.list.length ? m.players.list.map((p) => details(row({ gap: 'xs', align: 'center' }, ...(p.head ? [image(p.head, p.name)] : []), text(p.name, 'normal', { size: 'sm' })), text(p.name, 'accent'), ...(p.dimension ? [text(p.dimension)] : []), ...(p.vitals ? [text(p.vitals)] : [])))
          : [text(m.players.online ? 'names hidden' : 'nobody on', 'muted', { size: 'sm' })]),
        ...(named > 0 ? [text(`+${named}`, 'muted', { size: 'sm' })] : [])),
      ...(m.world ? [row({ gap: 'sm', align: 'center' }, icon(phase[0], phase[1], { size: 'sm' }), text(`Day ${m.world.day} · ${m.world.clock}`, 'normal', { size: 'sm' }))] : []),
      ...(chips.length ? [row({ gap: 'xs' }, ...chips.map((chip) => badge(chip, 'muted', { size: 'xs' })))] : []),
    ] : []),
    action('Connect / server window', m.open, { children: [icon('external', 'muted', { size: 'sm' })] })));
}
export function event() { return null; }
