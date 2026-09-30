#!/usr/bin/env node
// Builds test/fixtures/legacy-db/<cairn commit>/ with the Cairn that is currently installed.
// Run it once per accepted commit, with that commit installed, after `npm run build:ts`.
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const pin = JSON.parse(readFileSync(join(repoRoot, 'cairn-pin.json'), 'utf8'))
const out = (path) => pathToFileURL(join(repoRoot, 'out', path)).href
const { openCairnCore } = await import(out('adapters/cairn/cairnCoreAdapter.js'))
const { CairnDataLayout } = await import(out('adapters/storage/dataLayout.js'))
const { CoreHandlePool } = await import(out('application/coreHandlePool.js'))
const { MemoryApplication } = await import(out('application/memoryApplication.js'))

const AGENT_ID = 'fixture-agent'
const MEMORIES = [
  { scope: 'personal', kind: 'preference', content: 'Fixture agent prefers concise answers.' },
  { scope: 'project', kind: 'instruction', content: 'Fixture project deploys through the release gate.' },
]
const actor = { agentId: AGENT_ID, projectId: 'fixture-project', sessionId: 'fixture-session', providerId: 'codex' }

const base = mkdtempSync(join(tmpdir(), 'teamuq-memory-fixture-'))
try {
  const root = join(base, 'memory-cairn-v1')
  const layout = new CairnDataLayout(root)
  const application = new MemoryApplication(new CoreHandlePool({ layout, openCore: openCairnCore }))
  const stored = []
  for (const [index, memory] of MEMORIES.entries()) {
    const result = await application.execute('memory_remember', { ...memory, operationId: `fixture-${index}` }, actor)
    if (!result.ok) throw new Error(`remember failed: ${JSON.stringify(result)}`)
    stored.push({ ...memory, id: result.value.memory.id, namespace: result.value.memory.namespace })
  }
  await application.close()
  const agentHash = createHash('sha256').update(AGENT_ID).digest('hex')
  const agentRoot = join(root, 'agents', agentHash)
  const leftovers = readdirSync(agentRoot).filter((name) => name.endsWith('-wal') || name.endsWith('-shm'))
  if (leftovers.length > 0) throw new Error(`database is not checkpointed: ${leftovers.join(', ')}`)
  const destination = join(repoRoot, 'test', 'fixtures', 'legacy-db', pin.commit)
  if (existsSync(destination)) rmSync(destination, { recursive: true })
  mkdirSync(destination, { recursive: true })
  copyFileSync(join(agentRoot, 'memory.sqlite'), join(destination, 'memory.sqlite'))
  copyFileSync(join(agentRoot, 'identity.json'), join(destination, 'identity.json'))
  writeFileSync(
    join(destination, 'fixture.json'),
    `${JSON.stringify({ cairnCommit: pin.commit, agentId: AGENT_ID, actor, memories: stored }, null, 2)}\n`,
  )
  console.log(JSON.stringify({ ok: true, destination }))
} finally {
  rmSync(base, { recursive: true, force: true })
}
