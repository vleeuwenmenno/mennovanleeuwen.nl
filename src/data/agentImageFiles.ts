// File names for a generated image saved into Files (src/apps/AgentsSaveImage.ts): readable and
// the same every time for the same picture, never a bare id, and never one that is already taken.

/** "A lone lighthouse at dusk, ink wash" + id 0a1b2c3d-… → "a-lone-lighthouse-at-dusk-ink-0a1b2c3d.png". */
export function imageFileName(image: { id: string; settings?: { prompt?: string } | null }): string {
  const short = image.id.replace(/[^0-9a-f]/gi, '').slice(0, 8).toLowerCase() || 'picture'
  const words = (image.settings?.prompt ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .match(/[a-z0-9]+/g) ?? []
  let slug = ''
  for (const w of words.slice(0, 8)) {
    const next = slug ? `${slug}-${w}` : w
    if (next.length > 48) break
    slug = next
  }
  return `${slug || 'image'}-${short}.png`
}

/** `name`, or "name 2.png", "name 3.png" … : the first that `taken` says is free. */
export function freeName(name: string, taken: (name: string) => boolean): string {
  if (!taken(name)) return name
  const dot = name.lastIndexOf('.')
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
  let n = 2
  while (taken(`${stem} ${n}${ext}`)) n++
  return `${stem} ${n}${ext}`
}
