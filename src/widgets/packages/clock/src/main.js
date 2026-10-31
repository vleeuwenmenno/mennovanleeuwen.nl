import { column, text } from '@mvlos/widget';

// The clock: input.clock is the host's clock, already formatted for this person.
// { time, period, weekday, date, weekdayShort, dateShort, show, tone, ... }
// size 'display' scales the text with the widget's width; 'headline' is the smaller line under it.
export function render(input) {
  const c = input.clock;
  if (!c) return column(text('Clock', 'muted'));
  const tone = c.tone === 'accent' ? 'accent' : 'normal';
  const time = c.period ? c.time + ' ' + c.period : c.time;
  const rows = [text(time, tone, { size: 'display' })];
  if (c.show === 'full') rows.push(text(c.weekday + ', ' + c.date, 'muted', { size: 'headline' }));
  else if (c.show === 'short') rows.push(text(c.weekdayShort + ' ' + c.dateShort, 'muted', { size: 'headline' }));
  return column(...rows);
}

export function event() {
  return null;
}
