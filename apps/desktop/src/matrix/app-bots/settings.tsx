import { useState } from 'react'

import { AppCatalogAvatar } from '@/app/atum/app-catalog-presentation'
import { NoticeBand } from '@/components/ui/error-state'
import { Switch } from '@/components/ui/switch'
import { useI18n } from '@/i18n'

import { appLocalizedCopy } from '../../../shared/app-catalog'
import type { MatrixSnapshot } from '../../../shared/matrix'
import { useMatrixSettingsCopy } from '../settings-copy'
import { SettingsRow } from '../settings-row'

/** Account-scoped consent revocation.  Main owns the fixed DELETE route. */
export function AppBotSettings({ snapshot }: { snapshot: MatrixSnapshot }) {
  const { locale } = useI18n()
  const text = useMatrixSettingsCopy()
  const [pending, setPending] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const apps = (snapshot.apps?.apps ?? []).filter(app => app.bot)
  const bridge = window.atumMatrix.apps

  if (!bridge) {
    return null
  }

  if (!apps.length) {
    return <SettingsRow className="atum-settings-row-quiet" title={text.appsEmpty} />
  }

  const revoke = async (appId: string) => {
    setPending(appId); setFailed(null)

    try {
      await bridge.botRevoke(appId)
      await bridge.refresh()
    } catch {
      setFailed(appId)
    } finally {
      setPending(null)
    }
  }

  return (
    <div data-matrix-app-bot-settings>
      {apps.map(app => {
        const name = app.bot?.display_name ?? appLocalizedCopy(app.name, locale, app.app)

        return (
          <div className="atum-settings-item" key={app.app_id}>
            <SettingsRow
              control={
                <Switch
                  aria-label={name}
                  checked
                  disabled={pending !== null}
                  onCheckedChange={enabled => !enabled && void revoke(app.app_id)}
                />
              }
              help={text.usedInChats}
              title={
                <span className="flex items-center gap-(--ak-s2)">
                  <AppCatalogAvatar app={app} className="ak-appicon ak-appicon--sm" locale={locale} tile />
                  {name}
                </span>
              }
            />
            {failed === app.app_id && <NoticeBand role="status">{text.appUpdateFailed}</NoticeBand>}
          </div>
        )
      })}
    </div>
  )
}
