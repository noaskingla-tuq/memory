import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, relative, resolve, isAbsolute } from 'node:path'
import { DEVKIT_DIR, DEVKIT_FILE, DEVKIT_LOCK, REPO_ROOT, hashBytes } from './vendor-lock.mjs'

export const PASSPHRASE_ENV_FOR_TESTS = 'TEAMUQ_KEY_PASSPHRASE_FOR_TESTS'
const DEVKIT_PATH = join(DEVKIT_DIR, DEVKIT_FILE)

export function assertDevkitLock() {
  const lock = JSON.parse(readFileSync(join(DEVKIT_DIR, DEVKIT_LOCK), 'utf8'))
  if (hashBytes(readFileSync(DEVKIT_PATH)) !== lock.sha256) throw new Error(`${DEVKIT_FILE} differs from ${DEVKIT_LOCK}; run npm run devkit:sync -- --kit <public-devkit>`)
  if (lock.source?.repo === 'teamuq-plugin-devkit') {
    const expected = [DEVKIT_FILE, 'lib/tuq-capability-client.mjs', 'lib/tuq-capability-client.d.mts']
    if (JSON.stringify(lock.files?.map((file) => file.path)) !== JSON.stringify(expected)) throw new Error('portable devkit file set differs from its lock')
    for (const file of lock.files) {
      const bytes = readFileSync(join(DEVKIT_DIR, file.path))
      if (hashBytes(bytes) !== file.sha256) throw new Error(`${file.path} differs from ${DEVKIT_LOCK}`)
    }
  }
  return lock
}

function nearestExisting(target) {
  let current = resolve(target)
  const tail = []
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) break
    tail.unshift(current.slice(parent.length + 1))
    current = parent
  }
  return join(realpathSync(current), ...tail)
}

function isInside(parent, child) {
  const path = relative(parent, child)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

export function assertKeyOutsideRepo(keyFile) {
  const resolved = nearestExisting(keyFile)
  if (isInside(realpathSync(REPO_ROOT), resolved)) throw new Error(`the key path ${keyFile} is inside this repository; keep signing keys outside it`)
  let current = dirname(resolved)
  for (;;) {
    if (existsSync(join(current, '.git'))) throw new Error(`the key path ${keyFile} is inside the git work tree ${current}; keep signing keys outside any repository`)
    const parent = dirname(current)
    if (parent === current) return
    current = parent
  }
}

// why: the passphrase-from-environment path exists only for throwaway keys; a real key must always be typed at the prompt
export function runDevkit(args, { interactive = false, passphraseForTests } = {}) {
  const env = { ...process.env }
  delete env[PASSPHRASE_ENV_FOR_TESTS]
  if (passphraseForTests !== undefined) env[PASSPHRASE_ENV_FOR_TESTS] = passphraseForTests
  const result = spawnSync(process.execPath, [DEVKIT_PATH, ...args], {
    env,
    encoding: 'utf8',
    stdio: interactive ? ['inherit', 'pipe', 'inherit'] : ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    timeout: 120_000,
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error }
}

export function devkitJson(result, what) {
  if (result.status !== 0) throw new Error(`${what} failed (exit ${result.status}): ${(result.stderr || result.error?.message || '').trim().slice(0, 600)}`)
  try {
    return JSON.parse(result.stdout)
  } catch {
    throw new Error(`${what} printed no JSON`)
  }
}
