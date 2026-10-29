import { column, text, button, editor } from '@mvlos/widget';
export function render(input) {
  if (!input.note) return column(text('Note unavailable', 'muted'));
  const tasks = input.note.text.split('\n').flatMap((line, index) => {
    const match = /^\s*[-*+] \[([ xX])\]\s?(.*)$/.exec(line);
    return match ? [button(`${match[1] === ' ' ? '☐' : '☑'} ${match[2] || 'Item'}`, `toggle:${index}`)] : [];
  });
  return column(text('Note', 'accent'), editor(), ...tasks);
}
export function event(input, event) {
  if (!input.note || !/^toggle:\d+$/.test(event)) return null;
  const lines = input.note.text.split('\n');
  const index = Number(event.split(':')[1]);
  if (!lines[index] || !/^\s*[-*+] \[([ xX])\]/.test(lines[index])) return null;
  lines[index] = lines[index].replace(/\[([ xX])\]/, (_, mark) => mark === ' ' ? '[x]' : '[ ]');
  return { type: 'note.replace', text: lines.join('\n'), expectedRevision: input.note.revision };
}
