import { column, row, text, button } from '@mvlos/widget';

// Daily tally: count things (glasses of water, pages read) per day. It keeps
// { day, count, total } in this widget's own saved state (custom.state, at most 4 KiB).
// input.custom = { now, today, state, revision }. Changing state is an explicit effect:
// event() returns { type: 'custom.replace', state, expectedRevision }, and the host only
// applies it if the state is still the one it was computed from.

function read(input) {
  const c = input.custom || {};
  const s = c.state && typeof c.state === 'object' ? c.state : {};
  const total = typeof s.total === 'number' ? s.total : 0;
  const count = s.day === c.today && typeof s.count === 'number' ? s.count : 0;
  return { today: c.today, count, total };
}

export function render(input) {
  const v = read(input);
  return column(
    text('Daily tally', 'accent'),
    text(String(v.count), v.count > 0 ? 'success' : 'muted'),
    row(button('+1', 'inc'), button('-1', 'dec'), button('Reset today', 'reset')),
    text(v.total + ' all time · ' + v.today, 'muted')
  );
}

export function event(input, name) {
  const v = read(input);
  let count = v.count;
  let total = v.total;
  if (name === 'inc') { count += 1; total += 1; }
  else if (name === 'dec' && count > 0) { count -= 1; total -= 1; }
  else if (name === 'reset') { total -= count; count = 0; }
  else return null;
  return { type: 'custom.replace', state: { day: v.today, count, total }, expectedRevision: input.custom.revision };
}
