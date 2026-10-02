import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertKeyOutsideRepo } from './devkit.mjs'

export function createTempKey({ keyIdPrefix = 'teamuq-tmp-' } = {}) {
  const keyId = `${keyIdPrefix}${randomBytes(4).toString('hex')}`
  const passphrase = randomBytes(18).toString('base64url')
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'teamuq-memory-key-'))
  const keyFile = join(directory, `${keyId}.key.pem`)
  const pubFile = join(directory, `${keyId}.pub.json`)
  try {
    assertKeyOutsideRepo(keyFile)
    const pair = generateKeyPairSync('ed25519', {
      privateKeyEncoding: { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase },
      publicKeyEncoding: { type: 'spki', format: 'der' },
    })
    const publicKey = Buffer.from(pair.publicKey.subarray(pair.publicKey.length - 32)).toString('base64')
    writeFileSync(keyFile, pair.privateKey, { flag: 'wx', mode: 0o600 })
    writeFileSync(pubFile, `${JSON.stringify({ keyId, publicKey }, null, 2)}\n`, { flag: 'wx' })
    return { keyId, keyFile, pubFile, publicKey, passphrase, cleanup: () => rmSync(directory, { recursive: true, force: true }) }
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
}

export function createTempDevKey() {
  const passphrase = randomBytes(18).toString('base64url')
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'teamuq-memory-dev-key-'))
  try {
    const pair = generateKeyPairSync('ed25519', {
      privateKeyEncoding: { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase },
      publicKeyEncoding: { type: 'spki', format: 'der' },
    })
    const raw = Buffer.from(pair.publicKey.subarray(pair.publicKey.length - 32))
    const keyId = `dev-${createHash('sha256').update(raw).digest('hex').slice(0, 16)}`
    const keyFile = join(directory, `${keyId}.key.pem`)
    const pubFile = join(directory, `${keyId}.pub.json`)
    assertKeyOutsideRepo(keyFile)
    const publicKey = raw.toString('base64')
    writeFileSync(keyFile, pair.privateKey, { flag: 'wx', mode: 0o600 })
    writeFileSync(pubFile, `${JSON.stringify({ keyId, publicKey }, null, 2)}\n`, { flag: 'wx' })
    return { keyId, keyFile, pubFile, publicKey, passphrase, cleanup: () => rmSync(directory, { recursive: true, force: true }) }
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
}
