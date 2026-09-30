#!/usr/bin/env node
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CAIRN_ROOT, PIN_FILE, checkPinStage, computeStageRecord, EXCLUDED_DIRS, readPin, sha256Bytes } from './cairn-files.mjs'
import { normalise } from './vendor-lock.mjs'

export function recordStage() {
  const pin = readPin()
  const next = { ...pin, stage: { excluded: [...EXCLUDED_DIRS], files: computeStageRecord() } }
  writeFileSync(PIN_FILE, `${JSON.stringify(next, null, 2)}\n`)
  return next.stage.files.length
}

export function stageCairn(outDir) {
  const pin = readPin()
  const problems = checkPinStage(pin)
  if (problems.length > 0) throw new Error(`Cairn source does not match cairn-pin.json: ${problems.join('; ')}`)
  const target = resolve(outDir)
  const cairnDir = join(target, 'cairn')
  rmSync(cairnDir, { recursive: true, force: true })
  for (const entry of pin.stage.files) {
    const destination = join(cairnDir, ...entry.path.split('/'))
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(join(CAIRN_ROOT, ...entry.path.split('/')), destination)
    if (sha256Bytes(readFileSync(destination)) !== entry.sha256) throw new Error(`${entry.path}: staged copy differs from the pin record`)
  }
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, 'cairn-pin.json'), normalise(readFileSync(PIN_FILE)))
  return { files: pin.stage.files.length, commit: pin.commit }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outIndex = process.argv.indexOf('--out')
  try {
    if (process.argv.includes('--record')) {
      console.log(JSON.stringify({ ok: true, recorded: recordStage() }))
    } else if (outIndex !== -1 && process.argv[outIndex + 1] !== undefined) {
      console.log(JSON.stringify({ ok: true, ...stageCairn(process.argv[outIndex + 1]) }))
    } else {
      console.error('usage: node tools/stage-cairn.mjs --out <stageDir> | --record')
      process.exit(2)
    }
  } catch (error) {
    console.error(JSON.stringify({ ok: false, problem: error instanceof Error ? error.message : String(error) }))
    process.exit(1)
  }
}
