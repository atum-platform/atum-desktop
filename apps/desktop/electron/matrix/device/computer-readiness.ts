/** Re-probe on every call so a macOS grant takes effect without restarting Atum. */
export function createComputerReadiness(deps: {
  status(): Promise<{ accessibility?: boolean; screen_recording?: boolean }>
  request(): Promise<void>
  explain(message: string, settingsUrl: string): Promise<void>
}) {
  let requested: string | null = null

  return async (force = false): Promise<string | null> => {
    if (force) { requested = null }
    const status = await deps.status()

    if (!force && status.accessibility && status.screen_recording) {
      requested = null
      return null
    }
    const permission = !status.accessibility ? 'Accessibility' : 'Screen Recording'
    if (requested !== permission) {
      requested = permission

      try { await deps.request() } catch (error) { requested = null; throw error }
      const updated = await deps.status()

      if (updated.accessibility && updated.screen_recording) { requested = null;

 return null }

      await deps.explain(`Allow CuaDriver ${permission} so your assistant can use this Mac.`,
        `x-apple.systempreferences:com.apple.preference.security?Privacy_${!status.accessibility ? 'Accessibility' : 'ScreenCapture'}`)
    }
    return `Allow CuaDriver ${permission} in System Settings, then continue.`
  }
}
