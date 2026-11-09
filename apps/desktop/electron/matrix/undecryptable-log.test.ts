import { expect, it } from 'vitest'

import { MATRIX_DECRYPTION_FAILURE_CODES } from '../../shared/matrix-undecryptable'

import { matrixRoomLogHash, MatrixUndecryptableLog } from './undecryptable-log'

const ROOM_A = '!phone-chat:atum.example'
const ROOM_B = '!another-room:atum.example'

function harness() {
  const lines: string[] = []
  let now = 0
  const log = new MatrixUndecryptableLog(line => lines.push(line), 10 * 60_000, () => now)

  return { lines, log, advance: (ms: number) => (now += ms) }
}

it('writes one line per host kind, room and reason, then one per ten minutes with the count', () => {
  const { lines, log, advance } = harness()

  // A timeline that retries the same unreadable messages on every sync.
  for (let sync = 0; sync < 21; sync++) {
    log.observe('human', { roomId: ROOM_A, code: 'MEGOLM_UNKNOWN_INBOUND_SESSION_ID' })
    log.observe('agent:alfred', { roomId: ROOM_A, code: 'MEGOLM_UNKNOWN_INBOUND_SESSION_ID' })
    log.observe('human', { roomId: ROOM_B, code: 'HISTORICAL_MESSAGE_NO_KEY_BACKUP' })
    advance(30_000)
  }

  const a = matrixRoomLogHash(ROOM_A)
  const b = matrixRoomLogHash(ROOM_B)

  expect(lines).toEqual([
    `[Matrix] undecryptable host=human room=${a} reason=MEGOLM_UNKNOWN_INBOUND_SESSION_ID`,
    `[Matrix] undecryptable host=agent room=${a} reason=MEGOLM_UNKNOWN_INBOUND_SESSION_ID`,
    `[Matrix] undecryptable host=human room=${b} reason=HISTORICAL_MESSAGE_NO_KEY_BACKUP`,
    `[Matrix] undecryptable host=human room=${a} reason=MEGOLM_UNKNOWN_INBOUND_SESSION_ID count=20`,
    `[Matrix] undecryptable host=agent room=${a} reason=MEGOLM_UNKNOWN_INBOUND_SESSION_ID count=20`,
    `[Matrix] undecryptable host=human room=${b} reason=HISTORICAL_MESSAGE_NO_KEY_BACKUP count=20`
  ])
})

it('keeps a new reason in the same room apart from the one already said', () => {
  const { lines, log } = harness()

  log.observe('human', { roomId: ROOM_A, code: 'MEGOLM_UNKNOWN_INBOUND_SESSION_ID' })
  log.observe('human', { roomId: ROOM_A, code: 'MEGOLM_KEY_WITHHELD_FOR_UNVERIFIED_DEVICE' })

  expect(lines).toHaveLength(2)
  expect(lines[1]).toContain('reason=MEGOLM_KEY_WITHHELD_FOR_UNVERIFIED_DEVICE')
})

it('never writes the room, an agent or app name, or anything but a listed reason', () => {
  const { lines, log } = harness()

  for (const code of MATRIX_DECRYPTION_FAILURE_CODES) {
    log.observe('app:moon', { roomId: ROOM_A, code })
  }

  for (const line of lines) {
    expect(line).not.toContain(ROOM_A)
    expect(line).not.toContain('moon')
    expect(line).toMatch(/^\[Matrix\] undecryptable host=app room=[0-9a-f]{12} reason=[A-Z0-9_]+$/)
  }

  expect(lines).toHaveLength(MATRIX_DECRYPTION_FAILURE_CODES.length)

  // Anything else is not a diagnostic this log knows: nothing is written.
  for (const value of [
    null,
    'text',
    [],
    { roomId: ROOM_A, code: 'the message said hello' },
    { roomId: ROOM_A, code: 'MEGOLM_KEY_WITHHELD', body: 'hello' },
    { roomId: 'not-a-room', code: 'MEGOLM_KEY_WITHHELD' },
    { roomId: `!${'x'.repeat(1024)}`, code: 'MEGOLM_KEY_WITHHELD' }
  ]) {
    log.observe('human', value)
  }

  expect(lines).toHaveLength(MATRIX_DECRYPTION_FAILURE_CODES.length)
})
