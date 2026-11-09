/** A device's last activity, in the window's language; never a device identifier. */
export function matrixDeviceLastSeen(at: number, locale: string, now = Date.now()): string {
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  const minutes = Math.round((Math.min(at, now) - now) / 60_000)

  if (minutes > -60) {
    return format.format(minutes, 'minute')
  }

  const hours = Math.round(minutes / 60)

  return hours > -24 ? format.format(hours, 'hour') : format.format(Math.round(hours / 24), 'day')
}
