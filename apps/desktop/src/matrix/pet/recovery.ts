import { MATRIX_PET_DEFAULT_SCALE, type MatrixPetBridge, type MatrixPetTarget } from '../../../shared/matrix-pet'

import type { PetSelection } from './selection'

export type PetHatchError = 'draft' | 'limit' | 'recovering' | 'conflict' | 'priceChanged' | 'refused'
interface RecoveryInput
  extends
    MatrixPetTarget,
    Pick<PetSelection, 'busy' | 'mounted' | 'sequence' | 'setPending' | 'setView' | 'setScale' | 'setRecovery'> {
  bridge: MatrixPetBridge
  setHatchError(value: PetHatchError | undefined): void
}

/** Recovery actions keep the same named target and shared write fence. */
export function petRecoveryActions({
  bridge,
  scope,
  agent,
  busy,
  mounted,
  sequence,
  setPending,
  setView,
  setScale,
  setRecovery,
  setHatchError
}: RecoveryInput) {
  const adoptPending = async () => {
    if (busy.current) {
      return
    }

    busy.current = true
    setPending(true)

    try {
      const result = await bridge.adoptPending({ scope, agent })
      setView(result)
      setScale(result.selection.pet?.scale ?? MATRIX_PET_DEFAULT_SCALE)
      setHatchError(undefined)
    } catch {
      setHatchError('conflict')
    } finally {
      busy.current = false
      setPending(false)
    }
  }

  const retryPending = async () => {
    if (busy.current) {
      return
    }

    busy.current = true
    const attempt = ++sequence.current
    setPending(true)

    try {
      const result = await bridge.retryPending({ scope, agent })

      if (mounted.current && attempt === sequence.current) {
        setView(result)
        setRecovery('none')
      }
    } catch {
      if (mounted.current && attempt === sequence.current) {
        setHatchError('recovering')
      }
    } finally {
      if (mounted.current && attempt === sequence.current) {
        busy.current = false
        setPending(false)
      }
    }
  }

  const discardPending = async () => {
    if (busy.current) {
      return
    }

    busy.current = true
    const attempt = ++sequence.current
    setPending(true)

    try {
      await bridge.discardPending({ scope, agent })

      if (mounted.current && attempt === sequence.current) {
        setRecovery('none')
      }
    } catch {
      if (mounted.current && attempt === sequence.current) {
        setHatchError('recovering')
      }
    } finally {
      if (mounted.current && attempt === sequence.current) {
        busy.current = false
        setPending(false)
      }
    }
  }

  return { adoptPending, retryPending, discardPending }
}
