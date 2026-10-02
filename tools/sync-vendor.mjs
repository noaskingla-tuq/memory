#!/usr/bin/env node
import { resolve } from 'node:path'
import { syncDevkit } from './sync-devkit.mjs'

function argument(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

const coreRoot = argument('--core')
const only = argument('--only')
if (coreRoot === undefined || (only !== undefined && only !== 'devkit')) {
  console.error('usage: node tools/sync-vendor.mjs --core <TeamUQ repo path> --only devkit; memory contract source is contract/v1 in this repository')
  process.exit(2)
}
try {
  const report = syncDevkit(resolve(coreRoot))
  console.log(JSON.stringify({ ok: true, devkit: report }))
} catch (error) {
  console.error(JSON.stringify({ ok: false, problem: error instanceof Error ? error.message : String(error) }))
  process.exit(1)
}
