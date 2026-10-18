import type { AnalyticsConfig } from '../../server/tracking/config.js'

export const DEFAULT_TRACKING_TIMEOUT_MS = 300000

export function parseTrackingTimeout(value: string | undefined): number {
  const timeout = value === undefined ? DEFAULT_TRACKING_TIMEOUT_MS : Number(value)
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 300000) throw new Error('TRACKING_TIMEOUT_MUST_BE_1000_TO_300000_MS')
  return timeout
}

/** Offline CLI budget only: apply to reads, prior-version lookups, DDL, recovery and INSERTs. */
export function trackingAnalyticsConfig(config: AnalyticsConfig, timeoutMs: number): AnalyticsConfig {
  return { ...config, clickhouse: { ...config.clickhouse, requestTimeoutMs: timeoutMs }, queryTimeoutMs: timeoutMs }
}
