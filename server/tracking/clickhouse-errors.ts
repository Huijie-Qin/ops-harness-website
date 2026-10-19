export type ClickHouseOperation = 'query' | 'command' | 'manifest_exists' | 'manifest_projection' | 'manifest_watermark' | 'table_export' | 'api_metadata' | 'api_result'
export type RequestContext = { phase: 'headers' | 'body'; operation: ClickHouseOperation; queryId: string; requestElapsedMs: number; attempt: number }

export class ClickHouseHttpError extends Error {
  readonly diagnostics: RequestContext & { httpStatus: number; clickhouseCode?: number }
  constructor(status: number, exceptionCode: string | null, context: RequestContext) {
    super(`CLICKHOUSE_HTTP_${status}`)
    // The response body can contain SQL/rows. Retain only a bounded numeric header.
    const code = exceptionCode && /^[1-9]\d{0,8}$/.test(exceptionCode) ? Number(exceptionCode) : undefined
    this.diagnostics = { ...context, httpStatus: status, ...(code === undefined ? {} : { clickhouseCode: code }) }
  }
}

const transportErrors = {
  ECONNRESET: 'ANALYTICS_CONNECTION_RESET', EPIPE: 'ANALYTICS_CONNECTION_RESET',
  UND_ERR_SOCKET: 'ANALYTICS_SOCKET_CLOSED', ECONNREFUSED: 'ANALYTICS_CONNECTION_REFUSED',
  UND_ERR_CONNECT_TIMEOUT: 'ANALYTICS_CONNECT_TIMEOUT', ETIMEDOUT: 'ANALYTICS_NETWORK_TIMEOUT',
  UND_ERR_HEADERS_TIMEOUT: 'ANALYTICS_QUERY_TIMEOUT', UND_ERR_BODY_TIMEOUT: 'ANALYTICS_QUERY_TIMEOUT',
  HPE_INVALID_EOF_STATE: 'ANALYTICS_RESPONSE_TRUNCATED', HTTP_PROTOCOL_ERROR: 'ANALYTICS_HTTP_PROTOCOL_ERROR',
  ENOTFOUND: 'ANALYTICS_DNS_FAILED', EAI_AGAIN: 'ANALYTICS_DNS_FAILED',
  CERT_HAS_EXPIRED: 'ANALYTICS_TLS_FAILED', DEPTH_ZERO_SELF_SIGNED_CERT: 'ANALYTICS_TLS_FAILED',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'ANALYTICS_TLS_FAILED', ERR_TLS_CERT_ALTNAME_INVALID: 'ANALYTICS_TLS_FAILED',
} as const
type TransportCode = keyof typeof transportErrors | 'ABORT_TIMEOUT' | 'CANCELLED' | 'UNKNOWN'

/** Store only allowlisted metadata, never the original error, URL, SQL, headers or body. */
export class ClickHouseTransportError extends Error {
  constructor(code: string, readonly diagnostics: RequestContext & { transportCode: TransportCode }) { super(code) }
  get retryableRead() { return ['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET', 'HPE_INVALID_EOF_STATE'].includes(this.diagnostics.transportCode) }
}

export function transportFailure(error: unknown, signal: AbortSignal, context: RequestContext): ClickHouseTransportError {
  if (signal.aborted) {
    const timeout = signal.reason?.name === 'TimeoutError'
    return new ClickHouseTransportError(timeout ? 'ANALYTICS_QUERY_TIMEOUT' : 'ANALYTICS_CANCELLED', { ...context, transportCode: timeout ? 'ABORT_TIMEOUT' : 'CANCELLED' })
  }
  let current = error
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    const { code, cause, name, message } = current as { code?: unknown; cause?: unknown; name?: unknown; message?: unknown }
    if (typeof code === 'string' && Object.hasOwn(transportErrors, code)) {
      return new ClickHouseTransportError(transportErrors[code as keyof typeof transportErrors], { ...context, transportCode: code as keyof typeof transportErrors })
    }
    // Some Node 24 HTTP parser errors have no code. Inspect only this fixed
    // signature; parser data/message can contain server content and is discarded.
    if (name === 'HTTPParserError') {
      const parserCode = typeof message === 'string' && message.endsWith('(Invalid EOF state)') ? 'HPE_INVALID_EOF_STATE' : 'HTTP_PROTOCOL_ERROR'
      return new ClickHouseTransportError(transportErrors[parserCode], { ...context, transportCode: parserCode })
    }
    current = cause
  }
  return new ClickHouseTransportError('ANALYTICS_TRANSPORT_ERROR', { ...context, transportCode: 'UNKNOWN' })
}
