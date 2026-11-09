import { useCallback, useEffect, useRef, useState } from 'react'

import {
  MATRIX_PET_DEFAULT_SCALE,
  type MatrixPetBridge,
  type MatrixPetDraft,
  type MatrixPetHatchProgress,
  type MatrixPetPhoto,
  type MatrixPetTarget
} from '../../../shared/matrix-pet'
import { canGenerateMatrixPet } from '../pet-input'

import { petHatchQuote } from './catalog'
import { type PetHatchError, petRecoveryActions } from './recovery'
import type { PetSelection } from './selection'

interface PetHatchInput extends MatrixPetTarget {
  bridge: MatrixPetBridge
  selection: PetSelection
}

/** One draft/hatch operation for the keyed agent; no model or pricing policy lives here. */
export function usePetHatch({ bridge, scope, agent, selection }: PetHatchInput) {
  const { catalog, canEdit, busy, mounted, setPending, setView, setScale, setCatalog } = selection
  const [drafts, setDrafts] = useState<MatrixPetDraft[]>([])
  const [draft, setDraft] = useState<number>()
  const [hatchPrompt, setHatchPrompt] = useState('')
  const [hatchName, setHatchName] = useState('')
  const [hatchPhase, setHatchPhase] = useState<MatrixPetHatchProgress['phase']>()
  const [hatchError, setHatchError] = useState<PetHatchError>()
  const [photoSelected, setPhotoSelected] = useState(false)
  const photo = useRef<MatrixPetPhoto | undefined>(undefined)
  const hatchQuote = petHatchQuote(catalog)
  const noRounds = catalog?.hatch.roundsLeft === 0

  const hatchOperation = useRef<string | undefined>(undefined)

  const refreshCatalog = () =>
    bridge
      .catalog({ scope, agent })
      .then(next => {
        if (mounted.current) {
          setCatalog(next)
        }

        return next
      })
      .catch(() => undefined)

  const generate = async () => {
    if (busy.current || !canEdit || noRounds || !canGenerateMatrixPet(hatchPrompt, Boolean(photo.current))) {
      return
    }

    const operationId = crypto.randomUUID()
    hatchOperation.current = operationId
    busy.current = true
    setPending(true)
    setHatchError(undefined)
    setHatchPhase('designing')

    try {
      const selectedPhoto = photo.current

      const result = await bridge.generate({
        target: { scope, agent },
        operationId,
        prompt: hatchPrompt.trim(),
        count: 4,
        ...(selectedPhoto ? { photo: selectedPhoto } : {})
      })

      if (hatchOperation.current === operationId) {
        setDrafts(result.drafts)
        setDraft(result.drafts[0]?.index)
        setHatchPhase('ready')
      }

      void refreshCatalog()
    } catch {
      // The gateway refuses a draft once the daily allowance (personal or platform-wide)
      // is spent. Re-read it so that case shows the allowance message, not "try again".
      const next = await refreshCatalog()

      if (hatchOperation.current === operationId) {
        setHatchError(next?.hatch.roundsLeft === 0 ? undefined : 'draft')
        setHatchPhase(undefined)
      }
    } finally {
      photo.current = undefined
      setPhotoSelected(false)

      if (hatchOperation.current === operationId) {
        setPending(false)
        busy.current = false
      }
    }
  }

  const hatch = async () => {
    if (busy.current || !canEdit || draft === undefined || !hatchName.trim() || !hatchOperation.current) {
      return
    }

    const operationId = hatchOperation.current
    busy.current = true
    setPending(true)
    setHatchError(undefined)
    setHatchPhase('rendering')

    try {
      if (!hatchQuote) {
        return
      }

      const result = await bridge.hatch({
        target: { scope, agent },
        operationId,
        token: drafts[0]?.token ?? '',
        index: draft,
        displayName: hatchName.trim(),
        description: hatchPrompt.trim(),
        quote: hatchQuote
      })

      if (hatchOperation.current === operationId) {
        setView(result)
        setScale(result.selection.pet?.scale ?? MATRIX_PET_DEFAULT_SCALE)
        setDrafts([])
        setDraft(undefined)
        setHatchPhase(undefined)
        void bridge
          .catalog({ scope, agent })
          .then(setCatalog)
          .catch(() => {})
      }
    } catch (failure) {
      if (hatchOperation.current === operationId) {
        const text = String(failure)
        setHatchError(
          text.includes('matrix_pet_refused')
            ? 'refused'
            : text.includes('price_changed')
              ? 'priceChanged'
              : text.includes('limit')
                ? 'limit'
                : text.includes('conflict') || text.includes('adopt')
                  ? 'conflict'
                  : text.includes('uncertain') || text.includes('recovering')
                    ? 'recovering'
                    : 'draft'
        )

        if (text.includes('price_changed')) {
          void bridge
            .catalog({ scope, agent })
            .then(setCatalog)
            .catch(() => {})
        }

        setHatchPhase(undefined)
      }
    } finally {
      if (hatchOperation.current === operationId) {
        setPending(false)
        busy.current = false
      }
    }
  }

  const cancelHatch = () => {
    const operationId = hatchOperation.current

    if (operationId) {
      void bridge.cancel(operationId)
    }
  }

  const choosePhoto = useCallback(async () => {
    if (busy.current) {
      return
    }

    try {
      const selected = await bridge.choosePhoto()

      if (!mounted.current) {
        return
      }

      photo.current = selected ?? undefined
      setPhotoSelected(Boolean(selected))
    } catch {
      // Native pickers reject when closed or unavailable. Treat that exactly as no selection.
      if (mounted.current) {
        photo.current = undefined
        setPhotoSelected(false)
      }
    }
  }, [bridge, busy, mounted])

  useEffect(
    () =>
      bridge.onHatchProgress(progress => {
        if (progress.operationId === hatchOperation.current) {
          setHatchPhase(progress.phase)
        }
      }),
    [bridge]
  )

  useEffect(
    () => () => {
      photo.current = undefined
      hatchOperation.current = undefined
    },
    []
  )

  return {
    drafts,
    draft,
    setDraft,
    hatchPrompt,
    setHatchPrompt,
    hatchName,
    setHatchName,
    hatchPhase,
    hatchError,
    photoSelected,
    hatchQuote,
    noRounds,
    generate,
    hatch,
    cancelHatch,
    choosePhoto,
    ...petRecoveryActions({ ...selection, bridge, scope, agent, setHatchError })
  }
}

export type PetHatch = ReturnType<typeof usePetHatch>
