#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { syncDevkit } from './sync-devkit.mjs'
import {
  CORE_CONTRACT_DIR,
  CORE_LOCK,
  GENERATED_TS,
  HASH_RULE,
  METHODS,
  PLUGIN_ID,
  PLUGIN_OWNED,
  SHIM_FILE,
  SHIM_TEXT,
  VENDOR_DIR,
  VENDOR_LOCK,
  generatedSource,
  hashBytes,
  normalise,
  walkFiles,
} from './vendor-lock.mjs'

const USAGE = 'usage: node tools/sync-vendor.mjs --core <TeamUQ repo path> [--only contract|devkit]'

function argument(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

function fail(message) {
  console.error(JSON.stringify({ ok: false, problem: message }))
  process.exit(1)
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function syncContract(coreRoot) {
  const sourceDir = join(coreRoot, ...CORE_CONTRACT_DIR.split('/'))
  if (!existsSync(join(sourceDir, CORE_LOCK))) fail(`no ${CORE_LOCK} under ${CORE_CONTRACT_DIR}`)

  const lock = JSON.parse(readFileSync(join(sourceDir, CORE_LOCK), 'utf8'))
  if (lock.pluginId !== PLUGIN_ID) fail('Core lock pluginId is not teamuq.memory')
  if (JSON.stringify(lock.methods) !== JSON.stringify(METHODS)) fail('Core lock methods differ from the four contract methods')
  if (lock.hashRule !== HASH_RULE) fail('Core lock hashRule changed')
  const listed = Object.keys(lock.files).sort()
  const present = walkFiles(sourceDir).filter((file) => file !== CORE_LOCK)
  if (JSON.stringify(listed) !== JSON.stringify(present)) fail('Core contract directory has files the lock does not list, or the reverse')
  for (const file of listed) {
    if (hashBytes(readFileSync(join(sourceDir, file))) !== lock.files[file]) fail(`Core file hash differs from its lock: ${file}`)
  }

  // why: a vendored copy must be reproducible from a commit, so uncommitted contract edits are refused
  if (git(coreRoot, ['status', '--porcelain', '--', CORE_CONTRACT_DIR]) !== '') fail('Core contract directory has uncommitted changes')
  const coreCommit = git(coreRoot, ['rev-parse', 'HEAD'])
  const contractCommit = git(coreRoot, ['log', '-1', '--format=%H', '--', CORE_CONTRACT_DIR])
  if (!/^[0-9a-f]{40}$/.test(coreCommit) || !/^[0-9a-f]{40}$/.test(contractCommit)) fail('could not read Core commits')

  rmSync(VENDOR_DIR, { recursive: true, force: true })
  for (const file of [...listed, CORE_LOCK]) {
    const target = join(VENDOR_DIR, ...file.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, normalise(readFileSync(join(sourceDir, file))))
  }
  writeFileSync(join(VENDOR_DIR, SHIM_FILE), SHIM_TEXT)

  const files = {}
  for (const file of walkFiles(VENDOR_DIR)) files[file] = hashBytes(readFileSync(join(VENDOR_DIR, file)))
  const coreLockSha256 = files[CORE_LOCK]
  const vendorLock = {
    vendorLockVersion: 1,
    pluginId: PLUGIN_ID,
    contractVersion: lock.contractVersion,
    hashRule: HASH_RULE,
    source: { repo: 'teamuq-electron', coreCommit, contractCommit, contractDir: CORE_CONTRACT_DIR },
    coreLockSha256,
    pluginOwnedFiles: PLUGIN_OWNED,
    files,
  }
  writeFileSync(join(VENDOR_DIR, VENDOR_LOCK), `${JSON.stringify(vendorLock, null, 2)}\n`)
  writeFileSync(GENERATED_TS, generatedSource(coreLockSha256))
  return { coreCommit, contractCommit, coreLockSha256, files: Object.keys(files).length }
}

const coreArgument = argument('--core')
const only = argument('--only')
if (coreArgument === undefined || (only !== undefined && only !== 'contract' && only !== 'devkit')) fail(USAGE)
const coreRoot = resolve(coreArgument)

const report = { ok: true }
if (only !== 'devkit') report.contract = syncContract(coreRoot)
if (only !== 'contract') {
  try {
    report.devkit = syncDevkit(coreRoot)
  } catch (error) {
    fail(`devkit: ${error instanceof Error ? error.message : String(error)}`)
  }
}
console.log(JSON.stringify(report))
