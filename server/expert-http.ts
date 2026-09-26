import type { IncomingMessage, ServerResponse } from 'node:http'
import { EMPLOYEE_ID_HEADER, normalizeEmployeeId } from '@dsh-ops/expert-distribution-contract'
import type { AdminContext } from './admin-files.js'
import { ExpertStore, ExpertValidationError } from './expert-store.js'
import { serveFile } from './files.js'
import { GuideError } from './guide-store.js'

/**
 * Administrator routes of 专家分发. They run behind the website's admin session, same-origin and
 * CSRF checks (see guide-http); validation failures carry the individual issues for the form.
 */
export async function handleExpertAdmin(store: ExpertStore, req: IncomingMessage, res: ServerResponse, url: URL, { json, method, body }: AdminContext): Promise<boolean> {
  const tools = url.pathname === '/api/admin/expert-tools' || url.pathname.startsWith('/api/admin/expert-tools/')
  if (!tools && url.pathname !== '/api/admin/experts' && !url.pathname.startsWith('/api/admin/experts/')) return false
  try {
    if (tools) {
      // The custom tool library: saved entries take effect for every expert using them at the next sync.
      if (url.pathname === '/api/admin/expert-tools') { method(req, ['GET']); json(res, await store.listTools()); return true }
      const match = /^\/api\/admin\/expert-tools\/([a-z0-9][a-z0-9-]{0,40})$/.exec(url.pathname)
      if (!match) throw new GuideError('NOT_FOUND', 404)
      method(req, ['PUT', 'DELETE'])
      const data = await body(req)
      json(res, req.method === 'PUT' ? await store.updateTool(match[1]!, data.tool, data.revision) : await store.removeTool(match[1]!, data.revision))
      return true
    }
    if (url.pathname === '/api/admin/experts') {
      method(req, ['GET', 'POST'])
      if (req.method === 'GET') json(res, await store.list())
      else { const data = await body(req); json(res, await store.create({ ...(data.id === undefined ? {} : { id: data.id }), draft: data.draft }, data.revision)) }
      return true
    }
    if (url.pathname === '/api/admin/experts/options') { method(req, ['GET']); json(res, await store.options()); return true }
    if (url.pathname === '/api/admin/experts/import') { method(req, ['POST']); json(res, await store.importPackage(req)); return true }
    const pending = /^\/api\/admin\/experts\/import\/([a-f0-9]{32})(\/apply)?$/.exec(url.pathname)
    if (pending) {
      const importId = pending[1]!
      if (pending[2]) { method(req, ['POST']); const data = await body(req); json(res, await store.applyImport(importId, { target: data.target, adoptAllowlist: data.adoptAllowlist ?? false, publish: data.publish ?? false, tools: data.tools ?? {} }, data.revision)) }
      else {
        method(req, ['GET', 'DELETE'])
        json(res, req.method === 'GET' ? await store.previewImport(importId) : await store.discardImport(importId))
      }
      return true
    }
    const match = /^\/api\/admin\/experts\/([^/]+)(?:\/(skills|distribution|publish)(?:\/([^/]+))?)?$/.exec(url.pathname)
    if (!match) throw new GuideError('NOT_FOUND', 404)
    const id = decodeURIComponent(match[1]!), action = match[2], child = match[3] === undefined ? undefined : decodeURIComponent(match[3])
    if (!action) {
      method(req, ['GET', 'PUT', 'DELETE'])
      if (req.method === 'GET') json(res, await store.get(id))
      else { const data = await body(req); json(res, req.method === 'PUT' ? await store.saveDraft(id, data.draft, data.revision) : await store.remove(id, data.revision)) }
    } else if (action === 'skills') {
      if (child === undefined) {
        method(req, ['POST'])
        json(res, await store.attachSkill(id, url.searchParams.get('name') ?? '', url.searchParams.get('required') !== 'false', req, req.headers['x-revision']))
      } else { method(req, ['DELETE']); json(res, await store.detachSkill(id, child, (await body(req)).revision)) }
    } else if (action === 'distribution' && child === undefined) {
      method(req, ['PUT']); const data = await body(req)
      json(res, await store.setDistribution(id, data.distribution, data.revision))
    } else if (action === 'publish' && child === undefined) {
      method(req, ['POST']); json(res, await store.publish(id, (await body(req)).revision))
    } else throw new GuideError('NOT_FOUND', 404)
    return true
  } catch (error) {
    if (!(error instanceof ExpertValidationError)) throw error
    json(res, { error: error.code, issues: error.issues }, error.status)
    return true
  }
}

