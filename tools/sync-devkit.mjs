import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEVKIT_BUILD_COMMAND,
  DEVKIT_BUILD_SCRIPT,
  DEVKIT_DIR,
  DEVKIT_FILE,
  DEVKIT_LOCK,
  DEVKIT_SOURCES,
  DEVKIT_TOOL,
  HASH_RULE,
  hashBytes,
  normalise,
} from './vendor-lock.mjs'

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

export function syncDevkit(coreRoot) {
  if (git(coreRoot, ['status', '--porcelain', '--', ...DEVKIT_SOURCES]) !== '') {
    throw new Error('the Core sources embedded in the devkit have uncommitted changes')
  }
  const coreCommit = git(coreRoot, ['rev-parse', 'HEAD'])
  if (!/^[0-9a-f]{40}$/.test(coreCommit)) throw new Error('could not read the Core commit')
  const scratch = mkdtempSync(join(tmpdir(), 'teamuq-devkit-sync-'))
  try {
    const built = join(scratch, DEVKIT_FILE)
    const output = execFileSync(process.execPath, [join(coreRoot, ...DEVKIT_BUILD_SCRIPT.split('/')), '--out', built], { cwd: coreRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    const report = JSON.parse(output)
    const text = normalise(readFileSync(built))
    const sha256 = hashBytes(text)
    if (report.sha256 !== sha256) throw new Error('the build report sha256 differs from the built file')
    mkdirSync(DEVKIT_DIR, { recursive: true })
    copyFileSync(built, join(DEVKIT_DIR, DEVKIT_FILE))
    const lock = {
      devkitLockVersion: 1,
      tool: DEVKIT_TOOL,
      file: DEVKIT_FILE,
      hashRule: HASH_RULE,
      sha256,
      bytes: text.length,
      source: { repo: 'teamuq-electron', coreCommit, coreVersion: report.coreVersion, buildCommand: DEVKIT_BUILD_COMMAND, sources: DEVKIT_SOURCES },
    }
    writeFileSync(join(DEVKIT_DIR, DEVKIT_LOCK), `${JSON.stringify(lock, null, 2)}\n`)
    return { coreCommit, coreVersion: report.coreVersion, sha256, bytes: text.length }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}
