import { afterEach, describe, expect, it, vi } from 'vitest'

import { assistantDefinitionWriteWire, type AtumAssistantDefinitionWrite } from '../../shared/atum-agent-portability'

import {
  createMatrixAgent,
  getMatrixAgentSkill,
  listMatrixAgentDefinitions,
  MAXIMUM_SKILL_RESPONSE_BYTES,
  publishMatrixPersonalPet,
  putMatrixAgentSkill,
  readMatrixAgentDefinition,
  readMatrixAgentMemory,
  requestMatrixAgentPet,
  requestMatrixAgentProfiles,
  retireMatrixAgent,
  writeMatrixAgentAvatar,
  writeMatrixAgentDefinition,
  writeMatrixAgentMemory
} from './agent-definition'
import type { MatrixAgentDefinitionError } from './agent-definition'

const ASSISTANT = '00000000-0000-4000-8000-af16785cab34'
const OTHER_ASSISTANT = '00000000-0000-4000-8000-c2f6ff001058'
const IDENTITY = '00000000-0000-4000-8000-33eadc33b125'
const PRINCIPAL = '00000000-0000-4000-8000-f257a03cc663'
const OTHER_PRINCIPAL = '00000000-0000-4000-8000-5b3379da4cd1'
const HASH = 'a'.repeat(64)
const resource = 'https://matrix.test/atum'
const grant = {
  accessToken: 'native-only-token',
  refreshToken: 'not-sent',
  issuer: 'https://id.test/',
  subject: 'alice'
}

const definition = {
  schema_version: 1,
  soul: 'Keep answers compact.',
  model_alias: 'binh-minh',
  reasoning: { enabled: true, effort: 'medium' },
  skills: []
}

function record(overrides: Record<string, unknown> = {}) {
  return {
    id: ASSISTANT,
    identity_id: IDENTITY,
    principal: PRINCIPAL,
    display_name: 'Helper',
    avatar: '🌙',
    avatar_url: null,
    is_default: true,
    lifecycle_revision: 2,
    status: 'active',
    identity_revision: 3,
    definition_revision: 4,
    ...overrides
  }
}

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    assistant: record(),
    definition,
    definition_revision: 4,
    identity_revision: 3,
    ...overrides
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })
}

afterEach(() => vi.unstubAllGlobals())

