import { crc32, deflateRawSync } from 'node:zlib'

/** 1980-01-01 00:00 in MS-DOS form: one fixed time, so the same Skill always packs to the same bytes. */
const DOS_DATE = 0x21
const DOS_TIME = 0
/** General purpose flag: names are UTF-8. */
const UTF8_NAMES = 0x0800

/**
 * One repaired Skill folder as the ZIP this website stores and every client downloads: the files at the
 * archive root, UTF-8 names, sizes and CRC in the local headers (no data descriptor), stored or deflate,
 * no ZIP64, no extra fields. That is exactly what `readArchive` here and the product's cloud install read.
 * Deterministic: `SKILL.md` first, the rest in code-unit order, one fixed timestamp.
 */
export function writeSkillZip(files: ReadonlyMap<string, Uint8Array>): Buffer {
  const names = [...files.keys()].sort((left, right) => left === 'SKILL.md' ? -1 : right === 'SKILL.md' ? 1 : left < right ? -1 : left > right ? 1 : 0)
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const path of names) {
    const data = Buffer.from(files.get(path)!)
    const name = Buffer.from(path, 'utf8')
    const deflated = data.length > 0 ? deflateRawSync(data, { level: 6 }) : data
    const method = deflated.length < data.length ? 8 : 0
    const body = method === 8 ? deflated : data
    const crc = crc32(data) >>> 0
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(UTF8_NAMES, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, body)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(UTF8_NAMES, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(DOS_TIME, 12)
    central.writeUInt16LE(DOS_DATE, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += 30 + name.length + body.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(names.length, 8)
  end.writeUInt16LE(names.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}
