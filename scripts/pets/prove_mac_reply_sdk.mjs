// Synthetic PT12 acceptance against an isolated, non-federating Synapse on loopback.
// No user credentials are accepted. The product flag stays off; only a disposable
// bundle used by this proof enables it. See the PT12 session log for stack setup.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { build } from 'esbuild'
import { ClientEvent, createClient, EventType, RoomEvent } from 'matrix-js-sdk'
import { logger } from 'matrix-js-sdk/lib/logger.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const desktop = path.join(root, 'apps/desktop')
const output = path.join(desktop, 'build/plan3-pets-sdk-proof')
const server = 'http://127.0.0.1:22408'
const quiet = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, getChild() { return quiet } }
logger.setLevel('silent')
logger.getChild = () => quiet
const clients = []
const checks = []

async function until(check, label) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`proof_deadline:${label}`)
}

async function api(route, body, token) {
  const response = await fetch(`${server}/_matrix/client/v3/${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000)
  })
  assert.equal(response.ok, true, `synthetic_api:${response.status}`)
  return response.json()
}

async function device(label) {
  const session = await api('register', {
    username: `pets-${label}-${randomBytes(6).toString('hex')}`,
    password: randomBytes(32).toString('hex'), device_id: `PETS${label.toUpperCase()}`,
    auth: { type: 'm.login.dummy' }
  })
  const client = createClient({ baseUrl: server, userId: session.user_id,
    deviceId: session.device_id, accessToken: session.access_token, logger: quiet })
  clients.push(client)
  await client.initRustCrypto({ useIndexedDB: false })
  client.getCrypto().globalBlacklistUnverifiedDevices = true
  let ready = false
  client.on(ClientEvent.Sync, state => { ready = ['PREPARED', 'SYNCING'].includes(state) })
  client.on(RoomEvent.Timeline, event => void client.decryptEventIfNeeded(event).catch(() => {}))
  await client.startClient({ initialSyncLimit: 50, pollTimeout: 1_000 })
  await until(() => ready, `${label}_sync`)
  return { client, session }
}

async function bundle(enabled) {
  const file = path.join(output, enabled ? 'enabled.mjs' : 'default-off.mjs')
  await build({
    stdin: { contents: `export {publishMatrixResult,publishMatrixNotice} from './src/matrix/publish-result';
      export {matrixPetCompletionIntents,parseMatrixPetReply} from './shared/matrix-pet-intent';
      export {createPetIntentIntake} from './src/matrix/pet/intake';`, resolveDir: desktop },
    outfile: file, bundle: true, platform: 'node', format: 'esm', packages: 'external',
    plugins: enabled ? [{ name: 'isolated-proof-flag', setup(builder) {
      builder.onLoad({ filter: /shared\/matrix-pet-intent\.ts$/ }, async args => {
        const source = await readFile(args.path, 'utf8')
        assert.equal(source.includes('export const MATRIX_PET_INTENT_PLAYBACK = false'), true)
        return { contents: source.replace('export const MATRIX_PET_INTENT_PLAYBACK = false',
          'export const MATRIX_PET_INTENT_PLAYBACK = true'), loader: 'ts' }
      })
    } }] : []
  })
  return import(pathToFileURL(file).href)
}

function pass(name) { checks.push(name); console.log(`PASS ${name}`) }

await mkdir(output, { recursive: true })
try {
  const enabled = await bundle(true)
  const off = await bundle(false)
  const owner = await device('owner')
  const agent = await device('agent')
  const { room_id: roomId } = await owner.client.createRoom({
    visibility: 'private', preset: 'private_chat', is_direct: true,
    creation_content: { type: 'io.atum.assistant' },
    invite: [agent.session.user_id],
    initial_state: [{ type: EventType.RoomEncryption, state_key: '',
      content: { algorithm: 'm.megolm.v1.aes-sha2' } }]
  })
  await until(() => agent.client.getRoom(roomId)?.getMyMembership() === 'invite', 'invite')
  await agent.client.joinRoom(roomId)
  await until(() => clients.every(client => {
    const room = client.getRoom(roomId)
    return room?.getMyMembership() === 'join' && room.getMembers().length === 2 &&
      room.getMembers().every(member => member.membership === 'join') && room.hasEncryptionStateEvent()
  }), 'private_room_sync')
  for (const [sender, recipient] of [[owner, agent], [agent, owner]]) {
    await sender.client.getCrypto().getUserDeviceInfo([recipient.session.user_id], true)
    await sender.client.getCrypto().setDeviceVerified(recipient.session.user_id, recipient.session.device_id, true)
  }
  pass('two synthetic SDK devices joined an encrypted private assistant room and verified one another')
  const question = await owner.client.sendTextMessage(roomId, 'wave')
  const pet = enabled.matrixPetCompletionIntents([{ action: 'wave' }], true)
  assert.deepEqual(pet, { v: 1, intents: [{ action: 'wave' }] })
  const command = { kind: 'publishResult', roomId, eventId: question.event_id,
    body: 'Waving.', invocationId: 'synthetic-pets-invocation', transactionId: 'pets-proof-wave', pet }
  const eventId = await enabled.publishMatrixResult(agent.client, command)
  assert.equal(await enabled.publishMatrixResult(agent.client, command), eventId)
  const wire = await api(`rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(eventId)}`,
    undefined, owner.session.access_token)
  assert.equal(wire.type, EventType.RoomMessageEncrypted)
  assert.equal(wire.content['io.atum.pet'], undefined)
  assert.equal(wire.content.body, undefined)
  pass('actual publisher encrypts ordinary reply content and the same transaction retries to one event')
  let reply
  await until(async () => {
    reply = owner.client.getRoom(roomId)?.findEventById(eventId)
    if (!reply) return false
    await owner.client.decryptEventIfNeeded(reply).catch(() => {})
    return !reply.isDecryptionFailure() && reply.getContent().body === command.body
  }, 'owner_decrypts_wave')
  assert.equal(reply.isEncrypted(), true)
  assert.equal(reply.getContent().msgtype, 'm.text')
  assert.deepEqual(reply.getContent()['io.atum.pet'], pet)
  const commands = enabled.parseMatrixPetReply(reply.getContent())
  const intake = enabled.createPetIntentIntake()
  const input = { room: { id: roomId, membership: 'join', assistant: true, direct: true,
    encrypted: true, agentPrincipal: agent.session.user_id }, message: {
    id: eventId, sender: reply.getSender(), timestamp: reply.getTs(), encrypted: true,
    body: reply.getContent().body, petIntents: { live: true, commands }
  }, now: Date.now(), shown: true, reducedMotion: false }
  assert.deepEqual(intake.accept(input), [{ action: 'wave' }])
  assert.equal(intake.accept(input), undefined)
  pass('owner SDK decrypts exact frozen wave envelope and production intake admits it once')
  const offId = await off.publishMatrixResult(agent.client, { ...command, transactionId: 'pets-proof-off' })
  const noticeId = await enabled.publishMatrixNotice(agent.client, { kind: 'publishNotice', roomId,
    eventId: question.event_id, body: 'Status.' })
  for (const [id, msgtype] of [[offId, 'm.text'], [noticeId, 'm.notice']]) {
    let event
    await until(async () => {
      event = owner.client.getRoom(roomId)?.findEventById(id)
      if (!event) return false
      await owner.client.decryptEventIfNeeded(event).catch(() => {})
      return !event.isDecryptionFailure() && event.getContent().msgtype === msgtype
    }, 'negative_reply_decrypt')
    assert.equal(event.isEncrypted(), true)
    assert.equal(event.getContent()['io.atum.pet'], undefined)
  }
  pass('default-off ordinary reply and enabled status notice decrypt without cosmetic intents')
  await writeFile(path.join(output, 'evidence.json'), `${JSON.stringify({ passed: true,
    scope: 'Local synthetic Synapse SDK encrypted read-back; isolated test flag; no packaged-native or H2 claim', checks }, null, 2)}\n`)
} finally {
  for (const client of clients) {
    client.stopClient()
    client.http.abort()
  }
}
