import { describe, expect, it, vi } from 'vitest'

import type { MatrixCompanyRequest, MatrixCompanyValue } from '../../shared/matrix-company'

import { MatrixCompanyError } from './company'
import { type CompanyDirectoryAccount, readCompanyChannelDirectory } from './company-directory'
import { directoryConfirms } from './company-room-guard'

const companyId = '00000000-0000-4000-8000-3f27f2fc4915'
const publicChannel = '00000000-0000-4000-8000-f19cafd05964'
const privateChannel = '00000000-0000-4000-8000-be9a925bf429'
const ref = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE'

const admitted = (): MatrixCompanyValue => {
  const row = (id: string, visibility: 'public' | 'private', roomId: string) => ({
    schemaVersion: 5 as const,
    channel: {
      id,
      companyId,
      displayName: visibility,
      visibility,
      topic: '',
      purpose: '',
      state: 'active' as const,
      ownerMemberRef: ref,
      authorityGeneration: 1,
      channelGeneration: 1,
      metadataRevision: 1
    },
    selfAdmission: { memberRef: ref, state: 'active' as const, admissionEpoch: 1, admissionGeneration: 1 },
    memberCount: 2,
    room: { state: 'ready' as const, roomId },
    actions: [] as never[]
  })

  return {
    schemaVersion: 5,
    channels: [row(publicChannel, 'public', '!public:atum.example'), row(privateChannel, 'private', '!private:atum.example')]
  }
}

const legacy = (): MatrixCompanyValue => ({
  schemaVersion: 2,
  channels: [
    {
      schemaVersion: 2,
      channel: {
        id: publicChannel,
        companyId,
        displayName: 'general',
        visibility: 'company',
        state: 'active',
        projectId: null,
        authorityGeneration: 1,
        channelGeneration: 1
      },
      memberCount: 2,
      room: { state: 'ready', roomId: '!public:atum.example' }
    }
  ]
})

function account(handlers: Partial<Record<MatrixCompanyRequest['action'], () => MatrixCompanyValue | Error>>) {
  const company = vi.fn(async (input: MatrixCompanyRequest) => {
    const handler = handlers[input.action]

    if (!handler) {
      throw new MatrixCompanyError('unavailable')
    }

    const value = handler()

    if (value instanceof Error) {
      throw value
    }

    return value
  })

  return { company } satisfies CompanyDirectoryAccount
}

const signal = () => new AbortController().signal

describe('the directory that decides which rooms are company channels', () => {
  it('lists private channels when the admitted directory is served', async () => {
    const source = account({ 'admitted-channels': admitted })
    const directory = await readCompanyChannelDirectory(source, companyId, signal())

    expect(source.company).toHaveBeenCalledTimes(1)
    expect(directoryConfirms(directory, { channelId: privateChannel }, '!private:atum.example')).toBe(true)
    expect(directoryConfirms(directory, { channelId: publicChannel }, '!public:atum.example')).toBe(true)
  })

  it.each(['missing', 'invalid'] as const)('reads 1.1 when the admitted directory answers %s', async code => {
    const source = account({ 'admitted-channels': () => new MatrixCompanyError(code), 'list-channels': legacy })
    const directory = await readCompanyChannelDirectory(source, companyId, signal())

    expect(source.company.mock.calls.map(([input]) => input.action)).toEqual(['admitted-channels', 'list-channels'])
    // Older servers mean public-only: the private room is not confirmed, so it is never guarded or searched.
    expect(directoryConfirms(directory, { channelId: publicChannel }, '!public:atum.example')).toBe(true)
    expect(directoryConfirms(directory, { channelId: privateChannel }, '!private:atum.example')).toBe(false)
  })

  it('does not recast a transient 503 as an older public-only server', async () => {
    const source = account({ 'admitted-channels': () => new MatrixCompanyError('unavailable'), 'list-channels': legacy })

    await expect(readCompanyChannelDirectory(source, companyId, signal())).rejects.toMatchObject({ code: 'unavailable' })
    expect(source.company).toHaveBeenCalledTimes(1)
  })

  it.each(['authentication', 'limit', 'cancelled', 'denied', 'conflict'] as const)(
    'does not quietly read a narrower directory after %s',
    async code => {
      const source = account({ 'admitted-channels': () => new MatrixCompanyError(code), 'list-channels': legacy })

      await expect(readCompanyChannelDirectory(source, companyId, signal())).rejects.toMatchObject({ code })
      expect(source.company).toHaveBeenCalledTimes(1)
    }
  )

  it('a signed-out account is a failed read, not an older server', async () => {
    const source = account({ 'admitted-channels': () => new Error('matrix_domain_signed_out'), 'list-channels': legacy })

    await expect(readCompanyChannelDirectory(source, companyId, signal())).rejects.toThrow('matrix_domain_signed_out')
    expect(source.company).toHaveBeenCalledTimes(1)
  })

  it('stops between the two reads when the request was cancelled', async () => {
    const controller = new AbortController()

    const source = account({
      'admitted-channels': () => {
        controller.abort()

        return new MatrixCompanyError('unavailable')
      },
      'list-channels': legacy
    })

    await expect(readCompanyChannelDirectory(source, companyId, controller.signal)).rejects.toBeDefined()
    expect(source.company).toHaveBeenCalledTimes(1)
  })
})
