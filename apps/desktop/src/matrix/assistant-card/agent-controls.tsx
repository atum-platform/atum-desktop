import { type ReactNode, useState } from 'react'

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { useI18n } from '@/i18n'
import { Bell, ChevronRight, Laptop, Pause } from '@/lib/icons'

import type { MatrixAgentView, MatrixRoom } from '../../../shared/matrix'
import { matrixAgentDeskText } from '../../../shared/matrix-agent-desk-copy'
import {
  MatrixAgentDeskDevices,
  matrixAgentDeskPaused,
  type MatrixAgentDeskState,
  useMatrixAgentSchedule,
  useMatrixRoomMute
} from '../agent-desk'

import { useAssistantCardCopy } from './copy'
import { CardNotice, RowGlyph } from './row-glyph'

/**
 * The panel's live controls, placed by the card in its sections (agent card revamp 2026-11-28):
 * Notifications under "In this chat", Your devices under "Can use", Pause under "On its own", and
 * while Pause holds its routines one Paused notice under the header with Resume. Each is absent
 * where it would do nothing.
 */
export interface AssistantCardControlSlots {
  notifications?: ReactNode
  devices?: ReactNode
  pause?: ReactNode
  /** The Paused notice, only while its routines are paused. */
  paused?: ReactNode
  /** Its routines are held by Pause: the Routines row says "3 · paused". */
  routinesPaused?: boolean
}

/**
 * The agent's controls beside its chat, as the desk had them (owner 2026-11-26: "control should still
 * exist"): this chat's notifications (the chat's own mute), the devices it can use (each one's state,
 * Allow, Stop while in use), and Pause once the host reads its schedule. One schedule read serves the
 * Pause switch and the Paused notice, so the two never disagree.
 */
export function useAssistantCardControls({
  active,
  agent,
  desk,
  room
}: {
  active: boolean
  agent: MatrixAgentView
  desk: MatrixAgentDeskState
  room: MatrixRoom
}): AssistantCardControlSlots {
  const schedule = useMatrixAgentSchedule(active, agent)
  const paused = schedule.hosted && schedule.canControl && matrixAgentDeskPaused(schedule.jobs)

  return {
    notifications: <NotificationsRow room={room} />,
    devices: desk.devices.length ? <DevicesRow desk={desk} /> : undefined,
    pause: schedule.hosted ? <PauseRow schedule={schedule} /> : undefined,
    paused: paused ? <PausedNotice onResume={schedule.resume} /> : undefined,
    routinesPaused: paused
  }
}

function NotificationsRow({ room }: { room: MatrixRoom }) {
  const { locale } = useI18n()
  const copy = matrixAgentDeskText(locale)
  const { muted, toggle } = useMatrixRoomMute(room)

  return (
    <label className="atum-settings-row cursor-pointer" data-assistant-card-notifications>
      <RowGlyph icon={Bell} />
      <span className="atum-settings-row-title min-w-0 flex-1">{copy.notifications}</span>
      <Switch aria-label={copy.notifications} checked={!muted} onCheckedChange={toggle} />
    </label>
  )
}

/** Your devices, folded to one row: the one in use (else the Mac's name, else how many), the list on a click. */
function DevicesRow({ desk }: { desk: MatrixAgentDeskState }) {
  const { locale } = useI18n()
  const copy = matrixAgentDeskText(locale)
  const [open, setOpen] = useState(false)
  const inUse = desk.devices.find(each => each.inUse)
  const only = desk.devices.length === 1 ? desk.devices[0] : undefined
  const value = inUse ? `${copy.usingNow} · ${inUse.mac.name}` : only ? only.mac.name : String(desk.devices.length)

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <button className="atum-settings-row atum-settings-link" data-assistant-card-devices type="button">
          <RowGlyph icon={Laptop} />
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

type Schedule = ReturnType<typeof useMatrixAgentSchedule>

/**
 * One Pause for the agent's scheduled work (native cron through the host's agent-control route). A
 * cloud agent the host serves always has the row (owner 2026-11-27: "agent card don't see pause"):
 * with routines it is the switch; with none, or while its schedule cannot be read, the switch waits,
 * so it never claims to pause what it cannot. Its meaning and "nothing scheduled" are the tooltip;
 * only a failure is said in the row, with Try again where reading again can help.
 */
function PauseRow({ schedule }: { schedule: Schedule }) {
  const { locale } = useI18n()
  const copy = matrixAgentDeskText(locale)
  const paused = matrixAgentDeskPaused(schedule.jobs)
  const state = schedule.canControl ? (paused ? 'paused' : 'running') : schedule.read === 'ready' ? 'empty' : schedule.read

  const failure =
    schedule.problem === 'stopped'
      ? copy.computerOff
      : schedule.problem
        ? copy.controlFailed
        : state === 'failed'
          ? copy.scheduleUnavailable
          : undefined

  const tip = state === 'empty' ? `${copy.pauseHint} ${copy.nothingScheduled}` : copy.pauseHint

  return (
    <div className="atum-settings-row" data-assistant-card-pause={state} title={tip}>
      <RowGlyph icon={Pause} />
      <span className="atum-settings-row-text min-w-0 flex-1">
        <span className="atum-settings-row-title">{copy.pause}</span>
        {failure && (
          <span className="atum-settings-row-help" role="status">
            {failure}
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
        disabled={!schedule.canControl}
        onCheckedChange={on => (on ? schedule.pause() : schedule.resume())}
      />
    </div>
  )
}

/** While paused: one notice under the header, what it means, and Resume. */
function PausedNotice({ onResume }: { onResume(): void }) {
  const { locale } = useI18n()
  const desk = matrixAgentDeskText(locale)
  const copy = useAssistantCardCopy()

  return (
    <CardNotice
      action={{ label: copy.routineResume, onClick: onResume }}
      body={desk.pauseHint}
      data-assistant-card-paused
      icon={Pause}
      title={copy.pausedTitle}
    />
  )
}
