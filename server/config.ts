import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { ReleaseConfigSchema } from '@dsh-ops/release-contract'
import { normalizeWebsiteUrl } from './website-url.js'

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
    configPath: absolute,
  }
}
export type WebsiteConfig = Awaited<ReturnType<typeof loadConfig>>
