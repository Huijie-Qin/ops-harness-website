export type VideoCategory = 'product' | 'feature' | 'practice'
export type VideoFile = { fileName: string; url: string; size: number; sha256: string; contentType: 'video/mp4' }
export type VideoInput = {
  title: string
  description: string
  category: VideoCategory
  status: 'draft' | 'published'
  featured: boolean
  coverUrl: string
  durationSeconds: number
}
export type VideoEntry = VideoInput & { id: string; video?: VideoFile | undefined; createdAt: string; updatedAt: string }
export type VideoCatalog = { schemaVersion: 1; revision: string; items: VideoEntry[] }
export type PublicVideoCatalog = { schemaVersion: 1; items: VideoEntry[] }

export const maxVideoFileBytes = 512 * 1024 ** 2
export const maxVideoEntries = 200
export const maxVideoTitle = 120
export const maxVideoDescription = 2000
export const maxVideoDurationSeconds = 86400
export const videoCategories: readonly VideoCategory[] = ['product', 'feature', 'practice']

/** Empty uses the website's default cover. No remote, executable or traversing URL is accepted. */
export function validVideoCoverUrl(value: string): boolean {
  return value === '' || /^\/media\/[a-f0-9]{64}\.(?:png|jpg|webp)$/.test(value)
    || (/^\/assets\/product\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.(?:png|jpg|jpeg|webp|svg)$/.test(value) && !value.includes('..'))
}
