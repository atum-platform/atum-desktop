import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'

import { type HubAction, type HubClient, HubPresentation } from '@/app/skills/hub-presentation'
import { useI18n } from '@/i18n'
import type { ActionResponse, ActionStatusResponse, SkillHubScanResult } from '@/types/hermes'

import { pagesCopy } from './copy'

export interface MatrixSkillsHubClient extends HubClient {
  install: (identifier: string) => Promise<ActionResponse>
  uninstall: (name: string) => Promise<ActionResponse>
  update: (name?: string) => Promise<ActionResponse>
  status: (name: string) => Promise<ActionStatusResponse>
  scan: (identifier: string) => Promise<SkillHubScanResult>
}

/** This is UI observation of Hermes's installer, not an installer or job store.
 * The native scope owns permission and action-name authority. Closing the page
 * stops observation only; reopening reconciles Hermes's installed map. */
export function MatrixSkillsHub({
  client,
  focus,
  onInstalled,
  query
}: {
  client: MatrixSkillsHubClient
  /** The official skill the Store sent the person to: its detail opens; nothing installs. */
  focus?: string
  onInstalled: () => void
  query: string
}) {
  const { locale } = useI18n()
  const copy = pagesCopy[locale]
  const instance = useId()
  const queryKeyPrefix = useMemo(() => ['matrix-skills-hub', instance] as const, [instance])
  const cache = useQueryClient()
  const [actions, setActions] = useState<Record<string, HubAction | undefined>>({})
  const [activeLogKey, setActiveLogKey] = useState<string | null>(null)
  const pending = useRef(new Set<string>())
  const mutationPending = useRef(false)
  const lifetime = useRef<AbortController | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller

    return () => {
      controller.abort()
      void cache.cancelQueries({ queryKey: queryKeyPrefix })
      cache.removeQueries({ queryKey: queryKeyPrefix })
    }
  }, [cache, queryKeyPrefix])

  const scan = useCallback(
    async (identifier: string) => {
      const controller = lifetime.current

      if (!controller || controller.signal.aborted) {
        throw new DOMException('Scan view closed', 'AbortError')
      }

      try {
        const result = await client.scan(identifier)

        if (controller.signal.aborted) {
          throw new DOMException('Scan view closed', 'AbortError')
        }

        return result
      } catch (error) {
        if (
          controller.signal.aborted ||
          (error instanceof Error && error.message === 'matrix_pages_hub_scan_cancelled')
        ) {
          throw new DOMException('Scan cancelled', 'AbortError')
        }

        throw error
      }
    },
    [client]
  )

  const run = useCallback(
    async (identifier: string, operation: 'install' | 'archive' | 'update' | 'update-all', installedName?: string) => {
      const controller = lifetime.current
      const actionKey = operation === 'update-all' ? '__update_all__' : identifier

      if (!controller || controller.signal.aborted || mutationPending.current || pending.current.has(actionKey)) {
        return
      }

      mutationPending.current = true
      pending.current.add(actionKey)
      const current = () => !controller.signal.aborted

      const paint = (value: HubAction) => {
        if (current()) {
          setActions(previous => ({ ...previous, [actionKey]: value }))
        }
      }

      paint({ kind: operation, running: true, lines: [] })
      setActiveLogKey(actionKey)
      let last: ActionStatusResponse | undefined

      try {
        const started =
          operation === 'archive'
            ? await client.uninstall(installedName!)
            : operation === 'install'
              ? await client.install(identifier)
              : await client.update(operation === 'update' ? installedName : undefined)

        const deadline = Date.now() + 10 * 60_000

        while (current()) {
          last = await client.status(started.name)

          if (!current()) {
            return
          }

          paint({
            kind: operation,
            running: last.running,
            exitCode: last.exit_code ?? undefined,
            lines: last.lines
          })

          if (!last.running) {
            if (last.exit_code !== 0) {
              throw new Error(
                operation === 'archive'
                  ? copy.archiveIncomplete
                  : operation === 'install'
                    ? copy.installIncomplete
                    : copy.updateIncomplete
              )
            }

            return
          }

          if (Date.now() >= deadline) {
            throw new Error(
              operation === 'archive'
                ? copy.archiveObservingEnded
                : operation === 'install'
                  ? copy.installObservingEnded
                  : copy.updateObservingEnded
            )
          }

          await new Promise<void>(resolve => {
            const done = () => {
              clearTimeout(timer)
              controller.signal.removeEventListener('abort', done)
              resolve()
            }

            const timer = setTimeout(done, 1200)
            controller.signal.addEventListener('abort', done, { once: true })
          })
        }
      } catch (error) {
        if (!current()) {
          return
        }

        const message = error instanceof Error ? error.message : String(error)

        if (message === `matrix_pages_hub_${operation}_cancelled`) {
          setActions(previous => ({ ...previous, [actionKey]: undefined }))
          setActiveLogKey(previous => (previous === actionKey ? null : previous))

          return
        }

        paint({
          kind: operation,
          running: false,
          exitCode: last?.exit_code ?? undefined,
          lines: [...(last?.lines ?? []), message]
        })
        throw error
      } finally {
        pending.current.delete(actionKey)
        mutationPending.current = false

        if (current()) {
          // Poll loss does not prove failure. Refresh actual installed truth even
          // after an error; never manufacture an installed=true optimistic flag.
          void cache.invalidateQueries({ queryKey: queryKeyPrefix })
          onInstalled()
        }
      }
    },
    [cache, client, copy, onInstalled, queryKeyPrefix]
  )

  return (
    <HubPresentation
      actions={actions}
      activeLogKey={activeLogKey}
      client={client}
      focusIdentifier={focus}
      installedOverrides={{}}
      maintenanceNote={copy.updateNote}
      onCloseLog={() => setActiveLogKey(null)}
      onInstall={identifier => run(identifier, 'install')}
      onScan={scan}
      onUninstall={(identifier, installedName) => run(identifier, 'archive', installedName)}
      onUpdate={(identifier, installedName) => run(identifier, 'update', installedName)}
      onUpdateAll={() => run('__update_all__', 'update-all')}
      query={query}
      queryKeyPrefix={queryKeyPrefix}
      uninstallingLabel={copy.archiving}
      uninstallLabel={copy.archive}
    />
  )
}
