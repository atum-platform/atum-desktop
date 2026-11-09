import { type QueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef } from 'react'

import { $workspaceProtected } from '@/app/atum/utilities/store'
import type { ModelSelection } from '@/app/shell/model-menu-panel'
import { getGlobalModelInfo } from '@/hermes'
import { useI18n } from '@/i18n'
import { manualPickRemoved, modelOptionsQueryKey } from '@/lib/model-options'
import { notifyError } from '@/store/notifications'
import { $activeGatewayProfile } from '@/store/profile'
import {
  $activeSessionId,
  $busy,
  $currentModel,
  $currentProvider,
  $currentReasoningEffort,
  getComposerSelectionGeneration,
  getCurrentModelSource,
  markComposerSelectionManual,
  setCurrentModel,
  setCurrentModelSource,
  setCurrentProvider,
  setCurrentReasoningEffort
} from '@/store/session'
import { $sessionStates, sessionTileDelegate } from '@/store/session-states'
import type { ModelOptionsResponse } from '@/types/hermes'

import { withSessionBusyRetry } from './use-prompt-actions/utils'

/**
 * One pick generation per live session, bumped for every selection that
 * targets it. A write that awaited the gateway reads it back afterwards: a
 * pick the person has since replaced neither writes over the newer one nor
 * rolls the newer one back when it fails. Module-level so every composer
 * surface (the primary composer, the tiles) shares one ledger per session.
 */
const pickGenerations = new Map<string, number>()

function nextPickGeneration(sessionId: string): number {
  const next = (pickGenerations.get(sessionId) ?? 0) + 1
  pickGenerations.set(sessionId, next)

  return next
}

/**
 * The one pick waiting for the primary session's turn to end. Latest wins: a
 * person who moved the slider twice during a run wants where they left it,
 * not a replay of each stop. One set of store listeners exists only while a
 * pick is pending; the pick — and the listeners with it — go away when the
 * turn ends, when the active session or gateway profile changes under it, or
 * when the composer that scheduled it unmounts.
 */
let deferredPick: { owner: object; sessionId: string; run: () => void } | null = null
let stopDeferredListeners: (() => void) | null = null

/**
 * Drops the pending pick. With an `owner`, only if that hook instance
 * scheduled it: the primary composer and every session tile mount this hook,
 * and a tile going away must not take the composer's pick with it.
 */
export function clearDeferredModelPick(owner?: object): void {
  if (owner && deferredPick && deferredPick.owner !== owner) {
    return
  }

  deferredPick = null
  stopDeferredListeners?.()
  stopDeferredListeners = null
}

function fireDeferredModelPick(): void {
  const pick = deferredPick
  clearDeferredModelPick()

  if (pick && $activeSessionId.get() === pick.sessionId) {
    pick.run()
  }
}

function deferModelPick(owner: object, sessionId: string, run: () => void): void {
  deferredPick = { owner, run, sessionId }

  if (!stopDeferredListeners) {
    const stops = [
      $busy.listen(busy => {
        if (!busy) {
          fireDeferredModelPick()
        }
      }),
      $activeSessionId.listen(active => {
        if (deferredPick && active !== deferredPick.sessionId) {
          clearDeferredModelPick()
        }
      }),
      $activeGatewayProfile.listen(() => clearDeferredModelPick())
    ]

    stopDeferredListeners = () => {
      for (const stop of stops) {
        stop()
      }
    }
  }

  // The turn may have ended between the caller's busy check and this arm.
  if (!$busy.get()) {
    fireDeferredModelPick()
  }
}

/** Test seam: forget every generation and any pending pick. */
export function resetModelPickCoordination(): void {
  pickGenerations.clear()
  clearDeferredModelPick()
}

interface ModelControlsOptions {
  queryClient: QueryClient
  requestGateway: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>
}

