// Masks in make_image_mask / list_image_masks results, as the chat and the terminal show them.
// No imports, so the server-side checks can load it too.

/** A mask the agent made (make_image_mask) or listed (list_image_masks), as the chat shows it. */
export type AgentMask = { mask_id: string; mask_url: string; source_image_id: string; source_url: string; width: number; height: number; target?: string; exclude?: string; coverage_percent?: number; status?: string; made_by?: string; warning?: string; hand_off?: boolean }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** Only this server's private mask and source paths become pictures, never a model-supplied URL. */
function agentMask(value: unknown): AgentMask | null {
  if (!value || typeof value !== 'object') return null
  const m = value as Record<string, unknown>
  if (typeof m.mask_id !== 'string' || !UUID.test(m.mask_id) || m.mask_url !== `/api/agents/image-masks/${m.mask_id}`) return null
  if (typeof m.source_image_id !== 'string' || !Number.isInteger(m.width) || !Number.isInteger(m.height) || (m.width as number) < 1 || (m.height as number) < 1) return null
  const text = (v: unknown) => typeof v === 'string' ? v.slice(0, 120) : undefined
  // The source loads by the mask's ID, resolved by the server when shown (also for cards saved
  // before that, whose stored link may name a thread that was deleted since).
  return { mask_id: m.mask_id, mask_url: m.mask_url, source_image_id: m.source_image_id, source_url: `${m.mask_url}/source`, width: m.width as number, height: m.height as number, target: text(m.target), exclude: text(m.exclude), coverage_percent: typeof m.coverage_percent === 'number' ? m.coverage_percent : undefined, status: text(m.status), made_by: text(m.made_by), warning: text(m.warning), hand_off: m.hand_off === true }
}
/** The masks in a make_image_mask result (also an empty or rejected one) or a list_image_masks result. */
export function agentMasks(result?: string): AgentMask[] {
  try {
    const parsed = JSON.parse(result ?? '') as { mask?: unknown; masks?: unknown; warning?: unknown }
    if (Array.isArray(parsed.masks)) return parsed.masks.map(agentMask).filter((m): m is AgentMask => !!m)
    const one = agentMask(parsed.mask)
    return one ? [{ ...one, ...(typeof parsed.warning === 'string' ? { warning: parsed.warning.slice(0, 200) } : {}) }] : []
  } catch { return [] }
}
