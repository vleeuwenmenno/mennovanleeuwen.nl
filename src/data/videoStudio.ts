import { api } from '../os/account'
import type { ImageProgress } from './imageModels'
import type { VideoCatalog, VideoFamily, VideoJobStatus, VideoModelChoice, VideoModelSettings } from './videoModels'
import type { VideoProject } from './videoPlan'

// The Video Studio's calls to the server (server/agentVideo.ts): every route is the signed-in
// account's own.

export type ProjectSummary = { id: string; title: string; revision: number; origin: string; updated_at: number; family: VideoFamily; duration: number; width: number; height: number; firstFrame: string | null }
export type ProjectRecord = { id: string; revision: number; origin: string; thread_id: string | null; created_at: number; updated_at: number; project: VideoProject }
export type VideoJob = { id: string; project_id: string; status: VideoJobStatus; error: string | null; video_id: string | null; origin: string; created_at: number; started_at: number | null; ended_at: number | null; progress: ImageProgress | null; title: string; family: VideoFamily; duration: number; width: number; height: number; seed: number }
export type StudioVideo = { id: string; project_id: string | null; job_id: string | null; name: string; size: number; width: number; height: number; frames: number; fps: number; duration: number; url: string; created_at: number; settings: Record<string, unknown> }
export type VideoSource = { id: string; name: string; width: number; height: number; url: string }
export type ThreadPicture = { id: string; name: string; url: string }

export const getVideoStatus = () => api<{ configured: boolean; maxQueued: number }>('/api/video')
export const getVideoCatalog = (fresh = false) => api<{ catalog: VideoCatalog; chosen: VideoModelSettings; resolved: Record<VideoFamily, VideoModelChoice> }>(`/api/video/catalog${fresh ? '?fresh=1' : ''}`)
export const saveVideoModels = (patch: Partial<Record<VideoFamily, Partial<VideoModelChoice>>>) => api<VideoModelSettings>('/api/video/models', { method: 'PUT', json: patch })

export const listVideoProjects = () => api<{ projects: ProjectSummary[] }>('/api/video/projects').then((r) => r.projects)
export const getVideoProject = (id: string) => api<ProjectRecord>(`/api/video/projects/${id}`)
export const createVideoProject = (project?: VideoProject) => api<ProjectRecord>('/api/video/projects', { method: 'POST', json: project ? { project } : {} })
export const deleteVideoProject = (id: string) => api<{ ok: true }>(`/api/video/projects/${id}`, { method: 'DELETE' })

/** A save based on `revision`; a newer one on the server (another tab saved) answers `conflict` with it. */
export async function saveVideoProject(id: string, revision: number, project: VideoProject): Promise<{ saved: ProjectRecord } | { conflict: ProjectRecord }> {
  const res = await fetch(`/api/video/projects/${id}`, { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision, project }) })
  const body = await res.json().catch(() => null)
  if (res.status === 409 && body?.current) return { conflict: body.current as ProjectRecord }
  if (!res.ok) throw new Error(body?.error ?? `Saving failed (${res.status})`)
  return { saved: body as ProjectRecord }
}

export const renderVideoProject = (id: string) => api<VideoJob>(`/api/video/projects/${id}/render`, { method: 'POST', json: {} })
export const listVideoJobs = (active = false) => api<{ jobs: VideoJob[] }>(`/api/video/jobs${active ? '?active=1' : ''}`).then((r) => r.jobs)
export const cancelVideoJob = (id: string) => api<VideoJob>(`/api/video/jobs/${id}`, { method: 'DELETE' })
export const listStudioVideos = (project?: string, before?: number) => api<{ videos: StudioVideo[]; next_before: number | null }>(`/api/video/videos?${new URLSearchParams({ ...(project ? { project } : {}), ...(before ? { before: String(before) } : {}) })}`)
export const deleteStudioVideo = (id: string) => api<{ ok: true }>(`/api/video/videos/${id}`, { method: 'DELETE' })

/** A keyframe the browser prepared: a PNG (base64) at the clip's size. */
export const uploadVideoSource = (name: string, data: string) => api<VideoSource>('/api/video/sources', { method: 'POST', json: { name, data } })
/** A copy of one of the account's pictures (generated image id, or attachment:<message>:<n>) as a keyframe. */
export const videoSourceFromImage = (imageId: string) => api<VideoSource>('/api/video/sources', { method: 'POST', json: { image_id: imageId } })
export const listThreadPictures = (before?: number) => api<{ pictures: ThreadPicture[]; next_before: number | null }>(`/api/video/pictures${before ? `?before=${before}` : ''}`)
export const sourceUrl = (id: string) => `/api/video/sources/${id}`