export function useModelControls({ queryClient, requestGateway }: ModelControlsOptions) {
  const { t } = useI18n()
  const copy = t.desktop
  const profileRefreshEpochRef = useRef(0)

  // The pending pick closes over this hook's gateway client; a composer that
  // goes away takes its own pick with it rather than firing through a dead
  // client — and only its own.
  const ownerRef = useRef<object>({})

  useEffect(() => {
    const owner = ownerRef.current

    return () => clearDeferredModelPick(owner)
  }, [])

  // All callbacks here read reactive session state from the store (.get())
  // rather than capturing it as a prop. The actions bag in wiring.tsx mutates
  // in place to keep a stable identity, so memoized surfaces capture these
  // callbacks once and never re-evaluate — a captured prop would be stale
  // forever. The store read is always current.
  const updateModelOptionsCache = useCallback(
    (
      sessionId: null | string,
      provider: string,
      model: string,
      includeGlobal: boolean,
      profile = $activeGatewayProfile.get()
    ) => {
      const patch = (prev: ModelOptionsResponse | undefined) => ({ ...(prev ?? {}), provider, model })

      queryClient.setQueryData<ModelOptionsResponse>(modelOptionsQueryKey(profile, sessionId), patch)

      if (includeGlobal) {
        queryClient.setQueryData<ModelOptionsResponse>(modelOptionsQueryKey(profile), patch)
      }
    },
    [queryClient]
  )

  // Seed the composer's model state from the profile default. `force` reseeds
  // for a profile swap (the new profile has its own default); otherwise this
  // only fills an EMPTY selection so a user's pick (plain UI state in
  // $currentModel) survives the lifecycle refreshes that fire on boot / fresh
  // draft / session events. A live session owns the footer, so skip entirely.
  const refreshCurrentModel = useCallback(
    async (force = false) => {
      // A forced profile swap opens a new intent epoch; an older in-flight
      // response for a previous profile must stand down when it resolves.
      if (force) {
        profileRefreshEpochRef.current += 1
      }

      const profileRefreshEpoch = profileRefreshEpochRef.current

      try {
        if ($activeSessionId.get()) {
          return
        }

        // A manual pick stays sticky UNLESS it was removed from the catalog (its
        // model no longer exists on the provider), in which case keeping it would
        // 404 every new chat — fall through to reseed from the profile default.
        // Reads the model-options cache the composer already populated; an
        // unknown/not-yet-loaded catalog conservatively preserves the pick.
        const keepManualPick = () => {
          if (force || !$currentModel.get() || getCurrentModelSource() !== 'manual') {
            return false
          }

          const options = queryClient.getQueryData<ModelOptionsResponse>(
            modelOptionsQueryKey($activeGatewayProfile.get())
          )

          return !manualPickRemoved(options?.providers, $currentProvider.get(), $currentModel.get())
        }

        if (keepManualPick()) {
          return
        }

        // Snapshot the selection generation before awaiting so a picker click
        // that lands while getGlobalModelInfo is in flight wins over this older
        // default — value comparisons alone miss re-selecting the same row.
        const selectionGeneration = getComposerSelectionGeneration()
        const result = await getGlobalModelInfo()

        if (
          profileRefreshEpochRef.current !== profileRefreshEpoch ||
          $activeSessionId.get() ||
          getComposerSelectionGeneration() !== selectionGeneration ||
          keepManualPick()
        ) {
          return
        }

        if (typeof result.model === 'string') {
          setCurrentModel(result.model)
        }

        if (typeof result.provider === 'string') {
          setCurrentProvider(result.provider)
        }

        if (typeof result.model === 'string' || typeof result.provider === 'string') {
          setCurrentModelSource('default')
        }
      } catch {
        // The delayed session.info event still updates this once the agent is ready.
      }
    },
    [queryClient]
  )

  // Returns whether the switch succeeded so callers can await it before applying
  // follow-up changes. The composer model is plain UI state: with no live
  // session it's just stored (and shipped on the next session.create); with one
  // it's scoped to that session via config.set. It NEVER writes the profile
  // default — that lives in Settings → Model — so picking a model here can't
  // silently mutate global config.
  //
  // `selection.sessionId` targets a specific surface (tile). When omitted, the
  // primary `$activeSessionId` is used (overlay / legacy callers). A tile
  // switch must not touch the primary globals — and must not be blocked by a
  // busy primary turn.
  const selectModel = useCallback(
    async (selection: ModelSelection): Promise<boolean> => {
      if ($workspaceProtected.get()) { selection = { ...selection, model: 'binh-minh', provider: 'atum-managed' } }
      const primaryRuntimeId = $activeSessionId.get()
      const liveSessionId = 'sessionId' in selection ? (selection.sessionId ?? null) : primaryRuntimeId
      const touchesPrimary = !liveSessionId || liveSessionId === primaryRuntimeId
      const generation = liveSessionId ? nextPickGeneration(liveSessionId) : 0

      // Still the newest pick for this session, on a primary that still shows
      // it. Read after every await: what was true when the write started may
      // not be by the time it returns.
      const current = (): boolean =>
        !liveSessionId ||
        (pickGenerations.get(liveSessionId) === generation && (!touchesPrimary || $activeSessionId.get() === liveSessionId))

      const prevModel = touchesPrimary ? $currentModel.get() : ($sessionStates.get()[liveSessionId!]?.model ?? '')

      const prevProvider = touchesPrimary
        ? $currentProvider.get()
        : ($sessionStates.get()[liveSessionId!]?.provider ?? '')

      const prevEffort = touchesPrimary
        ? $currentReasoningEffort.get()
        : ($sessionStates.get()[liveSessionId!]?.reasoningEffort ?? '')

      const prevSource = getCurrentModelSource()
      const liveGatewayProfile = $activeGatewayProfile.get()

      if (touchesPrimary) {
        setCurrentModel(selection.model)
        setCurrentProvider(selection.provider)

        if (selection.effort) {
          setCurrentReasoningEffort(selection.effort)
        }

        markComposerSelectionManual()
      } else if (liveSessionId) {
        // Optimistic tile paint — session.info will confirm; rollback on error.
        sessionTileDelegate()?.updateSession(liveSessionId, state => ({
          ...state,
          model: selection.model,
          provider: selection.provider,
          ...(selection.effort ? { reasoningEffort: selection.effort } : {})
        }))
      }

      updateModelOptionsCache(
        liveSessionId,
        selection.provider,
        selection.model,
        touchesPrimary && !liveSessionId,
        liveGatewayProfile
      )

      // No live session yet: the pick is pure UI state. session.create reads
      // $currentModel/$currentProvider and applies it as that session's override.
      if (!liveSessionId) {
        return true
      }

      const commit = async (): Promise<boolean> => {
      try {
        await withSessionBusyRetry(() => requestGateway('config.set', {
          session_id: liveSessionId,
          key: 'model',
          value: `${selection.model} --provider ${selection.provider} --session`
        }))

        // Overtaken while the write was out: the newer pick owns the session
        // from here, including its effort.
        if (!current()) {
          return true
        }

        // The slider's stops are catalog-derived model/effort pairs. Apply the
        // advertised effort to the same live session, rather than leaving a
        // successful model switch with its prior reasoning depth.
        if (selection.effort) {
          await withSessionBusyRetry(() => requestGateway('config.set', {
            key: 'reasoning',
            session_id: liveSessionId,
            value: selection.effort
          }))
        }

        void queryClient.invalidateQueries({ queryKey: modelOptionsQueryKey(liveGatewayProfile, liveSessionId) })

        return true
      } catch (err) {
        // An overtaken pick's failure is not the newer pick's: no rollback of
        // state that now describes something else, no toast for a choice the
        // person has already moved past. The catalog refresh still runs so the
        // server view corrects whatever this left behind.
        if (!current()) {
          void queryClient.invalidateQueries({ queryKey: modelOptionsQueryKey(liveGatewayProfile, liveSessionId) })

          return false
        }

        if (touchesPrimary) {
          setCurrentModel(prevModel)
          setCurrentProvider(prevProvider)

          if (selection.effort) {
            setCurrentReasoningEffort(prevEffort)
          }

          setCurrentModelSource(prevSource)
        } else if (liveSessionId) {
          sessionTileDelegate()?.updateSession(liveSessionId, state => ({
            ...state,
            model: prevModel,
            provider: prevProvider,
            ...(selection.effort ? { reasoningEffort: prevEffort } : {})
          }))
        }

        // A model write can succeed before its effort write fails. Restore the
        // live backend best-effort, then invalidate its catalog so the next
        // open reflects authoritative session state even if restoration failed.
        if (selection.effort && prevModel && prevProvider) {
          try {
            await requestGateway('config.set', {
              key: 'model',
              session_id: liveSessionId,
              value: `${prevModel} --provider ${prevProvider} --session`
            })

            if (prevEffort) {
              await requestGateway('config.set', {
                key: 'reasoning',
                session_id: liveSessionId,
                value: prevEffort
              })
            }
          } catch {
            // The original error is the useful one. Invalidation below lets the
            // server correct this optimistic view on the next picker opening.
          }
        }

        updateModelOptionsCache(
          liveSessionId,
          prevProvider,
          prevModel,
          touchesPrimary && !liveSessionId,
          liveGatewayProfile
        )
        void queryClient.invalidateQueries({ queryKey: modelOptionsQueryKey(liveGatewayProfile, liveSessionId) })
        notifyError(err, copy.modelSwitchFailed)

        return false
      }
      }

      // A turn is running on the primary session. The gateway refuses to change
      // the model under a live turn ("session busy"), and surfacing that as a
      // failure made switching mid-run look broken when every other assistant
      // simply applies the pick to the next turn. The composer has already
      // painted the pick; land it the moment the turn ends, unless a newer pick
      // or a session change has overtaken it by then. A failure then is
      // reported the way an immediate one is, from `commit`.
      if (touchesPrimary && $busy.get()) {
        deferModelPick(ownerRef.current, liveSessionId, () => {
          if (current()) {
            void commit()
          }
        })

        return true
      }

      return commit()
    },
    [copy.modelSwitchFailed, queryClient, requestGateway, updateModelOptionsCache]
  )

  return { refreshCurrentModel, selectModel, updateModelOptionsCache }
}
