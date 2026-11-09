/** Preserve the documented device access and approval boundaries. */
export interface ServedAgentRuntime {
  /** The agent's Matrix user: from its enrollment on this Mac, else from the roster. */
  readonly userId?: string
  /** Retired or being retired here: it no longer belongs to the owner's active roster. */
  readonly closed?: boolean
}

export function servedAgentUsers(agents: readonly ServedAgentRuntime[]): string[] {
  const users = new Set<string>()

  for (const agent of agents) {
    if (agent.userId && !agent.closed) {
      users.add(agent.userId)
    }
  }

  return [...users]
}
