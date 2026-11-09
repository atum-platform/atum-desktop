import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it, vi } from 'vitest'

import {
  answerApproval,
  type ApprovalChoice,
  approvalChoiceWords,
  approvalReasonText,
  type ApproveRecord,
  requestApproval,
  verifyApproval
} from './approvals'
import { canonicalJson } from './canonical'

const packDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../packages/device-protocol/fixtures/device-service'
)

const contract = JSON.parse(readFileSync(path.join(packDir, 'contract.json'), 'utf8'))
const readCase = (file: string) => JSON.parse(readFileSync(path.join(packDir, file), 'utf8'))

function approvalContext(data: any) {
  return {
    commandHash: data.commandHash,
    capability: data.capability,
    deviceServiceId: data.device.deviceServiceId,
    accountEpoch: data.device.accountEpoch,
    approvalKey: { kid: data.device.approvalKey.kid, spki: data.device.approvalKey.publicKey },
    usedNonces: (data.device.usedNonces ?? []) as string[],
    now: data.device.now
  }
}

describe('verifyApproval against the vendored approval fixtures (real ES256)', () => {
  const cases = (contract.fixtures as Array<{ file: string; message?: string; expect: string }>).filter(
    entry => entry.message === 'case.approval'
  )

  for (const { file, expect: kind } of cases) {
    const data = readCase(file)

    // The one quirk: approval-other-command sets BOTH the top-level reference and the record body to a
    // different command, so a top-level-reference consumer sees them agree. The wrong_command path is
    // covered by its own dedicated test below (reference = the pending command, not the record body).
    if (data.name === 'approval-other-command') {
      continue
    }

    it(`${data.name} (${kind})`, () => {
      const verdict = verifyApproval(data.approve.body as ApproveRecord, data.approve.kid, data.approve.sig, approvalContext(data))

      if (kind === 'reject') {
        // The embedded outcome is the violation (e.g. accepting an expired approval). A correct device
        // must not produce it.
        expect(verdict.outcome).not.toBe(data.expect.outcome)

        return
      }

      if (data.expect.outcome === 'valid') {
        expect(verdict.outcome).toBe('valid')
        expect((verdict as { approvalHash: string }).approvalHash).toBe(data.expect.approvalHash)
      } else {
        expect(verdict.outcome).toBe('invalid')
        expect((verdict as { reason: string }).reason).toBe(data.expect.reason)
      }
    })
  }

  it('wrong_command: an approval whose record is for a different command than the pending one', () => {
    const data = readCase('fixtures/approval-valid.case.json')

    const verdict = verifyApproval(data.approve.body as ApproveRecord, data.approve.kid, data.approve.sig, {
      ...approvalContext(data),
      commandHash: 'a-different-command-hash-than-the-record'
    })

    expect(verdict).toEqual({ outcome: 'invalid', reason: 'wrong_command' })
  })
})

