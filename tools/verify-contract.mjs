#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CONTRACT_SOURCE_DIR,
  CORE_LOCK,
  GENERATED_TS,
  HASH_RULE,
  METHODS,
  PLUGIN_ID,
  PLUGIN_OWNED,
  SHIM_FILE,
  SHIM_TEXT,
  DEVKIT_DIR,
  DEVKIT_FILE,
  DEVKIT_LOCK,
  DEVKIT_TOOL,
  VENDOR_DIR,
  VENDOR_LOCK,
  generatedSource,
  hashBytes,
  normalise,
  REPO_ROOT,
  walkFiles,
} from './vendor-lock.mjs'

const problems = []
const check = (condition, message) => { if (!condition) problems.push(message) }
const readJson = (base, file) => {
  try { return JSON.parse(readFileSync(join(base, file), 'utf8')) }
  catch { problems.push(`${file}: missing or unreadable`); return undefined }
}

const sourceLock = readJson(CONTRACT_SOURCE_DIR, CORE_LOCK)
const vendorLock = readJson(VENDOR_DIR, VENDOR_LOCK)
const vendorContractLock = readJson(VENDOR_DIR, CORE_LOCK)
let sourceLockSha256 = ''

if (sourceLock !== undefined && vendorLock !== undefined && vendorContractLock !== undefined) {
  check(sourceLock.pluginId === PLUGIN_ID && sourceLock.methods?.join('|') === METHODS.join('|'), 'plugin-owned contract identity or methods differ')
  check(sourceLock.hashRule === HASH_RULE && sourceLock.contractVersion === 1, 'plugin-owned contract version or hash rule differs')
  const sourceFiles = walkFiles(CONTRACT_SOURCE_DIR).filter((file) => file !== CORE_LOCK)
  check(JSON.stringify(Object.keys(sourceLock.files ?? {}).sort()) === JSON.stringify(sourceFiles), 'plugin-owned contract source files differ from contract/v1/lock.json')
  for (const file of sourceFiles) check(sourceLock.files?.[file] === hashBytes(readFileSync(join(CONTRACT_SOURCE_DIR, ...file.split('/')))), `${file}: hash differs from contract/v1/lock.json`)

  const actual = {}
  for (const file of walkFiles(VENDOR_DIR)) if (file !== VENDOR_LOCK) actual[file] = hashBytes(readFileSync(join(VENDOR_DIR, ...file.split('/'))))
  const expectedVendorFiles = [...Object.keys(sourceLock.files ?? {}), CORE_LOCK, SHIM_FILE].sort()
  check(JSON.stringify(Object.keys(actual).sort()) === JSON.stringify(expectedVendorFiles), 'vendored contract files differ from canonical source plus generated bridge')
  for (const file of Object.keys(actual)) {
    const expectedHash = file === SHIM_FILE ? hashBytes(Buffer.from(SHIM_TEXT)) : file === CORE_LOCK ? hashBytes(readFileSync(join(CONTRACT_SOURCE_DIR, CORE_LOCK))) : sourceLock.files?.[file]
    check(actual[file] === expectedHash, `${file}: hash differs from contract/v1`)
  }
  sourceLockSha256 = hashBytes(readFileSync(join(CONTRACT_SOURCE_DIR, CORE_LOCK)))
  check(vendorLock.source?.repo === 'teamuq-plugin-memory' && vendorLock.source?.contractDir === 'contract/v1', 'vendor provenance is not plugin-owned')
  check(vendorLock.source?.sourceLockSha256 === sourceLockSha256, 'vendor sourceLockSha256 differs from contract/v1/lock.json')
  check(vendorLock.pluginId === PLUGIN_ID && vendorLock.contractVersion === sourceLock.contractVersion && vendorLock.hashRule === HASH_RULE, 'vendor identity or contract version differs')
  check(JSON.stringify(vendorLock.pluginOwnedFiles) === JSON.stringify(PLUGIN_OWNED), 'pluginOwnedFiles differs')
  check(JSON.stringify(vendorLock.files) === JSON.stringify(actual), 'vendor.lock.json file hashes differ')
  check(vendorContractLock.pluginId === sourceLock.pluginId && JSON.stringify(vendorContractLock.files) === JSON.stringify(sourceLock.files), 'generated contract lock differs from plugin-owned source lock')

  const generated = existsSync(GENERATED_TS) ? readFileSync(GENERATED_TS, 'utf8').replace(/\r\n/gu, '\n') : ''
  check(generated === generatedSource(sourceLockSha256), 'src/backend/vendoredContractLock.ts does not carry the source lock sha256')
}

