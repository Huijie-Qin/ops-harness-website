export type ChapterMeta = { id: string; title: string; group: string; order: number; summary: string; archived: boolean }
export type Chapter = ChapterMeta & { markdown: string; revision: string; updatedAt: string; source: 'repository' | 'online' }
export type ChapterSummary = Omit<Chapter, 'markdown'> & { navigationGroup?: string }
export type ChapterDraft = ChapterMeta & { markdown: string }
export type HistoryEntry = { revision: string; savedAt: string; title: string }
export const chapterIdPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
export const maxChapterBytes = 128 * 1024

export function validChapterId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && chapterIdPattern.test(value)
}
