// Which fenced code blocks are visual blocks: ```visual (also ```vis). On its own so Markdown
// everywhere can ask without loading the spec reader (spec.ts) or the renderer.
export const isVisualLang = (lang: string) => /^(visual|vis)$/i.test(lang.trim())
