import { useStore } from '@nanostores/react'
import { atom } from 'nanostores'
import { useEffect, useState } from 'react'

import { useI18n } from '@/i18n'

import {
  MATRIX_BUNDLED_PETS,
  MATRIX_PET_DEFAULT_SCALE,
  type MatrixPetBridge,
  matrixPetChatRef
} from '../../../shared/matrix-pet'
import type { AtumPetChatAction } from '../../../shared/pet-chat/atum-pet-chat'
import { petChatCommand } from '../../../shared/pet-engine/chat-action'
import { petCopy } from '../pet-copy'

import type { PetAction } from './menu'
import { petOverlayCopy } from './overlay-copy'
import type { PetSelection } from './selection'
import { holdPetPresentation, type PetPresentation } from './store'

const empty = atom<PetPresentation>({ lastActiveAt: 0, commands: [] })

export interface PetActionsOptions {
  principal: string
  selection: PetSelection
  chat?: MatrixPetBridge['chat']
  history?: MatrixPetBridge['chatHistory']
  onSettings?: () => void
  onStore?: () => void
  popOut?: () => Promise<void>
  openPicker(size: boolean): void
  closePicker(): void
  pickerOpen: boolean
}

export function usePetActions(options: PetActionsOptions) {
  const {
    principal,
    selection,
    chat,
    history,
    onSettings,
    onStore,
    popOut,
    openPicker,
    closePicker,
    pickerOpen
  } = options

  const { locale } = useI18n()
  const copy = petCopy[locale]
  const [held, setHeld] = useState<ReturnType<typeof holdPetPresentation> | null>(null)
  const [actionFailed, setActionFailed] = useState(false)
  const presentation = useStore(held?.store ?? empty)
  const shown = Boolean(selection.view?.sprite && !selection.error)
  const name = selection.view?.sprite?.displayName ?? copy.title
  const chatRef = matrixPetChatRef(selection.view)

  useEffect(() => {
    const next = holdPetPresentation(principal, performance.now())
    setHeld(next)

    return next.release
  }, [principal])
  useEffect(() => {
    if (held) {
      held.store.set({ ...held.store.get(), pickerOpen })
    }
  }, [held, pickerOpen])
  useEffect(() => {
    if (!shown && held) {
      held.store.set({ ...held.store.get(), pickerOpen: false, menuOpen: false, glassOpen: false })
    }
  }, [shown, held])

  function patch(value: Partial<PetPresentation>) {
    if (held) {
      held.store.set({ ...held.store.get(), ...value })
    }
  }

  function gesture(action: 'wave' | 'sit' | 'lounge') {
    patch({
      pickerOpen: false,
      menuOpen: false,
      glassOpen: false,
      commands: [{ action }],
      lastActiveAt: performance.now()
    })
    closePicker()
  }

  function runChatAction(action: AtumPetChatAction) {
    const command = petChatCommand(action)

    if (command && shown) {
      patch({ commands: [command], lastActiveAt: performance.now() })
    }
  }

  const pet = selection.view?.selection.pet
  const slug = selection.view?.sprite?.slug

  const defaultBinding =
    slug && MATRIX_BUNDLED_PETS.includes(slug as (typeof MATRIX_BUNDLED_PETS)[number])
      ? { ref: { kind: 'bundled' as const, slug }, enabled: true, scale: MATRIX_PET_DEFAULT_SCALE }
      : undefined

  const binding = pet?.ref ? pet : defaultBinding

  const actions: PetAction[] = [
    {
      id: 'chat',
      label: copy.chatWith(name),
      disabled: !shown || !chat || !chatRef,
      run: () => {
        closePicker()
        patch({ pickerOpen: false, menuOpen: false, glassOpen: true })
      }
    },
    ...(['wave', 'sit', 'lounge'] as const).map(action => ({
      id: action,
      label: copy[action],
      disabled: !shown,
      run: () => gesture(action)
    })),
    { id: 'change', label: copy.change, run: () => openPicker(false) },
    { id: 'size', label: copy.size, disabled: !pet?.ref, run: () => openPicker(true) },
    ...(popOut
      ? [
          {
            id: 'popOut',
            label: petOverlayCopy[locale].popOut,
            disabled: !shown,
            run: () => {
              closePicker()
              setActionFailed(false)
              void popOut().catch(() => setActionFailed(true))
            }
          }
        ]
      : []),
    {
      id: 'visible',
      label: shown ? copy.hide : copy.show,
      disabled: !binding || !selection.canEdit,
      run: () => {
        if (binding) {
          void selection.write({ ...binding, enabled: !shown })
        }

        closePicker()
      }
    },
    {
      id: 'store',
      label: copy.store,
      disabled: !onStore,
      run: () => {
        closePicker()
        onStore?.()
      }
    },
    {
      id: 'settings',
      label: copy.settings,
      disabled: !onSettings,
      run: () => {
        closePicker()
        onSettings?.()
      }
    }
  ]

  return {
    actions,
    actionFailed,
    name,
    chat,
    chatRef,
    history,
    presentation,
    onChatAction: runChatAction,
    onMenuOpen: (menuOpen: boolean) => patch({ menuOpen }),
    closeChat: () => patch({ glassOpen: false }),
    pawState: !shown ? copy.hidden : presentation.pose === 'sleep' ? copy.asleep : copy.visible
  }
}
