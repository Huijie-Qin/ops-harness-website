import type { Release, ReleasePlatform, ReleaseArtifact } from '@dsh-ops/release-contract'
export type Navigation = { groups: { id: string; title: string; chapters: string[] }[]; hidden: string[] }
export type NavigationDocument = Navigation & { revision: string }
export type ContentSyncPreview = { revision: string; files: { path: string; action: '新增' | '覆盖' }[] }
export type MediaImage = { name: string; url: string; size: number; width: number; height: number; createdAt: string }
export type ReleaseDraft = { id: string; published: boolean; version: string; platform: ReleasePlatform; title: string; notes: string[]; files: ReleaseArtifact[]; revision: string; createdAt: string }
export type ManagedRelease = Release & { revision: string }
export const maxImageBytes = 10 * 1024 ** 2
export const maxPackageBytes = 2 * 1024 ** 3
