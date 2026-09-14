import type { WebsiteConfig } from './config.js'

type WebsiteEnvironment = { dev: boolean; host: string; websiteUrl: string }
export function minimumAdminPasswordLength(environment?: WebsiteEnvironment) {
  if (!environment?.dev || !['127.0.0.1', '::1', 'localhost'].includes(environment.host)) return 16
  const url = new URL(environment.websiteUrl)
  return url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) ? 6 : 16
}

export function readAdminPassword(config: Pick<WebsiteConfig, 'adminPasswordEnv' | 'host' | 'websiteUrl'>, dev = false) {
  const password = process.env[config.adminPasswordEnv]
  const minimum = minimumAdminPasswordLength({ dev, host: config.host, websiteUrl: config.websiteUrl })
  if (password !== undefined && (password.length < minimum || password.length > 256)) throw new Error(`Website administrator password must contain ${minimum} to 256 characters`)
  return password
}