describe('Matrix agent-definition client', () => {
  const pet = { ref: { kind: 'bundled' as const, slug: 'gigi' }, enabled: false, scale: 1 }
  const owner = 'owner-a'
  const expected = { owner, agent: PRINCIPAL }
  const savedPet = {
    ...expected,
    revision: 4,
    pet,
    provenance: 'explicit',
    access: 'owned',
    visitEndsAt: null,
    serverTime: '2026-10-03T00:00:00.000Z'
  }

  it.each([
    ['NUL name', 'good\0name', 'ok'],
    ['C0 name', 'good\tname', 'ok'],
    ['UTF-16 name limit', '🙂'.repeat(51), 'ok'],
    ['oversize UTF-8 name', '界'.repeat(101), 'ok'],
    ['oversize UTF-8 description', '界'.repeat(2001), 'ok'],
    ['lone surrogate', 'good', '\ud800']
  ])('rejects %s personal-pet metadata before any publish request', async (_label, displayName, description) => {
    const request = vi.fn()
    vi.stubGlobal('fetch', request)
    await expect(
      publishMatrixPersonalPet(
        resource,
        grant,
        {
          requestId: ASSISTANT,
          creditEntitlementId: OTHER_ASSISTANT,
          displayName,
          description,
          bundle: { schema_version: 1, sha256: HASH, files: [] }
        },
        AbortSignal.timeout(1000)
      )
    ).rejects.toThrow('matrix_agent_definition_invalid')
    expect(request).not.toHaveBeenCalled()
  })

  it('reads and writes pets on the fixed owner-authorized endpoint with strict CAS and no replay', async () => {
    const request = vi.fn(async () => json(savedPet))
    vi.stubGlobal('fetch', request)
    await expect(
      requestMatrixAgentPet(resource, grant, ASSISTANT, expected, AbortSignal.timeout(1000))
    ).resolves.toEqual(savedPet)
    await expect(
      requestMatrixAgentPet(resource, grant, ASSISTANT, expected, AbortSignal.timeout(1000), { revision: 4, pet })
    ).resolves.toEqual(savedPet)
    expect(request).toHaveBeenLastCalledWith(
      `${resource}/agents/${ASSISTANT}/pet`,
      expect.objectContaining({
        method: 'PUT',
        redirect: 'error',
        headers: { Authorization: 'Bearer native-only-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ expected_revision: 4, pet })
      })
    )
    request.mockResolvedValue(json({}, 409))
    await expect(
      requestMatrixAgentPet(resource, grant, ASSISTANT, expected, AbortSignal.timeout(1000), { revision: 3, pet })
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(request).toHaveBeenCalledTimes(3)
  })

  it('rejects mismatched pet acknowledgements and another owner or agent', async () => {
    for (const change of [
      { owner: 'other' },
      { agent: 'other' },
      { revision: 2 },
      { revision: 6 },
      { provenance: 'default' },
      { pet: { ...pet, enabled: true } }
    ]) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => json({ ...savedPet, ...change }))
      )
      await expect(
        requestMatrixAgentPet(resource, grant, ASSISTANT, expected, AbortSignal.timeout(1000), { revision: 4, pet })
      ).rejects.toThrow()
    }
  })

  it('bounds the pet response and rejects invalid targets and revisions before fetching', async () => {
    const request = vi.fn(async () => json({ ...savedPet, padding: 'x'.repeat(4096) }))
    vi.stubGlobal('fetch', request)
    await expect(
      requestMatrixAgentPet(resource, grant, ASSISTANT, expected, AbortSignal.timeout(1000))
    ).rejects.toMatchObject({ code: 'invalid' })
    await expect(
      requestMatrixAgentPet(resource, grant, '../escape', expected, AbortSignal.timeout(1000))
    ).rejects.toThrow()
    await expect(
      requestMatrixAgentPet(resource, grant, ASSISTANT, expected, AbortSignal.timeout(1000), { revision: -1, pet })
    ).rejects.toThrow()
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('uses the fixed domain URL and native bearer grant for canonical records', async () => {
    const request = vi.fn(async () => json([record({
      title: 'Research partner', mark_shape: 'heart', mark_color: 'coral'
    })]))
    vi.stubGlobal('fetch', request)

    await expect(listMatrixAgentDefinitions(resource, grant, new AbortController().signal)).resolves.toEqual([
      expect.objectContaining({ id: ASSISTANT, principal: PRINCIPAL, definitionRevision: 4,
        title: 'Research partner', mark: { shape: 'heart', color: 'coral' } })
    ])

    expect(request).toHaveBeenCalledWith(
      'https://matrix.test/atum/agents',
      expect.objectContaining({
        headers: { Authorization: 'Bearer native-only-token' },
        redirect: 'error',
        signal: expect.any(AbortSignal)
      })
    )
  })

  it('accepts an older roster without presentation and rejects partial or unknown marks', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json([record()])))
    await expect(listMatrixAgentDefinitions(resource, grant, AbortSignal.timeout(1000))).resolves.toEqual([
      expect.not.objectContaining({ mark: expect.anything(), title: expect.anything() })
    ])
    for (const bad of [
      record({ mark_shape: 'heart' }),
      record({ mark_shape: 'blob', mark_color: 'blue' }),
      record({ title: ' bad ' })
    ]) {
      vi.stubGlobal('fetch', vi.fn(async () => json([bad])))
      await expect(listMatrixAgentDefinitions(resource, grant, AbortSignal.timeout(1000))).rejects.toThrow(
        'matrix_agent_definition_invalid'
      )
    }
  })

  it('binds profile requests to the explicit origin and validates the platform envelope', async () => {
    const envelope = {
      originPrincipal: PRINCIPAL,
      originIsMain: true,
      agents: [{
        principal: PRINCIPAL,
        displayName: 'Helper',
        isMain: true,
        definitionRevision: 4,
        identityRevision: 3,
        avatarUrl: null
      }]
    }
    const request = vi.fn(async () => json(envelope))
    vi.stubGlobal('fetch', request)
    await expect(
      requestMatrixAgentProfiles(resource, grant, PRINCIPAL, { operation: 'list' }, AbortSignal.timeout(1000))
    ).resolves.toEqual(envelope)
    expect(request).toHaveBeenCalledWith(
      `${resource}/agent-profiles`,
      expect.objectContaining({
        method: 'POST',
        headers: { Authorization: 'Bearer native-only-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ originPrincipal: PRINCIPAL, request: { operation: 'list' } })
      })
    )

    vi.stubGlobal('fetch', vi.fn(async () => json({ ...envelope, originPrincipal: OTHER_PRINCIPAL })))
    await expect(
      requestMatrixAgentProfiles(resource, grant, PRINCIPAL, { operation: 'list' }, AbortSignal.timeout(1000))
    ).rejects.toMatchObject({ code: 'invalid' })
  })

  it('reads where each agent answers from the roster, as local unless it says cloud', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json([
          record({ answering: 'cloud', answeringChangedAt: 1791100800000 }),
          record({ id: OTHER_ASSISTANT, principal: OTHER_PRINCIPAL, is_default: false, answering: 'local' })
        ])
      )
    )

    const roster = await listMatrixAgentDefinitions(resource, grant, new AbortController().signal)
    expect(roster.map(agent => agent.answering)).toEqual(['cloud', 'local'])

    // An older platform says nothing, and a value this client does not know never reads as cloud.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json([record(), record({ id: OTHER_ASSISTANT, principal: OTHER_PRINCIPAL, is_default: false, answering: 'hybrid' })])
      )
    )

    const older = await listMatrixAgentDefinitions(resource, grant, new AbortController().signal)
    expect(older.map(agent => agent.answering)).toEqual([undefined, undefined])
  })

  it('requires the requested assistant and principal projection, never accepting another agent record', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(snapshot({ assistant: record({ id: OTHER_ASSISTANT }) })))
    )
    await expect(
      readMatrixAgentDefinition(resource, grant, ASSISTANT, new AbortController().signal)
    ).rejects.toMatchObject({ code: 'invalid' })

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json([record({ principal: 'not-a-principal' })]))
    )
    await expect(listMatrixAgentDefinitions(resource, grant, new AbortController().signal)).rejects.toMatchObject({
      code: 'invalid'
    })
  })

  it('reads explicit retired-agent metadata beside the active default while definition reads remain active-only', async () => {
    const retired = record({ id: OTHER_ASSISTANT, principal: OTHER_PRINCIPAL, status: 'retired', is_default: false })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json([record({ retired_agents: [retired] })]))
    )
    const roster = await listMatrixAgentDefinitions(resource, grant, new AbortController().signal)
    expect(roster).toEqual([
      expect.objectContaining({ principal: PRINCIPAL, status: 'active', isDefault: true }),
      expect.objectContaining({ principal: OTHER_PRINCIPAL, status: 'retired', isDefault: false })
    ])
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(snapshot({ assistant: retired })))
    )
    await expect(
      readMatrixAgentDefinition(resource, grant, OTHER_ASSISTANT, new AbortController().signal)
    ).rejects.toMatchObject({ code: 'invalid' })
  })

  it('refuses ambiguous or active tombstones before any local retirement can run', async () => {
    const retired = record({ id: OTHER_ASSISTANT, principal: OTHER_PRINCIPAL, status: 'retired', is_default: false })

    for (const rows of [
      [record({ retired_agents: null })],
      [record({ retired_agents: [record({ ...retired, status: 'active' })] })],
      [record({ retired_agents: [record({ ...retired, is_default: true })] })],
      [record({ retired_agents: [record({ ...retired, principal: PRINCIPAL })] })],
      [record({ retired_agents: [record({ ...retired, id: ASSISTANT })] })],
      [record({ retired_agents: [record({ ...retired, retired_agents: [] })] })],
      [record(), record({ ...retired, status: 'active', retired_agents: [] })]
    ]) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => json(rows))
      )
      await expect(listMatrixAgentDefinitions(resource, grant, new AbortController().signal)).rejects.toMatchObject({
        code: 'invalid'
      })
    }
  })

  it('writes exactly the version-fenced portable wire body and validates its accepted owner response', async () => {
    const request = vi.fn(async () =>
      json(
        snapshot({
          assistant: record({ definition_revision: 5 }),
          definition_revision: 5
        })
      )
    )

    vi.stubGlobal('fetch', request)

    await expect(
      writeMatrixAgentDefinition(
        resource,
        grant,
        ASSISTANT,
        {
          expectedDefinitionRevision: 4,
          expectedIdentityRevision: 3,
          displayName: 'Helper',
          avatar: '🌙',
          definition: {
            schemaVersion: 1,
            soul: definition.soul,
            modelAlias: 'binh-minh',
            reasoning: { enabled: true, effort: 'medium' },
            skills: []
          }
        },
        new AbortController().signal
      )
    ).resolves.toMatchObject({ definitionRevision: 5 })

    const [url, init] = request.mock.calls[0]! as unknown as [string, RequestInit]
    expect(url).toBe('https://matrix.test/atum/agents/00000000-0000-4000-8000-af16785cab34/definition')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(String(init.body))).toEqual({
      expected_definition_revision: 4,
      expected_identity_revision: 3,
      display_name: 'Helper',
      avatar: '🌙',
      definition
    })
  })

  it('sends canonical avatar bytes only to the fixed agent avatar endpoint', async () => {
    const request = vi.fn(async () => json(snapshot({
      assistant: record({ avatar_url: 'https://cdn.atum.test/agent.png' })
    })))
    vi.stubGlobal('fetch',request)
    const bytes = Uint8Array.from([137,80,78,71,13,10,26,10])

    await expect(writeMatrixAgentAvatar(
      resource,grant,ASSISTANT,PRINCIPAL,PRINCIPAL,{type:'image/png',bytes},new AbortController().signal
    )).resolves.toMatchObject({assistant:{principal:PRINCIPAL,avatarUrl:'https://cdn.atum.test/agent.png'}})

    const calls = request.mock.calls as unknown as Array<[string, RequestInit]>
    const [url,init] = calls[0]!
    expect(url).toBe(`https://matrix.test/atum/agents/${ASSISTANT}/avatar`)
    expect(init.method).toBe('PUT')
    expect(JSON.parse(String(init.body))).toEqual({
      originPrincipal:PRINCIPAL,
      targetPrincipal:PRINCIPAL,
      avatar:{type:'image/png',base64:Buffer.from(bytes).toString('base64')}
    })
    expect(init.headers).toMatchObject({Authorization:'Bearer native-only-token','Content-Type':'application/json'})

    await writeMatrixAgentAvatar(
      resource,grant,ASSISTANT,null,PRINCIPAL,null,new AbortController().signal
    )
    expect(JSON.parse(String(calls[1]![1].body))).toEqual({
      originPrincipal:null,
      targetPrincipal:PRINCIPAL,
      avatar:null
    })
  })

  it('accepts only a zero-revision null definition and does not turn it into a definition object', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json(
          snapshot({
            assistant: record({ definition_revision: 0 }),
            definition: null,
            definition_revision: 0
          })
        )
      )
    )
    await expect(
      readMatrixAgentDefinition(resource, grant, ASSISTANT, new AbortController().signal)
    ).resolves.toMatchObject({
      definition: null,
      definitionRevision: 0
    })

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(snapshot({ definition: null })))
    )
    await expect(
      readMatrixAgentDefinition(resource, grant, ASSISTANT, new AbortController().signal)
    ).rejects.toMatchObject({ code: 'invalid' })
  })

  it('reads and acknowledges a maximum-sized write with added canonical response metadata', async () => {
    const input: AtumAssistantDefinitionWrite = {
      expectedDefinitionRevision: 4,
      expectedIdentityRevision: 3,
      displayName: 'Helper',
      avatar: '🌙',
      definition: {
        schemaVersion: 1,
        soul: '',
        modelAlias: 'binh-minh',
        reasoning: null,
        skills: Array.from({ length: 512 }, (_, index) => ({ name: String(index).padStart(200, 's'), sha256: HASH }))
      }
    }

    const remaining = 262_144 - Buffer.byteLength(JSON.stringify(assistantDefinitionWriteWire(input)))
    input.definition.soul = '\n'.repeat(Math.floor(remaining / 2)) + 'x'.repeat(remaining % 2)
    const wire = assistantDefinitionWriteWire(input)
    expect(Buffer.byteLength(JSON.stringify(wire))).toBe(262_144)
    const response = snapshot({
      assistant: record({ definition_revision: 5 }),
      definition: wire.definition,
      definition_revision: 5
    })
    expect(Buffer.byteLength(JSON.stringify(response))).toBeGreaterThan(262_144)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(response))
    )

    await expect(
      writeMatrixAgentDefinition(resource, grant, ASSISTANT, input, new AbortController().signal)
    ).resolves.toMatchObject({ definitionRevision: 5, definition: input.definition })
    await expect(
      readMatrixAgentDefinition(resource, grant, ASSISTANT, new AbortController().signal)
    ).resolves.toMatchObject({ definitionRevision: 5, definition: input.definition })
  })

  it('round-trips astral names and avatars using canonical code-point limits', async () => {
    const displayName = '🙂'.repeat(40)
    const avatar = '🤖'.repeat(16)
    const assistant = record({ display_name: displayName, avatar })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json([assistant]))
    )
    await expect(listMatrixAgentDefinitions(resource, grant, new AbortController().signal)).resolves.toEqual([
      expect.objectContaining({ displayName, avatar })
    ])
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(snapshot({ assistant })))
    )
    await expect(
      writeMatrixAgentDefinition(
        resource,
        grant,
        ASSISTANT,
        {
          expectedDefinitionRevision: 4,
          expectedIdentityRevision: 3,
          displayName,
          avatar,
          definition: { schemaVersion: 1, soul: definition.soul, modelAlias: 'binh-minh', reasoning: null, skills: [] }
        },
        new AbortController().signal
      )
    ).resolves.toMatchObject({ assistant: { displayName, avatar } })

    for (const invalidIdentity of [{ display_name: `${displayName}🙂` }, { avatar: `${avatar}🤖` }]) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => json([record(invalidIdentity)]))
      )
      await expect(listMatrixAgentDefinitions(resource, grant, new AbortController().signal)).rejects.toMatchObject({
        code: 'invalid'
      })
    }
  })

  it.each([
    [401, 'denied'],
    [403, 'denied'],
    [404, 'missing'],
    [409, 'conflict'],
    [503, 'unavailable']
  ] as const)('maps status %i to typed %s without retrying', async (status, code) => {
    const request = vi.fn(async () => new Response('', { status }))
    vi.stubGlobal('fetch', request)

    await expect(listMatrixAgentDefinitions(resource, grant, new AbortController().signal)).rejects.toMatchObject({
      code
    } satisfies Partial<MatrixAgentDefinitionError>)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('rejects redirects, malformed JSON, and oversized bodies as bounded failures', async () => {
    const redirect = vi.fn(async () => new Response('', { status: 302, headers: { location: 'https://evil.test' } }))
    vi.stubGlobal('fetch', redirect)
    await expect(listMatrixAgentDefinitions(resource, grant, new AbortController().signal)).rejects.toMatchObject({
      code: 'unavailable'
    })
    expect((redirect.mock.calls as unknown as Array<[string, RequestInit]>)[0]?.[1]).toMatchObject({
      redirect: 'error'
    })

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { headers: { 'content-type': 'application/json' } }))
    )
    await expect(listMatrixAgentDefinitions(resource, grant, new AbortController().signal)).rejects.toMatchObject({
      code: 'invalid'
    })

    const cancel = vi.fn()

    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(1_048_577))
      },
      cancel
    })

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { headers: { 'content-type': 'application/json' } }))
    )
    await expect(listMatrixAgentDefinitions(resource, grant, new AbortController().signal)).rejects.toMatchObject({
      code: 'invalid'
    })
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('honors a caller abort before dispatch', async () => {
    const request = vi.fn(async () => json([]))
    vi.stubGlobal('fetch', request)
    const signal = AbortSignal.abort(new Error('cancelled by owner'))

    await expect(listMatrixAgentDefinitions(resource, grant, signal)).rejects.toThrow('cancelled by owner')
    expect(request).not.toHaveBeenCalled()
  })

  it('reads and revision-fences portable memory on the native agent route', async () => {
    const snapshot = { memory: ['Portable memory'], user: ['Owner'] }
    const saved = { assistant_id: ASSISTANT, revision: 7, enabled: true, snapshot }
    const request = vi.fn(async () => json(saved))
    vi.stubGlobal('fetch', request)

    await expect(
      readMatrixAgentMemory(resource, grant, ASSISTANT, new AbortController().signal)
    ).resolves.toEqual({ assistantId: ASSISTANT, revision: 7, enabled: true, snapshot })
    await expect(
      writeMatrixAgentMemory(
        resource,
        grant,
        ASSISTANT,
        { expected_revision: 6, enabled: true, snapshot },
        new AbortController().signal
      )
    ).resolves.toMatchObject({ revision: 7, snapshot })

    expect(request).toHaveBeenNthCalledWith(
      1,
      `${resource}/agents/${ASSISTANT}/memory`,
      expect.objectContaining({ headers: { Authorization: 'Bearer native-only-token' } })
    )
    expect(request).toHaveBeenNthCalledWith(
      2,
      `${resource}/agents/${ASSISTANT}/memory`,
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ expected_revision: 6, enabled: true, snapshot })
      })
    )

    request.mockResolvedValueOnce(json({}, 409))
    await expect(
      writeMatrixAgentMemory(
        resource,
        grant,
        ASSISTANT,
        { expected_revision: 6, enabled: true, snapshot },
        new AbortController().signal
      )
    ).rejects.toMatchObject({ code: 'conflict' })

    request.mockResolvedValueOnce(json({ ...saved, assistant_id: OTHER_ASSISTANT }))
    await expect(
      readMatrixAgentMemory(resource, grant, ASSISTANT, new AbortController().signal)
    ).rejects.toMatchObject({ code: 'invalid' })
  })

  it('rejects invalid memory writes before sending a native request', async () => {
    const request = vi.fn()
    vi.stubGlobal('fetch', request)

    for (const input of [
      { expected_revision: -1, enabled: true, snapshot: { memory: [], user: [] } },
      { expected_revision: 0, enabled: true, snapshot: { memory: [' repeated '], user: [] } },
      { expected_revision: 0, enabled: true, snapshot: { memory: ['same', 'same'], user: [] } }
    ]) {
      await expect(
        writeMatrixAgentMemory(resource, grant, ASSISTANT, input, new AbortController().signal)
      ).rejects.toMatchObject({ code: 'invalid' })
    }

    expect(request).not.toHaveBeenCalled()
  })

  it('uses the shared bundle validator and only accepts the available acknowledgement', async () => {
    const bundle = { schema_version: 1 as const, sha256: HASH, files: [] }
    const request = vi.fn(async () => json({ sha256: HASH, status: 'available' }))
    vi.stubGlobal('fetch', request)

    await expect(
      putMatrixAgentSkill(resource, grant, ASSISTANT, bundle, new AbortController().signal)
    ).resolves.toEqual({
      sha256: HASH,
      status: 'available'
    })
    const [skillUrl, skillInit] = (request.mock.calls as unknown as Array<[string, RequestInit]>)[0]!
    expect(skillUrl).toBe(`https://matrix.test/atum/agents/${ASSISTANT}/skills/${HASH}`)
    expect(JSON.parse(String(skillInit.body))).toEqual(bundle)

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ sha256: HASH, status: 'queued' }))
    )
    await expect(
      putMatrixAgentSkill(resource, grant, ASSISTANT, bundle, new AbortController().signal)
    ).rejects.toMatchObject({ code: 'invalid' })

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ ...bundle, sha256: 'b'.repeat(64) }))
    )
    await expect(
      getMatrixAgentSkill(resource, grant, ASSISTANT, HASH, new AbortController().signal)
    ).rejects.toMatchObject({ code: 'invalid' })
  })

  it('allows a valid encoded skill bundle larger than the definition response bound', async () => {
    const largeBundle = {
      schema_version: 1,
      sha256: HASH,
      files: [{ path: 'SKILL.md', content_base64: Buffer.from('a'.repeat(900_000)).toString('base64') }]
    }

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(largeBundle))
    )

    await expect(getMatrixAgentSkill(resource, grant, ASSISTANT, HASH, new AbortController().signal)).resolves.toEqual(
      largeBundle
    )
  })

  it("reads a bundle of exactly the platform's 3 MiB cap, and refuses one byte more", async () => {
    const sized = (bytes: number) => {
      const empty = JSON.stringify({
        schema_version: 1,
        sha256: HASH,
        files: [{ path: 'SKILL.md', content_base64: '' }]
      })

      return JSON.stringify({
        schema_version: 1,
        sha256: HASH,
        files: [{ path: 'SKILL.md', content_base64: 'A'.repeat(bytes - Buffer.byteLength(empty)) }]
      })
    }

    const body = (text: string) => new Response(text, { headers: { 'content-type': 'application/json' } })
    expect(Buffer.byteLength(sized(MAXIMUM_SKILL_RESPONSE_BYTES))).toBe(3 * 1024 * 1024)

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => body(sized(MAXIMUM_SKILL_RESPONSE_BYTES)))
    )
    await expect(
      getMatrixAgentSkill(resource, grant, ASSISTANT, HASH, new AbortController().signal)
    ).resolves.toMatchObject({
      sha256: HASH
    })

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => body(sized(MAXIMUM_SKILL_RESPONSE_BYTES + 1)))
    )
    await expect(
      getMatrixAgentSkill(resource, grant, ASSISTANT, HASH, new AbortController().signal)
    ).rejects.toMatchObject({
      code: 'invalid'
    })
  })

  it('gives skill transfers longer than a definition read before calling the link unavailable', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ schema_version: 1, sha256: HASH, files: [] }))
    )

    await getMatrixAgentSkill(resource, grant, ASSISTANT, HASH, new AbortController().signal)
    expect(timeout).toHaveBeenLastCalledWith(60_000)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json([]))
    )
    await listMatrixAgentDefinitions(resource, grant, new AbortController().signal)
    expect(timeout).toHaveBeenLastCalledWith(10_000)
    timeout.mockRestore()
  })
})

