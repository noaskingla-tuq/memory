import { createHash } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
export const VENDOR_DIR = join(REPO_ROOT, 'vendor', 'teamuq-contract')
export const VENDOR_LOCK = 'vendor.lock.json'
export const CORE_LOCK = 'lock.json'
export const GENERATED_TS = join(REPO_ROOT, 'src', 'backend', 'vendoredContractLock.ts')
export const CORE_CONTRACT_DIR = 'packages/features/agent-memory/contract/v1'
export const PLUGIN_ID = 'teamuq.memory'
export const METHODS = ['memory.remember@1', 'memory.inspect@1', 'diagnose']
export const HASH_RULE = 'sha256 hex of file bytes with CRLF normalised to LF'

// why: tsc resolves an import of contract.mjs to contract.d.mts, so Core's contract.d.ts needs this one-line bridge
export const SHIM_FILE = 'contract.d.mts'
export const SHIM_TEXT = 'export * from "./contract.js";\n'
export const PLUGIN_OWNED = [SHIM_FILE]

export function normalise(bytes) {
  return Buffer.from(Buffer.from(bytes).toString('utf8').replace(/\r\n/gu, '\n'), 'utf8')
}

export function hashBytes(bytes) {
  return createHash('sha256').update(normalise(bytes)).digest('hex')
}

export function walkFiles(directory, prefix = '') {
  if (!existsSync(directory)) return []
  const found = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) found.push(...walkFiles(join(directory, entry.name), relative))
    else found.push(relative)
  }
  return found.sort()
}

export function generatedSource(lockSha256) {
  return [
    '// why: written by tools/sync-vendor.mjs; contract:verify compares it with the sha256 of vendor/teamuq-contract/lock.json',
    `export const CONTRACT_LOCK_SHA256 = "${lockSha256}";`,
    '',
  ].join('\n')
}
