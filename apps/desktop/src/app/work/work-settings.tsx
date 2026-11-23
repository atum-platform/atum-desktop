import { useStore } from '@nanostores/react'
import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { NoticeBand } from '@/components/ui/error-state'
import { Switch } from '@/components/ui/switch'
import { useI18n } from '@/i18n'
import { SettingsRow, SettingsSection } from '@/matrix/settings-row'

import type { MatrixWorkBridge, MatrixWorkPlanConsent } from '../../../shared/matrix-work'
import type { WorkRelayLimit } from '../../../shared/matrix-work-relay'

import { workCopy } from './copy'
import { type WorkConsentAgent, workConsentDate, WorkPlanConsentSheet } from './plan-consent'
import { WORK_RELAY_PLAN_NAMES } from './relay-copy'
import { useWorkRelayUsageText } from './relay-chrome'
import { $work, $workPlanConsent, openWorkPlanConnect, openWorkPlanConsent } from './store'

type SettingsBridge = Pick<
  MatrixWorkBridge,
  'read' | 'openPlanConnect' | 'readPlanConsent' | 'revokePlanConsent' | 'setAssistants' | 'setPlan' | 'setPlanConsent' | 'setWork'
>

/** The plan switch's one line: who the consent names here and since when, or the plain help. */
export function workPlanSwitchHelp(
  copy: ReturnType<typeof workCopy>,
  consent: MatrixWorkPlanConsent | null,
  names: (principal: string) => string | undefined,
  locale: string
): { line: string; named: boolean } {
  const thisMac = consent?.macs.find(mac => mac.thisMac)

  if (consent?.state !== 'on' || !thisMac?.named || consent.agents.length === 0) {
    return { line: copy.planSwitch.help, named: false }
  }

  const known = consent.agents.map(names).filter((name): name is string => Boolean(name))
  const who = known.length === consent.agents.length ? known.join(', ') : known.length ? `${known.join(', ')} +${consent.agents.length - known.length}` : `${consent.agents.length}`
  const since = consent.grantedAt ? workConsentDate(consent.grantedAt, locale) : undefined

  return { line: since ? copy.planSwitch.named(who, since) : who, named: true }
}

/** The assistants states in which the owner's switch means something; `needs_grant` waits for the enrollment text. */
const ASSISTANT_SWITCH = new Set(['on', 'off', 'holding', 'stale', 'unreachable'])

/**
 * Settings › This Mac: Work itself on or off, and "Assistants can start work here" beside it when this Mac has the
 * route. Nothing is drawn while main reports no Work for this account (the projection is null): a build or an
 * account without Work has no row that does nothing.
 */
