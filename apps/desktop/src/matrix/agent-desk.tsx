import './agent-desk.css'

import { useEffect, useState } from 'react'

import { AtumAtom } from '@/components/brand/atum-atom'
import { NoticeBand } from '@/components/ui/error-state'
import { useI18n } from '@/i18n'
import { phosphorIcon } from '@/lib/phosphor-icon'

import type { MatrixAgentView, MatrixRoom, MatrixSnapshot } from '../../shared/matrix'
import { matrixAgentDeskText } from '../../shared/matrix-agent-desk-copy'
import type { MatrixReachMac } from '../../shared/matrix-agent-sources'
import type { MatrixDeviceBridge } from '../../shared/matrix-device'
import { matrixKnowledgeSourcesCopy } from '../../shared/matrix-knowledge-sources-copy'

import {
  matrixAgentDeskDevices,
  matrixAgentDeskMinutes,
  type MatrixAgentDeskNow,
  matrixAgentDeskNow,
  type MatrixProgressStep
} from './agent-desk-model'
import { HermesPrompt } from './hermes-prompts'
import { matrixMacRowLine, MatrixMacState, useMatrixReachMacs } from './mac-reach-rows'
import { MatrixPersonAvatar } from './member-avatar'
import { matrixRosterAgentName } from './roster-model'
import type { MatrixCloudStop } from './use-cloud-stop'

const CheckIcon = phosphorIcon('check')
const DesktopIcon = phosphorIcon('desktop')
const StopIcon = phosphorIcon('stop')

/** The agent's face at the size a tab chip or the ask's mark wants. */
export function MatrixAgentDeskFace({
  agent,
  className,
  name
}: {
  agent: MatrixAgentView
  className: string
  name: string
}) {
  return <MatrixPersonAvatar agent={agent} className={className} id={agent.userId} name={name} />
}

/** The agent's name as its roster row says it. */
export function useMatrixAgentDeskName(agent: MatrixAgentView): string {
  const { t } = useI18n()

  return matrixRosterAgentName(agent, t.matrixShell.assistantName)
}

/** Ticks once a minute while `on`, so "Working · 4 min" stays true without a snapshot. */
function useMinuteClock(on: boolean): number {
  const [now, setNow] = useState(Date.now)

  useEffect(() => {
    if (!on) {
      return
    }

    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 30_000)

    return () => clearInterval(timer)
  }, [on])

  return now
}

function Steps({ steps }: { steps: readonly MatrixProgressStep[] }) {
  if (!steps.length) {
    return null
  }

  return (
    <ul className="atum-desk-steps" data-agent-desk-steps>
      {steps.map((step, index) => (
        <li className="atum-desk-step" data-done={step.done || undefined} key={`${step.text}:${index}`}>
          {step.done ? (
            <CheckIcon aria-hidden className="ak-icon ak-icon--sm" />
          ) : (
            <span aria-hidden className="ak-spinner atum-desk-step-spinner" />
          )}
          <span>{step.text}</span>
        </li>
      ))}
    </ul>
  )
}

export interface MatrixAgentDeskStop {
  /** Stop is offered: a cloud turn names its question, or this room's local run is going. */
  available: boolean
  disabled: boolean
  stop(): void
}

/**
 * Stop for the desk, on the existing paths only: the cloud turn's stop (`stopTurn`, the same
 * hook the composer's button uses), a Mac-run agent's own cancel, and, while it is using this
 * Mac, the device host's Stop (Settings › Device) when that host says it is in use. Nothing is
 * decided here; each path's owner refuses what it will not do.
 */
export function matrixAgentDeskStop({
  cloud,
  onThisMac,
  roomId,
  running
}: {
  cloud: MatrixCloudStop
  onThisMac: boolean
  roomId: string
  running: boolean
}): MatrixAgentDeskStop {
  const available = Boolean(cloud.target) || running

  return {
    available,
    disabled: Boolean(cloud.target) && (cloud.stopping || cloud.requested),
    stop: () => {
      if (cloud.target) {
        cloud.stop()
      } else if (running) {
        void window.atumMatrix.cancelHermes(roomId).catch(() => undefined)
      }

      const device = (window as { atumDevice?: MatrixDeviceBridge }).atumDevice

      if (onThisMac && device) {
        void device
          .status()
          .then(status => (status.active ? device.stop() : undefined))
          .catch(() => undefined)
      }
    }
  }
}

