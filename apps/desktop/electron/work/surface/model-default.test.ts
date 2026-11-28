import { afterEach, expect, it, vi } from 'vitest'

import { ATUM_WORK_MODEL, ATUM_WORK_PROVIDER } from '../sidecar/process'

import { watchWorkModelDefault } from './model-default'

const atum = { instanceId: ATUM_WORK_PROVIDER, model: ATUM_WORK_MODEL }
const claude = { instanceId: 'claudeAgent', model: 'claude-sonnet-5-5' }
const codex = { instanceId: 'codex', model: 'gpt-6.2-sol' }

function provider(instanceId: string, type: string, label: string, ...models: string[]) {
  return {
    instanceId, driver: instanceId, enabled: true, installed: true, status: 'ready',
    auth: { status: 'authenticated', type, label },
    models: models.map(slug => ({ slug, name: slug, isCustom: false }))
  }
}

function connect() {
  const writes = vi.fn()
  const statuses = vi.fn()
  let markSubscribed!: () => void
  const subscribed = new Promise<void>(resolve => {markSubscribed = resolve})
  let active: FixtureSocket

  class FixtureSocket extends EventTarget {
    constructor() {
      super()
      active = this
      queueMicrotask(() => this.dispatchEvent(new Event('open')))
    }

    send(raw: string) {
      const { id, tag, payload } = JSON.parse(raw)

      if (tag === 'subscribeServerConfig') {markSubscribed()}

      if (tag !== 'server.updateSettings') {return}
      writes(payload.patch)
      queueMicrotask(() => this.receive({
        _tag: 'Exit', requestId: id, exit: { _tag: 'Success', value: payload.patch }
      }))
    }

    receive(frame: object) {
      this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) }))
    }

    close() {
      this.dispatchEvent(new Event('close'))
    }
  }

  vi.stubGlobal('WebSocket', FixtureSocket)
  const controller = new AbortController()
  const owner = { fetch: vi.fn(async () => Response.json({ ticket: 'fixture' })) }
  const ready = watchWorkModelDefault('http://127.0.0.1:8137', owner, controller.signal, () => true, statuses)

  return {
    ready, writes, statuses,
    chunk: async (update: object) => {
      await subscribed
      active.receive({ _tag: 'Chunk', requestId: '1', values: [update] })
    },
    close: () => controller.abort()
  }
}

afterEach(() => vi.unstubAllGlobals())

it('applies the best available model in the shared plan order and returns to Atum on sign-out', async () => {
  const work = connect()
  const chatgpt = provider('codex', 'chatgpt', 'ChatGPT Plus', codex.model)
  const sonnet = provider('claudeAgent', 'claude.ai', 'Claude Pro', 'claude-sonnet-4-6', claude.model, 'claude-opus-5-5')

  try {
    await work.chunk({ type: 'snapshot', config: { settings: { defaultModelSelection: atum }, providers: [chatgpt, sonnet] } })
    await work.ready
    expect(work.statuses).toHaveBeenLastCalledWith([chatgpt, sonnet])
    expect(work.writes.mock.calls).toEqual([[{ defaultModelSelection: claude }]])
    await work.chunk({ type: 'providerStatuses', payload: { providers: [chatgpt] } })
    expect(work.statuses).toHaveBeenLastCalledWith([chatgpt])
    expect(work.writes).toHaveBeenLastCalledWith({ defaultModelSelection: codex })
    await work.chunk({ type: 'providerStatuses', payload: { providers: [] } })
    expect(work.writes).toHaveBeenLastCalledWith({ defaultModelSelection: atum })
  } finally {
    work.close()
  }
})

it('keeps the Atum fallback until a usable subscription is observed', async () => {
  const work = connect()
  const free = provider('codex', 'chatgpt', 'ChatGPT Free', codex.model)
  const opencode = provider('opencode', 'opencode', 'OpenCode', 'opencode/deepseek-v9-flash')
  const apiKey = provider('claudeAgent', 'apiKey', 'Claude', claude.model)

  try {
    await work.chunk({ type: 'snapshot', config: { settings: { defaultModelSelection: atum }, providers: [free, opencode, apiKey] } })
    await work.ready
    expect(work.writes).not.toHaveBeenCalled()
    const go = 'opencode-go/deepseek-v4.1-flash'
    await work.chunk({ type: 'providerStatuses', payload: { providers: [provider('opencode', 'opencode', 'OpenCode', go)] } })
    expect(work.writes).toHaveBeenCalledExactlyOnceWith({ defaultModelSelection: { instanceId: 'opencode', model: go } })
  } finally {
    work.close()
  }
})

it('keeps an explicit environment default as the native catalog changes', async () => {
  const work = connect()
  const explicit = { instanceId: 'codex', model: 'gpt-6.2-astra' }

  try {
    await work.chunk({ type: 'snapshot', config: { settings: { defaultModelSelection: explicit }, providers: [] } })
    await work.ready
    await work.chunk({ type: 'providerStatuses', payload: { providers: [provider('claudeAgent', 'claude.ai', 'Claude Pro', claude.model)] } })
    expect(work.writes).not.toHaveBeenCalled()
  } finally {
    work.close()
  }
})