export function MatrixWorkSettings({
  agents = [],
  bridge = window.atumMatrix?.work,
  planLimit,
  claudeLimit,
  relayChats = false
}: {
  /** The account's own assistants, for the consent sheet's names and circles. */
  agents?: readonly WorkConsentAgent[]
  bridge?: Omit<SettingsBridge, 'read'> & Partial<Pick<SettingsBridge, 'read'>>
  /** Relay R1: the plan's reported limit (`status.limits`); drawn as one phrase on the connected plan row. Absent: no usage. */
  planLimit?: WorkRelayLimit
  claudeLimit?: WorkRelayLimit
  /** Relay R1: the plan also answers the assistants' chats, so the consent sheet says so. */
  relayChats?: boolean
}) {
  const { locale } = useI18n()
  const copy = workCopy(locale)
  const projection = useStore($work)
  const sheet = useStore($workPlanConsent)
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const [consent, setConsent] = useState<MatrixWorkPlanConsent | null>(null)
  const mounted = useRef(true)
  const planShown = Boolean(projection?.plan)
  const usage = useWorkRelayUsageText(planLimit)
  const connectedHelp = planLimit ? `${copy.connect.rowConnected} · ${usage}` : copy.connect.rowConnected
  const claudeUsage = useWorkRelayUsageText(claudeLimit)
  const unknownUsage = useWorkRelayUsageText(undefined)
  const planUsage = { codex: usage, claude: claudeUsage, antigravity: unknownUsage }
  const read = bridge?.read

  useEffect(() => {
    const refresh = () => void read?.().catch(() => undefined)

    refresh()
    window.addEventListener('focus', refresh)

    return () => window.removeEventListener('focus', refresh)
  }, [read])

  // The plan row reads the account's consent while it is drawn, and again when the sheet closes (it may have changed it).
  useEffect(() => {
    if (!planShown || !bridge || sheet) {
      return
    }

    let current = true
    bridge.readPlanConsent().then(
      next => current && setConsent(next),
      () => current && setConsent(null)
    )

    return () => {
      current = false
    }
  }, [bridge, planShown, sheet, projection?.plan])

  useEffect(() => {
    mounted.current = true

    return () => {
      mounted.current = false
    }
  }, [])

  if (!bridge || !projection) {
    return null
  }

  const run = async (action: () => Promise<void>) => {
    setPending(true)
    setFailed(false)

    try {
      await action()
    } catch {
      if (mounted.current) {
        setFailed(true)
      }
    } finally {
      if (mounted.current) {
        setPending(false)
      }
    }
  }

  const workOn = projection.view !== 'off'
  const name = (principal: string) => agents.find(agent => agent.principal === principal)?.name
  const planHelp = workPlanSwitchHelp(copy, consent, name, locale)

  const accountConsent = projection.relayAccountConsent === true
  const switchLabel = accountConsent
    ? locale === 'vi'
      ? 'Cho phép trợ lý dùng các gói đã kết nối trên máy Mac này'
      : 'Assistants can use my connected plans on this Mac'
    : copy.planSwitch.label

  const setPlan = (on: boolean) => {
    if (!accountConsent && on && !planHelp.named) {
      openWorkPlanConsent({ thisMac: true })

      return
    }

    void run(() => bridge.setPlan(on))
  }

  return (
    <SettingsSection data-matrix-work-settings="" title={copy.title}>
      <SettingsRow
        as="label"
        control={
          <Switch
            aria-label={copy.settings.title}
            checked={workOn}
            disabled={pending}
            onCheckedChange={on => void run(() => bridge.setWork(on))}
          />
        }
        help={copy.settings.help}
        title={copy.settings.title}
      />
      {workOn && ASSISTANT_SWITCH.has(projection.assistants) && (
        <SettingsRow
          as="label"
          control={
            <Switch
              aria-label={copy.switchLabel}
              checked={projection.assistants !== 'off'}
              disabled={pending}
              onCheckedChange={on => void run(() => bridge.setAssistants(on))}
            />
          }
          title={copy.switchLabel}
        />
      )}
      {workOn && projection.planConnect && (
        <SettingsRow
          control={
            <Button
              data-atum-work-plan-connect-row={projection.planConnect}
              disabled={pending}
              onClick={() => void openWorkPlanConnect(bridge).catch(() => setFailed(true))}
              size="sm"
              type="button"
              variant="secondary"
            >
              {projection.planConnect === 'connected' ? copy.connect.manage : copy.connect.action}
            </Button>
          }
          help={
            projection.planConnect === 'connected'
              ? <span className="block truncate" title={connectedHelp}>{connectedHelp}</span>
              : copy.connect.rowOffer
          }
          title={copy.connect.rowTitle}
        />
      )}
      {workOn && !projection.relayAccountConsent && projection.planConnect !== 'connected' && planLimit?.usedPercent !== undefined && (
        <SettingsRow data-atum-work-plan-usage="codex" help={<span className="block truncate" title={usage}>{usage}</span>} title="ChatGPT" />
      )}
      {workOn && !projection.relayAccountConsent && claudeLimit && <SettingsRow data-atum-work-plan-usage="claude" help={<span className="block truncate" title={claudeUsage}>{claudeUsage}</span>} title="Claude" />}
      {workOn && projection.relayAccountConsent && projection.connectedPlans?.map(plan => (
        <SettingsRow
          control={
            <Button disabled={pending} onClick={() => openWorkPlanConsent({ plan })} size="sm" type="button" variant="secondary">
              {locale === 'vi' ? 'Tác vụ đã lên lịch' : 'Scheduled tasks'}
            </Button>
          }
          data-atum-work-plan-usage={plan}
          help={planUsage[plan]}
          key={plan}
          title={WORK_RELAY_PLAN_NAMES[plan]}
        />
      ))}
      {workOn && projection.plan && (
        <SettingsRow
          control={
            <span className="flex items-center gap-2">
              {!accountConsent && planHelp.named && (
                <Button
                  data-atum-work-plan-consent-change
                  disabled={pending}
                  onClick={() => openWorkPlanConsent()}
                  size="sm"
                  type="button"
                  variant="text"
                >
                  {copy.planSwitch.change}
                </Button>
              )}
              <Switch
                aria-label={switchLabel}
                checked={projection.plan === 'on'}
                disabled={pending}
                onCheckedChange={setPlan}
              />
            </span>
          }
          data-atum-work-plan-switch={projection.plan}
          help={accountConsent ? undefined : planHelp.line}
          title={switchLabel}
        />
      )}
      <WorkPlanConsentSheet agents={agents} bridge={bridge} scope={relayChats ? 'chats' : 'work'} />
      {failed && (
        <NoticeBand role="status" tone="notice">
          {copy.settings.failed}
        </NoticeBand>
      )}
    </SettingsSection>
  )
}