function NowBlock({
  agent,
  name,
  now,
  steers,
  stop
}: {
  agent: MatrixAgentView
  name: string
  now: MatrixAgentDeskNow
  /** A message sent now changes the running turn (otherwise it waits for it). */
  steers: boolean
  stop: MatrixAgentDeskStop
}) {
  const { locale } = useI18n()
  const copy = matrixAgentDeskText(locale)
  const clock = useMinuteClock(now.state !== 'free')
  const minutes = now.state === 'free' ? undefined : matrixAgentDeskMinutes(now.since, clock)
  const withTime = (head: string) => (minutes === undefined ? head : `${head} · ${copy.minutes(minutes)}`)

  if (now.state === 'free') {
    return (
      <div className="atum-desk-now" data-agent-desk-now="free">
        <div className="atum-desk-now-head">
          <span className="atum-desk-now-state">{copy.free}</span>
        </div>
      </div>
    )
  }

  if (now.state === 'waiting') {
    return (
      <div className="atum-desk-now" data-agent-desk-now="waiting">
        <div className="atum-desk-now-head">
          <span aria-hidden className="ak-dot atum-desk-dot" />
          <span className="atum-desk-caption">{withTime(copy.waiting)}</span>
        </div>
        {/* The chat's own ask card, as it is: one object, so its frame is the only frame. */}
        <section aria-label={copy.ask(name)} className="atum-desk-ask">
          <div className="atum-desk-ask-head">
            <MatrixAgentDeskFace agent={agent} className="ak-avatar ak-avatar--sm" name={name} />
            <h3 className="atum-desk-ask-title">{copy.ask(name)}</h3>
          </div>
          <div className="atum-desk-ask-prompts">
            {now.prompts.map(prompt => (
              <HermesPrompt key={prompt.id} prompt={prompt} />
            ))}
          </div>
        </section>
      </div>
    )
  }

  const head = now.state === 'device' ? (now.device ? copy.onDevice(now.device) : copy.onThisMac) : copy.working

  return (
    <div className="atum-desk-now" data-agent-desk-now={now.state}>
      <div className="atum-desk-now-head">
        <AtumAtom aria-hidden className="ak-icon ak-icon--sm text-(--ak-ink-2)" data-working />
        <span className="atum-desk-now-state" role="status">
          {withTime(head)}
        </span>
      </div>
      {now.line && <p className="atum-desk-now-line">{now.line}</p>}
      <Steps steps={now.steps} />
      {stop.available && (
        <div className="atum-desk-now-actions">
          <button
            className="ak-btn ak-btn--sm"
            data-agent-desk-stop
            disabled={stop.disabled}
            onClick={stop.stop}
            type="button"
          >
            <StopIcon aria-hidden className="ak-icon ak-icon--sm" />
            {copy.stop}
          </button>
        </div>
      )}
      <p className="atum-desk-hint" data-agent-desk-hint={steers ? 'steer' : 'queue'}>
        {steers ? copy.steerHint : copy.queueHint}
      </p>
    </div>
  )
}

function DevicesSection({
  devices,
  stop
}: {
  devices: ReturnType<typeof matrixAgentDeskDevices>
  stop: MatrixAgentDeskStop
}) {
  const { locale } = useI18n()
  const copy = matrixAgentDeskText(locale)
  const sources = matrixKnowledgeSourcesCopy[locale]
  const permissions = window.atumMatrix.permissions

  if (!devices.length) {
    return null
  }

  return (
    <section aria-label={copy.devices} data-agent-desk-devices>
      <h3 className="ak-section">{copy.devices}</h3>
      <div className="ak-group--plain" role="list">
        {devices.map(({ mac, inUse }) => (
          <DeviceRow
            inUse={inUse}
            key={mac.id}
            locale={locale}
            mac={mac}
            permissions={permissions}
            sources={sources}
            stop={stop}
            stopLabel={copy.stop}
            usingNow={copy.usingNow}
          />
        ))}
      </div>
    </section>
  )
}

