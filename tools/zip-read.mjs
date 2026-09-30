import { crc32, inflateRawSync } from 'node:zlib'

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50

export function readZip(buffer) {
  let eocd = -1
  for (let at = buffer.length - 22; at >= Math.max(0, buffer.length - 22 - 65535); at -= 1) {
    if (buffer.readUInt32LE(at) === EOCD_SIGNATURE) {
      eocd = at
      break
    }
  }
  if (eocd === -1) throw new Error('not a zip archive: no end-of-central-directory record')
  const count = buffer.readUInt16LE(eocd + 10)
  let cursor = buffer.readUInt32LE(eocd + 16)
  const entries = new Map()
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) throw new Error('corrupt central directory')
    const method = buffer.readUInt16LE(cursor + 10)
    const expectedCrc = buffer.readUInt32LE(cursor + 16)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const size = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')
    cursor += 46 + nameLength + extraLength + commentLength
    if (name.endsWith('/')) continue
    if (entries.has(name)) throw new Error(`duplicate entry ${name}`)
    if (buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) throw new Error(`corrupt local header for ${name}`)
    const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28)
    const stored = buffer.subarray(dataStart, dataStart + compressedSize)
    if (method !== 0 && method !== 8) throw new Error(`unsupported compression method ${method} for ${name}`)
    const data = method === 0 ? Buffer.from(stored) : inflateRawSync(stored)
    if (data.length !== size || crc32(data) !== expectedCrc) throw new Error(`${name}: size or crc32 differs from the central directory`)
    entries.set(name, data)
  }
  return entries
}
