import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { test, vi } from 'vitest'

import { SharedGroupControl } from './shared-group-control'

const ACCOUNT_A = '00000000-0000-4000-8000-bd7662a5eeb4'
const ACCOUNT_B = '00000000-0000-4000-8000-b454f82c5857'
const ASSISTANT = '00000000-0000-4000-8000-f6222a1106ee'
const OTHER_ASSISTANT = '00000000-0000-4000-8000-e8d95748107a'
const IDENTITY = '00000000-0000-4000-8000-f1d11edf5c5c'
const OTHER_IDENTITY = '00000000-0000-4000-8000-fbfe405ca65f'
const PROFILE = 'moon'
const SOUL = 'Moon speaks only from this approved shared persona. 🌙'
const DIGEST = createHash('sha256').update(Buffer.from(SOUL, 'utf8')).digest('hex')

function harness() {
  let account: { accountId: string; baseUrl: string } | null = { accountId: ACCOUNT_A, baseUrl: 'https://atum.test' }
  let approved = false
  let approvedDigest: string | null = null
  let revision = 0
  let profileIdentity = IDENTITY
  let soul = SOUL
  const calls: Array<{ path: string; method: string; body?: Record<string, unknown> }> = []

  const listAssistants = vi.fn(async () => [{
    id: ASSISTANT,
    identityId: IDENTITY,
    status: 'active' as const,
    displayName: 'Moon', avatar: '🌙', isDefault: false, lifecycleRevision: 1,
    identityRevision: 1, definitionRevision: 0,
  }])

  const profileRequest = vi.fn(async (path: string, method: 'GET' | 'POST' | 'DELETE', body?: Record<string, unknown>) => {
    calls.push({ path, method, body })

    if (path === '/api/profiles') {
      return { profiles: [{ name: PROFILE, identity_id: profileIdentity }] }
    }

    if (path === `/api/profiles/${PROFILE}/shared-persona/approve` && method === 'POST') {
      const digest = createHash('sha256').update(Buffer.from(soul, 'utf8')).digest('hex')

      if (body?.expected_digest !== digest) {return { ok: false }}
      approved = true
      approvedDigest = digest
      revision += 1

      return {
        content: soul,
        digest,
        identity_id: profileIdentity,
        approval: { digest, revision },
        approved: true,
      }
    }

    if (path === `/api/profiles/${PROFILE}/shared-persona/approve` && method === 'DELETE') {
      approved = false
      revision += 1

      return { ok: true }
    }

    if (path === `/api/profiles/${PROFILE}/shared-persona` && method === 'GET') {
      const digest = createHash('sha256').update(Buffer.from(soul, 'utf8')).digest('hex')

      return {
        content: soul,
        digest,
        identity_id: profileIdentity,
        approval: approved ? { digest: approvedDigest, revision } : null,
        approved: approved && digest === approvedDigest,
      }
    }

    throw new Error('unexpected profile request')
  })

  const device = {
    enable: vi.fn(async () => undefined),
    bindAgent: vi.fn(async () => undefined),
    unbindAgent: vi.fn(async () => undefined),
  }

  const stopRunner = vi.fn()

  const control = new SharedGroupControl({
    account: () => account,
    listAssistants,
    profileRequest,
    isLocalProfile: profile => profile === PROFILE,
    device,
    stopRunner,
  })

  return {
    control, calls, device, listAssistants, profileRequest, stopRunner,
    setAccount: (next: typeof account) => { account = next },
    setProfileIdentity: (next: string) => { profileIdentity = next },
    setSoul: (next: string) => { soul = next },
  }
}

test('preview resolves an active owned assistant to a local profile and returns the verified current bytes', async () => {
  const h = harness()
  const preview = await h.control.preview({ assistantId: ASSISTANT, profile: PROFILE })

  assert.deepEqual(preview, {
    content: SOUL,
    digest: DIGEST,
    identityId: IDENTITY,
    approvalRevision: null,
    approved: false,
    modelAlias: 'binh-minh',
  })
  assert.equal(h.device.enable.mock.calls.length, 0)
  assert.equal(h.calls.filter(call => call.path.endsWith('/shared-persona')).length, 1)
})

