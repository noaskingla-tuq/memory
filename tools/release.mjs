#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertDevkitLock, assertKeyOutsideRepo, devkitJson, runDevkit } from './devkit.mjs'
import { REPO_ROOT } from './vendor-lock.mjs'

export const DEFAULT_STAGE = join(REPO_ROOT, 'dist', 'stage')
const KEY_SUFFIX = '.key.pem'

function defaultPubFile(keyFile) {
  return keyFile.endsWith(KEY_SUFFIX) ? `${keyFile.slice(0, -KEY_SUFFIX.length)}.pub.json` : `${keyFile}.pub.json`
}

export function release({ stageDir = DEFAULT_STAGE, keyFile, keyId, anchors = 'core', pubFile, outFile, interactive = false, passphraseForTests }) {
  if (anchors !== 'core' && anchors !== 'self') throw new Error('anchors must be core or self')
  if (keyFile === undefined) throw new Error('a key file is required')
  assertDevkitLock()
  assertKeyOutsideRepo(keyFile)
  const stage = resolve(stageDir)
  const manifest = JSON.parse(readFileSync(join(stage, 'manifest.json'), 'utf8'))
  const out = resolve(outFile ?? join(dirname(stage), `${manifest.id}-${manifest.version}.tuqplugin`))
  const pub = resolve(pubFile ?? defaultPubFile(keyFile))
  if (anchors === 'self' && !existsSync(pub)) throw new Error(`--anchors self needs the public key file ${pub}`)
  const packArgs = ['pack', stage, '--key', resolve(keyFile), '--out', out, '--anchors', anchors, ...(keyId === undefined ? [] : ['--key-id', keyId])]
  const packed = devkitJson(runDevkit(packArgs, { interactive, passphraseForTests }), 'pack')
  const verifyArgs = ['verify', out, '--anchors', anchors, ...(anchors === 'self' ? ['--pub-file', pub] : [])]
  const verified = devkitJson(runDevkit(verifyArgs), 'verify')
  if (verified.id !== manifest.id || verified.version !== manifest.version) throw new Error('the packed artifact does not carry the staged id and version')
  return { file: packed.file, size: packed.size, sha256: packed.sha256, signer: packed.signer, anchors, fileCount: verified.fileCount, integritySha256: verified.integritySha256, pubFile: anchors === 'self' ? pub : null }
}

function argument(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const keyFile = argument('--key')
  if (keyFile === undefined) {
    console.error(`usage: node ${basename(process.argv[1])} --key <file.key.pem> [--key-id id] [--anchors core|self] [--pub-file file] [--stage dir] [--out file]\nThe passphrase is typed at the prompt; it is never accepted as an argument.`)
    process.exit(2)
  }
  try {
    const result = release({ stageDir: argument('--stage'), keyFile: resolve(keyFile), keyId: argument('--key-id'), anchors: argument('--anchors') ?? 'core', pubFile: argument('--pub-file'), outFile: argument('--out'), interactive: true })
    console.log(JSON.stringify({ ok: true, ...result }, null, 2))
  } catch (error) {
    console.error(JSON.stringify({ ok: false, problem: error instanceof Error ? error.message : String(error) }))
    process.exit(1)
  }
}
