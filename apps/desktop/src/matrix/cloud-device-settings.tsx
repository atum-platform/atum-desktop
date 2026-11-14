import { useCallback, useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { ConsentBoundary } from '@/components/ui/consent-boundary'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useI18n } from '@/i18n'

import type { MatrixDeviceBridge, MatrixDeviceStatus } from '../../shared/matrix-device'
import { capabilityLabel, deviceSettingsCopy } from '../app/settings/device-settings-copy'

import { SettingsRow, SettingsSection, SettingsStatus } from './settings-row'

const EMPTY: MatrixDeviceStatus = {
  available: false,
  enrolled: false,
  deviceName: null,
  cloudAgents: [],
  grants: [],
  grantable: [],
  active: false
}

function bridge(): MatrixDeviceBridge | undefined {
  return (window as { atumDevice?: MatrixDeviceBridge }).atumDevice
}

/**
 * Enrollment is automatic and account-scoped, so Settings shows status rather than an enrollment
 * decision. Two safety controls appear only when they have something to act on: Stop while an assistant is
 * using this Mac, and Revoke for a standing permission. Granting one up front ("Allow without
 * asking", one Touch ID per permission through main's `addGrant`) stays, folded under "Advanced"
 * once this Mac is on, so a protected action need not ask each time.
 */
export function MatrixCloudDeviceSettings() {
  const { locale, t } = useI18n()
  const copy = deviceSettingsCopy(locale)
  const words = t.cloud
  const [status, setStatus] = useState<MatrixDeviceStatus>(EMPTY)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [loading, setLoading] = useState(true)
  const reads = useRef(0)
  const [agent, setAgent] = useState('')
  const [capability, setCapability] = useState('')

  const refresh = useCallback(async () => {
    try {
      const api = bridge()

      if (!api) {
        return
      }

      setStatus(await api.status())
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }, [])

  useEffect(() => {
    let live = true

    const read = async () => {
      const request = ++reads.current
      const current = () => live && request === reads.current

      try {
        const api = bridge()

        if (!api) {
          return
        }

        const value = await api.status()

        if (current()) {
          setStatus(value)
          setFailed(false)
        }
      } catch {
        if (current()) {
          setFailed(true)
        }
      } finally {
        if (current()) {
          setLoading(false)
        }
      }
    }

    void read()
    const timer = setInterval(() => void read(), 5_000)

    return () => {
      live = false
      clearInterval(timer)
    }
  }, [])

  const act = async (run: () => Promise<unknown>) => {
    if (busy) {
      return
    }

    setBusy(true)
    setFailed(false)

    try {
      await run()
      await refresh()
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  const api = bridge()

  if (loading) {
    return (
      <ConsentBoundary><SettingsSection data-matrix-cloud-device-settings>
        <p role="status">{t.common.loading}</p>
      </SettingsSection></ConsentBoundary>
    )
  }

  return (
    <ConsentBoundary><SettingsSection data-matrix-cloud-device-settings>
      <SettingsRow
        control={
          status.active && api ? (
            <Button disabled={busy} onClick={() => void act(() => api.stop())} size="sm" variant="ghost">
              {copy.stopNow}
            </Button>
          ) : undefined
        }
        help={!status.available ? copy.unavailable : status.active ? copy.active : undefined}
        role="status"
        title={status.enrolled ? copy.ready : copy.reconnecting}
      />
      {api &&
        status.grants.map(grant => (
          <SettingsRow
            control={
              <Button
                disabled={busy}
                onClick={() => void act(() => api.revokeGrant(grant.id))}
                size="sm"
                variant="ghost"
              >
                {copy.revoke}
              </Button>
            }
            help={grant.agentName ?? grant.label ?? grant.target}
            key={grant.id}
            title={capabilityLabel(locale, grant.capability)}
          />
        ))}
      {status.enrolled && status.cloudAgents.length > 0 && api && (
        <details className="atum-settings-row block" data-matrix-allow-without-asking>
          <summary className="cursor-pointer text-(--atum-ink-muted)">{copy.advanced}</summary>
          <SettingsRow
            control={
              <div className="flex flex-wrap items-center gap-2">
                <Select disabled={busy} onValueChange={setAgent} value={agent}>
                  <SelectTrigger aria-label={copy.chooseAgent}>
                    <SelectValue placeholder={copy.chooseAgent} />
                  </SelectTrigger>
                  <SelectContent>
                    {status.cloudAgents.map(each => (
                      <SelectItem key={each.userId} value={each.userId}>
                        {each.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select disabled={busy} onValueChange={setCapability} value={capability}>
                  <SelectTrigger aria-label={copy.chooseCapability}>
                    <SelectValue placeholder={copy.chooseCapability} />
                  </SelectTrigger>
                  <SelectContent>
                    {status.grantable.map(each => (
                      <SelectItem key={each} value={each}>
                        {capabilityLabel(locale, each)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  disabled={busy || !agent || !capability}
                  onClick={() => void act(() => api.addGrant(capability, agent))}
                  size="sm"
                  variant="ghost"
                >
                  {busy ? copy.allowing : copy.allow}
                </Button>
              </div>
            }
            tip={copy.grantsIntro}
            title={copy.addTitle}
          />
        </details>
      )}
      {failed && (
        <SettingsStatus className="text-(--atum-danger)" role="status">
          {words.deviceStatusUnconfirmed}
        </SettingsStatus>
      )}
    </SettingsSection></ConsentBoundary>
  )
}