test('wrong ownership, profile identity, remote profile, and forged profile paths fail before SOUL reads', async () => {
  const wrongOwner = harness()
  wrongOwner.listAssistants.mockResolvedValueOnce([{
    id: OTHER_ASSISTANT, identityId: IDENTITY, status: 'active', displayName: 'Moon', avatar: '🌙', isDefault: false, lifecycleRevision: 1,
    identityRevision: 1, definitionRevision: 0,
  }])
  await assert.rejects(wrongOwner.control.preview({ assistantId: ASSISTANT, profile: PROFILE }), /shared_group_control_assistant_not_owned/u)
  assert.equal(wrongOwner.calls.length, 0)

  const changedIdentity = harness()
  changedIdentity.setProfileIdentity(OTHER_IDENTITY)
  await assert.rejects(changedIdentity.control.preview({ assistantId: ASSISTANT, profile: PROFILE }), /shared_group_control_identity_mismatch/u)
  assert.equal(changedIdentity.calls.filter(call => call.path.endsWith('/shared-persona')).length, 0)

  const remote = new SharedGroupControl({
    account: () => ({ accountId: ACCOUNT_A, baseUrl: 'https://atum.test' }),
    listAssistants: async () => [],
    profileRequest: async () => ({ profiles: [] }),
    isLocalProfile: () => false,
    device: { enable: async () => undefined, bindAgent: async () => undefined, unbindAgent: async () => undefined },
  })

  await assert.rejects(remote.preview({ assistantId: ASSISTANT, profile: PROFILE }), /shared_group_control_profile_not_local/u)

  const forged = harness()
  await assert.rejects(forged.control.preview({ assistantId: ASSISTANT, profile: '../default' }), /shared_group_control_invalid_input/u)
  assert.equal(forged.calls.length, 0)
})

test('approval checks the displayed digest, persists local approval, then enables and binds the device', async () => {
  const h = harness()
  await assert.rejects(
    h.control.approve({ assistantId: ASSISTANT, profile: PROFILE, expectedDigest: '0'.repeat(64) }),
    /shared_group_control_digest_changed/u,
  )
  assert.equal(h.device.enable.mock.calls.length, 0)

  assert.deepEqual(await h.control.approve({ assistantId: ASSISTANT, profile: PROFILE, expectedDigest: DIGEST }), { ok: true })
  const approval = h.calls.findIndex(call => call.method === 'POST')
  const approvalOrder = h.profileRequest.mock.invocationCallOrder[approval]!
  const rereadOrder = h.profileRequest.mock.invocationCallOrder[approval + 1]!
  const enable = h.device.enable.mock.invocationCallOrder[0]!
  const bind = h.device.bindAgent.mock.invocationCallOrder[0]!
  assert.equal(approval >= 0, true)
  assert.equal(approvalOrder < enable, true)
  assert.equal(rereadOrder < enable, true)
  assert.equal(enable < bind, true)
  assert.deepEqual((h.device.bindAgent.mock.calls as unknown as Array<[unknown]>)[0]?.[0], {
    assistantId: ASSISTANT,
    profileIdentity: IDENTITY,
    modelAlias: 'binh-minh',
    personaDigest: DIGEST,
    personaRevision: 1,
  })
})

test('a failed remote bind preserves the current local approval for an owner retry', async () => {
  const h = harness()
  h.device.bindAgent.mockRejectedValueOnce(new Error('offline'))

  await assert.rejects(
    h.control.approve({ assistantId: ASSISTANT, profile: PROFILE, expectedDigest: DIGEST }),
    /shared_group_control_device_bind_failed/u,
  )

  const preview = await h.control.preview({ assistantId: ASSISTANT, profile: PROFILE })
  assert.equal(preview.approved, true)
  assert.equal(preview.approvalRevision, 1)
  assert.equal(h.device.enable.mock.calls.length, 1)

  await h.control.approve({ assistantId: ASSISTANT, profile: PROFILE, expectedDigest: DIGEST })
  assert.equal(h.calls.filter(call => call.method === 'POST').length, 1)
  assert.equal((await h.control.preview({ assistantId: ASSISTANT, profile: PROFILE })).approvalRevision, 1)
  assert.equal(h.device.bindAgent.mock.calls.length, 2)
})

test('registration failure is retryable with the original approval revision', async () => {
  const h = harness()
  h.device.enable.mockRejectedValueOnce(new Error('feature_unavailable'))
  await assert.rejects(h.control.approve({ assistantId: ASSISTANT, profile: PROFILE, expectedDigest: DIGEST }))
  assert.equal(h.device.bindAgent.mock.calls.length, 0)
  assert.equal((await h.control.preview({ assistantId: ASSISTANT, profile: PROFILE })).approved, true)

  await h.control.approve({ assistantId: ASSISTANT, profile: PROFILE, expectedDigest: DIGEST })
  assert.equal(h.calls.filter(call => call.method === 'POST').length, 1)
  assert.equal(h.device.enable.mock.calls.length, 2)
  assert.equal(h.device.bindAgent.mock.calls.length, 1)
})