function DeviceRow({
  inUse,
  locale,
  mac,
  permissions,
  sources,
  stop,
  stopLabel,
  usingNow
}: {
  inUse: boolean
  locale: string
  mac: MatrixReachMac
  permissions: typeof window.atumMatrix.permissions
  sources: (typeof matrixKnowledgeSourcesCopy)[keyof typeof matrixKnowledgeSourcesCopy]
  stop: MatrixAgentDeskStop
  stopLabel: string
  usingNow: string
}) {
  const line = matrixMacRowLine(mac, sources, locale)
  const pane = line.action?.kind === 'settings' && permissions ? line.action.pane : undefined

  return (
    <div className="ak-row" data-agent-desk-device={inUse ? 'in-use' : mac.state} role="listitem">
      <DesktopIcon aria-hidden className="ak-icon" />
      <div className="ak-row-main">
        <span className="truncate">{mac.name}</span>
        {(inUse || line.help) && <span className="ak-row-meta">{inUse ? usingNow : line.help}</span>}
      </div>
      {inUse && stop.available ? (
        <button
          className="ak-btn ak-btn--sm"
          data-agent-desk-device-stop
          disabled={stop.disabled}
          onClick={stop.stop}
          type="button"
        >
          {stopLabel}
        </button>
      ) : pane && permissions ? (
        <button
          className="ak-btn ak-btn--sm"
          data-agent-desk-allow={pane}
          onClick={() => void permissions.openSettings(pane).catch(() => undefined)}
          type="button"
        >
          {sources.folderAccess.openSettings}
        </button>
      ) : (
        <span className="atum-desk-row-end">
          <MatrixMacState copy={sources} state={mac.state} />
        </span>
      )}
    </div>
  )
}

/**
 * The agent's own tab in its 1:1 chat's side panel: Now and your devices, from what the window
 * already knows. A section with nothing to show is absent. No
 * money, no settings, no second chat: steering is the composer.
 */
export function MatrixAgentDesk({
  active,
  agent,
  cloudStop,
  room,
  snapshot
}: {
  /** The desk is on screen: device reads run only then. */
  active: boolean
  agent: MatrixAgentView
  cloudStop: MatrixCloudStop
  room: MatrixRoom
  snapshot: MatrixSnapshot
}) {
  const { locale, t } = useI18n()
  const copy = matrixAgentDeskText(locale)
  const name = useMatrixAgentDeskName(agent)
  const macs = useMatrixReachMacs(active)
  const running = snapshot.hermesActivity?.roomId === room.id && snapshot.hermesActivity.state === 'running'
  const prompts = snapshot.agentTurns?.find(turn => turn.roomId === room.id)?.prompts

  const now = matrixAgentDeskNow({
    roomId: room.id,
    agentId: agent.userId,
    messages: snapshot.messages,
    typing: snapshot.typing,
    turns: snapshot.localTurns,
    running,
    ...(prompts ? { prompts } : {}),
    ...(cloudStop.target ? { stopTarget: cloudStop.target } : {}),
    terminalOpen: Boolean(snapshot.terminals?.some(tab => tab.open))
  })

  const devices = matrixAgentDeskDevices(macs ?? [], now)
  const onThisMac = devices.some(each => each.inUse && each.mac.thisMac) || (now.state === 'device' && !now.device)
  const stop = matrixAgentDeskStop({ cloud: cloudStop, onThisMac, roomId: room.id, running })
  // A device in use lifts the whole section under Now (in use first); at rest it sits below Files.
  const deviceInUse = devices.some(each => each.inUse)

  return (
    <div aria-label={copy.desk(name)} className="atum-desk" data-agent-desk role="region">
      <NowBlock agent={agent} name={name} now={now} steers={running} stop={stop} />
      {deviceInUse && <DevicesSection devices={devices} stop={stop} />}
      {!deviceInUse && <DevicesSection devices={devices} stop={stop} />}
      {cloudStop.refused && (
        <NoticeBand className="mx-(--ak-s2) mt-(--ak-s2)" role="status" tone="notice">
          {t.cloud.stopRefused}
        </NoticeBand>
      )}
    </div>
  )
}
