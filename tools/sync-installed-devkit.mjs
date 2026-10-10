import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { DEVKIT_DIR, DEVKIT_FILE, DEVKIT_LOCK, DEVKIT_TOOL, HASH_RULE, hashBytes, normalise } from './vendor-lock.mjs'

export function syncInstalledDevkit(directory) {
  const root = resolve(directory)
  const metadataBytes = readFileSync(join(root, 'kit.version.json'))
  const metadata = JSON.parse(metadataBytes)
  if (metadata.schemaVersion !== 1 || metadata.coreVersion !== metadata.kitVersion || !Array.isArray(metadata.files)) throw new Error('unrecognized developer kit')
  const payloads = new Map()
  for (const entry of metadata.files) {
    const file = resolve(root, entry.path)
    const suffix = relative(root, file)
    if (isAbsolute(suffix) || suffix.startsWith('..') || lstatSync(file).isSymbolicLink()) throw new Error(`unsafe developer kit path: ${entry.path}`)
    const bytes = readFileSync(file)
    if (bytes.length !== entry.size || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error(`developer kit hash mismatch: ${entry.path}`)
    payloads.set(entry.path, bytes)
  }
  const tool = payloads.get(`bin/${DEVKIT_FILE}`)
  if (tool === undefined) throw new Error('developer kit has no author CLI')
  const files = [{ path: DEVKIT_FILE, bytes: tool }]
  for (const file of ['tuq-capability-client.mjs', 'tuq-capability-client.d.mts']) {
    const bytes = payloads.get(`lib/${file}`)
    if (bytes === undefined) throw new Error(`developer kit has no ${file}`)
    files.push({ path: `lib/${file}`, bytes })
  }
  mkdirSync(DEVKIT_DIR, { recursive: true })
  mkdirSync(join(DEVKIT_DIR, 'lib'), { recursive: true })
  for (const file of files) writeFileSync(join(DEVKIT_DIR, file.path), file.bytes)
  const lock = {
    devkitLockVersion: 1, tool: DEVKIT_TOOL, file: DEVKIT_FILE, hashRule: HASH_RULE,
    sha256: hashBytes(tool), bytes: normalise(tool).length,
    files: files.map((file) => ({ path: file.path, sha256: hashBytes(file.bytes), bytes: normalise(file.bytes).length })),
    source: { repo: 'teamuq-plugin-devkit', coreVersion: metadata.coreVersion, kitVersion: metadata.kitVersion, metadataSha256: createHash('sha256').update(metadataBytes).digest('hex') },
  }
  writeFileSync(join(DEVKIT_DIR, DEVKIT_LOCK), `${JSON.stringify(lock, null, 2)}\n`)
  return lock.source
}
