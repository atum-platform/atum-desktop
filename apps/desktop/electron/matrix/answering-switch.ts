import { DeviceRegistryError } from './device/enrollment'

/**
 * The legacy "answers in the cloud" switch at the end of a home move (`POST /agents/{p}/answering`).
 *
 * The platform refuses that switch for every agent that has a saved execution policy
 * (`matrix_agent_set_answering_mode`, 0224: `upgrade_required`): for such an agent where it
 * answers follows its policy, so there is nothing to switch. Calling it anyway made a move that
 * the cloud had already committed report `failed / switch` to the person. A policy agent
 * therefore skips the call, and a refusal that names the same reason (the cached policy was not
 * known yet) is read as the same thing, not as a failure.
 *
 * Any other refusal or outage is still an error: for an agent without a saved policy the switch
 * is what moves its answering.
 */
export async function switchAnsweringToCloud(input: {
  /** The Mac's cached policy for this agent is a saved one (`policy.source === 'saved'`). */
  savedPolicy: boolean
  /** The legacy answering call. */
  switchAnswering(): Promise<unknown>
}): Promise<'switched' | 'follows_policy'> {
  if (input.savedPolicy) {
    return 'follows_policy'
  }

  try {
    await input.switchAnswering()
  } catch (error) {
    if (error instanceof DeviceRegistryError && error.reason === 'upgrade_required') {
      return 'follows_policy'
    }

    throw error
  }

  return 'switched'
}