// Several agents per person (0146;  §2.7).
const REQUEST = '00000000-0000-4000-8000-c9f98e2c65c7'

describe('creating and retiring agents', () => {
  it("lists each agent's Matrix user, and still lists a platform that has none", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json([
          record({ matrixUser: '@agent-00:atum.test' }),
          record({ id: OTHER_ASSISTANT, principal: OTHER_PRINCIPAL })
        ])
      )
    )
    const [first, second] = await listMatrixAgentDefinitions(resource, grant, new AbortController().signal)
    expect(first!.matrixUser).toBe('@agent-00:atum.test')
    expect(second!.matrixUser).toBeUndefined()

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json([record({ matrixUser: 'not-a-user' })]))
    )
    await expect(listMatrixAgentDefinitions(resource, grant, new AbortController().signal)).rejects.toMatchObject({
      code: 'invalid'
    })
  })

  it('creates an agent by request and name only, and requires its Matrix user', async () => {
    const created = record({ id: OTHER_ASSISTANT, is_default: false, display_name: 'Alfred', matrixUser: '@agent-01:atum.test' })
    const request = vi.fn(async (url: string) =>
      String(url).endsWith('/cloud/disclosure') ? new Response('', { status: 503 }) : json(created)
    )

    vi.stubGlobal('fetch', request)
    const agent = await createMatrixAgent(
      resource,
      grant,
      { requestId: REQUEST, displayName: 'Alfred' },
      new AbortController().signal
    )
    expect(agent).toMatchObject({
      id: OTHER_ASSISTANT,
      displayName: 'Alfred',
      isDefault: false,
      matrixUser: '@agent-01:atum.test'
    })
    expect(agent.cloudPlacement).toBeUndefined()
    // The disclosure read is unavailable: today's two-key body, byte for byte.
    const [url, init] = request.mock.calls.filter(([each]) => String(each).endsWith('/agents')).at(-1) as unknown as [
      string,
      RequestInit
    ]
    expect(url).toBe('https://matrix.test/atum/agents')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ requestId: REQUEST, displayName: 'Alfred' })

    for (const input of [
      { requestId: 'x', displayName: 'Alfred' },
      { requestId: REQUEST, displayName: '  ' },
      { requestId: REQUEST, displayName: 'x'.repeat(41) }
    ]) {
      await expect(createMatrixAgent(resource, grant, input, new AbortController().signal)).rejects.toMatchObject({
        code: 'invalid'
      })
    }

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(record({ id: OTHER_ASSISTANT, is_default: false })))
    )
    await expect(
      createMatrixAgent(resource, grant, { requestId: REQUEST, displayName: 'Alfred' }, new AbortController().signal)
    ).rejects.toMatchObject({ code: 'invalid' })
  })

  it('surfaces a required hire with its price and resends the confirmation', async () => {
    const refusal = { error: 'matrix_409', details: { reason: 'hire_required', hire: { price_protons: 60000, price_micro_protons: 60000000 } } }
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      String(url).endsWith('/cloud/disclosure') ? new Response('', { status: 503 }) : json(refusal, 409)))
    await expect(
      createMatrixAgent(resource, grant, { requestId: REQUEST, displayName: 'Third' }, new AbortController().signal)
    ).rejects.toMatchObject({ code: 'hire_required', refusal: { reason: 'hire_required', hire: { price_protons: 60000 } } })

    const request = vi.fn(async (url: string) =>
      String(url).endsWith('/cloud/disclosure') ? new Response('', { status: 503 })
        : json(record({ id: OTHER_ASSISTANT, is_default: false, display_name: 'Third', matrixUser: '@agent-03:atum.test' })))
    vi.stubGlobal('fetch', request)
    await createMatrixAgent(resource, grant, { requestId: REQUEST, displayName: 'Third', hireConfirmed: true }, new AbortController().signal)
    const [, init] = request.mock.calls.filter(([each]) => String(each).endsWith('/agents')).at(-1) as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({ requestId: REQUEST, displayName: 'Third', hireConfirmed: true })
  })

  it('asks for a cloud placement with the active disclosure version and reads the answer', async () => {
    const request = vi.fn(async (url: string) =>
      String(url).endsWith('/cloud/disclosure')
        ? json({ kind: 'cloud', version: 7 })
        : json(
            record({
              id: OTHER_ASSISTANT,
              is_default: false,
              display_name: 'Alfred',
              matrixUser: '@agent-01:atum.test',
              cloud_placement: 'pending_trust'
            })
          )
    )

    vi.stubGlobal('fetch', request)
    const agent = await createMatrixAgent(
      resource,
      grant,
      { requestId: REQUEST, displayName: 'Alfred' },
      new AbortController().signal
    )

    expect(agent.cloudPlacement).toBe('pending_trust')
    expect(request.mock.calls.map(([url]) => String(url))).toEqual([
      'https://matrix.test/atum/cloud/disclosure',
      'https://matrix.test/atum/agents'
    ])
    const [, init] = request.mock.calls.at(-1) as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({
      requestId: REQUEST,
      displayName: 'Alfred',
      disclosureVersion: 7
    })
  })

  it('cloud-only: a new agent still asks for the cloud after one failed disclosure read', async () => {
    const created = record({ id: OTHER_ASSISTANT, is_default: false, display_name: 'Alfred', matrixUser: '@agent-01:atum.test' })
    let disclosureReads = 0
    const request = vi.fn(async (url: string, _init?: RequestInit) => {
      if (String(url).endsWith('/cloud/disclosure')) {
        disclosureReads += 1

        return disclosureReads === 1 ? new Response('', { status: 503 }) : json({ kind: 'cloud', version: 7 })
      }

      return json({ ...created, cloud_placement: 'placed' })
    })

    vi.stubGlobal('fetch', request)
    const agent = await createMatrixAgent(resource, grant, { requestId: REQUEST, displayName: 'Alfred' }, new AbortController().signal)

    expect(agent.cloudPlacement).toBe('placed')
    expect(disclosureReads).toBe(2)
    const [, init] = request.mock.calls.at(-1) as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toMatchObject({ disclosureVersion: 7 })
  })

  it('keeps a placement it does not know (and a refusal) as an ordinary record', async () => {
    for (const [placement, expected] of [
      ['placed', 'placed'],
      ['capacity', 'capacity'],
      ['no_access', 'no_access'],
      ['consent_mismatch', 'consent_mismatch'],
      ['elsewhere', undefined],
      [undefined, undefined]
    ] as const) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) =>
          String(url).endsWith('/cloud/disclosure')
            ? json({ kind: 'cloud', version: 7 })
            : json(
                record({
                  id: OTHER_ASSISTANT,
                  is_default: false,
                  display_name: 'Alfred',
                  matrixUser: '@agent-01:atum.test',
                  ...(placement === undefined ? {} : { cloud_placement: placement })
                })
              )
        )
      )
      const agent = await createMatrixAgent(
        resource,
        grant,
        { requestId: REQUEST, displayName: 'Alfred' },
        new AbortController().signal
      )
      expect(agent.cloudPlacement).toBe(expected)
    }
  })

  it('retries the old two-key create once when the Shell predates the placement key', async () => {
    const bodies: string[] = []
    const request = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/cloud/disclosure')) {
        return json({ kind: 'cloud', version: 7 })
      }

      bodies.push(String(init?.body))

      return bodies.length === 1
        ? new Response('', { status: 400 })
        : json(record({ id: OTHER_ASSISTANT, is_default: false, matrixUser: '@agent-01:atum.test' }))
    })

    vi.stubGlobal('fetch', request)
    const agent = await createMatrixAgent(
      resource,
      grant,
      { requestId: REQUEST, displayName: 'Alfred' },
      new AbortController().signal
    )

    expect(agent.cloudPlacement).toBeUndefined()
    expect(bodies).toEqual([
      JSON.stringify({ requestId: REQUEST, displayName: 'Alfred', disclosureVersion: 7 }),
      JSON.stringify({ requestId: REQUEST, displayName: 'Alfred' })
    ])
  })

  it('retires an agent with a bodiless DELETE and reads its cleanup state', async () => {
    const request = vi.fn(async () => json({ id: OTHER_ASSISTANT, status: 'retired', sessionCleanup: 'pending' }))
    vi.stubGlobal('fetch', request)
    expect(await retireMatrixAgent(resource, grant, OTHER_ASSISTANT, new AbortController().signal)).toEqual({
      id: OTHER_ASSISTANT,
      status: 'retired',
      sessionCleanup: 'pending'
    })
    const [url, init] = request.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`https://matrix.test/atum/agents/${OTHER_ASSISTANT}`)
    expect(init.method).toBe('DELETE')
    expect(init.body).toBeUndefined()

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ id: ASSISTANT, status: 'retired', sessionCleanup: 'complete' }))
    )
    await expect(
      retireMatrixAgent(resource, grant, OTHER_ASSISTANT, new AbortController().signal)
    ).rejects.toMatchObject({
      code: 'invalid'
    })
  })
})

