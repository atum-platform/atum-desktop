import { useStore } from '@nanostores/react'
import { useEffect, useRef, useState } from 'react'

import { AtumAssistantAvatar } from '@/app/atum/assistant-avatar'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { NoticeBand } from '@/components/ui/error-state'
import { Switch } from '@/components/ui/switch'
import { useI18n } from '@/i18n'

import type { AtumAssistantMark } from '../../../shared/atum-agent-portability'
import type { MatrixWorkBridge, MatrixWorkPlanConsent } from '../../../shared/matrix-work'

import { workCopy } from './copy'
import { WORK_RELAY_PLAN_NAMES, workRelayCopy } from './relay-copy'
import { $workPlanConsent, type WorkPlanConsentRequest } from './store'

/** An assistant as the owner's own account record names it (never as the agent names itself). */
export interface WorkConsentAgent {
  principal: string
  name: string
  avatarUrl?: string | null
  mark?: AtumAssistantMark
  isDefault?: boolean
}

type ConsentBridge = Pick<MatrixWorkBridge, 'readPlanConsent' | 'revokePlanConsent' | 'setPlan' | 'setPlanConsent'>

/**
 * The label of each of the owner's other Macs: the name the owner gave it (the device registry's), so a Mac is the same Mac every
 * time the sheet opens. Two Macs with one name are told apart by a number after it; a Mac the read carried no name for falls back to
 * "Your other Mac n".
 */
export function macLabelsFor(macs: MatrixWorkPlanConsent['macs'], fallback: (index: number) => string): Map<string, string> {
  const others = macs.filter(mac => !mac.thisMac)
  const count = (name: string) => others.filter(mac => mac.name === name).length
  const seen = new Map<string, number>()
  let unnamed = 0
  const labels = new Map<string, string>()

  for (const mac of others) {
    if (!mac.name) {
      labels.set(mac.id, fallback(++unnamed))

      continue
    }

    const nth = (seen.get(mac.name) ?? 0) + 1
    seen.set(mac.name, nth)
    labels.set(mac.id, count(mac.name) > 1 ? `${mac.name} ${nth}` : mac.name)
  }

  return labels
}

export function workConsentDate(at: number, locale: string): string {
  return new Intl.DateTimeFormat(locale === 'vi' ? 'vi-VN' : 'en', { day: 'numeric', month: 'short', year: 'numeric' }).format(at)
}

/**
 * What the sheet starts with. Express opt-in: an empty record selects nothing, except what the owner's own tap named (the assistant
 * they tapped, or this Mac whose switch they turned on, or the only Mac there is). A record that is on starts from what it names.
 */
export function workConsentDraft(consent: MatrixWorkPlanConsent, request: WorkPlanConsentRequest) {
  const on = consent.state === 'on'
  const agents = new Set(on ? consent.agents : [])
  const macs = new Set(on ? consent.macs.filter(mac => mac.named).map(mac => mac.id) : [])

  if (request.agent && consent.eligible.includes(request.agent)) {
    agents.add(request.agent)
  }

  const thisMac = consent.macs.find(mac => mac.thisMac)

  // This Mac's switch was the tap; with one Mac only, it is the only place the plan can run, so Allow names it (the list is not drawn).
  if (thisMac && (request.thisMac || consent.macs.length === 1)) {
    macs.add(thisMac.id)
  }

  return { agents, macs, alsoWhenScheduled: on && consent.alsoWhenScheduled }
}

/**
 * Gate 4b-2, the one consent screen: which assistants may use the owner's ChatGPT plan, on which Macs, and whether scheduled tasks
 * count. Default off; Allow is the express act OpenAI asks for. When it is on: when it was granted, and one tap turns it off on
 * every Mac. It writes through the platform (`work_consent_set` / `_revoke`); each Mac applies it on its next pull.
 */
