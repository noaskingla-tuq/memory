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
export const METHODS = ['memory.remember@1', 'memory.inspect@1', 'diagnose', 'memory.profile.sync@1']
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

export const DEVKIT_DIR = join(REPO_ROOT, 'vendor', 'teamuq-devkit')
export const DEVKIT_FILE = 'tuq-plugin-tool.mjs'
export const DEVKIT_LOCK = 'devkit.lock.json'
export const DEVKIT_TOOL = 'tuq-plugin-tool'
export const DEVKIT_BUILD_SCRIPT = '.teamuq/scripts/plugin-tools/build-devkit.mjs'
export const DEVKIT_BUILD_COMMAND = 'npm run build:plugin-devkit -- --out <repo>/vendor/teamuq-devkit/tuq-plugin-tool.mjs'
// why: the bundle embeds these sources, so a dirty copy of any of them would make the recorded Core commit a lie
export const DEVKIT_SOURCES = [
  '.teamuq/scripts/plugin-tools',
  'packages/plugin-sdk',
  'packages/platform/plugin-artifact',
  'package.json',
  'tsconfig.node.json',
]
