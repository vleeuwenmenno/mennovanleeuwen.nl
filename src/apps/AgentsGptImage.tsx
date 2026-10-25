import type { AgentMessage } from '../data/agents'
import { AttachedFiles, sentPicture } from './AgentsImages'

// What a gpt_image call made, under its tool card: a picture (kept with the result, like a sent
// picture, so it is still there when the thread is opened again) or an icon from the library.

type IconResult = { slug: string; url: string; reused: boolean }

function iconOf(content: string): IconResult | null {
  try {
    const v = JSON.parse(content) as { icon?: Partial<IconResult> }
    const i = v.icon
    return i && typeof i.slug === 'string' && /^[a-z0-9_-]{1,64}$/.test(i.slug) ? { slug: i.slug, url: `/api/agents/icons/${i.slug}`, reused: !!i.reused } : null
  } catch {
    return null
  }
}

export function GptImageResult({ threadId, result }: { threadId: string | null; result: AgentMessage }) {
  const icon = iconOf(result.content)
  if (icon)
    return (
      <div className="agt-gpt-icon">
        <img src={`${icon.url}?m=${result.id}`} alt={icon.slug} width={48} height={48} draggable={false} onError={(e) => (e.currentTarget.style.visibility = 'hidden')} />
        <span>
          <code>icon:{icon.slug}</code>
          <span className="muted"> · {icon.reused ? 'from your icon library' : 'new in your icon library'}</span>
        </span>
      </div>
    )
  if (!threadId || !result.attachments?.length) return null
  return (
    <div className="agt-gpt-picture">
      <AttachedFiles files={result.attachments} pictureOf={sentPicture(threadId, result)} sent />
    </div>
  )
}
