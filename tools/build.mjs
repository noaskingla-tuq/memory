#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { runDevkit, devkitJson, assertDevkitLock } from './devkit.mjs'
import { release } from './release.mjs'
import { stageCairn } from './stage-cairn.mjs'
import { createTempKey } from './temp-key.mjs'
import { verifyArtifact } from './verify-artifact.mjs'
import { REPO_ROOT } from './vendor-lock.mjs'

const CAIRN_IMPORT = 'cairn-memory/core/index.mjs'
const CAIRN_RELATIVE = './cairn/core/index.mjs'

const cairnExternal = {
  name: 'cairn-external',
  setup(builder) {
    builder.onResolve({ filter: /^cairn-memory(?:\/|$)/u }, (args) => {
      if (args.path !== CAIRN_IMPORT) return { errors: [{ text: `only ${CAIRN_IMPORT} may be imported from cairn-memory, got ${args.path}` }] }
      return { path: CAIRN_RELATIVE, external: true }
    })
  },
}

function argument(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

function runNode(script) {
  const result = spawnSync(process.execPath, [join(REPO_ROOT, 'tools', script)], { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  if (result.status !== 0) throw new Error(`${script} failed: ${(result.stderr || result.stdout).trim().slice(0, 600)}`)
}

async function bundleBackend(outFile) {
  const result = await build({
    entryPoints: [join(REPO_ROOT, 'src', 'backend', 'entry.ts')],
    absWorkingDir: REPO_ROOT,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node24',
    outfile: outFile,
    legalComments: 'none',
    charset: 'utf8',
    logLevel: 'silent',
    metafile: true,
    plugins: [cairnExternal],
  })
  const inputs = Object.keys(result.metafile.inputs)
  if (inputs.some((input) => input.includes('cairn-memory'))) throw new Error('the bundle inlined Cairn sources')
  return { inputs: inputs.length }
}

export async function bundleUi(stageDir) {
  const uiDir = join(stageDir, 'ui')
  mkdirSync(uiDir, { recursive: true })
  const result = await build({
    entryPoints: [join(REPO_ROOT, 'src', 'ui', 'main.ts')],
    absWorkingDir: REPO_ROOT,
    tsconfig: join(REPO_ROOT, 'tsconfig.ui.json'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    outfile: join(uiDir, 'app.js'),
    legalComments: 'none',
    charset: 'utf8',
    logLevel: 'silent',
    metafile: true,
  })
  const inputs = Object.keys(result.metafile.inputs)
  if (inputs.some((input) => input.includes('node_modules'))) throw new Error('the UI bundle pulled in a package from node_modules')
  copyFileSync(join(REPO_ROOT, 'plugin', 'ui', 'index.html'), join(uiDir, 'index.html'))
  // why: the view may link only app.css, so tokens.css is inlined into it here
  await build({
    entryPoints: [join(REPO_ROOT, 'src', 'ui', 'styles', 'app.css')],
    absWorkingDir: REPO_ROOT,
    bundle: true,
    outfile: join(uiDir, 'app.css'),
    legalComments: 'none',
    charset: 'utf8',
    logLevel: 'silent',
  })
  return { inputs: inputs.length }
}

function writeManifest(stageDir) {
  const template = readFileSync(join(REPO_ROOT, 'plugin', 'manifest.template.json'), 'utf8')
  const version = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version
  if (!template.includes('"@VERSION@"')) throw new Error('manifest.template.json has no @VERSION@ placeholder')
  const manifest = JSON.parse(template.replace('@VERSION@', version))
  writeFileSync(join(stageDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

export async function buildPlugin({ dist = join(REPO_ROOT, 'dist'), keyFile, keyId, anchors, stageOnly = false } = {}) {
  runNode('verify-source-untouched.mjs')
  runNode('verify-contract.mjs')
  assertDevkitLock()
  const stageDir = join(dist, 'stage')
  rmSync(stageDir, { recursive: true, force: true })
  mkdirSync(stageDir, { recursive: true })
  const bundle = await bundleBackend(join(stageDir, 'backend.mjs'))
  const ui = await bundleUi(stageDir)
  const staged = stageCairn(stageDir)
  const manifest = writeManifest(stageDir)
  const validated = devkitJson(runDevkit(['validate', stageDir]), 'validate')
  const report = { stageDir, id: manifest.id, version: manifest.version, bundleInputs: bundle.inputs, uiInputs: ui.inputs, cairnFiles: staged.files, cairnCommit: staged.commit, validated: validated.ok === true }
  if (stageOnly) return report

  const ephemeral = keyFile === undefined ? createTempKey() : null
  try {
    const outFile = join(dist, `${manifest.id}-${manifest.version}.tuqplugin`)
    const mode = anchors ?? (ephemeral === null ? 'core' : 'self')
    const packed = release(ephemeral === null
      ? { stageDir, keyFile, keyId, anchors: mode, outFile, interactive: true }
      : { stageDir, keyFile: ephemeral.keyFile, keyId: ephemeral.keyId, pubFile: ephemeral.pubFile, anchors: mode, outFile, passphraseForTests: ephemeral.passphrase })
    const pubFile = packed.pubFile === null ? undefined : join(dist, 'signer.pub.json')
    if (packed.pubFile !== null) copyFileSync(packed.pubFile, pubFile)
    const verification = verifyArtifact(packed.file, { anchors: mode, pubFile })
    if (!verification.ok) throw new Error(`verify-artifact failed: ${verification.checks.filter((entry) => !entry.ok).map((entry) => entry.name).join('; ')}`)
    const info = { ...report, file: packed.file, size: packed.size, sha256: packed.sha256, signer: packed.signer, anchors: mode, ephemeralKey: ephemeral !== null, pubFile: pubFile ?? null }
    writeFileSync(join(dist, 'build-info.json'), `${JSON.stringify(info, null, 2)}\n`)
    return info
  } finally {
    ephemeral?.cleanup()
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const keyFile = argument('--key')
  try {
    const info = await buildPlugin({ dist: resolve(argument('--dist') ?? join(REPO_ROOT, 'dist')), keyFile: keyFile === undefined ? undefined : resolve(keyFile), keyId: argument('--key-id'), anchors: argument('--anchors'), stageOnly: process.argv.includes('--stage-only') })
    if (info.ephemeralKey) console.error('warning: signed with a throwaway key (--anchors self); a real Core does not accept this package. Use --key for a release.')
    console.log(JSON.stringify({ ok: true, ...info }, null, 2))
  } catch (error) {
    console.error(JSON.stringify({ ok: false, problem: error instanceof Error ? error.message : String(error) }))
    process.exitCode = 1
  }
}