test('a changed persona after a failed bind requires fresh review and approval', async () => {
  const h = harness()
  h.device.bindAgent.mockRejectedValueOnce(new Error('offline'))
  await assert.rejects(h.control.approve({ assistantId: ASSISTANT, profile: PROFILE, expectedDigest: DIGEST }))
  h.setSoul(`${SOUL}\nUse clear language.`)
  await assert.rejects(
    h.control.approve({ assistantId: ASSISTANT, profile: PROFILE, expectedDigest: DIGEST }),
    /shared_group_control_digest_changed/u
  )
  const updated = await h.control.preview({ assistantId: ASSISTANT, profile: PROFILE })
  assert.equal(updated.approved, false)
  assert.equal(h.calls.filter(call => call.method === 'POST').length, 1)
  await h.control.approve({ assistantId: ASSISTANT, profile: PROFILE, expectedDigest: updated.digest })
  assert.equal(h.calls.filter(call => call.method === 'POST').length, 2)
  assert.equal((await h.control.preview({ assistantId: ASSISTANT, profile: PROFILE })).approvalRevision, 2)
})

test('an A-to-B-to-A account transition invalidated during preview or approval cannot resume stale work', async () => {
  const h = harness()
  h.listAssistants.mockImplementationOnce(async () => {
    h.setAccount({ accountId: ACCOUNT_B, baseUrl: 'https://atum.test' })
    h.control.invalidate()
    h.setAccount({ accountId: ACCOUNT_A, baseUrl: 'https://atum.test' })

    return [{ id: ASSISTANT, identityId: IDENTITY, status: 'active' as const, displayName: 'Moon', avatar: '🌙', isDefault: false, lifecycleRevision: 1, identityRevision: 1, definitionRevision: 0 }]
  })

  await assert.rejects(h.control.preview({ assistantId: ASSISTANT, profile: PROFILE }), /shared_group_control_account_changed/u)
  assert.equal(h.calls.length, 0)

  h.listAssistants.mockImplementationOnce(async () => {
    h.setAccount({ accountId: ACCOUNT_B, baseUrl: 'https://atum.test' })
    h.control.invalidate()
    h.setAccount({ accountId: ACCOUNT_A, baseUrl: 'https://atum.test' })

    return [{ id: ASSISTANT, identityId: IDENTITY, status: 'active' as const, displayName: 'Moon', avatar: '🌙', isDefault: false, lifecycleRevision: 1, identityRevision: 1, definitionRevision: 0 }]
  })

  await assert.rejects(h.control.approve({ assistantId: ASSISTANT, profile: PROFILE, expectedDigest: DIGEST }), /shared_group_control_account_changed/u)
  assert.equal(h.calls.length, 0)
  assert.equal(h.device.enable.mock.calls.length, 0)
  assert.equal(h.device.bindAgent.mock.calls.length, 0)
})

test('runner persona re-resolves by identity and returns the exact verified UTF-8 bytes once', async () => {
  const h = harness()
  await h.control.approve({ assistantId: ASSISTANT, profile: PROFILE, expectedDigest: DIGEST })
  h.calls.length = 0

  const snapshot = await h.control.persona({
    assistantId: ASSISTANT,
    profileIdentity: IDENTITY,
    personaDigest: DIGEST,
    personaRevision: 1,
  })

  assert.equal(snapshot.soulBytes.equals(Buffer.from(SOUL, 'utf8')), true)
  assert.equal(snapshot.personaDigest, DIGEST)
  assert.equal(h.calls.filter(call => call.path.endsWith('/shared-persona')).length, 1)

  await assert.rejects(h.control.persona({
    assistantId: ASSISTANT,
    profileIdentity: IDENTITY,
    personaDigest: 'f'.repeat(64),
    personaRevision: 1,
  }), /shared_group_control_approval_not_current/u)
})

test('a SOUL edit leaves its older approval visible but cannot run or bind as current', async () => {
  const h = harness()
  await h.control.approve({ assistantId: ASSISTANT, profile: PROFILE, expectedDigest: DIGEST })
  h.setSoul(`${SOUL}\nEdited after consent.`)

  const preview = await h.control.preview({ assistantId: ASSISTANT, profile: PROFILE })
  assert.equal(preview.approved, false)
  assert.equal(preview.approvalRevision, 1)

  await assert.rejects(h.control.persona({
    assistantId: ASSISTANT,
    profileIdentity: IDENTITY,
    personaDigest: DIGEST,
    personaRevision: 1,
  }), /shared_group_control_approval_not_current/u)
})

test('revocation stops the runner and clears remote binding before local approval', async () => {
  const h = harness()
  await h.control.approve({ assistantId: ASSISTANT, profile: PROFILE, expectedDigest: DIGEST })
  h.calls.length = 0
  await h.control.revoke({ assistantId: ASSISTANT, profile: PROFILE })

  assert.equal(h.stopRunner.mock.calls.length, 1)
  assert.equal(h.device.unbindAgent.mock.calls.length, 1)
  assert.equal(h.calls.findIndex(call => call.method === 'DELETE') >= 0, true)
})
