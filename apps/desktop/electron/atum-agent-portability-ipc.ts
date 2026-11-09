import { parseAccountPreferences } from '../shared/atum-account-preferences'
import type { AtumAssistantDefinitionWrite } from '../shared/atum-agent-portability'

import type { AtumAssistantPortabilityService } from './atum-agent-portability'
import type { AtumAgentSync } from './atum-agent-sync'
import type { MessagingClientBoundary } from './atum-messaging/types'

interface IpcMainLike {
  handle(channel: string, listener: (_event: unknown, ...args: unknown[]) => unknown): void
  removeHandler?(channel: string): void
}

export const ATUM_ASSISTANT_PORTABILITY_IPC_CHANNELS = [
  'atum:assistants:definition:get',
  'atum:assistants:definition:put',
  'atum:assistants:materialize',
  'atum:assistants:definition:apply',
  'atum:assistants:legacy:import',
  'atum:assistants:sync:status',
  'atum:assistants:sync:run',
  'atum:assistants:sync:preferences',
  'atum:assistants:sync:preferences:patch',
  'atum:assistants:sync:preferences:seed',
  'atum:assistants:sync:memory',
  'atum:assistants:sync:resolve'
] as const

export interface AtumAssistantPortabilityIpcAuthority {
  assertTrustedSender(event: unknown): void
}

function assistantId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  ) {
    throw new Error('assistant_id_invalid')
  }

  return value
}

function write(value: unknown): AtumAssistantDefinitionWrite {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('assistant_definition_invalid')
  }

  const input = value as Record<string, unknown>
  const expected = ['expectedDefinitionRevision', 'expectedIdentityRevision', 'displayName', 'avatar', 'definition']

  if (Object.keys(input).length !== expected.length || Object.keys(input).some(key => !expected.includes(key))) {
    throw new Error('assistant_definition_invalid')
  }

  if (
    !Number.isSafeInteger(input.expectedDefinitionRevision) ||
    Number(input.expectedDefinitionRevision) < 0 ||
    !Number.isSafeInteger(input.expectedIdentityRevision) ||
    Number(input.expectedIdentityRevision) < 1 ||
    typeof input.displayName !== 'string' ||
    typeof input.avatar !== 'string'
  ) {
    throw new Error('assistant_definition_invalid')
  }

  return input as unknown as AtumAssistantDefinitionWrite
}

export function registerAtumAssistantPortabilityIpc(
  ipc: IpcMainLike,
  client: Pick<MessagingClientBoundary, 'getAssistantDefinition' | 'putAssistantDefinition'>,
  service: AtumAssistantPortabilityService,
  authority: AtumAssistantPortabilityIpcAuthority,
  sync?: AtumAgentSync
): () => void {
  ipc.handle('atum:assistants:definition:get', (event, id) => {
    authority.assertTrustedSender(event)

    return client.getAssistantDefinition(assistantId(id))
  })
  ipc.handle('atum:assistants:definition:put', (event, id, input) => {
    authority.assertTrustedSender(event)

    return sync
      ? sync.publishDefinition(assistantId(id), write(input))
      : client.putAssistantDefinition(assistantId(id), write(input))
  })
  ipc.handle('atum:assistants:materialize', (event, id) => {
    authority.assertTrustedSender(event)

    return service.materializeAssistant(assistantId(id))
  })
  ipc.handle('atum:assistants:definition:apply', (event, id) => {
    authority.assertTrustedSender(event)

    return service.applyAssistantDefinition(assistantId(id))
  })
  ipc.handle('atum:assistants:legacy:import', (event, id) => {
    authority.assertTrustedSender(event)

    return service.importLegacyAssistant(assistantId(id))
  })

  ipc.handle('atum:assistants:sync:status', event => {
    authority.assertTrustedSender(event)

    return sync?.statuses() ?? []
  })
  ipc.handle('atum:assistants:sync:preferences', event => {
    authority.assertTrustedSender(event)

    if (!sync) { throw new Error('sync_unavailable') }

    return sync.preferences()
  })

  for (const action of ['patch', 'seed'] as const) {
    ipc.handle(`atum:assistants:sync:preferences:${action}`, (event, accountId, snapshot) => {
      authority.assertTrustedSender(event)

      if (!sync) { throw new Error('sync_unavailable') }

      return action === 'patch'
        ? sync.patchPreferences(assistantId(accountId), parseAccountPreferences(snapshot))
        : sync.seedPreferences(assistantId(accountId), parseAccountPreferences(snapshot))
    })
  }

  ipc.handle('atum:assistants:sync:run', event => {
    authority.assertTrustedSender(event)

    if (!sync) {throw new Error('sync_unavailable')}

    return sync.sync()
  })
  ipc.handle('atum:assistants:sync:memory', (event, id, enabled) => {
    authority.assertTrustedSender(event)

    if (!sync || typeof enabled !== 'boolean') {throw new Error('invalid_sync_request')}

    return sync.setMemoryEnabled(assistantId(id), enabled)
  })
  ipc.handle('atum:assistants:sync:resolve', (event, id, kind, choice) => {
    authority.assertTrustedSender(event)

    if (!sync || !['skills', 'memory'].includes(String(kind)) || !['local', 'cloud'].includes(String(choice)))
      {throw new Error('invalid_sync_request')}

    return sync.resolve(assistantId(id), kind as 'skills' | 'memory', choice as 'local' | 'cloud')
  })

  return () => ATUM_ASSISTANT_PORTABILITY_IPC_CHANNELS.forEach(channel => ipc.removeHandler?.(channel))
}
