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
// why: the plugin needs both the memory sink from 1.6.3 and the agent avatar bridge added in 1.7.0
const MIN_CORE_VERSION = '>=1.7.0'
const RESOURCE_RANGES = { memoryMB: [256, 512], bootTimeoutSec: [10, 30] }
const PLUGIN_ID = 'teamuq.memory'
const UI_ENTRY = 'ui/index.html'
const UI_FILES = ['ui/index.html', 'ui/app.js', 'ui/app.css']
const EXPECTED_PERMISSIONS = ['agent:avatar-read', 'backend:invoke', 'ui:view']
const EXPECTED_BACKEND_METHODS = ['ui.agentStats', 'ui.forget', 'ui.get', 'ui.list', 'ui.overview', 'ui.search', 'ui.status']
const EXPECTED_MAX_SESSIONS = 4
// why: the view CSP is script-src 'self' with no eval and connect-src 'self'; each pattern below is either blocked at runtime or a way to reach outside the plugin origin
const SCRIPT_TAG = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/giu
const INLINE_HANDLER = /<[a-z][^>]*\son[a-z]+\s*=/iu
const JAVASCRIPT_URL = /javascript\s*:/iu
const FORBIDDEN_UI_PATTERNS = [
  ['eval', /\beval\s*\(/u],
  ['new Function', /\bnew\s+Function\b/u],
  ['http(s):// URL', /https?:\/\//iu],
  ['fetch(', /\bfetch\s*\(/u],
  ['WebSocket', /\bWebSocket\b/u],
]

function isPatchAbove(version, base) {
  const parse = (value) => /^(\d+)\.(\d+)\.(\d+)$/u.exec(String(value))?.slice(1).map(Number)
  const [next, current] = [parse(version), parse(base)]
  return next !== undefined && current !== undefined && next[0] === current[0] && next[1] === current[1] && next[2] > current[2]
}

export function scanUiFile(name, content) {
  const problems = []
  if (name.endsWith('.html')) {
    for (const match of content.matchAll(SCRIPT_TAG)) {
      const source = /\bsrc\s*=\s*(["'])([^"']*)\1/iu.exec(match[1])
      if (source === null || match[2].trim() !== '') problems.push(`inline script in ${name}`)
      else if (source[2] !== 'app.js') problems.push(`${name} loads a script other than app.js: ${source[2]}`)
    }
    if ((content.match(/<script\b/giu) ?? []).length !== [...content.matchAll(SCRIPT_TAG)].length) problems.push(`unterminated script tag in ${name}`)
    if (INLINE_HANDLER.test(content)) problems.push(`inline event handler attribute in ${name}`)
    if (JAVASCRIPT_URL.test(content)) problems.push(`javascript: URL in ${name}`)
    const links = [...content.matchAll(/<link\b[^>]*>/giu)].map((match) => /\bhref\s*=\s*(["'])([^"']*)\1/iu.exec(match[0])?.[2])
    if (links.some((href) => href !== 'app.css')) problems.push(`${name} links a stylesheet other than app.css`)
  }
  for (const [label, pattern] of FORBIDDEN_UI_PATTERNS) if (pattern.test(content)) problems.push(`${label} in ${name}`)
  return problems
}

function specifiersOf(text) {
  return [STATIC_IMPORT, SIDE_EFFECT_IMPORT, DYNAMIC_IMPORT].flatMap((pattern) => [...text.matchAll(pattern)].map((match) => match[2]))
}

export function verifyArtifact(file, { anchors = 'self', pubFile, dev = false } = {}) {
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
  const verifyArgs = ['verify', resolve(file), '--anchors', anchors, ...(anchors === 'self' ? ['--pub-file', resolve(pubFile ?? '')] : []), ...(dev ? ['--preplanted-id', PLUGIN_ID] : [])]
  const verifyName = `devkit verify --anchors ${anchors}${dev ? ' --preplanted-id' : ''} passes`
  let verified
  try {
    verified = devkitJson(runDevkit(verifyArgs), 'devkit verify')
    check(verifyName, verified.id === PLUGIN_ID && (verified.signer?.kind === 'dev') === dev, `signer ${JSON.stringify(verified.signer)}`)
  } catch (error) {
    check(verifyName, false, error.message)
  }

  const expected = ['backend.mjs', 'cairn-pin.json', 'manifest.json', ...UI_FILES, ...GENERATED, ...pin.stage.files.map((entry) => `cairn/${entry.path}`)].sort()
  const unexpected = names.filter((name) => !expected.includes(name))
  const missing = expected.filter((name) => !names.includes(name))
  check('file set equals backend.mjs + cairn-pin.json + manifest + ui/** + signature files + the pin-recorded Cairn files', unexpected.length === 0 && missing.length === 0, `unexpected: ${unexpected.join(', ') || 'none'}; missing: ${missing.join(', ') || 'none'}`)
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
  check('manifest is composed: entry.backend is backend.mjs and entry.ui is ui/index.html, both files exist', manifest.entry?.backend === 'backend.mjs' && manifest.entry?.ui === UI_ENTRY && entries.has('backend.mjs') && entries.has(UI_ENTRY), JSON.stringify(manifest.entry))
  const views = manifest.contributes?.views ?? []
  check('manifest declares exactly the memory view (title 記憶, tab and fullpage, default tab) on ui/index.html', views.length === 1 && views[0].id === 'memory' && views[0].title === '記憶' && views[0].entry === UI_ENTRY && views[0].defaultPresentation === 'tab' && JSON.stringify([...(views[0].presentations ?? [])].sort()) === JSON.stringify(['fullpage', 'tab']), JSON.stringify(views))
  check('manifest permissions are exactly ui:view, backend:invoke and agent:avatar-read and data is kept on uninstall', Array.isArray(manifest.permissions) && JSON.stringify([...manifest.permissions].sort()) === JSON.stringify(EXPECTED_PERMISSIONS) && manifest.data?.uninstall === 'keep', JSON.stringify(manifest.permissions))
  const methods = Array.isArray(manifest.backendMethods) ? manifest.backendMethods : []
  check('manifest backendMethods are exactly the seven ui.* methods', JSON.stringify([...methods].sort()) === JSON.stringify(EXPECTED_BACKEND_METHODS), JSON.stringify(methods))
  check('no memory.* method (nor diagnose) is exposed to the view through backendMethods', !methods.some((method) => /^(?:memory\.|diagnose$)/u.test(method)), methods.join(', '))
  check('manifest backendMethods do not list memory.profile.sync@1: Core pushes the name table through its own gate and the view never calls it', !methods.some((method) => String(method).includes('profile.sync')), methods.join(', '))
  const resources = manifest.resources ?? {}
  check('manifest resources follow the S0 recommendation', resources.cpuThreads === 1 && resources.maxSessions === EXPECTED_MAX_SESSIONS && resources.idleUnloadSec === 180 && Object.entries(RESOURCE_RANGES).every(([field, [low, high]]) => resources[field] >= low && resources[field] <= high), JSON.stringify(resources))
  check(dev ? `manifest version is a 1.0.x patch above package.json version ${packageJson.version} (dev-pack --bump-patch)` : `manifest version equals package.json version ${packageJson.version}`, dev ? isPatchAbove(manifest.version, packageJson.version) : manifest.version === packageJson.version, String(manifest.version))
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
  check(dev ? 'signature.json is ed25519 with a dev- keyId (development build)' : 'signature.json is ed25519 with a non-dev keyId', signature.algorithm === 'ed25519' && typeof signature.keyId === 'string' && signature.keyId.startsWith('dev-') === dev, String(signature.keyId))
  const uiProblems = UI_FILES.filter((name) => entries.has(name)).flatMap((name) => scanUiFile(name, text(name)))
  check('CSP safety: no inline script, event handler attribute, javascript: URL, eval, new Function, http(s):// URL, fetch( or WebSocket in ui/**, and index.html loads only app.js and app.css', uiProblems.length === 0, uiProblems.join('; '))
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
  const dev = process.argv.includes('--dev')
  if (file === undefined || file.startsWith('--') || (anchors === 'self' && pubFile === undefined) || (dev && anchors !== 'self')) {
    console.error('usage: node tools/verify-artifact.mjs <file.tuqplugin> --pub-file <file.pub.json> [--anchors self] [--dev]\n       node tools/verify-artifact.mjs <file.tuqplugin> --anchors core\n--dev checks a dev-pack build (development key, teamuq.memory preplanted id)')
    process.exit(2)
  }
  try {
    const report = verifyArtifact(file, { anchors, pubFile, dev })
    console.log(JSON.stringify(report, null, 2))
    process.exitCode = report.ok ? 0 : 1
  } catch (error) {
    console.error(JSON.stringify({ ok: false, problem: error instanceof Error ? error.message : String(error) }))
    process.exit(1)
  }
}
