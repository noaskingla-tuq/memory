import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from './vendor-lock.mjs'

export const CAIRN_ROOT = join(REPO_ROOT, 'node_modules', 'cairn-memory')
export const PIN_FILE = join(REPO_ROOT, 'cairn-pin.json')
// why: nothing outside these two directories imports them at runtime; verify-artifact re-checks every relative import of the staged files
export const EXCLUDED_DIRS = ['core/test', 'core/testing']
export const EXTRA_FILES = ['plugins/cairn-memory/lib/redact.mjs', 'LICENSE']
export const REDACT_FILE = 'plugins/cairn-memory/lib/redact.mjs'

export function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

export function readPin() {
  return JSON.parse(readFileSync(PIN_FILE, 'utf8'))
}

function walk(directory, prefix, found) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relative = `${prefix}/${entry.name}`
    if (EXCLUDED_DIRS.includes(relative)) continue
    if (entry.isDirectory()) walk(join(directory, entry.name), relative, found)
    else if (entry.isFile()) found.push(relative)
    else throw new Error(`${relative} is neither a file nor a directory`)
  }
}

export function listCairnSourceFiles(root = CAIRN_ROOT) {
  const found = []
  walk(join(root, 'core'), 'core', found)
  for (const extra of EXTRA_FILES) {
    const stat = existsSync(join(root, extra)) ? lstatSync(join(root, extra)) : null
    if (stat === null || !stat.isFile()) throw new Error(`Cairn source has no ${extra}`)
    found.push(extra)
  }
  return found.sort()
}

export function computeStageRecord(root = CAIRN_ROOT) {
  return listCairnSourceFiles(root).map((path) => ({ path, sha256: sha256Bytes(readFileSync(join(root, ...path.split('/')))) }))
}

export function checkPinStage(pin, root = CAIRN_ROOT) {
  const problems = []
  const stage = pin.stage
  if (typeof stage !== 'object' || stage === null || !Array.isArray(stage.files) || !Array.isArray(stage.excluded)) return ['cairn-pin.json has no stage record (run node tools/stage-cairn.mjs --record)']
  if (JSON.stringify(stage.excluded) !== JSON.stringify(EXCLUDED_DIRS)) problems.push('stage.excluded differs from the directories the tools exclude')
  let actual
  try {
    actual = computeStageRecord(root)
  } catch (error) {
    return [...problems, error instanceof Error ? error.message : String(error)]
  }
  const recorded = new Map(stage.files.map((entry) => [entry.path, entry.sha256]))
  if (recorded.size !== stage.files.length) problems.push('stage.files lists a path twice')
  const actualPaths = actual.map((entry) => entry.path)
  const recordedPaths = [...recorded.keys()].sort()
  if (JSON.stringify(actualPaths) !== JSON.stringify(recordedPaths)) {
    const extra = actualPaths.filter((path) => !recorded.has(path))
    const missing = recordedPaths.filter((path) => !actualPaths.includes(path))
    problems.push(`stage file set differs from the installed Cairn (unlisted: ${extra.join(', ') || 'none'}; missing: ${missing.join(', ') || 'none'})`)
  }
  for (const entry of actual) {
    if (recorded.has(entry.path) && recorded.get(entry.path) !== entry.sha256) problems.push(`${entry.path}: sha256 differs from the pin record`)
  }
  if (recorded.get(REDACT_FILE) !== pin.redactSha256) problems.push('stage record of redact.mjs differs from redactSha256')
  return problems
}
