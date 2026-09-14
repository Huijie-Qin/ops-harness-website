import { crc32 } from 'node:zlib'
import { createHash } from 'node:crypto'
import { readFile, rename, unlink, lstat } from 'node:fs/promises'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { maxImageBytes, type MediaImage } from '../shared/admin.js'
import { GuideError } from './guide-store.js'
import { atomicJson, missing, readJson, receiveFile, safeDirectory, withLock } from './admin-files.js'
import { openContainedFile, serveFile } from './files.js'

export function imageFormat(b: Buffer) {
  let ext = '', width = 0, height = 0
  if (b.length >= 45 && b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && b.toString('ascii',12,16) === 'IHDR' && b.toString('ascii',b.length-8,b.length-4) === 'IEND') {
    let sawData = false, end = 8
    while (end + 12 <= b.length) { const length = b.readUInt32BE(end); if (length > b.length - end - 12) throw new GuideError('INVALID_IMAGE'); const kind = b.toString('ascii', end+4, end+8); if (crc32(b.subarray(end+4,end+8+length)) !== b.readUInt32BE(end+8+length)) throw new GuideError('INVALID_IMAGE'); if (end === 8 && (kind !== 'IHDR' || length !== 13)) throw new GuideError('INVALID_IMAGE'); if (kind === 'IDAT') sawData = true; if (kind === 'IEND' && (length !== 0 || end+12 !== b.length)) throw new GuideError('INVALID_IMAGE'); end += length+12 }
    if (!sawData || end !== b.length) throw new GuideError('INVALID_IMAGE')
    ext = 'png'; width = b.readUInt32BE(16); height = b.readUInt32BE(20)
  } else if (b.length > 10 && b[0] === 255 && b[1] === 216 && b[b.length-2] === 255 && b[b.length-1] === 217) {
    ext = 'jpg'
    for (let i = 2; i + 9 < b.length;) {
      if (b[i++] !== 255) break
      while (b[i] === 255) i++
      const marker = b[i++]!
      if (marker === 218 || marker === 217) break
      if (marker === 1 || marker >= 208 && marker <= 215) continue
      if (i + 2 > b.length) break
      const length = b.readUInt16BE(i)
      if (length < 2 || i + length > b.length) break
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker) && length >= 8) { height = b.readUInt16BE(i+3); width = b.readUInt16BE(i+5); break }
      i += length
    }
  } else if (b.length >= 30 && b.toString('ascii',0,4) === 'RIFF' && b.toString('ascii',8,12) === 'WEBP' && b.readUInt32LE(4) + 8 === b.length) {
    ext = 'webp'
    const kind = b.toString('ascii',12,16)
    if (kind === 'VP8X') { width = b.readUIntLE(24,3)+1; height = b.readUIntLE(27,3)+1 }
    if (kind === 'VP8 ' && b.subarray(23,26).equals(Buffer.from([157,1,42]))) { width = b.readUInt16LE(26)&0x3fff; height = b.readUInt16LE(28)&0x3fff }
    if (kind === 'VP8L' && b[20] === 47) { const bits = b.readUInt32LE(21); width = (bits&0x3fff)+1; height = ((bits>>>14)&0x3fff)+1 }
  }
  if (!ext || !width || !height || width > 16000 || height > 16000 || width * height > 40_000_000) throw new GuideError('INVALID_IMAGE')
  return { ext, width, height }
}
export async function readMediaIndex(root: string): Promise<MediaImage[]> {
    try {
      const value = await readJson(root, ['index.json'], 4 * 1024 ** 2) as MediaImage[]
      if (!Array.isArray(value) || value.length > 4000 || value.some(v => !v || typeof v.name !== 'string' || v.name.length > 200 || !/^\/media\/[a-f0-9]{64}\.(png|jpg|webp)$/.test(v.url) || !Number.isSafeInteger(v.size) || v.size <= 0 || v.size > maxImageBytes || !Number.isSafeInteger(v.width) || !Number.isSafeInteger(v.height) || typeof v.createdAt !== 'string')) throw new GuideError('CONTENT_UNAVAILABLE', 503)
      if (new Set(value.map(v => v.url)).size !== value.length) throw new GuideError('CONTENT_UNAVAILABLE', 503)
      return value
    } catch (e) { if (missing(e)) return []; throw e }
}
export async function readMediaBytes(root: string, image: MediaImage) {
  const { handle, info } = await openContainedFile(root, [image.url.slice('/media/'.length)])
  try {
    if (info.size !== image.size || info.size > maxImageBytes) throw new GuideError('INVALID_IMAGE')
    const bytes = await handle.readFile(), format = imageFormat(bytes)
    if (image.url !== `/media/${createHash('sha256').update(bytes).digest('hex')}.${format.ext}` || format.width !== image.width || format.height !== image.height) throw new GuideError('INVALID_IMAGE')
    return bytes
  } finally { await handle.close() }
}
export class MediaStore {
  readonly root: string
  readonly seedRoot: string | undefined
  constructor(directory: string, seedDirectory?: string) { this.root = path.join(directory, 'media'); this.seedRoot = seedDirectory ? path.join(seedDirectory, 'media') : undefined }
  async onlineList() { await safeDirectory(this.root); return readMediaIndex(this.root) }
  async list(): Promise<MediaImage[]> {
    const online = await this.onlineList(), seeds = this.seedRoot ? await readMediaIndex(this.seedRoot) : []
    const images = [...online, ...seeds.filter(v => !online.some(item => item.url === v.url))]
    if (images.length > 4000) throw new GuideError('IMAGE_LIMIT', 409)
    return images
  }
  async resolveImage(image: MediaImage) {
    try { return { root: this.root, bytes: await readMediaBytes(this.root, image) } }
    catch (error) { if (!missing(error) || !this.seedRoot) throw error; return { root: this.seedRoot, bytes: await readMediaBytes(this.seedRoot, image) } }
  }
  async upload(req: IncomingMessage, name: string) {
    if (!name || name.length > 200 || /[/\\\x00-\x1f]/.test(name)) throw new GuideError('INVALID_IMAGE')
    const file = await receiveFile(req, this.root, maxImageBytes)
    try {
      const bytes = await readFile(file.temp), format = imageFormat(bytes)
      const filename = `${createHash('sha256').update(bytes).digest('hex')}.${format.ext}`
      return await withLock(this.root, '.media-lock', async () => {
        const images = await this.list(), existing = images.find(v => v.url === `/media/${filename}`)
        if (existing) return existing
        if (images.length >= 4000) throw new GuideError('IMAGE_LIMIT', 409)
        const result = { name, url: `/media/${filename}`, size: file.size, width: format.width, height: format.height, createdAt: new Date().toISOString() }
        try { const info = await lstat(path.join(this.root, filename)); if (!info.isFile() || info.isSymbolicLink() || info.size !== file.size) throw new GuideError('CONTENT_UNAVAILABLE', 503) }
        catch (e) { if (!missing(e)) throw e; await rename(file.temp, path.join(this.root, filename)) }
        await atomicJson(this.root, 'index.json', [result, ...images]); return result
      })
    } finally { await unlink(file.temp).catch(e => { if (!missing(e)) throw e }) }
  }
  async serve(req: IncomingMessage, res: ServerResponse, url: URL) {
    if (!url.pathname.startsWith('/media/')) return false
    if (!['GET','HEAD'].includes(req.method ?? '')) { res.writeHead(405); res.end(); return true }
    const match = /^\/media\/([a-f0-9]{64}\.(png|jpg|webp))$/.exec(url.pathname)
    if (!match) { res.writeHead(404); res.end(); return true }
    try {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
      const options = { type: `image/${match[2] === 'jpg' ? 'jpeg' : match[2]}`, etag: `"${match[1]}"` }
      try { await serveFile(req, res, this.root, [match[1]!], options) }
      catch (error) { if (!missing(error) || !this.seedRoot) throw error; await serveFile(req, res, this.seedRoot, [match[1]!], options) }
    } catch { res.removeHeader('Cache-Control'); res.writeHead(404); res.end() }
    return true
  }
}
