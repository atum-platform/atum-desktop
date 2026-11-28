import { useState } from 'react'

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { useI18n } from '@/i18n'
import { ChevronRight } from '@/lib/icons'

import type { MatrixAgentView, MatrixRoom } from '../../../shared/matrix'
import { matrixAgentDeskText } from '../../../shared/matrix-agent-desk-copy'
import {
  MatrixAgentDeskDevices,
  matrixAgentDeskPaused,
  type MatrixAgentDeskState,
  useMatrixAgentSchedule,
  useMatrixRoomMute
} from '../agent-desk'

/**
 * The agent's controls on its card beside its chat, as the desk had them (owner 2026-11-26: "control
 * should still exist"): this chat's notifications (the chat's own mute), the devices it can use (each
 * one's state, Allow, Stop while in use), and Pause once the host reads its schedule. Rows in the
 * card's own group, each shown only where it does something.
 */
export function AssistantCardControls({
  active,
  agent,
  desk,
  room
}: {
  active: boolean
  agent: MatrixAgentView
  desk: MatrixAgentDeskState
  room: MatrixRoom
}) {
  return (
    <>
      <NotificationsRow room={room} />
      <DevicesRow desk={desk} />
      <PauseRow active={active} agent={agent} />
    </>
  )
}

function NotificationsRow({ room }: { room: MatrixRoom }) {
  const { locale } = useI18n()
  const copy = matrixAgentDeskText(locale)
  const { muted, toggle } = useMatrixRoomMute(room)

  return (
    <label className="atum-settings-row cursor-pointer" data-assistant-card-notifications>
      <span className="atum-settings-row-title min-w-0 flex-1">{copy.notifications}</span>
      <Switch aria-label={copy.notifications} checked={!muted} onCheckedChange={toggle} />
    </label>
  )
}

/** Your devices, folded to one row: the one in use (or how many), the desk's list on a click. */
function DevicesRow({ desk }: { desk: MatrixAgentDeskState }) {
  const { locale } = useI18n()
  const copy = matrixAgentDeskText(locale)
  const [open, setOpen] = useState(false)

  if (!desk.devices.length) {
    return null
  }

  const inUse = desk.devices.find(each => each.inUse)
  const value = inUse ? `${copy.usingNow} · ${inUse.mac.name}` : String(desk.devices.length)

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <button className="atum-settings-row atum-settings-link" data-assistant-card-devices type="button">
          <span className="atum-settings-row-title shrink-0">{copy.devices}</span>
          <span className="atum-card-row-value ms-auto" title={value}>
            {value}
          </span>
          <ChevronRight aria-hidden className="atum-settings-chevron" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label={copy.devices}
        className="ak-glass ak-menu z-[140] w-80 max-w-[calc(100vw-1rem)] border-0 bg-transparent p-1.5"
        data-assistant-card-devices-popover
        sideOffset={8}
      >
        <div className="ak-menu-label">{copy.devices}</div>
        <MatrixAgentDeskDevices desk={desk} />
      </PopoverContent>
    </Popover>
  )
}

/**
 * One Pause for the agent's scheduled work (native cron through the host's agent-control route), with
 * its meaning as a tooltip. A cloud agent the host serves always has the row (owner 2026-11-27: "agent
 * card don't see pause"): with routines it is the switch; with none, or while its schedule cannot be
 * read, the row says so and the switch waits, so it never claims to pause what it cannot.
 */
function PauseRow({ active, agent }: { active: boolean; agent: MatrixAgentView }) {
  const { locale } = useI18n()
  const copy = matrixAgentDeskText(locale)
  const schedule = useMatrixAgentSchedule(active, agent)
  const paused = matrixAgentDeskPaused(schedule.jobs, schedule.globallyPaused)

  if (!schedule.hosted) {
    return null
  }

  const state = schedule.canControl ? (paused ? 'paused' : 'running') : schedule.read === 'ready' ? 'empty' : schedule.read
  const note =
    schedule.problem === 'stopped'
      ? copy.computerOff
      : schedule.problem
        ? copy.controlFailed
        : state === 'empty'
          ? copy.nothingScheduled
          : state === 'failed'
            ? copy.scheduleUnavailable
            : undefined

  return (
    <div className="atum-settings-row" data-assistant-card-pause={state} title={copy.pauseHint}>
      <span className="atum-settings-row-text min-w-0 flex-1">
        <span className="atum-settings-row-title">{copy.pause}</span>
        {note && (
          <span className="atum-settings-row-help" role="status">
            {note}
          </span>
        )}
      </span>
      {state === 'failed' && (
        <button className="ak-btn ak-btn--sm" data-assistant-card-pause-retry onClick={schedule.reload} type="button">
          {copy.tryAgain}
        </button>
      )}
      <Switch
        aria-label={copy.pause}
        checked={paused}
        disabled={!schedule.canControl || schedule.pending}
        onCheckedChange={on => (on ? schedule.pause() : schedule.resume())}
      />
    </div>
  )
}
