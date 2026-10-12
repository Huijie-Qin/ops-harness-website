import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AdminContext } from './admin-files.js'
import { GuideError } from './guide-store.js'
import type { VideoStore } from './videos-store.js'

export async function handleVideoAdmin(store: VideoStore, req: IncomingMessage, res: ServerResponse, url: URL, { json, method, body }: AdminContext) {
  if (url.pathname === '/api/admin/videos') {
    method(req, ['GET', 'POST'])
    if (req.method === 'GET') json(res, await store.list())
    else { const data = await body(req); json(res, await store.create(data.entry, data.revision)) }
    return true
  }
  if (!url.pathname.startsWith('/api/admin/videos/')) return false
  const match = /^\/api\/admin\/videos\/([^/]+)(?:\/(file|preview))?$/.exec(url.pathname)
  if (!match) throw new GuideError('VIDEO_NOT_FOUND', 404)
  const id = decodeURIComponent(match[1]!)
  if (match[2] === 'preview') { method(req, ['GET', 'HEAD']); await store.preview(id, req, res) }
  else if (match[2] === 'file') {
    method(req, ['POST'])
    json(res, await store.upload(id, url.searchParams.get('name'), req, req.headers['x-revision'], req.headers['x-video-duration']))
  } else {
    method(req, ['PUT', 'DELETE']); const data = await body(req)
    json(res, req.method === 'PUT' ? await store.update(id, data.entry, data.revision) : await store.remove(id, data.revision))
  }
  return true
}

export function createVideoHandler(store: VideoStore) {
  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    if (url.pathname !== '/api/videos' && !url.pathname.startsWith('/videos/')) return false
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new GuideError('METHOD_NOT_ALLOWED', 405)
      if (url.pathname === '/api/videos') {
        const data = await store.published()
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(req.method === 'HEAD' ? undefined : JSON.stringify(data))
      } else {
        const match = /^\/videos\/([a-f0-9]{64}\.mp4)$/.exec(url.pathname)
        if (!match) throw new GuideError('VIDEO_NOT_FOUND', 404)
        await store.servePublished(match[1]!, req, res)
      }
    } catch (error) {
      if (res.headersSent) { res.destroy(); return true }
      const known = error instanceof GuideError
      res.writeHead(known ? error.status : 503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ error: known ? error.code : 'CONTENT_UNAVAILABLE' }))
    }
    return true
  }
}
