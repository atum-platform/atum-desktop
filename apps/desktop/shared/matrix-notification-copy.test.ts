import { expect, it } from 'vitest'

import { DESKTOP_LOCALES } from './desktop-locale'
import { matrixNotificationCopy } from './matrix-notification-copy'

it('ships every notification level and quiet-hours label in every desktop locale', () => {
  for (const locale of DESKTOP_LOCALES) {
    const copy = matrixNotificationCopy(locale)

    expect([
      copy.accountLevel,
      copy.accountLevelHelp,
      copy.quietHours,
      copy.quietHoursHelp,
      copy.from,
      copy.until,
      copy.timeZone,
      copy.failed,
      copy.readonly,
      ...Object.values(copy.levels),
      ...Object.values(copy.overrides)
    ].every(value => value.trim().length > 0)).toBe(true)
  }
})
