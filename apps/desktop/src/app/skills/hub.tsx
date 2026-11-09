import { useStore } from '@nanostores/react'
import { useCallback } from 'react'

import { getSkillHubSources, previewSkillHub, scanSkillHub, searchSkillsHub } from '@/hermes'
import { useI18n } from '@/i18n'
import {
  $hubActions,
  $hubActiveLog,
  $hubInstalledOverride,
  closeHubLog,
  HUB_SOURCES_KEY,
  installHubSkill,
  uninstallHubSkill,
  UPDATE_ALL_KEY,
  updateHubSkills
} from '@/store/hub-actions'
import { notify, notifyError } from '@/store/notifications'

import { type HubClient, HubPresentation, type HubQueryKeys } from './hub-presentation'

const legacyClient: HubClient = {
  getSources: getSkillHubSources,
  preview: previewSkillHub,
  search: searchSkillsHub
}

// hub-actions invalidates these after every legacy action. Keep them exactly
// stable while the native page receives isolated query-key prefixes.
const legacyQueryKeys: HubQueryKeys = {
  sources: HUB_SOURCES_KEY,
  search: (query, source) => ['skill-hub-search', query, source],
  preview: identifier => ['skill-hub-preview', identifier]
}

export function SkillsHub({ query }: { query: string }) {
  const { t } = useI18n()
  const h = t.skills.hub
  const actions = useStore($hubActions)
  const installedOverrides = useStore($hubInstalledOverride)
  const activeLogKey = useStore($hubActiveLog)

  const install = useCallback(
    async (identifier: string, name: string) => {
      notify({ kind: 'success', title: h.installStarted(name), message: h.actionLog })

      try {
        await installHubSkill(identifier)
      } catch (error) {
        notifyError(error, h.actionFailed)
        throw error
      }
    },
    [h]
  )

  const uninstall = useCallback(
    async (identifier: string, installedName: string) => {
      notify({ kind: 'success', title: h.uninstallStarted(installedName), message: h.actionLog })

      try {
        await uninstallHubSkill(identifier, installedName)
      } catch (error) {
        notifyError(error, h.actionFailed)
        throw error
      }
    },
    [h]
  )

  const updateAll = useCallback(async () => {
    notify({ kind: 'success', title: h.updateStarted, message: h.actionLog })

    try {
      await updateHubSkills()
    } catch (error) {
      notifyError(error, h.actionFailed)
      throw error
    }
  }, [h])

  const scan = useCallback(
    async (identifier: string) => {
      try {
        return await scanSkillHub(identifier)
      } catch (error) {
        notifyError(error, h.scanFailed)
        throw error
      }
    },
    [h]
  )

  return (
    <HubPresentation
      actions={actions}
      activeLogKey={activeLogKey}
      client={legacyClient}
      closeDetailOnInstall
      installedOverrides={installedOverrides}
      onCloseLog={closeHubLog}
      onInstall={install}
      onScan={scan}
      onUninstall={uninstall}
      onUpdateAll={updateAll}
      query={query}
      queryKeyPrefix={['skill-hub']}
      queryKeys={legacyQueryKeys}
      updateActionKey={UPDATE_ALL_KEY}
    />
  )
}
