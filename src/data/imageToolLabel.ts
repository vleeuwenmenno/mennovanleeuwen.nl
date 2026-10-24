export const IMAGE_REVIEW_LABEL = 'Showed image learnings; nothing submitted yet'
/** A generate_image reply that showed learning evidence instead of submitting (and its older format). */
export const isImageReview = (result?: string) => !!result && (result.includes('"status":"review_once"') || result.includes('"learning_review_required":true'))
/** The generate_image row label. No imports, so the image checks can load it under plain Node. */
export function generateImageLabel(a: Record<string, unknown>, result?: string): string {
  const s = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : '')
  // A review reply submitted nothing: say so before any operation's success label.
  if (isImageReview(result)) return IMAGE_REVIEW_LABEL
  if (a.operation === 'refine') return result ? 'Refined image' : 'Refine image'
  if (a.hires) return result ? 'Generated image with hires' : 'Generate image with hires'
  if (a.operation === 'inpaint') return result ? 'Inpainted image' : `Inpaint image: ${s('prompt')}`
  if (a.operation === 'remove') return result ? 'Removed the masked area' : 'Remove the masked area'
  if (a.operation === 'upscale') return result ? 'Upscaled image' : `Upscale image: ${s('upscale_model')}`
  const label = result ? a.source_image_id ? 'Edited image' : 'Generated image' : `${a.source_image_id ? 'Edit image' : 'Generate image'}: ${s('prompt').slice(0, 120)}`
  return label + qualityNote(result)
}

/** " · clearly broken: noise", when the automatic quality check flagged a result; else empty. */
export function qualityNote(result?: string): string {
  try {
    const q = JSON.parse(result ?? '').quality as { very_bad?: unknown; defects?: unknown } | undefined
    if (q?.very_bad !== true) return ''
    const defects = Array.isArray(q.defects) ? q.defects.filter((d): d is string => typeof d === 'string').slice(0, 2).join(', ') : ''
    return ` · clearly broken${defects ? `: ${defects.slice(0, 120)}` : ''}`
  } catch { return '' }
}

/** The model_details row: model, family, recommended line and its source, in one line. */
export function modelDetailsLabel(a: Record<string, unknown>, result?: string): string {
  const name = typeof a.name === 'string' ? a.name.split(/[\\/]/).pop()! : ''
  if (!result) return name ? `Model details: ${name}` : `Searched models: “${String(a.query ?? '').slice(0, 80)}”`
  try {
    const v = JSON.parse(result)
    if (Array.isArray(v.matches)) return `Searched models: “${String(a.query ?? '').slice(0, 80)}” · ${v.matches.length} ${v.matches.length === 1 ? 'match' : 'matches'}`
    const r = v.recommended ?? {}
    const family = v.family?.label ? ` · ${v.family.label}` : ''
    if (v.supported === false) return `Model details: ${name}${family} · not supported here`
    if (typeof r.sampler === 'string') {
      const source = r.source === 'civitai_examples' ? `Civitai examples${r.agree ? ` (${r.agree} agree)` : ''}` : r.source === 'family_default' ? 'family default' : r.source === 'user_saved' ? 'your saved settings' : 'preset'
      return `Model details: ${name}${family} · ${r.sampler}/${r.scheduler} · ${r.steps} steps · CFG ${r.cfg}${r.clip_skip > 1 ? ` · clip skip ${r.clip_skip}` : ''} · ${source}`
    }
    if (typeof r.strength === 'number') return `LoRA details: ${name}${v.lora_manager?.base_model ? ` · ${v.lora_manager.base_model}` : ''} · strength ${r.strength}${r.trained_words?.length ? ` · ${r.trained_words.slice(0, 3).join(', ')}` : ''}`
    return `Model details: ${name}${family}`
  } catch { return `Model details: ${name}` }
}
