import type { UserSortKey } from '../../shared/analytics.js'

export type Installation = { tenantId: string; installationId: string; environment: 'production' | 'development' | 'test' }
export type Principal = { issuer: string; subject: string; displayName: string; expiresAt: number }
export type AnalyticsQuery = { from: string; to: string; environment: string; platform?: string | undefined; appVersion?: string | undefined; userId?: string | undefined; offset: number; limit: number; search?: string | undefined; sort?: UserSortKey | undefined; direction?: 'asc' | 'desc' | undefined }
export function dayAt(ms: number) { return new Date(ms + 8 * 3600000).toISOString().slice(0, 10) }
