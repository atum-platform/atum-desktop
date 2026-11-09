import { useStore } from '@nanostores/react'
import { useEffect, useRef, useState } from 'react'

import { useMediaQuery } from '@/hooks/use-media-query'
import { useI18n } from '@/i18n'

import type { MatrixSnapshot } from '../../../shared/matrix'
import type { MatrixPetBridge } from '../../../shared/matrix-pet'
import type { MatrixPetDisplayBridge } from '../../../shared/matrix-pet-display'

import { usePetActions } from './actions'
import { PetGlassChat } from './glass-chat'
import { usePetHatch } from './hatch'
import { $matrixPetHatchRequest } from './hatch-request'
import { petOverlayCopy } from './overlay-copy'
import { PetPopover } from './popover'
import { usePetSelection } from './selection'
import { MatrixPetStage } from './stage'
import { usePetIntentIntake } from './use-intake'
import { usePetWork } from './use-work'

interface AgentPetProps {
  bridge: MatrixPetBridge
  scope: string
  agent: string
  snapshot: MatrixSnapshot
  onSettings?: () => void
  onStore?: () => void
  display?: MatrixPetDisplayBridge
}

export function AgentPet({ bridge, scope, agent, snapshot, onSettings, onStore, display }: AgentPetProps) {
  const reduceMotion = useMediaQuery('(prefers-reduced-motion: reduce)')
  const { locale } = useI18n()
  const [open, setOpen] = useState(false)
  const [focusSize, setFocusSize] = useState(0)
  // Counts the hatches asked for from elsewhere (the Store's Hatch card); 0 while none is.
  const [focusHatch, setFocusHatch] = useState(0)
  const hatchRequest = useStore($matrixPetHatchRequest)
  const consumedHatchRequest = useRef<typeof hatchRequest>(null)
  const anchor = useRef<HTMLDivElement>(null)
  const selection = usePetSelection({ bridge, scope, agent })
  usePetIntentIntake(snapshot, Boolean(selection.view?.sprite && !selection.error), reduceMotion)
  const hatch = usePetHatch({ bridge, scope, agent, selection })
  const { choosePhoto } = hatch
  const work = usePetWork(snapshot)

  // Closing ends a Store hatch request; later opens from an account action or pet menu are ordinary.
  const changeOpen = (next: boolean) => {
    setOpen(next)

    if (!next) {
      setFocusHatch(0)
    }
  }

  const ui = usePetActions({
    principal: JSON.stringify([scope, agent]),
    selection,
    chat: bridge.chat,
    history: bridge.chatHistory,
    onSettings,
    onStore,
    popOut: display ? () => display.popOut({ scope, agent }) : undefined,
    pickerOpen: open,
    closePicker: () => changeOpen(false),
    openPicker: size => {
      setFocusSize(current => (size ? current + 1 : 0))
      setFocusHatch(0)
      setOpen(true)
    }
  })

  // The Store asked for a hatch in this chat: open on the hatch panel, and take the request once.
  useEffect(() => {
    if (!hatchRequest || hatchRequest.roomId !== snapshot.roomId) {
      return
    }

    // State updates made below can render before the atom subscription observes its clear.
    // Retain the request identity so a Store photo request is consumed only once.
    if (consumedHatchRequest.current === hatchRequest) {
      return
    }

    consumedHatchRequest.current = hatchRequest

    $matrixPetHatchRequest.set(null)
    setFocusSize(0)
    setFocusHatch(current => current + 1)
    setOpen(true)

    if (hatchRequest.choosePhoto) {
      void choosePhoto()
    }
  }, [choosePhoto, hatchRequest, snapshot.roomId])

  useEffect(
    () =>
      display?.onAction(value => {
        if (value.target.scope !== scope || value.target.agent !== agent) {
          return false
        }

        ui.actions.find(action => action.id === value.action)?.run()

        return true
      }),
    [display, scope, agent, ui.actions]
  )

  const hasVisiblePet = Boolean(selection.view?.sprite && !selection.error)

  return (
    <div
      className={`pointer-events-none relative mx-auto w-full max-w-[700px] px-10 ${hasVisiblePet || open ? 'h-8' : 'h-0'}`}
      data-matrix-pet={agent}
      ref={anchor}
    >
      {selection.view?.sprite && !selection.error && (
        <div className="absolute inset-x-10 bottom-0 h-full">
          <MatrixPetStage
            actions={ui.actions}
            agent={agent}
            info={selection.view.sprite}
            onMenuOpen={ui.onMenuOpen}
            onPetClick={() => ui.actions.find(action => action.id === 'chat')?.run()}
            principal={JSON.stringify([scope, agent])}
            roaming={selection.view.roaming ?? true}
            still={reduceMotion}
            work={work}
          />
        </div>
      )}
      <div className="pointer-events-auto absolute right-10 bottom-0 flex items-end gap-1">
        {ui.actionFailed && (
          <p className="text-xs text-muted-foreground" role="status">
            {petOverlayCopy[locale].failed}
          </p>
        )}
        <PetPopover
          actions={ui.actions}
          display={display}
          focusHatch={focusHatch}
          focusSize={focusSize}
          hatch={hatch}
          onOpenChange={changeOpen}
          open={open}
          selection={selection}
        />
      </div>
      {ui.presentation.glassOpen && selection.view?.sprite && !selection.error && (
        <PetGlassChat
          anchor={anchor.current}
          chat={ui.chat}
          chatRef={ui.chatRef}
          close={ui.closeChat}
          history={ui.history}
          name={ui.name}
          onAction={ui.onChatAction}
          position={ui.presentation.position}
          sprite={selection.view.sprite}
        />
      )}
    </div>
  )
}
