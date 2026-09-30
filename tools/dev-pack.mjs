#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPlugin } from './build.mjs'
import { assertDevkitLock, assertKeyOutsideRepo, devkitJson, runDevkit } from './devkit.mjs'
import { PLUGIN_ID, REPO_ROOT } from './vendor-lock.mjs'

export const DEV_OUT = join(REPO_ROOT, 'dist', 'dev', `${PLUGIN_ID}.tuqplugin`)
const KEY_SUFFIX = '.key.pem'
const DEV_KEY_NAME = /^dev-[0-9a-f]{16}\.key\.pem$/u

export async function devPack({ keyFile, outFile = DEV_OUT, interactive = false, passphraseForTests } = {}) {
  if (keyFile === undefined) throw new Error('a development key file is required')
  const key = resolve(keyFile)
  if (!DEV_KEY_NAME.test(basename(key))) throw new Error(`${basename(key)} is not a development key: it must be named dev-<16 hex>.key.pem (node vendor/teamuq-devkit/tuq-plugin-tool.mjs dev-keygen --out-dir <dir outside any repo>)`)
  assertDevkitLock()
  assertKeyOutsideRepo(key)
  const pubFile = `${key.slice(0, -KEY_SUFFIX.length)}.pub.json`
  if (!existsSync(pubFile)) throw new Error(`the public key file ${pubFile} must sit next to the key`)
  const out = resolve(outFile)
  const staged = await buildPlugin({ dist: dirname(out), stageOnly: true })
  const common = ['--preplanted-id', PLUGIN_ID]
  const packed = devkitJson(runDevkit(['dev-pack', staged.stageDir, '--key', key, '--out', out, '--bump-patch', ...common], { interactive, passphraseForTests }), 'dev-pack')
  const verified = devkitJson(runDevkit(['verify', out, '--anchors', 'self', '--pub-file', pubFile, ...common]), 'verify')
  if (verified.id !== PLUGIN_ID || verified.version !== packed.version || verified.signer?.kind !== 'dev') throw new Error('the packed artifact is not the development build of teamuq.memory that was just signed')
  return { file: packed.file, id: packed.id, version: packed.version, signer: packed.signer, sha256: packed.sha256, integritySha256: verified.integritySha256, pubFile }
}

function argument(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const keyFile = argument('--key')
  if (keyFile === undefined) {
    console.error(`usage: node ${basename(process.argv[1])} --key <dev-<16 hex>.key.pem> [--out file.tuqplugin]\nThe passphrase is typed at the prompt; it is never accepted as an argument. The output path is reused between runs so the patch version keeps counting up.`)
    process.exit(2)
  }
  try {
    const result = await devPack({ keyFile, outFile: argument('--out'), interactive: true })
    console.log(JSON.stringify({ ok: true, ...result }, null, 2))
  } catch (error) {
    console.error(JSON.stringify({ ok: false, problem: error instanceof Error ? error.message : String(error) }))
    process.exit(1)
  }
}
