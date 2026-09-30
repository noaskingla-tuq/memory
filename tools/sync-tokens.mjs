#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hashBytes, REPO_ROOT } from './vendor-lock.mjs'

export const CORE_TOKEN_FILE = 'apps/desktop/src/renderer/styles/base.css'
export const TOKENS_CSS = join(REPO_ROOT, 'src', 'ui', 'styles', 'tokens.css')
export const TOKENS_LOCK = join(REPO_ROOT, 'src', 'ui', 'styles', 'tokens.lock.json')
const OUTPUT_RELATIVE = 'src/ui/styles/tokens.css'
const LIGHT_SELECTOR = ':root, html[data-theme="light"]'
const DARK_SELECTOR = 'html[data-theme="dark"]'

export const SYNCED_TOKENS = [
  'accent', 'accent-hover', 'accent-tint', 'on-accent',
  'text-primary', 'text-secondary', 'text-muted',
  'border', 'border-strong',
  'surface', 'surface-sunken', 'surface-muted',
  'success', 'error', 'warning', 'warning-strong', 'error-strong', 'success-strong', 'error-tint',
  'hit-bg', 'hit-fg',
  'font-mono', 'sp-1', 'sp-2', 'sp-3', 'sp-4', 'sp-6',
]

// why: Core's --text-secondary is 4.33:1 on --surface-muted and --on-accent is 2.46:1 on --accent, so the plugin adds readable variants instead of redefining Core names
export const PLUGIN_OWNED = {
  light: {
    link: '#1d72a8',
    'text-secondary-strong': '#595959',
    'accent-fg': '#04202f',
    'danger-fg': '#ffffff',
    'font-ui': 'system-ui, -apple-system, "Segoe UI", "Microsoft JhengHei", "PingFang TC", sans-serif',
  },
  dark: {
    link: '#7cc4ee',
    'text-secondary-strong': 'var(--text-secondary)',
    'accent-fg': '#04202f',
    'danger-fg': '#1c0b0d',
    'font-ui': 'system-ui, -apple-system, "Segoe UI", "Microsoft JhengHei", "PingFang TC", sans-serif',
  },
}

function argument(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

function fail(message) {
  console.error(JSON.stringify({ ok: false, problem: message }))
  process.exit(1)
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function topLevelRules(cssText) {
  const text = cssText.replace(/\/\*[\s\S]*?\*\//gu, '')
  const rules = []
  let depth = 0
  let selectorStart = 0
  let bodyStart = 0
  let selector = ''
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === '{') {
      if (depth === 0) {
        selector = text.slice(selectorStart, index).replace(/\s+/gu, ' ').trim()
        bodyStart = index + 1
      }
      depth += 1
    } else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        rules.push({ selector, body: text.slice(bodyStart, index) })
        selectorStart = index + 1
      }
    }
  }
  return rules
}

function declarations(body) {
  const found = {}
  for (const match of body.matchAll(/^\s*--([a-z0-9-]+)\s*:\s*([^;]+);/gmu)) found[match[1]] = match[2].replace(/\s+/gu, ' ').trim()
  return found
}

export function parseCoreTokens(cssText) {
  const rules = topLevelRules(cssText)
  const pick = (selector) => {
    const matches = rules.filter((rule) => rule.selector === selector)
    if (matches.length !== 1) throw new Error(`expected exactly one top-level rule for "${selector}" in Core base.css, found ${matches.length}`)
    return declarations(matches[0].body)
  }
  const lightAll = pick(LIGHT_SELECTOR)
  const darkAll = pick(DARK_SELECTOR)
  const light = {}
  const dark = {}
  for (const name of SYNCED_TOKENS) {
    if (lightAll[name] === undefined) throw new Error(`Core base.css has no light value for --${name}`)
    light[name] = lightAll[name]
    if (darkAll[name] !== undefined) dark[name] = darkAll[name]
  }
  return { light, dark }
}

function lines(values, indent) {
  return Object.entries(values).map(([name, value]) => `${indent}--${name}: ${value};`)
}

export function renderTokensCss({ light, dark, pluginOwned = PLUGIN_OWNED }) {
  const darkOwned = Object.fromEntries(Object.entries(pluginOwned.dark).filter(([name, value]) => pluginOwned.light[name] !== value))
  return [
    ':root {',
    '  color-scheme: light dark;',
    ...lines(light, '  '),
    ...lines(pluginOwned.light, '  '),
    '}',
    '',
    '@media (prefers-color-scheme: dark) {',
    '  :root {',
    ...lines({ ...dark, ...darkOwned }, '    '),
    '  }',
    '}',
    '',
  ].join('\n')
}

function sha256(text) {
  return hashBytes(Buffer.from(text, 'utf8'))
}

