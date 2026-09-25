import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, rename, unlink } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { MAX_ARTIFACT_BYTES, RunIdSchema, type ArtifactInfo } from '@dsh-ops/cloud-task-contract'
import { safeDirectory } from '../admin-files.js'
import { serveFile } from '../files.js'
import { CloudError } from './errors.js'

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
const fileName = (runId: string) => `${RunIdSchema.parse(runId)}.zip`

/** Run result archives on local disk: `<directory>/artifacts/<runId>.zip`, streamed in with a sha256 check. */
export class ArtifactStore {
  private uploads = 0
  constructor(readonly directory: string, private maxConcurrent = 4) {}
  async receive(req: IncomingMessage, runId: string, expectedSha256: string, maxBytes = MAX_ARTIFACT_BYTES): Promise<{ size: number; sha256: string }> {
    // The contract allows either media type for the ZIP upload; executors send application/zip.
    const mediaType = req.headers['content-type']?.split(';')[0]?.trim()
    if (mediaType !== 'application/octet-stream' && mediaType !== 'application/zip') throw new CloudError('INVALID_REQUEST', 415, 'application/zip or application/octet-stream required')
    if (Number(req.headers['content-length'] ?? 0) > maxBytes) throw new CloudError('ARTIFACT_TOO_LARGE', 413)
    if (this.uploads >= this.maxConcurrent) throw new CloudError('RATE_LIMITED', 429, 'too many uploads in progress')
    this.uploads++
    await safeDirectory(this.directory)
    const temp = path.join(this.directory, `.${randomUUID()}.upload`)
    const final = path.join(this.directory, fileName(runId))
    const hash = createHash('sha256')
    let handle, size = 0, complete = false
    const deadline = setTimeout(() => req.destroy(), 30 * 60_000)
    const idle = () => { req.destroy() }
    req.setTimeout(60_000, idle)
    try {
      handle = await open(temp, 'wx', 0o600)
      for await (const bytes of req) {
        const chunk = Buffer.from(bytes)
        size += chunk.length
        if (size > maxBytes) throw new CloudError('ARTIFACT_TOO_LARGE', 413)
        hash.update(chunk)
        await handle.writeFile(chunk)
      }
      if (!size) throw new CloudError('INVALID_REQUEST', 400, 'empty upload')
      await handle.sync()
      await handle.close(); handle = undefined
      const sha256 = hash.digest('hex')
      if (sha256 !== expectedSha256) throw new CloudError('ARTIFACT_MISMATCH', 400, 'sha256 does not match x-artifact-sha256')
      await rename(temp, final)
      complete = true
      return { size, sha256 }
    } finally {
      clearTimeout(deadline); req.setTimeout(0); req.off('timeout', idle); this.uploads--
      await handle?.close()
      if (!complete) await unlink(temp).catch(() => {})
    }
  }
  async serve(req: IncomingMessage, res: ServerResponse, runId: string, info: ArtifactInfo) {
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('X-Artifact-Sha256', info.sha256)
    res.setHeader('X-Artifact-File-Count', String(info.fileCount))
    try {
      await serveFile(req, res, this.directory, [fileName(runId)], { type: 'application/zip', expectedSize: info.size, etag: `"${info.sha256}"`, attachment: fileName(runId) })
    } catch (error) {
      if (missing(error)) throw new CloudError('NOT_FOUND', 404, 'artifact file is gone')
      throw error
    }
  }
  async remove(runId: string) { await unlink(path.join(this.directory, fileName(runId))).catch(error => { if (!missing(error)) throw error }) }
  async initialize() { await mkdir(this.directory, { recursive: true, mode: 0o700 }); await safeDirectory(this.directory) }
}
