import { column, row, grid, box, text, action, link, dot, icon, divider } from '@mvlos/widget';

// Agenda: today and the days after it. One grid keeps the columns aligned across days:
// time (or a task's checkbox), the calendar colour, the title and its marks.
const heading = () => text('Agenda', 'normal', { size: 'lg', weight: 'bold' });
const message = (...nodes) => column({ gap: 'md' }, heading(), ...nodes);

function eventRow(e, now) {
  const past = !e.allDay && e.end < now, current = !e.allDay && e.start <= now && !past;
  return row(
    text(e.time, current ? 'accent' : 'muted', { size: 'sm', align: 'end', weight: current ? 'bold' : 'normal' }),
    dot(e.color),
    link(e.title, e.open, { hint: `${e.calendar}${e.location ? ' · ' + e.location : ''}`, tone: past ? 'muted' : current ? 'accent' : 'normal' }),
    row({ gap: 'xs', wrap: false },
      ...(e.mark ? [e.mark.open ? action(e.mark.glyph, e.mark.open, { hint: e.mark.title }) : text(e.mark.glyph)] : []),
      ...(e.meet ? [link('🎥', e.meet, { hint: 'Join the video call' })] : [])));
}

function taskRow(t, today) {
  return row(
    action('☐', t.complete, { checked: false, hint: `Complete "${t.title}"` }),
    dot(t.color),
    link(t.title, t.open, { hint: t.notes }),
    text(t.time, t.due !== today ? 'danger' : 'muted', { size: 'xs', align: 'end' }));
}

export function render(input) {
  const a = input.agenda, c = input.controls || {};
  if (!a) return message(text('Loading calendar…', 'muted'));
  if (a.state === 'signed-out') return message(text('Your calendar shows here once you sign in.'), action('Sign in with GitHub', c.signIn));
  if (a.state === 'connect') return message(text('Connect a calendar to see what is coming up.'), action('Google Calendar', c.google), action('Fastmail / CalDAV', c.settings));
  const errors = (a.errors || []).map((e) => text(e, 'danger', { size: 'sm' }));
  if (a.state === 'loading') return message(...errors, text('Opening your calendar…', 'muted'));
  if (a.state === 'error') return message(...errors, box({ tone: 'danger' }, text(input.error || 'Calendar unavailable', 'danger')));
  const rows = a.days.flatMap((day, index) => [
    ...(index ? [divider({ span: 'all' })] : []),
    text(day.label, index ? 'muted' : 'accent', { size: 'xs', weight: 'bold', span: 'all' }),
    ...(!day.tasks.length && !day.events.length ? [text(a.page.truncated ? 'No items on this page' : 'Nothing planned', 'muted', { size: 'sm', span: 'all' })] : []),
    ...day.tasks.map((t) => taskRow(t, a.today)),
    ...day.events.map((e) => eventRow(e, a.now)),
  ]);
  return column({ gap: 'md' }, heading(), ...errors, grid(['auto', 'auto', '1fr', 'auto'], { gap: 'sm', align: 'center' }, ...rows), action('Open Calendar', c.open, { children: [icon('external', 'muted', { size: 'sm' })] }));
}
export function event() { return null; }