export function buildLock({ light, dark, coreCommit, fileCommit, sourceSha256 }) {
  const css = renderTokensCss({ light, dark })
  return {
    lockVersion: 1,
    source: { repo: 'teamuq-electron', file: CORE_TOKEN_FILE, coreCommit, fileCommit, fileSha256: sourceSha256 },
    tokens: { light, dark },
    pluginOwned: PLUGIN_OWNED,
    output: { file: OUTPUT_RELATIVE, sha256: sha256(css) },
  }
}

export function verifyTokens({ cssFile = TOKENS_CSS, lockFile = TOKENS_LOCK } = {}) {
  const problems = []
  if (!existsSync(cssFile)) return { ok: false, problems: [`missing ${cssFile}`] }
  if (!existsSync(lockFile)) return { ok: false, problems: [`missing ${lockFile}`] }
  const lock = JSON.parse(readFileSync(lockFile, 'utf8'))
  const css = readFileSync(cssFile, 'utf8').replace(/\r\n/gu, '\n')
  if (lock.lockVersion !== 1) problems.push('tokens.lock.json has an unknown lockVersion')
  if (sha256(css) !== lock.output?.sha256) problems.push('tokens.css was edited by hand: its sha256 differs from tokens.lock.json')
  const expected = renderTokensCss({ light: lock.tokens.light, dark: lock.tokens.dark, pluginOwned: lock.pluginOwned })
  if (css !== expected) problems.push('tokens.css is not what tokens.lock.json renders')
  if (JSON.stringify(lock.pluginOwned) !== JSON.stringify(PLUGIN_OWNED)) problems.push('the plugin-owned tokens in tokens.lock.json differ from tools/sync-tokens.mjs')
  if (JSON.stringify(Object.keys(lock.tokens.light)) !== JSON.stringify(SYNCED_TOKENS)) problems.push('the synced token list in tokens.lock.json differs from tools/sync-tokens.mjs')
  return { ok: problems.length === 0, problems }
}

function readCore(coreRoot) {
  const file = join(coreRoot, ...CORE_TOKEN_FILE.split('/'))
  if (!existsSync(file)) fail(`no ${CORE_TOKEN_FILE} under ${coreRoot}`)
  const bytes = readFileSync(file)
  const tokens = (() => {
    try {
      return parseCoreTokens(bytes.toString('utf8'))
    } catch (error) {
      return fail(error.message)
    }
  })()
  // why: a synced copy must be reproducible from a commit, so an uncommitted edit of Core's token file is refused
  if (git(coreRoot, ['status', '--porcelain', '--', CORE_TOKEN_FILE]) !== '') fail(`Core ${CORE_TOKEN_FILE} has uncommitted changes`)
  const coreCommit = git(coreRoot, ['rev-parse', 'HEAD'])
  const fileCommit = git(coreRoot, ['log', '-1', '--format=%H', '--', CORE_TOKEN_FILE])
  if (!/^[0-9a-f]{40}$/u.test(coreCommit) || !/^[0-9a-f]{40}$/u.test(fileCommit)) fail('could not read Core commits')
  return { ...tokens, coreCommit, fileCommit, sourceSha256: hashBytes(bytes) }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const core = argument('--core')
  const usage = 'usage: node tools/sync-tokens.mjs --core <TeamUQ repo path> [--check]\n       node tools/sync-tokens.mjs --verify'
  if (process.argv.includes('--verify')) {
    const verdict = verifyTokens()
    console.log(JSON.stringify(verdict, null, 2))
    process.exit(verdict.ok ? 0 : 1)
  }
  if (core === undefined || core.startsWith('--')) {
    console.error(usage)
    process.exit(2)
  }
  const read = readCore(resolve(core))
  const lock = buildLock(read)
  const css = renderTokensCss(read)
  if (process.argv.includes('--check')) {
    const current = existsSync(TOKENS_LOCK) ? JSON.parse(readFileSync(TOKENS_LOCK, 'utf8')) : null
    const same = current !== null && JSON.stringify(current.tokens) === JSON.stringify(lock.tokens) && current.output?.sha256 === lock.output.sha256
    console.log(JSON.stringify({ ok: same, coreCommit: read.coreCommit, lockedCoreCommit: current?.source?.coreCommit ?? null, problem: same ? undefined : 'Core token values differ from tokens.lock.json; run tokens:sync' }))
    process.exit(same ? 0 : 1)
  }
  writeFileSync(TOKENS_CSS, css)
  writeFileSync(TOKENS_LOCK, `${JSON.stringify(lock, null, 2)}\n`)
  const verdict = verifyTokens()
  console.log(JSON.stringify({ ok: verdict.ok, coreCommit: read.coreCommit, fileCommit: read.fileCommit, tokens: SYNCED_TOKENS.length, cssSha256: lock.output.sha256, problems: verdict.problems }))
  process.exit(verdict.ok ? 0 : 1)
}
