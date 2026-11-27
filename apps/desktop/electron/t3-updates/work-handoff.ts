import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

import type { DesktopUpdateState } from '../../vendor/t3-updates/packages/contracts/src/desktopUpdates'
import type { WorkDesktopUpdateHandler, WorkDesktopUpdateRequest } from '../work/sidecar/desktop-control'

type Connection = Parameters<WorkDesktopUpdateHandler>[1]
type Prepare = Extract<WorkDesktopUpdateRequest, { type: 'requestDesktopUpdate' }>

class WorkUpdateRefusal extends Error {}

export function workDesktopUpdateHandler(updates: {
  state(): DesktopUpdateState
  checkNow(): Promise<boolean>
  download(): Promise<boolean>
  setChannel(channel: string): Promise<boolean>
  restart(version: string): Promise<boolean>
}): WorkDesktopUpdateHandler {
  let active: { id: string; connection: Connection; abort: AbortController } | undefined
  let prepared: {
    token: string
    requestId: string
    connection: Connection
    channel: DesktopUpdateState['channel']
    version: string
    expiresAt: number
  } | undefined
  let committing: string | undefined

  const fail = (connection: Connection, requestId: string, reason: string) =>
    connection.report({ requestId, outcome: 'failed', reason, state: updates.state() })

  async function prepare(request: Prepare, connection: Connection, signal: AbortSignal) {
    const { requestId, channel, targetVersion } = request
    if (channel && channel !== updates.state().channel) {
      if (!targetVersion || !await updates.setChannel(channel === 'nightly' ? 'beta' : 'latest')) {
        throw new WorkUpdateRefusal('The requested update channel is unavailable.')
      }
    }

    let checked = false
    let downloaded = false
    let lastState: DesktopUpdateState | undefined
    while (!signal.aborted && connection.current()) {
      const state = updates.state()
      if (state !== lastState) {
        connection.report({ requestId, state })
        lastState = state
      }
      if (!state.enabled || (channel && state.channel !== channel)) {
        throw new WorkUpdateRefusal('Desktop updates are unavailable for the requested channel.')
      }
      if (targetVersion === state.currentVersion || state.status === 'up-to-date') {
        if (targetVersion && targetVersion !== state.currentVersion) {
          throw new Error('The requested release is no longer available.')
        }
        connection.report({ requestId, outcome: 'up-to-date', state })
        return
      }
      if (state.status === 'downloaded' && state.downloadedVersion) {
        if (targetVersion && targetVersion !== state.downloadedVersion) {
          throw new Error('The requested release is no longer available.')
        }
        prepared = {
          token: randomUUID(), requestId, connection, channel: state.channel,
          version: state.downloadedVersion, expiresAt: Date.now() + 5 * 60_000
        }
        connection.report({ requestId, outcome: 'ready-to-install', preparedRequestId: prepared.token, state })
        return
      }
      if (state.status === 'error') {throw new WorkUpdateRefusal('The Mac could not prepare the update.')}
      if (state.status === 'idle' && !checked) {checked = await updates.checkNow()}
      if (state.status === 'available' && !downloaded) {downloaded = await updates.download()}
      await delay(250, undefined, { signal, ref: false })
    }
  }

  return (request, connection) => {
    if (!connection.current()) {return}
    if (prepared && (prepared.expiresAt <= Date.now() || !prepared.connection.current())) {prepared = undefined}
    if (request.type === 'cancelDesktopUpdate') {
      if (active?.id === request.requestId && active.connection === connection) {active.abort.abort()}
      if (prepared?.requestId === request.requestId && prepared.connection === connection) {prepared = undefined}
      return
    }
    if (request.type === 'commitDesktopUpdate') {
      if (committing === request.requestId) {return}
      const state = updates.state()
      const selection = prepared
      // Only the prepared token for this still-owned connection, channel and exact version
      // can consume the preparation. Replay cannot enter the normal install path twice.
      if (committing || !selection || selection.connection !== connection || selection.token !== request.requestId ||
          selection.version !== state.downloadedVersion || selection.channel !== state.channel) {
        fail(connection, request.requestId, 'The prepared desktop update is no longer available.')
        return
      }
      prepared = undefined
      committing = selection.token
      void updates.restart(selection.version).then(accepted => {
        if (!accepted) {fail(connection, request.requestId, 'The Mac could not restart for the update.')}
      }, () => fail(connection, request.requestId, 'The Mac could not restart for the update.')).finally(() => {
        committing = undefined
      })
      return
    }
    if (request.type !== 'requestDesktopUpdate') {return}
    if (committing || prepared || (active && !active.abort.signal.aborted && active.connection.current())) {
      fail(connection, request.requestId, 'A desktop update is already in progress.')
      return
    }
    const pending = { id: request.requestId, connection, abort: new AbortController() }
    active = pending
    const deadline = AbortSignal.timeout(4 * 60_000)
    const signal = AbortSignal.any([deadline, pending.abort.signal, connection.signal])
    void prepare(request, connection, signal).catch(error => {
      if (connection.current() && !pending.abort.signal.aborted) {
        fail(connection, request.requestId, deadline.aborted ? 'Preparing the desktop update timed out.' :
          error instanceof WorkUpdateRefusal ? error.message : 'The Mac could not prepare the update.')
      }
    }).finally(() => {if (active === pending) {active = undefined}})
  }
}
