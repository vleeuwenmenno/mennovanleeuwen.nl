import { column, text } from '@mvlos/widget';

// The clock: input.clock is the host's clock, already formatted for this person.
// { time, period, weekday, date, weekdayShort, dateShort, show, tone, ... }
// size 'face' scales the text with the widget's width; 'subface' is the smaller line under it.
export function render(input) {
  const c = input.clock;
  if (!c) return column(text('Clock', 'muted'));
  const tone = c.tone === 'accent' ? 'accent' : 'normal';
  const time = c.period ? c.time + ' ' + c.period : c.time;
  const rows = [text(time, tone, { size: 'face' })];
  if (c.show === 'full') rows.push(text(c.weekday + ', ' + c.date, 'muted', { size: 'subface' }));
  else if (c.show === 'short') rows.push(text(c.weekdayShort + ' ' + c.dateShort, 'muted', { size: 'subface' }));
  return column(...rows);
}

export function event() {
  return null;
}
