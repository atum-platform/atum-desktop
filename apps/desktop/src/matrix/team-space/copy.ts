import { useI18n } from '@/i18n'

import { matrixCompanyCopy } from '../../../shared/matrix-company-copy'
import { matrixTeamSpaceCopy } from '../../../shared/matrix-team-space-copy'

/** Both copy tables Team Space draws from: the company workspace's and C1/C2's. */
export function useTeamSpaceCopy() {
  const { locale } = useI18n()

  return { company: matrixCompanyCopy(locale), locale, team: matrixTeamSpaceCopy(locale) }
}
