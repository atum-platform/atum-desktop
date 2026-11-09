import type { CompanyRole13 } from '../../../shared/matrix-company-team-space'

import { useTeamSpaceCopy } from './copy'

/** A role as a quiet pill. The owner reads a shade stronger: there is exactly one. */
export function RoleBadge({ role }: { role: CompanyRole13 }) {
  const { team } = useTeamSpaceCopy()

  return (
    <span
      className={
        role === 'owner'
          ? 'rounded-full border border-(--atum-ink-faint) bg-(--atum-surface-2) px-2 py-0.5 text-xs font-medium text-(--atum-ink)'
          : 'rounded-full border border-(--atum-line) px-2 py-0.5 text-xs text-(--atum-ink-muted)'
      }
      data-role-badge={role}
    >
      {team[role]}
    </span>
  )
}
