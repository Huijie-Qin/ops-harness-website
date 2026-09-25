import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { isIP } from 'node:net'
import { z } from 'zod'
import { ReleaseConfigSchema } from '@dsh-ops/release-contract'
import { normalizeWebsiteUrl } from './website-url.js'

const CloudExtraHostSchema = z.string().max(320).refine(value => {
  const separator = value.indexOf(':')
  if (separator < 1) return false
  const hostname = value.slice(0, separator), address = value.slice(separator + 1)
  const validHostname = hostname.length <= 253 && hostname.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
  return validHostname && (address === 'host-gateway' || (!address.includes('%') && isIP(address) !== 0))
}, 'extraHosts entries must be hostname:host-gateway or hostname:IP')

const CloudDockerSchema = z.object({
  socketPath: z.string().min(1).default(process.platform === 'win32' ? '//./pipe/docker_engine' : '/var/run/docker.sock'),
  image: z.string().min(1).max(256).default('dsh-ops-cloud:latest'),
  memoryMb: z.number().int().min(256).max(65_536).default(2048),
  cpus: z.number().min(0.25).max(64).default(1),
  network: z.string().min(1).max(64).default('bridge'),
  sandbox: z.enum(['native', 'bubblewrap']).default('native'),
  extraHosts: z.array(CloudExtraHostSchema).max(32).default([]).refine(values => new Set(values.map(value => value.slice(0, value.indexOf(':')).toLowerCase())).size === values.length, 'extraHosts must not repeat a hostname'),
  instancePort: z.number().int().min(1).max(65_535).default(3080),
  /** Explicit non-root container uid:gid, matching ownership of the bind-mounted home. */
  user: z.string().regex(/^[1-9]\d{0,9}:[1-9]\d{0,9}$/, 'user must be a non-root numeric uid:gid').optional(),
  /** Origin the executor inside a container uses to reach this website (defaults to websiteUrl). */
  websiteUrlForInstances: z.string().max(2048).transform((value, ctx) => {
    try { return normalizeWebsiteUrl(value) }
    catch { ctx.addIssue({ code: 'custom', message: 'websiteUrlForInstances must be an HTTP or HTTPS origin' }); return z.NEVER }
  }).optional(),
}).strict()
const CloudProcessSchema = z.object({
  productRepo: z.string().max(4096).default(''),
  dshEntry: z.string().max(4096).default(''),
  overlays: z.array(z.string().min(1).max(4096)).max(16).default([]),
  nodeExecutable: z.string().max(4096).default(''),
  portRangeStart: z.number().int().min(1024).max(65_000).default(3400),
}).strict()
const CloudSchema = z.object({
  enabled: z.boolean().default(false),
  directory: z.string().min(1).default('../.runtime/website-cloud'),
  orchestrator: z.enum(['docker', 'process']).default('docker'),
  idleStopMinutes: z.number().int().min(1).max(1440).default(15),
  executorPollMs: z.number().int().min(1000).max(600_000).default(5000),
  modelApiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]{0,100}$/).default('DSH_OPS_CLOUD_MODEL_API_KEY'),
  modelBaseUrl: z.string().max(2048).transform((value, ctx) => {
    try {
      const url = new URL(value)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('invalid URL')
      return url.toString().replace(/\/$/, '')
    } catch { ctx.addIssue({ code: 'custom', message: 'modelBaseUrl must be an HTTP or HTTPS URL without credentials, query or fragment' }); return z.NEVER }
  }).optional(),
  modelName: z.string().trim().min(1).max(256).optional(),
  docker: CloudDockerSchema.prefault({}),
  process: CloudProcessSchema.prefault({}),
}).strict().refine(value => (value.modelBaseUrl === undefined) === (value.modelName === undefined), { message: 'modelBaseUrl and modelName must be configured together' })

const WebsiteConfigSchema = ReleaseConfigSchema.extend({
  websiteUrl: z.string().max(2048).transform((value, ctx) => {
    try { return normalizeWebsiteUrl(value) }
    catch {
      ctx.addIssue({ code: 'custom', message: 'websiteUrl must be an HTTP or HTTPS origin without credentials, a subpath, query or fragment' })
      return z.NEVER
    }
  }),
  analyticsDirectory: z.string().min(1).default('../.runtime/website-analytics'),
  trackingEnabled: z.boolean().default(false),
  contentDirectory: z.string().refine(value => value.trim().length > 0),
  adminPasswordEnv: z.string().regex(/^[A-Z][A-Z0-9_]{0,100}$/),
  cloud: CloudSchema.prefault({}),
})

export async function loadConfig(configPath = process.env.DSH_OPS_WEBSITE_CONFIG) {
  if (configPath === undefined && (process.env.DSH_OPS_RELEASE_CONFIG !== undefined || process.env.DSH_OPS_WEBSITE_CONTENT_CONFIG !== undefined)) {
    throw new Error('Website configuration has been merged. Set DSH_OPS_WEBSITE_CONFIG to a complete website.json instead of DSH_OPS_RELEASE_CONFIG or DSH_OPS_WEBSITE_CONTENT_CONFIG.')
  }
  const absolute = path.resolve(configPath ?? 'config/website.json')
  const raw = await readFile(absolute, 'utf8')
  const config = WebsiteConfigSchema.parse(JSON.parse(raw.replace(/^\uFEFF/, '')))
  return {
    ...config,
    releaseDirectory: path.resolve(path.dirname(absolute), config.releaseDirectory),
    contentDirectory: path.resolve(path.dirname(absolute), config.contentDirectory),
    analyticsDirectory: path.resolve(path.dirname(absolute), config.analyticsDirectory),
    cloud: {
      ...config.cloud,
      directory: path.resolve(path.dirname(absolute), config.cloud.directory),
      process: {
        ...config.cloud.process,
        productRepo: config.cloud.process.productRepo && path.resolve(path.dirname(absolute), config.cloud.process.productRepo),
        dshEntry: config.cloud.process.dshEntry && path.resolve(path.dirname(absolute), config.cloud.process.dshEntry),
        overlays: config.cloud.process.overlays.map(overlay => path.resolve(path.dirname(absolute), overlay)),
      },
    },
    configPath: absolute,
  }
}
export type WebsiteConfig = Awaited<ReturnType<typeof loadConfig>>
