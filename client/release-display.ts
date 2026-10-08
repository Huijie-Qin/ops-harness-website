import { getReleaseType } from '@dsh-ops/release-contract'

export function releaseTypeLabel(version: string): string {
  return { stable: '正式版', beta: 'Beta 测试版', rc: 'RC 候选版', preview: '其他预览版' }[getReleaseType(version)]
}

export function releaseAudience(version: string): string {
  const type = getReleaseType(version)
  if (type === 'stable') return '新版客户端：正式版和测试版频道均可接收。'
  if (type === 'beta' || type === 'rc') return '新版客户端：仅选择测试版频道的用户可接收。'
  return '新版客户端：此预览版本不会通过自动更新提供。'
}

export const releaseAudienceDetail = '自动更新仍受平台、发布时间、最低版本和灰度条件限制。旧版客户端只接收正式版；官网仍可手动下载。'
