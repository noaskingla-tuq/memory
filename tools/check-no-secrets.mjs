#!/usr/bin/env node
// Fails when the working tree contains private key material or key files, or when .gitignore stops excluding them.
import { readFileSync, readdirSync, lstatSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const SKIP_DIRS = new Set(['node_modules', '.git', 'out', 'dist'])
const REQUIRED_IGNORES = ['dist/', 'out/', '*.pem', '*.key', 'keys/']
const PRIVATE_KEY_BLOCK = new RegExp(`-----BEGIN ${'(?:[A-Z0-9]+ )*'}PRIVATE KEY-----`)
const KEY_FILE_NAME = /\.(?:pem|key)$/i
const MAX_TEXT_BYTES = 2 * 1024 * 1024

const problems = []
let scanned = 0

function visit(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const rel = relative(repoRoot, path).replaceAll('\\', '/')
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      if (entry.name === 'keys') problems.push(`${rel}/: keys directory present`)
      visit(path)
      continue
    }
    if (KEY_FILE_NAME.test(entry.name)) problems.push(`${rel}: key file present`)
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.size > MAX_TEXT_BYTES) continue
    const text = readFileSync(path, 'utf8')
    scanned += 1
    if (PRIVATE_KEY_BLOCK.test(text)) problems.push(`${rel}: private key block`)
  }
}

visit(repoRoot)

const ignoreLines = new Set(
  readFileSync(join(repoRoot, '.gitignore'), 'utf8').split(/\r?\n/).map((line) => line.trim()),
)
for (const pattern of REQUIRED_IGNORES) {
  if (!ignoreLines.has(pattern)) problems.push(`.gitignore: missing ${pattern}`)
}

if (problems.length > 0) {
  console.error(JSON.stringify({ ok: false, problems }, null, 2))
  process.exit(1)
}
console.log(JSON.stringify({ ok: true, scanned }))
