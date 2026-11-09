import { expect, it, vi } from 'vitest'

import {
  compareCurrentOwnerReader,
  crossSignCurrentOwnerReader,
  type MatrixOwnerReaderTrustPort,
  type OwnerReaderTrustEnrollment
} from './owner-reader-trust'

const owner = { userId: '@owner:example.test', deviceId: 'OWNER_DEVICE' }
const executorId = '00000000-0000-4000-8000-cf4c4732fd3b'
const enrollmentId = '00000000-0000-4000-8000-ecbad70593ee'

function enrollment(overrides: Partial<OwnerReaderTrustEnrollment> = {}): OwnerReaderTrustEnrollment {
  return {
    executorId,
    enrollmentId,
    kind: 'owner_reader',
    ownerPrincipal: '00000000-0000-4000-8000-0d23e78bd190',
    ownerUserId: owner.userId,
    deviceId: `ATUM_COMPANION_${executorId}`,
    enrollmentState: 'awaiting_trust',
    trust: 'pending',
    disclosureVersion: 1,
    ownerDevice: owner.deviceId,
    handoffUntil: 1_790_600_000_000,
    ...overrides
  }
}

function harness(records: OwnerReaderTrustEnrollment[]) {
  const command = vi.fn(async () => null)
  let index = 0
  const port: MatrixOwnerReaderTrustPort = { identity: owner, command }

  return {
    command,
    run: () => crossSignCurrentOwnerReader({ owner: port, current: async () => records[Math.min(index++, records.length - 1)]!, now: () => 1_790_578_800_000 })
  }
}

it('cross-signs only the current server-bound owner reader and returns no secret material', async () => {
  const input = harness([enrollment(), enrollment()])

  const result = await input.run()
  expect(result).toEqual({ executorId, enrollmentId, deviceId: `ATUM_COMPANION_${executorId}` })
  expect(input.command).toHaveBeenCalledExactlyOnceWith({ kind: 'ownerReaderCrossSignDevice', deviceId: `ATUM_COMPANION_${executorId}` })
  expect(JSON.stringify(result)).not.toMatch(/secret|recovery|token/i)
})

it.each([
  ['wrong human account', enrollment({ ownerUserId: '@other:example.test' })],
  ['wrong native owner device', enrollment({ ownerDevice: 'OTHER_DEVICE' })],
  ['agent-bearing enrollment', { ...enrollment(), agentPrincipal: executorId } as OwnerReaderTrustEnrollment],
  ['non-companion target', enrollment({ deviceId: 'ARBITRARY_DEVICE' })],
  ['active enrollment is not a pending handoff', { ...enrollment(), enrollmentState: 'active' } as unknown as OwnerReaderTrustEnrollment],
  ['trusted enrollment is not a pending handoff', { ...enrollment(), trust: 'trusted' } as unknown as OwnerReaderTrustEnrollment],
  ['expired handoff', enrollment({ handoffUntil: 1_790_578_800_000 })]
])('refuses %s before it calls the SDK', async (_name, bad) => {
  const input = harness([bad, bad])

  await expect(input.run()).rejects.toThrow('matrix_owner_reader_handoff_invalid')
  expect(input.command).not.toHaveBeenCalled()
})

it('does not let a changed enrollment turn a completed signature into a trusted handoff', async () => {
  const input = harness([enrollment(), enrollment({ enrollmentId: '00000000-0000-4000-8000-54cf138c3f97' })])

  await expect(input.run()).rejects.toThrow('matrix_owner_reader_handoff_stale')
  expect(input.command).toHaveBeenCalledExactlyOnceWith({ kind: 'ownerReaderCrossSignDevice', deviceId: `ATUM_COMPANION_${executorId}` })
})

function comparison(mismatch=false, changed=false) {
  const now=1790578800000, row=enrollment({handoffUntil:now+600000})
  const decimal:[number,number,number]=[1000,9191,4000]

  const command=vi.fn<MatrixOwnerReaderTrustPort['command']>(async value=>value.kind==='ownerReaderVerificationRead' ?
    {flowId:'actual-flow',decimal:mismatch ? [1001,9191,4000] : decimal} : null)

  let posted=false

  const verification=vi.fn(async(body?:{flowId:string;ownerDevice:string;decimal:[number,number,number]})=>{
    posted=!!body

    return {flowId:'actual-flow',decimal,ownerDevice:owner.deviceId,deviceId:row.deviceId,expiresAt:now+120000,
      state:body ? (mismatch ? 'cancelled' as const:'confirmed' as const) : 'pending' as const}
  })

  return {command,verification,run:()=>compareCurrentOwnerReader({owner:{identity:owner,command},
    current:async()=>posted && changed ? {...row,ownerDevice:'OTHER'}:row,verification,now:()=>now})}
}

it('compares exact actual SDK values through the private domain before confirming the standard MAC exchange',async()=>{
  const f=comparison()
  await f.run()
  expect(f.verification).toHaveBeenLastCalledWith({flowId:'actual-flow',ownerDevice:owner.deviceId,decimal:[1000,9191,4000]})
  expect(f.command).toHaveBeenLastCalledWith({kind:'ownerReaderVerificationRespond',deviceId:`ATUM_COMPANION_${executorId}`,
    flowId:'actual-flow',decimal:[1000,9191,4000],action:'confirm'})
})

it('records and rejects mismatched actual SDK values without confirming',async()=>{
  const f=comparison(true)
  await f.run()
  expect(f.command).toHaveBeenLastCalledWith(expect.objectContaining({action:'mismatch',decimal:[1001,9191,4000]}))
})

it('a changed enrollment after domain comparison cannot confirm the SDK verifier',async()=>{
  const f=comparison(false,true)
  await expect(f.run()).rejects.toThrow('matrix_owner_reader_stale')
  expect(f.command.mock.calls.some(([v])=>v.kind==='ownerReaderVerificationRespond')).toBe(false)
})
