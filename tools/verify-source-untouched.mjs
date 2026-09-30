#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkPinStage } from './cairn-files.mjs'

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const pin = JSON.parse(readFileSync(join(repoRoot, 'cairn-pin.json'), 'utf8'))
const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
const packageLock = JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8'))
const installedRoot = join(repoRoot, 'node_modules/cairn-memory')
const CAIRN_IMPORT_FILE = 'src/adapters/cairn/cairnCoreAdapter.ts'
const SQL_READER_FILE = 'src/adapters/ui/cairnReader.ts'
// why: only cairnReader.ts may query Cairn database files; the two other files are older exceptions pinned by the content checks in sqlProblems
const SQL_ALLOWED_FILES = [SQL_READER_FILE, 'src/adapters/storage/upgradeBackup.ts', 'src/backend/diagnose.ts']
const SQL_MARKER = /node:sqlite|\bDatabaseSync\b|better-sqlite3|['"]sqlite3['"]|sql\.js/
const SQL_WRITE_WORDS = /\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|VACUUM|ATTACH|DETACH|REINDEX|ANALYZE)\b/
const srcIndex = process.argv.indexOf('--src')
const srcRoot = srcIndex === -1 ? join(repoRoot, 'src') : resolve(process.argv[srcIndex + 1] ?? '')

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

function sourceFiles(root) {
  const found = []
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.name.endsWith('.ts')) found.push({ name: relative(dirname(root), path).replaceAll('\\', '/'), text: readFileSync(path, 'utf8') })
    }
  }
  visit(root)
  return found
}

function sourceImports(files) {
  return files.filter(({ text }) => /(?:from\s+|import\s*\()(['"])cairn-memory\//.test(text)).map(({ name }) => name)
}

function sqlProblems(files) {
  const problems = []
  for (const { name, text } of files) {
    if (SQL_MARKER.test(text) && !SQL_ALLOWED_FILES.includes(name)) problems.push(`SQL outside cairnReader.ts: ${name}`)
  }
  const reader = files.find(({ name }) => name === SQL_READER_FILE)
  if (reader === undefined) return [...problems, `${SQL_READER_FILE} is missing`]
  if (!/PRAGMA query_only = ON/.test(reader.text)) problems.push('cairnReader.ts does not set PRAGMA query_only = ON')
  if (/readOnly\s*:/.test(reader.text)) problems.push('cairnReader.ts opens with readOnly, which cannot recover a hot journal')
  if (SQL_WRITE_WORDS.test(reader.text)) problems.push('cairnReader.ts contains a write statement keyword')
  for (const match of reader.text.matchAll(/PRAGMA\s+(\w+)\s*=/g)) {
    if (match[1] !== 'query_only' && match[1] !== 'trusted_schema') problems.push(`cairnReader.ts assigns PRAGMA ${match[1]}`)
  }
  const diagnose = files.find(({ name }) => name === 'src/backend/diagnose.ts')
  if (diagnose !== undefined) {
    for (const match of diagnose.text.matchAll(/new DatabaseSync\(([^)]*)\)/g)) {
      if (match[1]?.trim() !== '":memory:"') problems.push('diagnose.ts opens something other than :memory:')
    }
  }
  return problems
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
const files = sourceFiles(srcRoot)
const imports = sourceImports(files)
if (imports.length !== 1 || imports[0] !== CAIRN_IMPORT_FILE) {
  throw new Error(`Unexpected Cairn imports: ${JSON.stringify(imports)}`)
}
const sql = sqlProblems(files)
if (sql.length > 0) throw new Error(`SQL boundary violated: ${sql.join('; ')}`)
console.log(JSON.stringify({ ok: true, commit: pin.commit, coreTree: actualTree, redactSha256: actualRedact, import: imports[0], sqlReader: SQL_READER_FILE }))
