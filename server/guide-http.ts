import { createHash, randomBytes, timingSafeEqual, scrypt } from 'node:crypto'
import { promisify } from 'node:util'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { GuideStore, GuideError, encodeChapter } from './guide-store.js'
import type { AdminHandler } from './admin-files.js'
import { maxChapterBytes } from '../shared/guide.js'

const derive = promisify(scrypt)
const digest = (value: string) => createHash('sha256').update(value).digest()
const equal = (a: string, b: string) => timingSafeEqual(digest(a), digest(b))
const ttl = 8 * 60 * 60 * 1000
const idleTtl = 30 * 60 * 1000
type Session = { csrf: string; expires: number; lastSeen: number }
export async function createGuideHandler(store: GuideStore, options: { origin: string; password?: string | undefined; now?: () => number; admin?: AdminHandler }) {
  await store.initialize()
  const origin = new URL(options.origin).origin
  const host = new URL(origin).host
  const salt = randomBytes(32)
  const passwordHash = options.password ? await derive(options.password, salt, 64) as Buffer : undefined
  const sessions = new Map<string, Session>()
  const failures = new Map<string, { count: number; until: number }>()
  const now = options.now ?? Date.now
  let globalAttempts = { count: 0, until: 0 }, deriving = 0
  const cookieName = 'website_admin'
  const cookie = (value: string, age: number) => `${cookieName}=${value}; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=${age}${origin.startsWith('https:') ? '; Secure' : ''}`
  const json = (res: ServerResponse, data: unknown, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)) }
  const method = (req: IncomingMessage, allowed: string[]) => { if (!allowed.includes(req.method ?? '')) throw new GuideError('METHOD_NOT_ALLOWED', 405) }
  const checkOrigin = (req: IncomingMessage) => {
    if (req.headers.host !== host || req.headers.origin !== origin || req.headers['sec-fetch-site'] === 'cross-site') throw new GuideError('ORIGIN_REJECTED', 403)
  }
  const session = (req: IncomingMessage): Session | undefined => {
    const match = req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1)
    const key = match ? digest(match).toString('hex') : ''
    const value = sessions.get(key)
    if (!value || value.expires <= now() || value.lastSeen + idleTtl <= now()) { sessions.delete(key); return }
    value.lastSeen = now()
    return value
  }
  async function body(req: IncomingMessage, limit = maxChapterBytes + 8192, deadline = 15000): Promise<Record<string, unknown>> {
    if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new GuideError('JSON_REQUIRED', 415)
    if (Number(req.headers['content-length'] ?? 0) > limit) throw new GuideError('CHAPTER_TOO_LARGE', 413)
    if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') throw new GuideError('INVALID_REQUEST', 415)
    let size = 0
    const chunks: Buffer[] = []
    // Bound slow requests without a timer or listener surviving completion.
    const timeout = setTimeout(() => req.destroy(), deadline)
    try {
      for await (const chunk of req) {
        size += chunk.length
        if (size > limit) throw new GuideError('CHAPTER_TOO_LARGE', 413)
        chunks.push(Buffer.from(chunk))
      }
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
      return parsed
    } catch (error) { if (error instanceof GuideError) throw error; throw new GuideError('INVALID_REQUEST') }
    finally { clearTimeout(timeout) }
  }
  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    if (url.pathname !== '/api/guide' && !url.pathname.startsWith('/api/guide/') && !url.pathname.startsWith('/api/admin/')) return false
    try {
      if (url.pathname === '/api/guide') {
        method(req, ['GET'])
        const query = url.searchParams.get('q') ?? ''
        if (query.length > 120) throw new GuideError('QUERY_TOO_LONG')
        json(res, { chapters: await store.readerList(query) }); return true
      }
      if (url.pathname.startsWith('/api/guide/')) {
        method(req, ['GET'])
        const chapter = await store.get(decodeURIComponent(url.pathname.slice('/api/guide/'.length)))
        if (chapter.archived) throw new GuideError('CHAPTER_NOT_FOUND', 404)
        json(res, { chapter }); return true
      }
      for (const [key, value] of sessions) if (value.expires <= now() || value.lastSeen + idleTtl <= now()) sessions.delete(key)
      for (const [key, value] of failures) if (value.until <= now()) failures.delete(key)
      if (req.headers.host !== host || req.headers['sec-fetch-site'] === 'cross-site') throw new GuideError('ORIGIN_REJECTED',403)
      if (url.pathname === '/api/admin/session') {
        method(req, ['GET']); const current = session(req)
        json(res, { configured: Boolean(passwordHash), authenticated: Boolean(current), csrf: current?.csrf }); return true
      }
      if (url.pathname === '/api/admin/login') {
        method(req, ['POST']); checkOrigin(req)
        if (!passwordHash) throw new GuideError('ADMIN_NOT_CONFIGURED', 503)
        // Use the actual peer; untrusted forwarding headers cannot reset a limit.
        const key = req.socket.remoteAddress ?? 'unknown'
        if (globalAttempts.until <= now()) globalAttempts = { count: 0, until: now() + 300000 }
        const attempt = failures.get(key)
        if ((attempt?.count ?? 0) >= 5 || failures.size >= 1000 || globalAttempts.count >= 50) {
          res.setHeader('Retry-After', String(Math.max(1, Math.ceil(((attempt?.count ?? 0) >= 5 ? attempt!.until : globalAttempts.until) - now()) / 1000)))
          throw new GuideError('LOGIN_RATE_LIMIT', 429)
        }
        // Reserve attempts before reading the body or allocating password work.
        globalAttempts.count++
        failures.set(key, { count: (attempt?.count ?? 0) + 1, until: attempt?.until ?? now() + 300000 })
        if (deriving >= 2) { res.setHeader('Retry-After', '1'); throw new GuideError('LOGIN_BUSY', 429) }
        deriving++
        let candidate: Buffer
        try {
          const data = await body(req, 2048, 5000)
          if (typeof data.password !== 'string' || !data.password.length || data.password.length > 256 || Object.keys(data).some(k => k !== 'password')) throw new GuideError('INVALID_CREDENTIALS', 401)
          candidate = await derive(data.password, salt, 64) as Buffer
        } finally { deriving-- }
        if (!timingSafeEqual(candidate, passwordHash)) throw new GuideError('INVALID_CREDENTIALS', 401)
        failures.delete(key)
        const previous = session(req)
        for (const [key, value] of sessions) if (value === previous) sessions.delete(key)
        if (sessions.size >= 100) sessions.delete(sessions.keys().next().value!)
        const token = randomBytes(32).toString('base64url')
        const current = { csrf: randomBytes(32).toString('base64url'), expires: now() + ttl, lastSeen: now() }
        sessions.set(digest(token).toString('hex'), current)
        res.setHeader('Set-Cookie', cookie(token, ttl / 1000))
        json(res, { authenticated: true, csrf: current.csrf }); return true
      }
      const current = session(req)
      if (!current) throw new GuideError('AUTH_REQUIRED', 401)
      if (req.method !== 'GET') {
        checkOrigin(req)
        if (!equal(String(req.headers['x-csrf-token'] ?? ''), current.csrf)) throw new GuideError('CSRF_REJECTED', 403)
      }
      if (url.pathname === '/api/admin/logout') {
        method(req, ['POST'])
        for (const [key, value] of sessions) if (value === current) sessions.delete(key)
        res.setHeader('Set-Cookie', cookie('', 0)); json(res, { authenticated: false }); return true
      }
      if (url.pathname === '/api/admin/navigation') {
        method(req, ['GET', 'PUT'])
        if (req.method === 'GET') json(res, await store.navigation())
        else { const data = await body(req); json(res, await store.saveNavigation(data.navigation, data.revision)) }
        return true
      }
      if (await options.admin?.(req, res, url, { json, method, body })) return true
      if (url.pathname === '/api/admin/guides') {
        method(req, ['GET']); json(res, { chapters: await store.list(true) }); return true
      }
      const match = /^\/api\/admin\/guides\/([^/]+)(?:\/(history|restore|archive|export)(?:\/([^/]+))?)?$/.exec(url.pathname)
      if (!match) throw new GuideError('NOT_FOUND', 404)
      const id = decodeURIComponent(match[1]!), action = match[2], revision = match[3]
      if (!action) {
        method(req, ['GET','PUT'])
        if (req.method === 'GET') json(res, { chapter: await store.get(id) })
        else {
          const data = await body(req)
          if ((data.chapter as Record<string,unknown>)?.id !== id) throw new GuideError('INVALID_CHAPTER_ID')
          json(res, { chapter: await store.save(data.chapter, data.revision, data.groupId === undefined ? undefined : { groupId: data.groupId, navigationRevision: data.navigationRevision }) })
        }
      } else if (action === 'history') {
        method(req,['GET'])
        json(res, revision ? { chapter: await store.historical(id, revision) } : { history: await store.history(id) })
      } else if (action === 'export') {
        method(req,['GET'])
        const { revision: rev, updatedAt, source, ...draft } = await store.get(id)
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename="${draft.id}.md"` }); res.end(encodeChapter(draft))
      } else {
        method(req,['POST']); const data = await body(req)
        if (action === 'archive' && typeof data.archived !== 'boolean') throw new GuideError('INVALID_REQUEST')
        const chapter = action === 'restore' ? await store.restore(id, String(data.historyRevision), data.revision) : await store.archive(id, data.archived as boolean, data.revision)
        json(res, { chapter })
      }
    } catch (error) {
      const known = error instanceof GuideError
      json(res, { error: known ? error.code : 'CONTENT_UNAVAILABLE' }, known ? error.status : 503)
    }
    return true
  }
}
