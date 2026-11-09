import { useEffect, useRef } from 'react'

import { agentIdForSession, talkToAtumAgent } from '@/app/atum/agents'
import { useI18n } from '@/i18n'
import { petProfile, setPetActivity } from '@/store/pet'
import { refreshPetInfoFor, setPetScale, togglePetEnabled } from '@/store/pet-gallery'
import {
  $petOverlayAgents,
  setPetOverlayHideHandler,
  setPetOverlayOpenAppHandler,
  setPetOverlayScaleHandler,
  setPetOverlaySettingsHandler,
  setPetOverlayStoreHandler,
  setPetOverlaySubmitHandler
} from '@/store/pet-overlay'
import { $sessions } from '@/store/session'
import { $attentionSessionIds, $workingSessionIds } from '@/store/session-states'
import { isSecondaryWindow } from '@/store/windows'

import type { GatewayRequester } from '../types'

interface PetBridgeParams {
  requestGateway: GatewayRequester
  resumeSession: (sessionId: string) => Promise<unknown> | unknown
  submitText: (text: string) => Promise<unknown> | unknown
  /** Where the overlay's "Pet settings…" lands (the app owns routing). */
  openPetSettings: () => void
  /** Where the overlay's "Pet Store…" lands. */
  openPetStore: () => void
}

/**
 * Wires each popped-out pet back into the app: submit a prompt, resize, and open
 * that pet's most recent thread, plus mirroring per-agent activity into the
 * poses. Handlers register ONCE through refs tracking the latest callbacks —
 * re-registering on identity churn leaves a nulled-handler window that can drop
 * a submit. Primary window only.
 *
 * Every handler is scoped to the agent whose pet it came from. The main process
 * derives that agent from the sending overlay window rather than from anything
 * the overlay claimed, so it is safe to route a message by: a pet cannot put
 * words in another assistant's thread.
 */
export function usePetBridge({ openPetSettings, openPetStore, requestGateway, resumeSession, submitText }: PetBridgeParams): void {
  const { t } = useI18n()
  const submitTextRef = useRef(submitText)
  submitTextRef.current = submitText
  const resumeSessionRef = useRef(resumeSession)
  resumeSessionRef.current = resumeSession
  const requestGatewayRef = useRef(requestGateway)
  requestGatewayRef.current = requestGateway
  const openPetSettingsRef = useRef(openPetSettings)
  openPetSettingsRef.current = openPetSettings
  const openPetStoreRef = useRef(openPetStore)
  openPetStoreRef.current = openPetStore
  // Same reason as the callbacks above: the effect registers once, so it must
  // not close over a `t` that changes when the user switches language.
  const copyRef = useRef(t.settings.appearance.pet)
  copyRef.current = t.settings.appearance.pet

  useEffect(() => {
    if (isSecondaryWindow()) {
      return
    }

    /** That agent's most recent thread. `$sessions` is most-recent-first. */
    const latestSessionFor = (agent: string) =>
      $sessions.get().find(session => agentIdForSession(session.profile) === agent)

    setPetOverlaySubmitHandler((text, agent) => {
      // Typing into a pet is talking to THAT assistant. If it already owns the
      // chat in front of us, submit straight in; otherwise move the app to its
      // most recent thread (or a fresh one) first, so the message cannot land
      // in whichever conversation happened to be open.
      if (agent === petProfile()) {
        void submitTextRef.current(text)

        return
      }

      const latest = latestSessionFor(agent)
      const arrive = latest?.id ? resumeSessionRef.current(latest.id) : (talkToAtumAgent(agent), undefined)

      void Promise.resolve(arrive).then(() => submitTextRef.current(text))
    })
    // Alt+wheel resize from a popped-out pet — persist through this window's
    // gateway (the overlay has none) so it survives restart, against that pet's
    // own profile rather than whichever one is active.
    setPetOverlayScaleHandler((scale, agent) => setPetScale(requestGatewayRef.current, scale, agent))
    // "Hide pet" from the overlay's context menu. `popInPet` already ran (see
    // the bridge), so this only has to turn the pet off — through this window's
    // gateway, which the overlay does not have.
    setPetOverlayHideHandler(() => {
      const copy = copyRef.current

      void togglePetEnabled(requestGatewayRef.current, false, {
        fallback: copy.turnOffFailed,
        noneAvailable: copy.noneAvailable
      })
    })
    setPetOverlaySettingsHandler(() => openPetSettingsRef.current())
    setPetOverlayStoreHandler(() => openPetStoreRef.current())
    // Mail icon: open the thread belonging to the pet that was clicked.
    setPetOverlayOpenAppHandler(agent => {
      const latest = latestSessionFor(agent)

      if (latest?.id) {
        void resumeSessionRef.current(latest.id)
      } else {
        talkToAtumAgent(agent)
      }
    })

    return () => {
      setPetOverlaySubmitHandler(null)
      setPetOverlayOpenAppHandler(null)
      setPetOverlayScaleHandler(null)
      setPetOverlayHideHandler(null)
      setPetOverlaySettingsHandler(null)
      setPetOverlayStoreHandler(null)
    }
  }, [])

  // Load the spritesheet for every pet that is popped out but NOT the agent in
  // front of you. The in-window pet polls only the active agent, so without this
  // a background assistant's overlay has no sprite to draw — most visibly right
  // after boot, when `restorePetOverlay` reopens windows for agents whose info
  // has never been fetched. Same 15s cadence as the in-window poll.
  useEffect(() => {
    if (isSecondaryWindow()) {
      return
    }

    let cancelled = false

    const pull = () => {
      const active = petProfile()

      for (const agent of $petOverlayAgents.get()) {
        if (!cancelled && agent !== active) {
          void refreshPetInfoFor(requestGatewayRef.current, agent)
        }
      }
    }

    pull()

    const timer = window.setInterval(pull, 15_000)
    const unsub = $petOverlayAgents.listen(pull)

    return () => {
      cancelled = true
      window.clearInterval(timer)
      unsub()
    }
  }, [])

  // Mirror coarse per-agent state — is this assistant working, is it blocked on
  // you — into each pet's activity, so a background agent's pet reacts rather
  // than mirroring whatever the front chat is doing.
  //
  // Coarse on purpose: the fine-grained beats (reasoning, toolRunning, the
  // celebrate/error flashes) come from the message stream, which runs for the
  // session in front of you, so those stay the active agent's. What every agent
  // gets is busy and awaitingInput, which is what the bubble actually says.
  useEffect(() => {
    const sync = () => {
      const sessions = $sessions.get()
      const working = new Set($workingSessionIds.get())
      const attention = new Set($attentionSessionIds.get())
      const busyAgents = new Set<string>()
      const waitingAgents = new Set<string>()

      for (const session of sessions) {
        const agent = agentIdForSession(session.profile)

        if (working.has(session.id)) {
          busyAgents.add(agent)
        }

        if (attention.has(session.id)) {
          waitingAgents.add(agent)
        }
      }

      for (const agent of new Set([...busyAgents, ...waitingAgents, petProfile()])) {
        setPetActivity({ awaitingInput: waitingAgents.has(agent), busy: busyAgents.has(agent) }, agent)
      }
    }

    sync()

    const unsubs = [$sessions.listen(sync), $attentionSessionIds.listen(sync), $workingSessionIds.listen(sync)]

    return () => {
      for (const off of unsubs) {
        off()
      }
    }
  }, [])
}