/** Fixed-window request budget per client address; the catalog is polled, downloads are rare. */
class RequestBudget {
  private readonly windows = new Map<string, { count: number; until: number }>()
  constructor(private readonly limit: number, private readonly windowMs: number, private readonly now: () => number) {}
  take(key: string): boolean {
    const now = this.now()
    if (this.windows.size > 5000) for (const [entry, value] of this.windows) if (value.until <= now) this.windows.delete(entry)
    const current = this.windows.get(key)
    if (!current || current.until <= now) { this.windows.set(key, { count: 1, until: now + this.windowMs }); return true }
    current.count++
    return current.count <= this.limit
  }
}

/**
 * Public, read-only routes the product's cloud expert plugin calls from its Host. Every route checks
 * the caller's visibility; anything not visible reads as absent. Browser pages are refused.
 */
export function createExpertPublicHandler(store: ExpertStore, options: { now?: () => number; requestsPerMinute?: number } = {}) {
  const budget = new RequestBudget(options.requestsPerMinute ?? 600, 60_000, options.now ?? Date.now)
  const send = (req: IncomingMessage, res: ServerResponse, status: number, data: unknown) => {
    const body = JSON.stringify(data)
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', Vary: 'X-Ops-Employee-Id' })
    res.end(req.method === 'HEAD' ? undefined : body)
  }
  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    if (!url.pathname.startsWith('/api/experts/v1/')) return false
    try {
      if (req.headers.origin !== undefined || req.headers['sec-fetch-site'] !== undefined) throw new GuideError('BROWSER_REJECTED', 403)
      if (!budget.take(req.socket.remoteAddress ?? 'unknown')) { res.setHeader('Retry-After', '60'); throw new GuideError('RATE_LIMITED', 429) }
      const header = req.headers[EMPLOYEE_ID_HEADER]
      const raw = Array.isArray(header) ? header[0] : header
      const employeeId = raw === undefined || raw.trim() === '' ? undefined : normalizeEmployeeId(raw)
      if (raw !== undefined && raw.trim() !== '' && employeeId === undefined) throw new GuideError('INVALID_EMPLOYEE_ID', 400)
      res.setHeader('Vary', 'X-Ops-Employee-Id')
      if (url.pathname === '/api/experts/v1/catalog') {
        const catalog = await store.publicCatalog(employeeId)
        res.setHeader('ETag', catalog.etag)
        if (req.headers['if-none-match'] === catalog.etag) { res.writeHead(304, { 'Cache-Control': 'no-store' }); res.end(); return true }
        send(req, res, 200, catalog.body)
        return true
      }
      const match = /^\/api\/experts\/v1\/experts\/([^/]+)\/versions\/(\d{1,9})\/(responsibility|skills\/([^/]+))$/.exec(url.pathname)
      if (!match) throw new GuideError('NOT_FOUND', 404)
      const id = decodeURIComponent(match[1]!), version = Number(match[2])
      if (match[3] === 'responsibility') {
        const file = await store.publicResponsibility(id, version, employeeId)
        const etag = `"${file.sha256}"`
        res.setHeader('ETag', etag)
        res.setHeader('Cache-Control', 'no-store')
        if (req.headers['if-none-match'] === etag) { res.writeHead(304); res.end(); return true }
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Length': file.bytes.length, 'X-Content-Sha256': file.sha256 })
        res.end(req.method === 'HEAD' ? undefined : file.bytes)
        return true
      }
      const file = await store.publicSkill(id, version, decodeURIComponent(match[4]!), employeeId)
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('X-Skill-Name', file.name)
      res.setHeader('X-Skill-Sha256', file.sha256)
      await serveFile(req, res, file.root, file.segments, { type: file.type, expectedSize: file.size, etag: `"${file.sha256}"`, attachment: file.fileName })
      return true
    } catch (error) {
      if (!(error instanceof GuideError)) throw error
      if (!res.headersSent) send(req, res, error.status, { error: error.code })
      else res.destroy()
      return true
    }
  }
}
