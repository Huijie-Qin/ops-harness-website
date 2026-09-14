import { createHash, randomUUID } from 'node:crypto'
import { mkdir, lstat, open, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { GuideError } from './guide-store.js'
import { openContainedFile } from './files.js'
export const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT'
export async function safeDirectory(dir: string) {
  await mkdir(dir, { recursive: true })
  const info = await lstat(dir)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new GuideError('UNSAFE_CONTENT_PATH', 503)
}
export async function atomicJson(dir: string, name: string, value: unknown) {
  await safeDirectory(dir)
  const temp = path.join(dir, `.${randomUUID()}.tmp`)
  const handle = await open(temp, 'wx', 0o600)
  try {
    try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync() } finally { await handle.close() }
    await rename(temp, path.join(dir, name))
  } finally { await unlink(temp).catch(e => { if (!missing(e)) throw e }) }
}
export async function readJson(root: string, segments: string[], max = 1024 * 1024): Promise<unknown> {
  const { handle, info } = await openContainedFile(root, segments)
  try { if (info.size > max) throw new GuideError('CONTENT_UNAVAILABLE', 503); return JSON.parse((await handle.readFile('utf8')).replace(/^\uFEFF/, '')) } finally { await handle.close() }
}
export async function withLock<T>(root: string, name: string, action: () => Promise<T>) {
  await safeDirectory(root)
  let lock
  try { lock = await open(path.join(root, name), 'wx', 0o600) }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new GuideError('CONTENT_BUSY', 409); throw e }
  try { return await action() } finally { await lock.close(); await unlink(path.join(root, name)) }
}
let uploads = 0
// Stream to a private temporary file; no installer is loaded into memory or executed.
export async function receiveFile(req: IncomingMessage, dir: string, max: number) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/octet-stream') throw new GuideError('BINARY_REQUIRED', 415)
  if (Number(req.headers['content-length'] ?? 0) > max) throw new GuideError('UPLOAD_TOO_LARGE', 413)
  if (uploads >= 2) throw new GuideError('UPLOAD_BUSY', 429)
  uploads++
  const temp = path.join(dir, `.${randomUUID()}.upload`)
  let handle, size = 0, complete = false
  const hash = createHash('sha512')
  const deadline = setTimeout(() => req.destroy(), 30 * 60 * 1000)
  const idle = () => { req.destroy() }
  req.setTimeout(60_000, idle)
  try {
    await safeDirectory(dir); handle = await open(temp, 'wx', 0o600)
    for await (const bytes of req) {
      const chunk = Buffer.from(bytes); size += chunk.length
      if (size > max) throw new GuideError('UPLOAD_TOO_LARGE', 413)
      hash.update(chunk); await handle.writeFile(chunk)
    }
    if (!size) throw new GuideError('EMPTY_UPLOAD')
    await handle.sync(); complete = true
    return { temp, size, sha512: hash.digest('base64') }
  } finally {
    clearTimeout(deadline); req.setTimeout(0); req.off('timeout', idle); uploads--; await handle?.close()
    if (!complete) await unlink(temp).catch(() => {})
  }
}
export type AdminContext = { json: (res: ServerResponse, data: unknown, status?: number) => void; method: (req: IncomingMessage, methods: string[]) => void; body: (req: IncomingMessage) => Promise<Record<string, unknown>> }
export type AdminHandler = (req: IncomingMessage, res: ServerResponse, url: URL, context: AdminContext) => Promise<boolean>
