import { column, text, button, editor, divider } from '@mvlos/widget';
export function render(input) {
  if (!input.note) return column(text('Note unavailable', 'muted'), editor());
  const tasks = input.note.text.split('\n').slice(0, 64).flatMap((line, index) => {
    if (index === 0 && input.note.continues) return [];
    const match = /^\s*[-*+] \[([ xX])\]\s?(.*)$/.exec(line);
    return match ? [button(`${match[1] === ' ' ? '☐' : '☑'} ${Array.from(match[2] || 'Item').slice(0, 256).join('')}`, `toggle:${index}`)] : [];
  });
  return column(editor(), ...(tasks.length ? [divider(), ...tasks] : []));
}
export function event(input, event) {
  if (!input.note || !/^toggle:\d+$/.test(event)) return null;
  const lines = input.note.text.split('\n');
  const index = Number(event.split(':')[1]);
  if (index === 0 && input.note.continues) return null;
  if (!lines[index] || !/^\s*[-*+] \[([ xX])\]/.test(lines[index])) return null;
  const lineStart = lines.slice(0, index).reduce((offset, line) => offset + line.length + 1, 0);
  const mark = lines[index].indexOf('[') + 1;
  const start = (input.note.offset || 0) + lineStart + mark;
  return { type: 'note.edit', start, end: start + 1, text: lines[index][mark] === ' ' ? 'x' : ' ', expectedRevision: input.note.revision };
}
