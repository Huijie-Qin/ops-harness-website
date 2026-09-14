import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

export async function openContainedFile(root: string, segments: string[]) {
  let candidate = path.resolve(root)
  const rootInfo = await lstat(candidate)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Invalid file root')
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..' || /[/\\\0:]/.test(segment)) throw new Error('Invalid file path')
    candidate = path.join(candidate, segment)
    const info = await lstat(candidate)
    if (info.isSymbolicLink()) throw new Error('Symbolic links are not served')
  }
  const handle = await open(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error('Not a regular file')
    return { handle, info }
  } catch (error) { await handle.close(); throw error }
}

export function byteRange(header: string | undefined, size: number): { start: number; end: number } | undefined {
  if (!header) return undefined
  const match = /^bytes=(\d*)-(\d*)$/.exec(header)
  if (!match || (!match[1] && !match[2])) throw new Error('Invalid byte range')
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]))
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) throw new Error('Invalid byte range')
  return { start, end }
}

export async function serveFile(req: IncomingMessage, res: ServerResponse, root: string, segments: string[], options: { type: string; expectedSize?: number; etag?: string; attachment?: string }) {
  const { handle, info } = await openContainedFile(root, segments)
  let streamed = false
  try {
    if (options.expectedSize !== undefined && info.size !== options.expectedSize) throw new Error('Release file size changed')
    res.setHeader('Content-Type', options.type)
    res.setHeader('Accept-Ranges', 'bytes')
    if (options.etag) res.setHeader('ETag', options.etag)
    if (options.attachment) res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(options.attachment)}`)
    if (options.etag && req.headers['if-none-match'] === options.etag) { res.writeHead(304); res.end(); return }
    let range
    try { range = byteRange(req.headers.range, info.size) } catch {
      res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); res.end(); return
    }
    if (range) res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${info.size}`)
    res.setHeader('Content-Length', range ? range.end - range.start + 1 : info.size)
    res.writeHead(range ? 206 : 200)
    if (req.method === 'HEAD') { res.end(); return }
    const stream = handle.createReadStream(range ? { ...range, autoClose: true } : { autoClose: true })
    streamed = true
    res.on('close', () => stream.destroy())
    stream.on('error', () => res.destroy())
    stream.pipe(res)
  } finally { if (!streamed) await handle.close() }
}
