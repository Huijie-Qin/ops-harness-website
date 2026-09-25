import { validChapterId } from '../shared/guide'

export const adminSections = [
  { id: 'guides', label: '文档编辑', icon: 'book' },
  { id: 'documents', label: '目录与文档管理', icon: 'grid' },
  { id: 'releases', label: '发布包', icon: 'download' },
  { id: 'media', label: '图片库', icon: 'grid' },
  { id: 'knowledge', label: '知识库', icon: 'book' },
  { id: 'analytics', label: '运营统计', icon: 'windows' },
  { id: 'cloud', label: '云端任务', icon: 'clock' },
] as const
export const analyticsViews = [
  { id: 'overview', label: '总览' }, { id: 'users', label: '用户明细' },
  { id: 'rankings', label: '活跃排名' }, { id: 'features', label: '功能使用' },
  { id: 'conversations', label: '对话与 Token' }, { id: 'skills', label: 'Skill 使用' },
  { id: 'operations', label: '操作明细' }, { id: 'health', label: '采集状态' },
] as const
export type AdminSection = typeof adminSections[number]['id']
export type AnalyticsView = typeof analyticsViews[number]['id']
export type AdminRoute = { section: AdminSection; view: AnalyticsView; documentId?: string; query: string }
const queryKeys = ['from', 'to', 'environment', 'appVersion', 'page', 'limit', 'search', 'sort', 'direction', 'user']

export function parseAdminHash(hash: string): AdminRoute {
  const [path = '', query = ''] = hash.replace(/^#\/?/, '').split('?')
  const [section, child] = path.split('/')
  const selected = adminSections.find(item => item.id === section)?.id ?? 'guides'
  const params = new URLSearchParams(query.slice(0, 4096))
  const clean = new URLSearchParams()
  if (selected === 'analytics') for (const key of queryKeys) {
    const value = params.get(key)
    if (value && value.length <= 128) clean.set(key, value)
  }
  return {
    section: selected,
    view: analyticsViews.find(item => item.id === child)?.id ?? 'overview',
    ...(section === 'guides' && child && validChapterId(child) ? { documentId: child } : {}),
    query: clean.toString(),
  }
}

export function adminHash(route: AdminRoute): string {
  const child = route.section === 'analytics' ? `/${route.view}` : route.section === 'guides' && route.documentId ? `/${route.documentId}` : ''
  return `#${route.section}${child}${route.section === 'analytics' && route.query ? `?${route.query}` : ''}`
}