export function WorkPlanConsentSheet({
  agents,
  bridge = window.atumMatrix?.work,
  scope = 'work'
}: {
  agents: readonly WorkConsentAgent[]
  bridge?: ConsentBridge
  /**
   * What the plan does once allowed. `work`: work the assistants start on the Mac (slice B). `chats`: relay R1, their chats with
   * the owner run on the Mac with this plan too (plan §6). The sentence must say what is true, so the caller sets it when the
   * relay is on.
   */
  scope?: 'work' | 'chats'
}) {
  const { locale } = useI18n()
  const relayWords = workRelayCopy(locale)
  const base = workCopy(locale).consent

  const copy =
    scope === 'chats' ? { ...base, line: relayWords.consentChatsLine, scheduled: relayWords.consentScheduled } : base

  const request = useStore($workPlanConsent)
  const [consent, setConsent] = useState<MatrixWorkPlanConsent | null>(null)
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [macs, setMacs] = useState<Set<string>>(new Set())
  const [scheduled, setScheduled] = useState(false)
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const live = useRef(true)

  useEffect(() => {
    live.current = true

    return () => {
      live.current = false
    }
  }, [])

  const adopt = (next: MatrixWorkPlanConsent, from: WorkPlanConsentRequest) => {
    const draft = workConsentDraft(next, from)
    setConsent(next)
    setChosen(draft.agents)
    setMacs(draft.macs)
    setScheduled(draft.alsoWhenScheduled)
  }

  useEffect(() => {
    if (!request || !bridge) {
      setConsent(null)
      setFailed(false)

      return
    }

    let current = true
    const read = request.plan ? bridge.readPlanConsent(request.plan) : bridge.readPlanConsent()
    void read.then(
      next => current && live.current && adopt(next, request),
      () => current && live.current && setFailed(true)
    )

    return () => {
      current = false
    }
  }, [bridge, request])

  if (!request || !bridge) {
    return null
  }

  const close = () => $workPlanConsent.set(null)
  const on = consent?.state === 'on' && (!request.plan || consent.alsoWhenScheduled)
  const named = agents.filter(agent => consent?.eligible.includes(agent.principal))
  const ready = chosen.size > 0 && macs.size > 0

  const run = async (action: () => Promise<void>) => {
    setPending(true)
    setFailed(false)

    try {
      await action()
      close()
    } catch {
      if (live.current) {
        setFailed(true)
      }
    } finally {
      if (live.current) {
        setPending(false)
      }
    }
  }

  const revoke = () => run(async () => {
    await (request.plan ? bridge.revokePlanConsent(request.plan) : bridge.revokePlanConsent())
  })

  const allow = () =>
    run(async () => {
      const input = { agents: [...chosen], macs: [...macs], alsoWhenScheduled: request.plan ? true : scheduled }

      await (request.plan ? bridge.setPlanConsent(input, request.plan) : bridge.setPlanConsent(input))
      const thisMac = consent?.macs.find(mac => mac.thisMac)

      // The owner turned this Mac's switch on to get here: Allow finishes that one act.
      if (request.thisMac && thisMac && macs.has(thisMac.id)) {
        await bridge.setPlan(true)
      }
    })

  const toggle = (set: Set<string>, id: string, value: boolean) => {
    const next = new Set(set)

    if (value) {
      next.add(id)
    } else {
      next.delete(id)
    }

    return next
  }

  const macLabels = macLabelsFor(consent?.macs ?? [], copy.otherMac)

  return (
    <Dialog onOpenChange={next => !next && close()} open>
      <DialogContent className="max-w-sm gap-4" data-atum-work-plan-consent={consent?.state ?? 'loading'}>
        <div className="grid gap-1.5">
          <DialogTitle>{request.plan
            ? `${locale === 'vi' ? 'Tác vụ đã lên lịch' : 'Scheduled tasks'} · ${WORK_RELAY_PLAN_NAMES[request.plan]}`
            : copy.title}</DialogTitle>
          <DialogDescription>
            {on && consent?.grantedAt
              ? copy.granted(workConsentDate(consent.grantedAt, locale))
              : request.plan
                ? locale === 'vi'
                  ? 'Chọn trợ lý và máy Mac có thể dùng gói này cho tác vụ đã lên lịch.'
                  : 'Choose which assistants and Macs can use this plan for scheduled tasks.'
                : copy.line}
          </DialogDescription>
        </div>
        {consent && (
          <div className="mt-3 grid gap-4">
            <div className="grid gap-1" data-atum-work-consent-agents role="group">
              <p className="mb-1 text-xs font-medium text-(--ui-text-tertiary)">{copy.assistants}</p>
              {named.length === 0 && <p className="text-sm text-(--ui-text-secondary)">{copy.none}</p>}
              {named.map(agent => (
                <label className="flex min-h-9 items-center gap-2.5 text-sm" key={agent.principal}>
                  <AtumAssistantAvatar
                    avatarUrl={agent.avatarUrl}
                    brand={agent.isDefault}
                    className="size-7 shrink-0 rounded-full"
                    id={agent.principal}
                    mark={agent.mark}
                    name={agent.name}
                  />
                  <span className="min-w-0 flex-1 truncate">{agent.name}</span>
                  <Checkbox
                    aria-label={agent.name}
                    checked={chosen.has(agent.principal)}
                    disabled={pending}
                    onCheckedChange={value => setChosen(toggle(chosen, agent.principal, value === true))}
                  />
                </label>
              ))}
            </div>
            {consent.macs.length > 1 && (
              <div className="grid gap-1" data-atum-work-consent-macs role="group">
                <p className="mb-1 text-xs font-medium text-(--ui-text-tertiary)">{copy.macs}</p>
                {consent.macs.map(mac => {
                  const label = mac.thisMac ? copy.thisMac : (macLabels.get(mac.id) ?? mac.id)

                  return (
                    <label className="flex min-h-9 items-center gap-2.5 text-sm" key={mac.id}>
                      <span className="min-w-0 flex-1 truncate">{label}</span>
                      <Checkbox
                        aria-label={label}
                        checked={macs.has(mac.id)}
                        disabled={pending}
                        onCheckedChange={value => setMacs(toggle(macs, mac.id, value === true))}
                      />
                    </label>
                  )
                })}
              </div>
            )}
            {!request.plan && (
              <label className="flex min-h-9 items-center gap-2.5 text-sm">
                <span className="min-w-0 flex-1">{copy.scheduled}</span>
                <Switch aria-label={copy.scheduled} checked={scheduled} disabled={pending} onCheckedChange={setScheduled} />
              </label>
            )}
          </div>
        )}
        {failed && (
          <NoticeBand role="alert" tone="failure">
            {copy.failed}
          </NoticeBand>
        )}
        <div className="flex items-center gap-2">
          {on && (
            <Button
              data-atum-work-consent-revoke
              disabled={pending}
              onClick={() => void revoke()}
              size="sm"
              type="button"
              variant="text"
            >
              {copy.revoke}
            </Button>
          )}
          <span className="flex-1" />
          <Button disabled={pending} onClick={close} size="sm" type="button" variant="ghost">
            {copy.cancel}
          </Button>
          <Button
            data-atum-work-consent-allow
            disabled={pending || !consent || !ready}
            onClick={() => void allow()}
            size="sm"
            type="button"
          >
            {on ? copy.save : copy.allow}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
