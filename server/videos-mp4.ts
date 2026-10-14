import { openContainedFile } from './files.js'
import { GuideError } from './guide-store.js'
import path from 'node:path'

type Box = { type: string; start: number; end: number }
function invalid(): never { throw new GuideError('INVALID_MP4') }

/** Bounded ISO BMFF structural inspection; this does not decode or transcode uploaded media. */
export async function validateMp4(file: string): Promise<void> {
  const { handle, info } = await openContainedFile(path.dirname(file), [path.basename(file)])
  let count = 0
  async function read(offset: number, length: number) {
    const bytes = Buffer.alloc(length)
    const result = await handle.read(bytes, 0, length, offset)
    if (result.bytesRead !== length) invalid()
    return bytes
  }
  async function boxes(start: number, end: number): Promise<Box[]> {
    const result: Box[] = []
    while (start < end) {
      if (++count > 10000 || end - start < 8) invalid()
      const header = await read(start, Math.min(16, end - start))
      let size = header.readUInt32BE(0), headerSize = 8
      const type = header.toString('ascii', 4, 8)
      if (size === 1) {
        if (header.length < 16) invalid()
        const extended = header.readBigUInt64BE(8)
        if (extended > BigInt(Number.MAX_SAFE_INTEGER)) invalid()
        size = Number(extended); headerSize = 16
      } else if (!size) size = end - start
      if (size < headerSize || size > end - start) invalid()
      result.push({ type, start: start + headerSize, end: start + size })
      start += size
    }
    return result
  }
  async function children(box: Box, type: string) { return (await boxes(box.start, box.end)).filter(item => item.type === type) }
  try {
    const top = await boxes(0, info.size), ftyp = top[0]
    if (!ftyp || ftyp.type !== 'ftyp' || ftyp.end - ftyp.start < 8 || ftyp.end - ftyp.start > 4096 || (ftyp.end - ftyp.start) % 4) invalid()
    const brands = await read(ftyp.start, ftyp.end - ftyp.start)
    const supported = new Set(['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V ', 'dash'])
    const brandNames = [brands.toString('ascii', 0, 4)]
    for (let i = 8; i < brands.length; i += 4) brandNames.push(brands.toString('ascii', i, i + 4))
    if (!brandNames.some(brand => supported.has(brand))) invalid()
    const movies = top.filter(box => box.type === 'moov')
    if (movies.length !== 1 || !top.some(box => box.type === 'mdat' && box.end > box.start)) invalid()
    const movie = movies[0]!
    if (movie.end - movie.start > 16 * 1024 ** 2) invalid()
    const headers = await children(movie, 'mvhd')
    if (headers.length !== 1 || headers[0]!.end - headers[0]!.start < 20) invalid()
    let video = false
    for (const track of await children(movie, 'trak')) {
      for (const media of await children(track, 'mdia')) {
        const handlers = await children(media, 'hdlr')
        if (handlers.length !== 1 || handlers[0]!.end - handlers[0]!.start < 12) invalid()
        if ((await read(handlers[0]!.start + 8, 4)).toString('ascii') !== 'vide') continue
        for (const info of await children(media, 'minf')) {
          for (const table of await children(info, 'stbl')) {
            for (const description of await children(table, 'stsd')) {
              if (description.end - description.start < 16) invalid()
              const entries = await boxes(description.start + 8, description.end)
              const declared = (await read(description.start + 4, 4)).readUInt32BE()
              if (!declared || declared !== entries.length) invalid()
              // VisualSampleEntry has a fixed 78-byte payload before any codec-specific boxes.
              if (entries.some(entry => entry.end - entry.start < 78 || entry.type === 'encv')) invalid()
              video = true
            }
          }
        }
      }
    }
    if (!video) invalid()
  } finally { await handle.close() }
}
