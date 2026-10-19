import { z } from 'zod'

const envName = z.string().regex(/^[A-Z][A-Z0-9_]{0,100}$/)
export const AnalyticsConfigSchema = z.object({
  clickhouse: z.object({
    url: z.string().default('http://127.0.0.1:8123').refine(value => {
      try {
        const url = new URL(value)
        return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/'
      } catch { return false }
    }, 'ClickHouse URL must be an HTTP(S) origin without credentials'),
    database: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/).default('website_analytics_dual'),
    writerUser: z.string().min(1).default('analytics_writer'),
    writerPasswordEnv: envName.default('CH_WRITER_PASSWORD'),
    readerUser: z.string().min(1).default('analytics_reader'),
    readerPasswordEnv: envName.default('CH_READER_PASSWORD'),
    adminUser: z.string().min(1).default('analytics_admin'),
    adminPasswordEnv: envName.default('CH_ADMIN_PASSWORD'),
    requestTimeoutMs: z.number().int().min(1000).max(300000).default(30000),
  }).strict().prefault({}),
  queryTimeoutMs: z.number().int().min(1000).max(300000).default(60000),
  writeTimeoutMs: z.number().int().min(1000).max(600000).default(120000),
  maxQueuedRequests: z.number().int().min(1).max(256).default(64),
}).strict().prefault({})
export type AnalyticsConfig = z.infer<typeof AnalyticsConfigSchema>