describe('requestApproval asks the Secure Enclave approval key and self-verifies', () => {
  const data = readCase('fixtures/approval-valid.case.json')
  const body = data.approve.body as ApproveRecord
  const approvalKey = { kid: data.approve.kid, spki: data.device.approvalKey.publicKey }

  function deps(approve: (bytes: Uint8Array, reason: string) => Promise<{ kid: string; sig: string }>) {
    return {
      setPaused: vi.fn(),
      signer: { approve: vi.fn(approve) },
      approvalKey: () => approvalKey,
      nonce: () => body.nonce,
      now: () => body.createdAt,
      deviceServiceId: () => body.deviceServiceId,
      accountEpoch: () => body.accountEpoch,
      // The contract fixture's record is the frozen 60 s one; production defaults to the sheet's 10 min.
      windowMs: 60_000
    }
  }

  const coded = (code: string) => Object.assign(new Error(`device_key_${code}`), { code })

  it('approved: pauses, signs the record bytes behind Touch ID, unpauses, returns the verified record', async () => {
    const d = deps(async () => ({ kid: data.approve.kid, sig: data.approve.sig }))

    const result = await requestApproval(
      {
        commandHash: body.commandHash,
        capability: body.capability,
        target: body.target,
        destination: body.destination,
        reason: 'T wants to run "ssh -T git@github.com" with the SSH agent'
      },
      d
    )

    expect(result.outcome).toBe('approved')
    expect((result as { approvalHash: string }).approvalHash).toBe(data.expect.approvalHash)
    // The signer gets the full device-service signed bytes (domain included), as WS-3b's signer frames them.
    const [bytes, reason] = d.signer.approve.mock.calls[0]
    expect(Buffer.from(bytes).toString('utf8')).toBe(`atum.device-service.v1\0Approve\0${canonicalJson(body)}`)
    expect(reason).toContain('ssh -T git@github.com')
    expect(d.setPaused).toHaveBeenNthCalledWith(1, true)
    expect(d.setPaused).toHaveBeenNthCalledWith(2, false)
  })

  it('the record lives as long as the sheet waits for the owner: 10 minutes by default', async () => {
    const d = { ...deps(async () => ({ kid: data.approve.kid, sig: data.approve.sig })), windowMs: undefined }

    await requestApproval(
      { commandHash: body.commandHash, capability: body.capability, target: body.target, reason: 'x' },
      d
    )

    const [bytes] = d.signer.approve.mock.calls[0]
    const record = JSON.parse(Buffer.from(bytes).toString('utf8').split('\0')[2])
    expect(record.expiresAt - record.createdAt).toBe(10 * 60_000)
  })

  it('denied: a cancelled sheet is approval_denied and the device is unpaused', async () => {
    const d = deps(async () => {
      throw coded('approval_denied')
    })

    const result = await requestApproval(
      { commandHash: body.commandHash, capability: body.capability, target: body.target, reason: 'x' },
      d
    )

    expect(result).toEqual({ outcome: 'denied', reason: 'approval_denied' })
    expect(d.setPaused).toHaveBeenLastCalledWith(false)
  })

  it('timeout: an unanswered sheet is approval_timeout (no signature → not approved)', async () => {
    const d = deps(async () => {
      throw coded('approval_timeout')
    })

    const result = await requestApproval(
      { commandHash: body.commandHash, capability: body.capability, target: body.target, reason: 'x' },
      d
    )

    expect(result).toEqual({ outcome: 'denied', reason: 'approval_timeout' })
  })

  it('an unexplained signer failure is a denial, never consent', async () => {
    const d = deps(async () => {
      throw new Error('boom')
    })

    const result = await requestApproval(
      { commandHash: body.commandHash, capability: body.capability, target: body.target, reason: 'x' },
      d
    )

    expect(result).toEqual({ outcome: 'denied', reason: 'approval_denied' })
  })

  it('a returned signature that does not verify is a denial, never an approval', async () => {
    const d = deps(async () => ({ kid: data.approve.kid, sig: 'AAAA' }))

    const result = await requestApproval(
      { commandHash: body.commandHash, capability: body.capability, target: body.target, reason: 'x' },
      d
    )

    expect(result).toEqual({ outcome: 'denied', reason: 'approval_denied' })
    expect(d.setPaused).toHaveBeenLastCalledWith(false)
  })

  it('no enrolled approval key: nothing is prompted', async () => {
    const d = { ...deps(async () => ({ kid: '', sig: '' })), approvalKey: () => null }

    const result = await requestApproval(
      { commandHash: body.commandHash, capability: body.capability, target: body.target, reason: 'x' },
      d
    )

    expect(result).toEqual({ outcome: 'denied', reason: 'unavailable' })
    expect(d.signer.approve).not.toHaveBeenCalled()
  })
})

describe('approvalReasonText names who, what and the exact command, in the owner’s language', () => {
  it('Vietnamese by default, with the exact command', () => {
    expect(approvalReasonText(undefined, { agent: 'T', capability: 'keychain', target: 'security dump-keychain' })).toBe(
      'T muốn dùng Chuỗi khóa của bạn để chạy “security dump-keychain”. Xác nhận một lần cho cả tác vụ (tối đa 30 phút).'
    )
  })

  it('every product locale has words for every capability, once and always', () => {
    const capabilities = [
      'ssh_agent', 'keychain', 'browser_store', 'cloud_cli', 'persistence', 'network_new_host', 'sudo',
      'other_agent_write', 'exec_downloaded', 'bulk_destructive', 'gui_upload'
    ] as const

    for (const locale of ['en', 'vi', 'ja', 'zh-CN', 'zh-Hant']) {
      for (const capability of capabilities) {
        const once = approvalReasonText(locale, { agent: 'T', capability, target: 'cmd' })
        expect(once, `${locale} ${capability}`).toContain('T')
        expect(once).toContain('cmd')
        expect(approvalReasonText(locale, { agent: 'T', capability, always: true })).not.toContain('cmd')
      }
    }
  })

  it('a very long command is cut, never hidden', () => {
    const text = approvalReasonText('en', { agent: 'T', capability: 'sudo', target: `sudo ${'x'.repeat(1000)}` })
    expect(Array.from(text).length).toBeLessThan(600)
    expect(text).toContain('sudo xxx')
  })
})


