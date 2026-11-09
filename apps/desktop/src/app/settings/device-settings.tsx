import { useCallback, useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useI18n } from '@/i18n'
import { Check, Cpu, KeyRound, Loader2, Lock, Plus, ShieldLock, StopFilled, Trash2 } from '@/lib/icons'
import { cn } from '@/lib/utils'

import { CONTROL_TEXT } from './constants'
import { capabilityLabel, deviceSettingsCopy } from './device-settings-copy'
import { ListRow, Pill, SettingsContent, SettingsSection } from './primitives'

/** A standing grant as the Device bridge reports it (`device/runtime.ts` `DeviceStatusView.grants`). */
interface StandingGrantView {
  id: string
  capability: string
  target: string
  label: string
  agent?: string
  agentName: string | null
  createdAt: number
}

/** `device/runtime.ts` `DeviceStatusView`. */
interface DeviceStatusView {
  available: boolean
  reason?: string
  enrolled: boolean
  deviceName: string | null
  cloudAgents: { userId: string; name: string }[]
  grants: StandingGrantView[]
  grantable: string[]
  active: boolean
}

/**
 * `window.atumDevice` (`electron/matrix/device/bridge-preload.ts`). Main checks the caller and parses
 * every request. Until the bootstrap is wired the bridge is absent and the section shows its empty,
 * not-enrolled state — never a crash.
 */
interface AtumDeviceBridge {
  status(): Promise<DeviceStatusView>
  addGrant(capability: string, agentUserId: string): Promise<unknown>
  revokeGrant(id: string): Promise<unknown>
  stop(): Promise<unknown>
}

const EMPTY: DeviceStatusView = {
  available: false,
  enrolled: false,
  deviceName: null,
  cloudAgents: [],
  grants: [],
  grantable: [],
  active: false
}

function bridge(): AtumDeviceBridge | null {
  return (globalThis as { atumDevice?: AtumDeviceBridge }).atumDevice ?? null
}

/**
 * The Device section of Settings (WS-4). It surfaces the on-device guards that ship with reach-down —
 * the indicator, Stop, the sandbox and the egress proxy — and the owner's standing permissions: adding
 * one takes Touch ID on this Mac, revoking one is immediate. None of it can be changed from the cloud.
 */
export function DeviceSettings() {
  const { locale } = useI18n()
  const copy = deviceSettingsCopy(locale)
  const [status, setStatus] = useState<DeviceStatusView>(EMPTY)
  const [revoking, setRevoking] = useState<string | null>(null)
  const [agent, setAgent] = useState('')
  const [capability, setCapability] = useState('')
  const [adding, setAdding] = useState(false)
  const [addFailed, setAddFailed] = useState(false)

  const refresh = useCallback(async () => {
    const api = bridge()

    if (!api) {
      return
    }

    try {
      setStatus({ ...EMPTY, ...(await api.status()) })
    } catch {
      // A bridge error leaves the last-known (or empty) state; never block the pane.
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const revoke = useCallback(
    async (id: string) => {
      const api = bridge()

      if (!api) {
        return
      }

      setRevoking(id)
      // Optimistic: drop the row now, reconcile from the authoritative status after.
      setStatus(prev => ({ ...prev, grants: prev.grants.filter(grant => grant.id !== id) }))

      try {
        await api.revokeGrant(id)
      } catch {
        // The refresh below shows what main really holds.
      } finally {
        setRevoking(null)
        void refresh()
      }
    },
    [refresh]
  )

  const add = useCallback(async () => {
    const api = bridge()

    if (!api || !agent || !capability) {
      return
    }

    setAdding(true)
    setAddFailed(false)

    try {
      await api.addGrant(capability, agent)
      setCapability('')
    } catch {
      setAddFailed(true)
    } finally {
      setAdding(false)
      void refresh()
    }
  }, [agent, capability, refresh])

  const stop = useCallback(async () => {
    try {
      await bridge()?.stop()
    } finally {
      void refresh()
    }
  }, [refresh])

  const canAdd = status.enrolled && status.cloudAgents.length > 0 && status.grantable.length > 0

  return (
    <SettingsContent>
      <p className="mb-4 text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">{copy.intro}</p>

      <SettingsSection
        aside={
          <Pill tone={status.enrolled ? 'primary' : 'muted'}>
            {status.enrolled ? <Check className="size-3" /> : <Loader2 className="size-3 animate-spin" />}
            {status.enrolled ? copy.ready : copy.reconnecting}
          </Pill>
        }
        icon={Cpu}
        title={status.deviceName ?? copy.statusTitle}
      >
        {status.enrolled && !status.available ? (
          <p className="text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">{copy.unavailable}</p>
        ) : null}
        {status.active ? (
          <ListRow
            action={
              <Button onClick={() => void stop()} size="sm" variant="ghost">
                <StopFilled className="size-3.5" />
                {copy.stopNow}
              </Button>
            }
            title={copy.active}
          />
        ) : null}
      </SettingsSection>

      <SettingsSection icon={ShieldLock} title={copy.guardsTitle}>
        <ul className="space-y-2 text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">
          <li>{copy.guardIndicator}</li>
          <li>{copy.guardStop}</li>
          <li>{copy.guardSandbox}</li>
          <li>{copy.guardEgress}</li>
        </ul>
      </SettingsSection>

      <SettingsSection icon={KeyRound} title={copy.grantsTitle}>
        <p className="mb-2 text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">{copy.grantsIntro}</p>
        {status.grants.length === 0 ? (
          <div className="flex items-start gap-2 rounded-lg bg-background/55 p-3 text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">
            <Lock className="mt-0.5 size-3.5 shrink-0" />
            <span>{copy.noGrants}</span>
          </div>
        ) : (
          status.grants.map(grant => (
            <ListRow
              action={
                <Button disabled={revoking === grant.id} onClick={() => void revoke(grant.id)} size="sm" variant="ghost">
                  {revoking === grant.id ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
                  {revoking === grant.id ? copy.revoking : copy.revoke}
                </Button>
              }
              description={grant.agentName ?? grant.label ?? grant.target}
              key={grant.id}
              title={capabilityLabel(locale, grant.capability)}
            />
          ))
        )}

        {canAdd ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-[length:var(--conversation-caption-font-size)] text-(--ui-text-secondary)">{copy.addTitle}</span>
            <Select onValueChange={setAgent} value={agent}>
              <SelectTrigger className={cn('min-w-36', CONTROL_TEXT)}>
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
            <Select onValueChange={setCapability} value={capability}>
              <SelectTrigger className={cn('min-w-44', CONTROL_TEXT)}>
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
            <Button disabled={adding || !agent || !capability} onClick={() => void add()} size="sm" variant="ghost">
              {adding ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
              {adding ? copy.allowing : copy.allow}
            </Button>
            {addFailed ? (
              <p className="w-full text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">{copy.allowFailed}</p>
            ) : null}
          </div>
        ) : null}
      </SettingsSection>
    </SettingsContent>
  )
}
