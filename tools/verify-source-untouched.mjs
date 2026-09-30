#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkPinStage } from './cairn-files.mjs'

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const pin = JSON.parse(readFileSync(join(repoRoot, 'cairn-pin.json'), 'utf8'))
const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
const packageLock = JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8'))
const installedRoot = join(repoRoot, 'node_modules/cairn-memory')
const CAIRN_IMPORT_FILE = 'src/adapters/cairn/cairnCoreAdapter.ts'

function gitObject(type, content) {
  return createHash('sha1').update(Buffer.from(`${type} ${content.length}\0`)).update(content).digest()
}

function gitTree(directory) {
  const entries = readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => `${left.name}${left.isDirectory() ? '/' : ''}`.localeCompare(`${right.name}${right.isDirectory() ? '/' : ''}`, 'en'))
  const parts = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    const stat = lstatSync(path)
    let mode
    let hash
    if (entry.isDirectory()) {
      mode = '40000'
      hash = gitTree(path)
    } else if (stat.isSymbolicLink()) {
      mode = '120000'
      hash = gitObject('blob', Buffer.from(readlinkSync(path)))
    } else {
      mode = stat.mode & 0o111 ? '100755' : '100644'
      hash = gitObject('blob', readFileSync(path))
    }
    parts.push(Buffer.from(`${mode} ${entry.name}\0`), hash)
  }
  return gitObject('tree', Buffer.concat(parts))
}

function sourceImports(root) {
  const found = []
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.name.endsWith('.ts')) {
        const text = readFileSync(path, 'utf8')
        if (/(?:from\s+|import\s*\()(['"])cairn-memory\//.test(text)) {
          found.push(relative(repoRoot, path).replaceAll('\\', '/'))
        }
      }
    }
  }
  visit(root)
  return found
}

const expectedDependency = `git+https://github.com/Cairn-ink/cairn-memory.git#${pin.commit}`
if (packageJson.dependencies['cairn-memory'] !== expectedDependency) throw new Error('Cairn package pin is not exact')
if (packageLock.packages[''].dependencies['cairn-memory'] !== expectedDependency) throw new Error('Cairn lock root pin differs')
if (!packageLock.packages['node_modules/cairn-memory'].resolved.endsWith(`#${pin.commit}`)) throw new Error('Cairn lock resolution differs')
if (!Array.isArray(pin.accepted) || !pin.accepted.includes(pin.commit)) throw new Error('Cairn pin commit is not in accepted[]')
const dataLayoutSource = readFileSync(join(repoRoot, 'src/adapters/storage/dataLayout.ts'), 'utf8')
if (!dataLayoutSource.includes(`CAIRN_COMMIT = "${pin.commit}"`)) throw new Error('dataLayout.ts CAIRN_COMMIT differs from the pin')
for (const accepted of pin.accepted) {
  for (const file of ['memory.sqlite', 'identity.json', 'fixture.json']) {
    if (!existsSync(join(repoRoot, 'test/fixtures/legacy-db', accepted, file))) throw new Error(`accepted commit ${accepted} has no legacy fixture file ${file}`)
  }
}
const redactFile = join(installedRoot, 'plugins/cairn-memory/lib/redact.mjs')
const actualRedact = createHash('sha256').update(readFileSync(redactFile)).digest('hex')
if (actualRedact !== pin.redactSha256) throw new Error(`Cairn redact.mjs sha256 mismatch: ${actualRedact}`)
const actualTree = gitTree(join(installedRoot, 'core')).toString('hex')
if (actualTree !== pin.coreTree) throw new Error(`Cairn core tree mismatch: ${actualTree}`)
const stageProblems = checkPinStage(pin, installedRoot)
if (stageProblems.length > 0) throw new Error(`Cairn stage record differs: ${stageProblems.join('; ')}`)
const imports = sourceImports(join(repoRoot, 'src'))
if (imports.length !== 1 || imports[0] !== CAIRN_IMPORT_FILE) {
  throw new Error(`Unexpected Cairn imports: ${JSON.stringify(imports)}`)
}
console.log(JSON.stringify({ ok: true, commit: pin.commit, coreTree: actualTree, redactSha256: actualRedact, import: imports[0] }))
