import { column, row, text } from '@mvlos/widget';
export function render(input) {
  const weather = input.weather;
  if (!weather) return column(text('Weather', 'accent'), text(input.error || 'Choose a place above.', 'muted'));
  return column(text(weather.place, 'accent'), text(weather.summary),
    row(...weather.hours.map(hour => text(hour, 'muted'))),
    ...weather.days.map(day => text(day)));
}
export function event() { return null; }
