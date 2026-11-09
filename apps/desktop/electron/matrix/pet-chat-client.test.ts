import { readFileSync } from 'node:fs'

import { describe, expect, it, vi } from 'vitest'

import {
  MatrixPetChatAuthenticationError,
  parsePetChatHistoryIpcInput,
  parsePetChatIpcInput,
  requestMatrixPetChat,
  requestMatrixPetChatHistory
} from './pet-chat-client'

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`../../shared/pet-chat/fixtures/pet-chat/v1/fixtures/${name}`, import.meta.url), 'utf8')
  )

const resource = 'https://shell.example/api/matrix/v1'
const grant = { accessToken: 'grant-token' } as never
const request = fixture('request.json')
const signal = new AbortController().signal

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

describe('pet chat client', () => {
  it('posts the exact companion request to the Matrix domain resource and parses the reply', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => ok(fixture('reply-with-action.json')))

    const reply = await requestMatrixPetChat(resource, grant, request, signal, { fetchImpl: fetchImpl as never })

    expect(fetchImpl).toHaveBeenCalledOnce()
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://shell.example/api/matrix/v1/pets/chat')
    expect(init.body).toBe(JSON.stringify(request))
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer grant-token')
    expect(reply.reply).toBe('Mình ngồi đây.')
    expect(reply.action).toEqual({ action: 'sit' })
  })

  it('accepts a domain resource with a trailing slash', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => ok(fixture('reply.json')))

    await requestMatrixPetChat('https://shell.example/api/matrix/v1/', grant, request, signal, {
      fetchImpl: fetchImpl as never
    })
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://shell.example/api/matrix/v1/pets/chat')
  })

  it('marks a refused domain grant for the account to refresh and retry', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response('{}', { status: 401 }))

    await expect(
      requestMatrixPetChat(resource, grant, request, signal, { fetchImpl: fetchImpl as never })
    ).rejects.toBeInstanceOf(MatrixPetChatAuthenticationError)
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('retries one dropped connection with the same message id', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(ok(fixture('reply.json')))

    const reply = await requestMatrixPetChat(resource, grant, request, signal, { fetchImpl: fetchImpl as never })

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const first = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string)
    const second = JSON.parse((fetchImpl.mock.calls[1]![1] as RequestInit).body as string)
    expect(first.message_id).toBe(second.message_id)
    expect(reply.reply).toBe('Mình đang nghe nè.')
  })

  it('does not retry a typed refusal or a typed 503', async () => {
    const insufficient = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify(fixture('error-insufficient-protons.json')), { status: 402 })
    )

    await expect(
      requestMatrixPetChat(resource, grant, request, signal, { fetchImpl: insufficient as never })
    ).rejects.toMatchObject({ code: 'insufficient_protons' })
    expect(insufficient).toHaveBeenCalledOnce()

    const unavailable = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ error: { code: 'temporarily_unavailable' } }), { status: 503 })
    )
    await expect(
      requestMatrixPetChat(resource, grant, request, signal, { fetchImpl: unavailable as never })
    ).rejects.toMatchObject({ code: 'temporarily_unavailable' })
    expect(unavailable).toHaveBeenCalledOnce()
  })

  it('reads history without a model call', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => ok(fixture('history.json')))

    const history = await requestMatrixPetChatHistory(
      resource,
      grant,
      { kind: 'personal', pet_id: '00000000-0000-4000-8000-25c26055aeb6' },
      signal,
      { fetchImpl: fetchImpl as never }
    )

    expect(fetchImpl.mock.calls[0]![0]).toBe('https://shell.example/api/matrix/v1/pets/chat/history')
    expect(history.pet_key).toBe('personal:00000000-0000-4000-8000-25c26055aeb6')
    expect(history.recent).toHaveLength(2)
  })

  it('rejects a malformed reply instead of passing it to the renderer', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => ok(fixture('reply-unknown-action.json')))
    await expect(
      requestMatrixPetChat(resource, grant, request, signal, { fetchImpl: fetchImpl as never })
    ).rejects.toThrow('invalid_pet_chat')
  })
})

describe('pet chat IPC input', () => {
  it('accepts exactly the contract request and rejects forbidden or extra fields', () => {
    expect(parsePetChatIpcInput(request)).toEqual(request)
    expect(parsePetChatIpcInput(fixture('request-forbidden-field.json'))).toBeUndefined()
    expect(parsePetChatIpcInput({ ...request, extra: true })).toBeUndefined()
    expect(parsePetChatIpcInput(fixture('request-empty-message.json'))).toBeUndefined()
  })

  it('accepts only a closed ref for history', () => {
    expect(parsePetChatHistoryIpcInput(fixture('history.request.json'))).toEqual({
      ref: { kind: 'personal', pet_id: '00000000-0000-4000-8000-25c26055aeb6' }
    })
    expect(parsePetChatHistoryIpcInput({ ref: { kind: 'bundled', slug: 'rex' } })).toBeUndefined()
    expect(parsePetChatHistoryIpcInput({ ref: request.ref, room_id: '!room' })).toBeUndefined()
  })
})
