// Shared JSON contract for the metric knowledge catalog. Field names use the snake_case spelling
// agreed with the product repository; `quer_card_data` keeps the upstream interface spelling.
export type MetricKnowledgeWorkflowIds = { get_card_index: string; get_card_meta: string; quer_card_data: string }
export type MetricKnowledgeIds = { card_index_knowledge_base: string; card_meta_knowledge_base: string }
export type MetricKnowledgeBaseMeta = {
  knowledge_description: string
  indicators_cover?: string | undefined
  reports_cover?: string | undefined
  update_frequency?: string | undefined
  typical_indicators?: string[] | undefined
}
export type MetricKnowledgeSkill = { name: string; file_name: string; sha256: string; size: number; kind: 'zip' | 'md'; uploaded_at: string }
export type MetricKnowledgeEntry = {
  id: string
  tenant_name: string
  tenant_id: string
  knowledge_retrieve_workflow_id: MetricKnowledgeWorkflowIds
  knowledge_id: MetricKnowledgeIds
  knowledge_base_meta: MetricKnowledgeBaseMeta
  skill?: MetricKnowledgeSkill | undefined
  enabled: boolean
  created_at: string
  updated_at: string
}
export type MetricKnowledgeCatalog = { schemaVersion: 1; revision: string; updatedAt: string; items: MetricKnowledgeEntry[] }
export type MetricKnowledgeInput = Omit<MetricKnowledgeEntry, 'id' | 'skill' | 'created_at' | 'updated_at'> & { id?: string | undefined }

export const metricKnowledgeIdPattern = /^metrics-[a-z0-9]+(?:-[a-z0-9]+)*$/
export const skillNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const maxKnowledgeId = 64
export const maxSkillName = 64
export const maxSkillDescription = 500
export const maxKnowledgeEntries = 500
export const maxTypicalIndicators = 50
export const maxSkillFileBytes = 5 * 1024 ** 2
export const maxSkillArchiveEntries = 256
export const maxSkillArchiveBytes = 20 * 1024 ** 2
export const maxSkillFileName = 200

export function validMetricKnowledgeId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= maxKnowledgeId && metricKnowledgeIdPattern.test(value)
}
