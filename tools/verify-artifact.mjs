#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { join, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CAIRN_ROOT, readPin, sha256Bytes } from './cairn-files.mjs'
import { assertDevkitLock, devkitJson, runDevkit } from './devkit.mjs'
import { REPO_ROOT, normalise } from './vendor-lock.mjs'
import { readZip } from './zip-read.mjs'

const GENERATED = ['integrity.json', 'signature.json']
const STATIC_IMPORT = /^[ \t]*(?:import|export)\s[^;'"`]*?\bfrom\s*(['"])([^'"]+)\1/gmu
const SIDE_EFFECT_IMPORT = /^[ \t]*import\s*(['"])([^'"]+)\1/gmu
const DYNAMIC_IMPORT = /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/gu
const URL_ASSET = /new URL\(\s*(['"])([^'"]+)\1\s*,\s*import\.meta\.url/gu
const PRIVATE_KEY_BLOCK = new RegExp(`-----BEGIN ${'(?:[A-Z0-9]+ )*'}PRIVATE KEY-----`, 'u')
// 1.6.3 is the first Core release with the whitelisted invokeBackend, the methodName regex that accepts '@' and the memory sink on invoke; older Cores accept the manifest but never call it.
const MIN_CORE_VERSION = '>=1.6.3'
const RESOURCE_RANGES = { memoryMB: [256, 512], bootTimeoutSec: [10, 30] }

function specifiersOf(text) {
  return [STATIC_IMPORT, SIDE_EFFECT_IMPORT, DYNAMIC_IMPORT].flatMap((pattern) => [...text.matchAll(pattern)].map((match) => match[2]))
}

export function verifyArtifact(file, { anchors = 'self', pubFile } = {}) {
  const checks = []
  const check = (name, ok, detail = '') => checks.push({ name, ok: ok === true, ...(detail === '' ? {} : { detail }) })
  const pin = readPin()
  const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))
  const archive = readFileSync(file)
  const entries = readZip(archive)
  const names = [...entries.keys()].sort()
  const text = (name) => (entries.has(name) ? entries.get(name).toString('utf8') : '')

  try {
    assertDevkitLock()
    check('devkit matches devkit.lock.json', true)
  } catch (error) {
    check('devkit matches devkit.lock.json', false, error.message)
  }
  const verifyArgs = ['verify', resolve(file), '--anchors', anchors, ...(anchors === 'self' ? ['--pub-file', resolve(pubFile ?? '')] : [])]
  let verified
  try {
    verified = devkitJson(runDevkit(verifyArgs), 'devkit verify')
    check(`devkit verify --anchors ${anchors} passes`, verified.id === 'teamuq.memory', `signer ${JSON.stringify(verified.signer)}`)
  } catch (error) {
    check(`devkit verify --anchors ${anchors} passes`, false, error.message)
  }

  const expected = ['backend.mjs', 'cairn-pin.json', 'manifest.json', ...GENERATED, ...pin.stage.files.map((entry) => `cairn/${entry.path}`)].sort()
  const unexpected = names.filter((name) => !expected.includes(name))
  const missing = expected.filter((name) => !names.includes(name))
  check('file set equals backend.mjs + cairn-pin.json + manifest + signature files + the pin-recorded Cairn files', unexpected.length === 0 && missing.length === 0, `unexpected: ${unexpected.join(', ') || 'none'}; missing: ${missing.join(', ') || 'none'}`)
  check(`artifact holds ${expected.length} files`, names.length === expected.length, `found ${names.length}`)
  check('no Cairn test or testing directory', !names.some((name) => /(^|\/)(?:test|testing)\//u.test(name)))

  const mismatched = []
  for (const entry of pin.stage.files) {
    const staged = entries.get(`cairn/${entry.path}`)
    const source = sha256Bytes(readFileSync(join(CAIRN_ROOT, ...entry.path.split('/'))))
    if (staged === undefined || sha256Bytes(staged) !== source || source !== entry.sha256) mismatched.push(entry.path)
  }
  check('every Cairn file hashes equal to node_modules and to the pin record', mismatched.length === 0, mismatched.join(', '))
  check('cairn/LICENSE is present', entries.has('cairn/LICENSE'))
  check('redact.mjs keeps its relative path and equals redactSha256', entries.has('cairn/plugins/cairn-memory/lib/redact.mjs') && sha256Bytes(entries.get('cairn/plugins/cairn-memory/lib/redact.mjs')) === pin.redactSha256)
  const pinBytes = entries.get('cairn-pin.json')
  check('cairn-pin.json sits next to backend.mjs and equals the repository pin', pinBytes !== undefined && sha256Bytes(pinBytes) === sha256Bytes(normalise(readFileSync(join(REPO_ROOT, 'cairn-pin.json')))))

  let listed = []
  try {
    listed = JSON.parse(text('integrity.json')).files
  } catch {
    listed = []
  }
  const integrityMismatch = names.filter((name) => !GENERATED.includes(name)).filter((name) => listed.find((entry) => entry.path === name)?.sha256 !== sha256Bytes(entries.get(name)))
  check('integrity.json lists every file with its actual sha256', listed.length === names.length - GENERATED.length && integrityMismatch.length === 0, integrityMismatch.join(', '))

  let manifest = {}
  try {
    manifest = JSON.parse(text('manifest.json'))
  } catch {
    manifest = {}
  }
  check('manifest identity is teamuq.memory / teamuq / full-trust', manifest.id === 'teamuq.memory' && manifest.publisher === 'teamuq' && manifest.trustTier === 'full-trust')
  check('manifest entry.backend is backend.mjs and the file exists', manifest.entry?.backend === 'backend.mjs' && entries.has('backend.mjs'))
  check('manifest has no permissions and keeps data on uninstall', Array.isArray(manifest.permissions) && manifest.permissions.length === 0 && manifest.data?.uninstall === 'keep')
  const resources = manifest.resources ?? {}
  check('manifest resources follow the S0 recommendation', resources.cpuThreads === 1 && resources.maxSessions === 2 && resources.idleUnloadSec === 180 && Object.entries(RESOURCE_RANGES).every(([field, [low, high]]) => resources[field] >= low && resources[field] <= high), JSON.stringify(resources))
  check(`manifest version equals package.json version ${packageJson.version}`, manifest.version === packageJson.version)
  check(`manifest pluginApi is set and minCoreVersion is ${MIN_CORE_VERSION}`, typeof manifest.pluginApi === 'string' && manifest.minCoreVersion === MIN_CORE_VERSION, `${manifest.pluginApi} ${manifest.minCoreVersion}`)

  const backend = text('backend.mjs')
  const backendSpecifiers = specifiersOf(backend)
  const relativeBackend = [...new Set(backendSpecifiers.filter((specifier) => specifier.startsWith('.')))]
  check('backend.mjs imports Cairn only as ./cairn/core/index.mjs', relativeBackend.length === 1 && relativeBackend[0] === './cairn/core/index.mjs' && !backendSpecifiers.some((specifier) => specifier.includes('cairn-memory')), relativeBackend.join(', '))
  check('backend.mjs has no bare package import (zod is inlined)', backendSpecifiers.every((specifier) => specifier.startsWith('.') || specifier.startsWith('node:')), backendSpecifiers.filter((specifier) => !specifier.startsWith('.') && !specifier.startsWith('node:')).join(', '))
  check('backend.mjs exports activate', /export\s*\{[^}]*\bactivate\b[^}]*\}|export\s+(?:async\s+)?function\s+activate\b/u.test(backend))

  const unresolved = []
  for (const name of names.filter((entry) => entry.endsWith('.mjs'))) {
    const own = text(name)
    const targets = [...specifiersOf(own).filter((specifier) => specifier.startsWith('.')), ...[...own.matchAll(URL_ASSET)].map((match) => match[2])]
    const bare = specifiersOf(own).filter((specifier) => !specifier.startsWith('.') && !specifier.startsWith('node:'))
    for (const target of targets) if (!entries.has(posix.normalize(posix.join(posix.dirname(name), target)))) unresolved.push(`${name} -> ${target}`)
    for (const specifier of bare) unresolved.push(`${name} -> ${specifier} (bare)`)
  }
  check('every relative import and asset URL of a staged .mjs resolves inside the artifact', unresolved.length === 0, unresolved.join('; '))

  let signature = {}
  try {
    signature = JSON.parse(text('signature.json'))
  } catch {
    signature = {}
  }
  check('signature.json is ed25519 with a non-dev keyId', signature.algorithm === 'ed25519' && typeof signature.keyId === 'string' && !signature.keyId.startsWith('dev-'), String(signature.keyId))
  check('no private key block in any file', !names.some((name) => PRIVATE_KEY_BLOCK.test(text(name))))

  return { ok: checks.every((entry) => entry.ok), file: resolve(file), size: archive.length, sha256: sha256Bytes(archive), fileCount: names.length, anchors, signer: verified?.signer, checks }
}

function argument(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2]
  const anchors = argument('--anchors') ?? 'self'
  const pubFile = argument('--pub-file')
  if (file === undefined || file.startsWith('--') || (anchors === 'self' && pubFile === undefined)) {
    console.error('usage: node tools/verify-artifact.mjs <file.tuqplugin> --pub-file <file.pub.json> [--anchors self]\n       node tools/verify-artifact.mjs <file.tuqplugin> --anchors core')
    process.exit(2)
  }
  try {
    const report = verifyArtifact(file, { anchors, pubFile })
    console.log(JSON.stringify(report, null, 2))
    process.exitCode = report.ok ? 0 : 1
  } catch (error) {
    console.error(JSON.stringify({ ok: false, problem: error instanceof Error ? error.message : String(error) }))
    process.exit(1)
  }
}