describe('Matrix owner time-zone report on the roster read', () => {
  it('carries only the caller-provided header and hands the platform ack back', async () => {
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const value = input instanceof Request ? input : new Request(input, init)

      expect(value.headers.get('atum-time-zone')).toBe('Asia/Tokyo')
      expect(value.headers.get('authorization')).toBe('Bearer native-only-token')

      return new Response(JSON.stringify([]), {
        status: 200,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'Atum-Time-Zone-Ack': 'Asia/Tokyo'
        }
      })
    })
    vi.stubGlobal('fetch', request)
    const ack = vi.fn()

    await expect(
      listMatrixAgentDefinitions(resource, grant, new AbortController().signal, {
        headers: { 'Atum-Time-Zone': 'Asia/Tokyo' },
        onTimeZoneAck: ack
      })
    ).resolves.toEqual([])
    expect(ack).toHaveBeenCalledOnce()
    expect(ack).toHaveBeenCalledWith('Asia/Tokyo')
    expect(request).toHaveBeenCalledOnce()
  })

  it('reports an absent ack as undefined, and sends no header when the caller asks for none', async () => {
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const value = input instanceof Request ? input : new Request(input, init)

      expect(value.headers.get('atum-time-zone')).toBeNull()

      return json([])
    })
    vi.stubGlobal('fetch', request)
    const ack = vi.fn()

    await listMatrixAgentDefinitions(resource, grant, new AbortController().signal, { onTimeZoneAck: ack })
    expect(ack).toHaveBeenCalledWith(undefined)

    await listMatrixAgentDefinitions(resource, grant, new AbortController().signal)
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('does not hand out an ack from a refused roster read', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 403 })))
    const ack = vi.fn()

    await expect(
      listMatrixAgentDefinitions(resource, grant, new AbortController().signal, {
        headers: { 'Atum-Time-Zone': 'Asia/Tokyo' },
        onTimeZoneAck: ack
      })
    ).rejects.toMatchObject({ code: 'denied' })
    expect(ack).not.toHaveBeenCalled()
  })
})
