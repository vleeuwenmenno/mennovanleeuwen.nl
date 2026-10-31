import { column, row, grid, text, icon, divider, spacer } from '@mvlos/widget';

// Weather: the selected place now, the next hours and the next days. The host projects the forecast
// (input.weather); older hosts only send the summary/hours/days strings, which still render.
const TONE = { sun: 'warning', 'cloud-sun': 'warning', moon: 'accent', 'cloud-moon': 'accent', rain: 'accent', drizzle: 'accent', snow: 'accent', storm: 'warning' };
const tone = (name) => TONE[name] || 'muted';

function legacy(w) {
  return column(text(w.place, 'accent'), text(w.summary), row(...w.hours.map((hour) => text(hour, 'muted'))), ...w.days.map((day) => text(day)));
}

export function render(input) {
  const w = input.weather;
  if (!w) return column(text('Weather', 'accent'), text(input.error || 'Choose a place above.', 'muted'));
  const now = w.now;
  if (!now || !w.hourly || !w.daily) return legacy(w);
  const degrees = (value) => `${value}°`;
  return column({ gap: 'md' },
    text(w.place, 'muted', { weight: 'medium', clamp: 1 }),
    row({ gap: 'md', align: 'center', wrap: false },
      icon(now.icon, tone(now.icon), { size: 'display' }),
      column({ gap: 'none' }, text(degrees(now.temp), 'normal', { size: 'display', weight: 'bold' }), text(now.text, 'muted', { clamp: 1 })),
      spacer(),
      column({ gap: 'xs', align: 'end' },
        text(`H ${degrees(now.high)}  L ${degrees(now.low)}`, 'normal', { size: 'sm', weight: 'medium', align: 'end' }),
        text(`feels ${degrees(now.feels)}`, 'muted', { size: 'xs', align: 'end' }),
        text(`${now.wind} ${now.windUnit} · ${now.humidity}%`, 'muted', { size: 'xs', align: 'end' }))),
    divider(),
    grid(w.hourly.map(() => '1fr'), { gap: 'sm', align: 'start' },
      ...w.hourly.map((hour) => column({ gap: 'xs', align: 'center' }, text(hour.time, 'muted', { size: 'xs' }), icon(hour.icon, tone(hour.icon)), text(degrees(hour.temp), 'normal', { size: 'sm', weight: 'bold' }),
        text(hour.rain >= 20 ? `${hour.rain}%` : ' ', 'accent', { size: 'xs', weight: 'normal' })))),
    divider(),
    grid(['auto', 'auto', '1fr', 'auto', 'auto'], { gap: 'sm', align: 'center' },
      ...w.daily.flatMap((day) => [
        text(day.label, 'normal', { weight: 'medium' }),
        icon(day.icon, tone(day.icon)),
        text(day.rain >= 20 ? `${day.rain}%` : '', 'accent', { size: 'xs' }),
        text(degrees(day.min), 'muted', { align: 'end' }),
        text(degrees(day.max), 'normal', { weight: 'bold', align: 'end' }),
      ])));
}
export function event() { return null; }
