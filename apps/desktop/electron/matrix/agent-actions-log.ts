import type { MatrixAgentView } from '../../shared/matrix'
import { matrixAgentActions, matrixAgentGroupOffer } from '../../shared/matrix-agent-actions'

const offered = (value: boolean) => (value ? 'offered' : 'hidden')

/**
 * What the window offers for each assistant (Q4, shared/matrix-agent-actions.ts), one line per
 * assistant when its answer changes, so a "where did Add to group go" report can be read from
 * the log. Closed codes only: the principal's first 8 characters, `place=cloud|local`,
 * `ready=0|1`, `group=offered|blocked|hidden` (as the group picker shows it) and offered/hidden for
 * photo and move. A cloud-route assistant a Mac keeps ready says `mac=answering|standby` last (the
 * saved policy and the lease decide it, not the roster's `answering`). No name, room or content. While the app starts, an assistant may log first as
 * `ready=0` or `place=local` and again once its host or the cloud roster is known: the last line
 * per assistant is its state.
 */
export class MatrixAgentActionsLog {
  private readonly last = new Map<string, string>()

  constructor(private readonly write: (line: string) => void) {}

  observe(agents: readonly MatrixAgentView[] | undefined): void {
    const seen = new Set<string>()

    for (const agent of agents ?? []) {
      seen.add(agent.principal)
      const actions = matrixAgentActions(agent)

      const line =
        `[Matrix] agent actions agent=${agent.principal.slice(0, 8)}` +
        ` place=${agent.answering === 'cloud' ? 'cloud' : 'local'} ready=${agent.ready ? 1 : 0}` +
        ` group=${matrixAgentGroupOffer(agent)} photo=${offered(actions.photo)} move=${offered(actions.move)}` +
        (agent.macRole ? ` mac=${agent.macRole}` : '')

      if (this.last.get(agent.principal) !== line) {
        this.last.set(agent.principal, line)
        this.write(line)
      }
    }

    // A retired assistant, or another account's: forget it, so it logs again if it comes back.
    for (const principal of [...this.last.keys()]) {
      if (!seen.has(principal)) {
        this.last.delete(principal)
      }
    }
  }
}
