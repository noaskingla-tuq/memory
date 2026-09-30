#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
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
  DEVKIT_DIR,
  DEVKIT_FILE,
  DEVKIT_LOCK,
  DEVKIT_TOOL,
  VENDOR_DIR,
  VENDOR_LOCK,
  generatedSource,
  hashBytes,
  normalise,
  walkFiles,
} from './vendor-lock.mjs'

const problems = []
const check = (condition, message) => {
  if (!condition) problems.push(message)
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(join(VENDOR_DIR, file), 'utf8'))
  } catch {
    problems.push(`${file}: missing or unreadable`)
    return undefined
  }
}

const lock = readJson(CORE_LOCK)
const vendorLock = readJson(VENDOR_LOCK)
let lockSha256 = ''

if (lock !== undefined && vendorLock !== undefined) {
  check(lock.pluginId === PLUGIN_ID && vendorLock.pluginId === PLUGIN_ID, 'pluginId is not teamuq.memory')
  check(JSON.stringify(lock.methods) === JSON.stringify(METHODS), 'lock methods differ from the three served methods')
  check(lock.hashRule === HASH_RULE && vendorLock.hashRule === HASH_RULE, 'hashRule differs')
  check(lock.contractVersion === vendorLock.contractVersion, 'contractVersion differs between the two locks')

  const actual = {}
  for (const file of walkFiles(VENDOR_DIR)) {
    if (file !== VENDOR_LOCK) actual[file] = hashBytes(readFileSync(join(VENDOR_DIR, file)))
  }
  lockSha256 = actual[CORE_LOCK] ?? ''
  const actualNames = Object.keys(actual).sort()
  const lockedNames = Object.keys(vendorLock.files ?? {}).sort()
  check(JSON.stringify(actualNames) === JSON.stringify(lockedNames), `vendored file set differs from ${VENDOR_LOCK}`)
  for (const file of actualNames) check(vendorLock.files?.[file] === actual[file], `${file}: sha256 differs from ${VENDOR_LOCK}`)

  const contractNames = actualNames.filter((file) => file !== CORE_LOCK && !PLUGIN_OWNED.includes(file))
  check(JSON.stringify(contractNames) === JSON.stringify(Object.keys(lock.files).sort()), `vendored files differ from the files ${CORE_LOCK} lists`)
  for (const file of contractNames) check(lock.files[file] === actual[file], `${file}: sha256 differs from Core ${CORE_LOCK}`)

  check(vendorLock.coreLockSha256 === lockSha256, `coreLockSha256 differs from the sha256 of ${CORE_LOCK}`)
  check(/^[0-9a-f]{40}$/.test(vendorLock.source?.coreCommit ?? ''), 'source.coreCommit is not a commit hash')
  check(/^[0-9a-f]{40}$/.test(vendorLock.source?.contractCommit ?? ''), 'source.contractCommit is not a commit hash')
  check(vendorLock.source?.contractDir === CORE_CONTRACT_DIR, 'source.contractDir differs')
  check(JSON.stringify(vendorLock.pluginOwnedFiles) === JSON.stringify(PLUGIN_OWNED), 'pluginOwnedFiles differs')
  check(existsSync(join(VENDOR_DIR, SHIM_FILE)) && readFileSync(join(VENDOR_DIR, SHIM_FILE), 'utf8') === SHIM_TEXT, `${SHIM_FILE} is not the expected bridge`)

  const generated = existsSync(GENERATED_TS) ? readFileSync(GENERATED_TS, 'utf8').replace(/\r\n/gu, '\n') : ''
  check(generated === generatedSource(lockSha256), 'src/backend/vendoredContractLock.ts does not carry the lock sha256')

  const coreIndex = process.argv.indexOf('--core')
  if (coreIndex !== -1) {
    const coreRoot = resolve(process.argv[coreIndex + 1] ?? '')
    const coreLock = join(coreRoot, ...CORE_CONTRACT_DIR.split('/'), CORE_LOCK)
    check(existsSync(coreLock) && hashBytes(readFileSync(coreLock)) === lockSha256, 'vendored lock differs from the Core checkout')
    try {
      const known = execFileSync('git', ['rev-parse', '--verify', `${vendorLock.source.contractCommit}^{commit}`], { cwd: coreRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
      check(known === vendorLock.source.contractCommit, 'Core does not know source.contractCommit')
    } catch {
      problems.push('Core does not know source.contractCommit')
    }
  }
}

let devkitLock
try {
  devkitLock = JSON.parse(readFileSync(join(DEVKIT_DIR, DEVKIT_LOCK), 'utf8'))
} catch {
  problems.push(`${DEVKIT_LOCK}: missing or unreadable`)
}
if (devkitLock !== undefined) {
  check(devkitLock.tool === DEVKIT_TOOL && devkitLock.file === DEVKIT_FILE, `${DEVKIT_LOCK}: tool or file name differs`)
  check(devkitLock.hashRule === HASH_RULE, `${DEVKIT_LOCK}: hashRule differs`)
  check(/^[0-9a-f]{40}$/.test(devkitLock.source?.coreCommit ?? ''), `${DEVKIT_LOCK}: source.coreCommit is not a commit hash`)
  check(/^[0-9]+[.][0-9]+[.][0-9]+$/.test(devkitLock.source?.coreVersion ?? ''), `${DEVKIT_LOCK}: source.coreVersion is not a version`)
  const devkitPath = join(DEVKIT_DIR, DEVKIT_FILE)
  if (!existsSync(devkitPath)) problems.push(`${DEVKIT_FILE}: missing`)
  else {
    const bytes = readFileSync(devkitPath)
    check(hashBytes(bytes) === devkitLock.sha256, `${DEVKIT_FILE}: sha256 differs from ${DEVKIT_LOCK}`)
    check(normalise(bytes).length === devkitLock.bytes, `${DEVKIT_FILE}: size differs from ${DEVKIT_LOCK}`)
  }
}

if (problems.length > 0) {
  console.error(JSON.stringify({ ok: false, problems }, null, 2))
  process.exit(1)
}
console.log(JSON.stringify({ ok: true, coreLockSha256: lockSha256, coreCommit: vendorLock.source.coreCommit, contractCommit: vendorLock.source.contractCommit, files: Object.keys(vendorLock.files).length, devkitSha256: devkitLock?.sha256 }))
