import { column, row, grid, box, text, action, link, icon } from '@mvlos/widget';

// Status: your updown.io checks. An overall banner, then one aligned row per check:
// state, name, response time and uptime. A failing check or a near-expiry certificate adds a line.
const title = (name) => text(name, 'normal', { size: 'lg', weight: 'bold' });
const message = (...nodes) => column({ gap: 'md' }, title('Status'), ...nodes);
const uptime = (value) => `${value >= 99.995 ? '100' : value.toFixed(2)}%`;
const uptimeTone = (value) => (value < 98 ? 'danger' : value < 99.5 ? 'warning' : 'normal');

function check(c) {
  const state = !c.enabled ? 'paused' : c.down ? 'down' : 'up';
  const warning = c.sslValid === false || (c.sslDays !== null && c.sslDays < 14);
  return link('', c.open, { fallback: 'row', hint: c.address, children: [
    icon(state === 'up' ? 'check' : state === 'down' ? 'down' : 'pause', state === 'up' ? 'success' : state === 'down' ? 'danger' : 'muted', { size: 'sm' }),
    column({ gap: 'none' },
      text(c.name, state === 'paused' ? 'muted' : 'normal', { weight: 'medium', clamp: 1 }),
      ...(c.enabled && c.down ? [text(`down${c.downSince ? ' ' + c.downSince : ''}${c.error ? ' · ' + c.error : ''}`, 'danger', { size: 'xs' })] : []),
      ...(warning ? [text(c.sslValid === false ? 'certificate invalid' : c.sslDays < 0 ? 'certificate expired' : `certificate expires in ${c.sslDays} day${c.sslDays === 1 ? '' : 's'}`, 'warning', { size: 'xs' })] : [])),
    text(c.responseTime !== null ? `${c.responseTime} ms` : '', 'muted', { size: 'sm', align: 'end' }),
    text(c.uptime !== null ? uptime(c.uptime) : '', uptimeTone(c.uptime), { size: 'sm', align: 'end', weight: 'medium' }),
  ] });
}

export function render(input) {
  const s = input.status, c = input.controls || {};
  if (!s) return message(text('Asking updown.io…', 'muted'));
  if (s.state === 'signed-out') return message(text('Your uptime checks show here once you sign in.'), action('Sign in with GitHub', c.signIn));
  if (s.state === 'connect') return message(text('Connect updown.io to see your checks.'), action('Settings → Integrations', c.settings));
  if (s.state === 'loading') return message(text('Asking updown.io…', 'muted'));
  if (s.state === 'error') return message(box({ tone: 'danger' }, text(input.error || 'Status checks unavailable', 'danger')));
  const total = s.page ? s.page.total : s.checks.length;
  const banner = s.down
    ? box({ tone: 'danger', gap: 'xs' }, row({ gap: 'sm', align: 'center' }, icon('alert', 'danger', { size: 'lg' }), text(`${s.down} down`, 'danger', { size: 'lg', weight: 'bold' })), text(`${total} check${total === 1 ? '' : 's'} on updown.io`, 'muted', { size: 'xs' }))
    : box({ tone: 'success', gap: 'xs' }, row({ gap: 'sm', align: 'center' }, icon('check', 'success', { size: 'lg' }), text('All up', 'success', { size: 'lg', weight: 'bold' })), text(`${total} check${total === 1 ? '' : 's'} on updown.io`, 'muted', { size: 'xs' }));
  return column({ gap: 'md' },
    title('Status'),
    banner,
    s.checks.length ? grid(['auto', '1fr', 'auto', 'auto'], { gap: 'sm', align: 'center' }, ...s.checks.map(check)) : text('No checks on updown.io yet.', 'muted'),
    link('Open updown.io ↗', c.open, { fallback: 'row', tone: 'muted' }));
}
export function event() { return null; }
