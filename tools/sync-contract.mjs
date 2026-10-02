#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import {
  CONTRACT_SOURCE_DIR,
  CORE_LOCK,
  GENERATED_TS,
  HASH_RULE,
  METHODS,
  PLUGIN_ID,
  PLUGIN_OWNED,
  REPO_ROOT,
  SHIM_FILE,
  SHIM_TEXT,
  VENDOR_DIR,
  VENDOR_LOCK,
  generatedSource,
  hashBytes,
  normalise,
  walkFiles,
} from './vendor-lock.mjs'

function fail(message) {
  console.error(JSON.stringify({ ok: false, problem: message }))
  process.exit(1)
}

const sourceLockFile = join(CONTRACT_SOURCE_DIR, CORE_LOCK)
if (!existsSync(sourceLockFile)) fail('contract/v1/lock.json is missing')
const vendorPath = resolve(VENDOR_DIR)
if (!vendorPath.startsWith(`${REPO_ROOT}${sep}`)) fail('refusing to replace a vendor path outside this repository')
const lock = JSON.parse(readFileSync(sourceLockFile, 'utf8'))
const sourceFiles = walkFiles(CONTRACT_SOURCE_DIR).filter((file) => file !== CORE_LOCK)
if (process.argv.includes('--refresh-lock')) {
  lock.files = Object.fromEntries(sourceFiles.map((file) => [file, hashBytes(readFileSync(join(CONTRACT_SOURCE_DIR, ...file.split('/'))))]))
  writeFileSync(sourceLockFile, `${JSON.stringify(lock, null, 2)}\n`)
}
if (lock.pluginId !== PLUGIN_ID || JSON.stringify(lock.methods) !== JSON.stringify(METHODS) || lock.hashRule !== HASH_RULE) fail('plugin-owned contract lock identity or schema differs')
const listed = Object.keys(lock.files ?? {}).sort()
if (JSON.stringify(listed) !== JSON.stringify(sourceFiles)) fail('plugin-owned contract source files differ from contract/v1/lock.json')
for (const file of listed) if (hashBytes(readFileSync(join(CONTRACT_SOURCE_DIR, ...file.split('/')))) !== lock.files[file]) fail(`plugin-owned contract hash differs: ${file}`)

rmSync(VENDOR_DIR, { recursive: true, force: true })
for (const file of [...listed, CORE_LOCK]) {
  const target = join(VENDOR_DIR, ...file.split('/'))
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, normalise(readFileSync(join(CONTRACT_SOURCE_DIR, ...file.split('/')))))
}
writeFileSync(join(VENDOR_DIR, SHIM_FILE), SHIM_TEXT)

const files = {}
for (const file of walkFiles(VENDOR_DIR)) if (file !== VENDOR_LOCK) files[file] = hashBytes(readFileSync(join(VENDOR_DIR, ...file.split('/'))))
const sourceLockSha256 = hashBytes(readFileSync(sourceLockFile))
writeFileSync(join(VENDOR_DIR, VENDOR_LOCK), `${JSON.stringify({
  vendorLockVersion: 1,
  pluginId: PLUGIN_ID,
  contractVersion: lock.contractVersion,
  hashRule: HASH_RULE,
  source: { repo: 'teamuq-plugin-memory', contractDir: 'contract/v1', sourceLockSha256 },
  pluginOwnedFiles: PLUGIN_OWNED,
  files,
}, null, 2)}\n`)
writeFileSync(GENERATED_TS, generatedSource(sourceLockSha256))
console.log(JSON.stringify({ ok: true, source: 'contract/v1', sourceLockSha256, files: Object.keys(files).length }))