const devkitLock = readJson(DEVKIT_DIR, DEVKIT_LOCK)
if (devkitLock !== undefined) {
  check(devkitLock.tool === DEVKIT_TOOL && devkitLock.file === DEVKIT_FILE, `${DEVKIT_LOCK}: tool or file name differs`)
  check(devkitLock.hashRule === HASH_RULE, `${DEVKIT_LOCK}: hashRule differs`)
  if (devkitLock.source?.repo === 'teamuq-plugin-devkit') {
    check(/^[0-9a-f]{64}$/u.test(devkitLock.source.metadataSha256 ?? ''), `${DEVKIT_LOCK}: developer kit metadata hash is missing`)
    check(devkitLock.source.kitVersion === devkitLock.source.coreVersion, `${DEVKIT_LOCK}: kit and Core versions differ`)
    check(JSON.stringify(devkitLock.files?.map((file) => file.path)) === JSON.stringify([DEVKIT_FILE, 'lib/tuq-capability-client.mjs', 'lib/tuq-capability-client.d.mts']), `${DEVKIT_LOCK}: portable kit file set differs`)
    for (const file of devkitLock.files ?? []) {
      if (![DEVKIT_FILE, 'lib/tuq-capability-client.mjs', 'lib/tuq-capability-client.d.mts'].includes(file.path)) continue
      const path = join(DEVKIT_DIR, file.path)
      check(existsSync(path) && hashBytes(readFileSync(path)) === file.sha256 && normalise(readFileSync(path)).length === file.bytes, `${DEVKIT_LOCK}: hash or size differs for ${file.path}`)
    }
  } else check(/^[0-9a-f]{40}$/u.test(devkitLock.source?.coreCommit ?? ''), `${DEVKIT_LOCK}: source.coreCommit is not a commit hash`)
  check(/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(devkitLock.source?.coreVersion ?? ''), `${DEVKIT_LOCK}: source.coreVersion is not a version`)
  const bytes = existsSync(join(DEVKIT_DIR, DEVKIT_FILE)) ? readFileSync(join(DEVKIT_DIR, DEVKIT_FILE)) : undefined
  if (bytes === undefined) problems.push(`${DEVKIT_FILE}: missing`)
  else {
    check(hashBytes(bytes) === devkitLock.sha256, `${DEVKIT_FILE}: sha256 differs from ${DEVKIT_LOCK}`)
    check(normalise(bytes).length === devkitLock.bytes, `${DEVKIT_FILE}: size differs from ${DEVKIT_LOCK}`)
  }
}

const sdkMetadata = readJson(join(REPO_ROOT, 'types'), 'tuq-plugin-sdk.version.json')
if (sdkMetadata !== undefined) {
  check(sdkMetadata.coreVersion === devkitLock?.source?.coreVersion, 'SDK types and author CLI versions differ')
  const sdkFile = join(REPO_ROOT, 'types', 'tuq-plugin-sdk.d.ts')
  check(existsSync(sdkFile) && hashBytes(readFileSync(sdkFile)) === sdkMetadata.sha256, 'SDK type hash differs from metadata')
}

if (problems.length > 0) {
  console.error(JSON.stringify({ ok: false, problems }, null, 2))
  process.exit(1)
}
console.log(JSON.stringify({ ok: true, source: 'contract/v1', sourceLockSha256, files: Object.keys(vendorLock.files).length, devkitSha256: devkitLock?.sha256 }))
