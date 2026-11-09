import { expect, test, vi } from 'vitest'

import type { AtumAssistantPortabilityService } from './atum-agent-portability'
import { registerAtumAssistantPortabilityIpc } from './atum-agent-portability-ipc'
import type { AtumAgentSync } from './atum-agent-sync'

const id = '00000000-0000-4000-8000-00f765af1c54'
test('all sync IPC actions require trusted main-frame authority and expose only typed actions', async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const sync = { statuses: vi.fn(() => []), sync: vi.fn(), setMemoryEnabled: vi.fn(), resolve: vi.fn() }

  const unregister = registerAtumAssistantPortabilityIpc({ handle: (name, handler) => { handlers.set(name, handler) }, removeHandler: name => { handlers.delete(name) } },
    { getAssistantDefinition: vi.fn(), putAssistantDefinition: vi.fn() }, {} as AtumAssistantPortabilityService,
    { assertTrustedSender: event => { if (event !== 'trusted') {throw new Error('untrusted')} } }, sync as unknown as AtumAgentSync)

  for (const name of ['status', 'run', 'memory', 'resolve', 'preferences', 'preferences:patch', 'preferences:seed']) {
    expect(() => handlers.get(`atum:assistants:sync:${name}`)?.('untrusted', id, true)).toThrow('untrusted')
  }
  expect(() => handlers.get('atum:assistants:sync:preferences:patch')?.('trusted', id, { schema_version: 1, api_key: 'forged' })).toThrow('invalid_account_preferences')

  expect(() => handlers.get('atum:assistants:sync:memory')?.('trusted', id, 'true')).toThrow('invalid_sync_request')
  expect(() => handlers.get('atum:assistants:sync:resolve')?.('trusted', id, 'path', '/tmp')).toThrow('invalid_sync_request')
  handlers.get('atum:assistants:sync:memory')?.('trusted', id, true)
  expect(sync.setMemoryEnabled).toHaveBeenCalledWith(id, true)
  unregister(); expect(handlers.size).toBe(0)
})
