#!/usr/bin/env node
import { resolve } from 'node:path'
import { syncDevkit } from './sync-devkit.mjs'
import { syncInstalledDevkit } from './sync-installed-devkit.mjs'

function argument(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

const coreRoot = argument('--core')
const kitRoot = argument('--kit')
const only = argument('--only')
if ((coreRoot === undefined) === (kitRoot === undefined) || (only !== undefined && only !== 'devkit')) {
  console.error('usage: node tools/sync-vendor.mjs (--kit <developer kit> | --core <TeamUQ repo>) --only devkit')
  process.exit(2)
}
try {
  const report = kitRoot === undefined ? syncDevkit(resolve(coreRoot)) : syncInstalledDevkit(resolve(kitRoot))
  console.log(JSON.stringify({ ok: true, devkit: report }))
} catch (error) {
  console.error(JSON.stringify({ ok: false, problem: error instanceof Error ? error.message : String(error) }))
  process.exit(1)
}
