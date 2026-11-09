import { useCallback, useEffect, useRef, useState } from 'react'

import type { AtumPetBinding } from '../../../shared/atum-account-preferences'
import {
  MATRIX_PET_DEFAULT_SCALE,
  type MatrixPetBridge,
  type MatrixPetCatalog,
  type MatrixPetCatalogItem,
  type MatrixPetRecovery,
  type MatrixPetTarget,
  type MatrixPetView
} from '../../../shared/matrix-pet'

interface PetSelectionInput extends MatrixPetTarget {
  bridge: MatrixPetBridge
}

function samePetBinding(left: AtumPetBinding | null, right: AtumPetBinding): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/** The named agent's selection and catalog cache. All writes share one request fence. */
export function usePetSelection({ bridge, scope, agent }: PetSelectionInput) {
  const [view, setView] = useState<MatrixPetView>()
  const [catalog, setCatalog] = useState<MatrixPetCatalog>()
  const [error, setError] = useState<'unavailable' | 'conflict' | 'priceChanged' | 'refused' | 'uncertain'>()
  const [pending, setPending] = useState(false)
  const [scale, setScale] = useState(MATRIX_PET_DEFAULT_SCALE)
  const [recovery, setRecovery] = useState<MatrixPetRecovery['state']>('none')
  const [canDiscardRecovery, setCanDiscardRecovery] = useState(false)
  const sequence = useRef(0)
  const busy = useRef(false)
  const mounted = useRef(true)
  const catalogLoading = useRef(false)

  // One catalog request at a time; a newer read or write supersedes its answer.
  const loadCatalog = useCallback(async () => {
    if (catalogLoading.current) {
      return
    }

    catalogLoading.current = true
    const attempt = sequence.current

    try {
      const next = await bridge.catalog({ scope, agent })

      if (mounted.current && attempt === sequence.current) {
        setCatalog(next)
      }
    } catch {
      // The picker shows what it has; the next read or opening it again asks again.
    } finally {
      catalogLoading.current = false
    }
  }, [bridge, scope, agent])

  const read = useCallback(async () => {
    if (busy.current) {
      return
    }

    busy.current = true
    const attempt = ++sequence.current
    setPending(true)
    setError(undefined)

    try {
      const result = await bridge.read({ scope, agent })

      if (mounted.current && attempt === sequence.current) {
        setView(result)
        setScale(result.selection.pet?.scale ?? MATRIX_PET_DEFAULT_SCALE)
      }

      // The read normally brings the catalog along; ask separately only when it could not
      // (an offline read never asks). A read that just asked and got no answer is not asked
      // again at once: that request would fail the same way. Opening the picker asks again.
      if (result.catalog) {
        if (mounted.current && attempt === sequence.current) {
          setCatalog(result.catalog)
        }
      } else if (!result.catalogUnavailable) {
        void loadCatalog()
      }

      void bridge
        .recovery({ scope, agent })
        .then(next => {
          if (mounted.current && attempt === sequence.current) {
            setRecovery(next.state)
            setCanDiscardRecovery(next.canDiscard)
          }
        })
        .catch(() => {})
    } catch {
      if (mounted.current && attempt === sequence.current) {
        setView(undefined)
        setError('unavailable')
      }
    } finally {
      if (mounted.current && attempt === sequence.current) {
        setPending(false)
        busy.current = false
      }
    }
  }, [bridge, scope, agent, loadCatalog])

  useEffect(() => {
    mounted.current = true
    busy.current = false
    void read()

    return () => {
      mounted.current = false
    }
  }, [read])

  // Reconcile on foreground/reconnect, not every timeline or typing update.
  useEffect(() => {
    const refresh = () => {
      void read()
    }

    window.addEventListener('focus', refresh)
    window.addEventListener('online', refresh)

    return () => {
      window.removeEventListener('focus', refresh)
      window.removeEventListener('online', refresh)
    }
  }, [read])

  // A visiting pet leaves when its visit ends on the server's clock, not at the next
  // focus: re-read then. The delay is measured against the server time of the same
  // read, so a wrong Mac clock neither keeps her nor sends her early.
  const visitEndsAt =
    view?.freshness === 'current'
      ? (view.visitEndsAt ?? (view.selection.access === 'visiting' ? view.selection.visitEndsAt : null))
      : null

  const serverTime = view?.selection.serverTime

  useEffect(() => {
    const remaining = visitEndsAt && serverTime ? Date.parse(visitEndsAt) - Date.parse(serverTime) : NaN

    // Already past (the platform still said visiting): wait for the next focus rather
    // than re-reading in a loop.
    if (!(remaining > 0)) {
      return
    }

    // A second's grace so the platform agrees it has ended; capped to what a timer holds.
    const timer = setTimeout(() => void read(), Math.min(remaining + 1_000, 2_147_483_647))

    return () => clearTimeout(timer)
  }, [visitEndsAt, serverTime, read])

  const write = async (pet: AtumPetBinding) => {
    if (busy.current || !view || view.freshness !== 'current' || error) {
      return
    }

    busy.current = true
    const attempt = ++sequence.current
    setPending(true)

    try {
      const result = await bridge.write({ scope, agent }, view.selection.revision, pet)

      if (mounted.current && attempt === sequence.current) {
        setView(result)
        setScale(result.selection.pet?.scale ?? MATRIX_PET_DEFAULT_SCALE)
      }
    } catch (failure) {
      // A conflict is authoritative. A transport failure is not: the CAS write may
      // have landed before its reply was lost, so reconcile with one fresh read
      // instead of asking the person to guess or replaying the write.
      if (String(failure).includes('matrix_agent_definition_conflict')) {
        if (mounted.current && attempt === sequence.current) {
          setError('conflict')
        }
      } else {
        try {
          const current = await bridge.read({ scope, agent })

          if (mounted.current && attempt === sequence.current) {
            if (current.freshness === 'current' && samePetBinding(current.selection.pet, pet)) {
              setView(current)
              setScale(current.selection.pet?.scale ?? MATRIX_PET_DEFAULT_SCALE)
              setError(undefined)

              if (current.catalog) {
                setCatalog(current.catalog)
              }
            } else {
              setError(
                current.freshness === 'current' && current.selection.revision !== view.selection.revision
                  ? 'conflict'
                  : 'unavailable'
              )
            }
          }
        } catch {
          if (mounted.current && attempt === sequence.current) {
            setError('unavailable')
          }
        }
      }
    } finally {
      if (mounted.current && attempt === sequence.current) {
        setPending(false)
        busy.current = false
      }
    }
  }

  const acquire = async (item: MatrixPetCatalogItem) => {
    const store = window.atumMatrix.store

    if (busy.current || !item.offer || item.offer.scope !== 'account' || !store) {
      return
    }

    busy.current = true
    const attempt = ++sequence.current
    setPending(true)
    setError(undefined)

    try {
      const purchased = await store.purchase({ offerId: item.offer.id, offerVersion: item.offer.version })

      if (purchased.outcome === 'offer_changed') {
        setError('priceChanged')
        void store.refresh().catch(() => {})

        return
      }

      if (purchased.outcome === 'refused') {
        setError('refused')

        return
      }

      if (purchased.outcome === 'uncertain') {
        setError('uncertain')

        return
      }

      // Delivery is account-scoped. Re-read after the durable Store journal has
      // confirmed it, then make the user's explicit per-agent binding.
      const current = await bridge.read({ scope, agent })
      const updatedCatalog = await bridge.catalog({ scope, agent })
      const acquired = updatedCatalog.items.find(next => JSON.stringify(next.ref) === JSON.stringify(item.ref))

      if (!acquired || acquired.access !== 'owned') {
        throw new Error('matrix_pet_delivery_pending')
      }

      const selected = await bridge.write({ scope, agent }, current.selection.revision, {
        ref: acquired.ref,
        enabled: true,
        scale: current.selection.pet?.scale ?? MATRIX_PET_DEFAULT_SCALE
      })

      if (mounted.current && attempt === sequence.current) {
        setView(selected)
        setCatalog(updatedCatalog)
        setScale(selected.selection.pet?.scale ?? MATRIX_PET_DEFAULT_SCALE)
      }
    } catch (failure) {
      if (mounted.current && attempt === sequence.current) {
        setError(String(failure).includes('conflict') ? 'conflict' : 'unavailable')
      }
    } finally {
      if (mounted.current && attempt === sequence.current) {
        setPending(false)
        busy.current = false
      }
    }
  }

  const canEdit = Boolean(view && view.freshness === 'current' && !pending && !error)

  return {
    view,
    catalog,
    error,
    pending,
    scale,
    setScale,
    canEdit,
    read,
    loadCatalog,
    write,
    acquire,
    busy,
    mounted,
    sequence,
    setPending,
    setView,
    setCatalog,
    recovery,
    setRecovery,
    canDiscardRecovery
  }
}

export type PetSelection = ReturnType<typeof usePetSelection>
