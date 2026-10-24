/** The generate_image row label. No imports, so the image checks can load it under plain Node. */
export function generateImageLabel(a: Record<string, unknown>, result?: string): string {
  const s = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : '')
  // A review reply submitted nothing: say so before any operation's success label.
  if (result?.includes('"status":"review_once"') || result?.includes('"learning_review_required":true')) return 'Showed image learnings before generating'
  if (a.operation === 'refine') return result ? 'Refined image' : 'Refine image'
  if (a.hires) return result ? 'Generated image with hires' : 'Generate image with hires'
  if (a.operation === 'inpaint') return result ? 'Inpainted image' : `Inpaint image: ${s('prompt')}`
  if (a.operation === 'remove') return result ? 'Removed the masked area' : 'Remove the masked area'
  if (a.operation === 'upscale') return result ? 'Upscaled image' : `Upscale image: ${s('upscale_model')}`
  return result ? a.source_image_id ? 'Edited image' : 'Generated image' : `${a.source_image_id ? 'Edit image' : 'Generate image'}: ${s('prompt').slice(0, 120)}`
}