describe('answerApproval — the one-tap "always allow this assistant" choice', () => {
  const approvedOnce = { outcome: 'approved' as const, record: {} as never, kid: 'k', sig: 's', approvalHash: 'O'.repeat(43) }

  function setup(choice: ApprovalChoice | Error, over: { offersAlways?: boolean; grant?: () => Promise<{ id: string; approvalHash: string }> } = {}) {
    const events: string[] = []

    const deps = {
      offersAlways: over.offersAlways ?? true,
      once: vi.fn(async () => (events.push('touch-id'), approvedOnce)),
      choose: vi.fn(async () => {
        events.push('choose')

        if (choice instanceof Error) {
          throw choice
        }

        return choice
      }),
      grant: vi.fn(over.grant ?? (async () => (events.push('grant'), { id: 'g1', approvalHash: 'G'.repeat(43) }))),
      setPaused: vi.fn((paused: boolean) => void events.push(paused ? 'pause' : 'unpause')),
      log: vi.fn()
    }

    return { deps, events }
  }

  it('always: ONE Touch ID signs the standing grant, the asking command is covered by it, and no per-command approval is asked', async () => {
    const { deps, events } = setup('always')

    expect(await answerApproval(deps)).toEqual({ outcome: 'approved', approvalHash: 'G'.repeat(43), standingGrantId: 'g1' })
    expect(deps.once).not.toHaveBeenCalled()
    expect(deps.grant).toHaveBeenCalledTimes(1)
    // The device is paused while any approval UI is up, and unpaused after each.
    expect(events).toEqual(['pause', 'choose', 'unpause', 'pause', 'grant', 'unpause'])
  })

  it('once: the plain Touch ID for this command and nothing is granted', async () => {
    const { deps } = setup('once')

    expect(await answerApproval(deps)).toBe(approvedOnce)
    expect(deps.grant).not.toHaveBeenCalled()
  })

  it('deny, or a choice that cannot be shown, is a refusal and asks for no Touch ID', async () => {
    for (const choice of ['deny', new Error('no window')] as const) {
      const { deps } = setup(choice)

      expect(await answerApproval(deps)).toEqual({ outcome: 'denied', reason: 'approval_denied' })
      expect(deps.once).not.toHaveBeenCalled()
      expect(deps.grant).not.toHaveBeenCalled()
      expect(deps.setPaused).toHaveBeenLastCalledWith(false)
    }
  })

  it('a cancelled Touch ID on "always" grants nothing and says why; a timeout stays a timeout', async () => {
    const cancelled = setup('always', { grant: async () => { throw Object.assign(new Error('x'), { code: 'approval_denied' }) } })
    expect(await answerApproval(cancelled.deps)).toEqual({ outcome: 'denied', reason: 'approval_denied' })

    const timedOut = setup('always', { grant: async () => { throw Object.assign(new Error('x'), { code: 'approval_timeout' }) } })
    expect(await answerApproval(timedOut.deps)).toEqual({ outcome: 'denied', reason: 'approval_timeout' })
    expect(timedOut.deps.setPaused).toHaveBeenLastCalledWith(false)
  })

  it('a capability that cannot be granted for good goes straight to the Touch ID with no choice', async () => {
    const { deps } = setup('always', { offersAlways: false })

    expect(await answerApproval(deps)).toBe(approvedOnce)
    expect(deps.choose).not.toHaveBeenCalled()
  })

  it('the three buttons exist in every language the sheet speaks', () => {
    for (const locale of ['en', 'vi', 'ja', 'zh', 'zh-TW', undefined]) {
      const words = approvalChoiceWords(locale)
      expect(new Set([words.once, words.always, words.deny]).size).toBe(3)
    }

    expect(approvalChoiceWords('vi').always).toBe('Luôn cho phép trợ lý này')
  })
})
