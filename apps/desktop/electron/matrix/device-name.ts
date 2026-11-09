import { execFile } from 'node:child_process'

/**
 * The name this Mac's device carries for the person's other devices (one-tap approval's sheet:
 * "Atum · MacBook Air"), never a raw ID. Only the Mac's model, never its Computer Name: device
 * names are visible to people who share a chat with the person, and a Computer Name usually holds
 * the owner's own name. Applied only to a device that has no name yet (security.ts
 * `nameOwnDevice`).
 */
export function matrixDeviceName(model: string | undefined): string {
  const clean =
    typeof model === 'string'
      ? model
          .replace(/\p{Cc}/gu, '')
          .trim()
          .slice(0, 60)
      : ''

  return `Atum · ${clean || 'Mac'}`
}

/** The Mac's model name ("MacBook Air", "Mac mini") from System Information; undefined on failure. */
export function readMatrixMacModel(run: typeof execFile = execFile): Promise<string | undefined> {
  return new Promise(resolve => {
    if (process.platform !== 'darwin') {
      resolve(undefined)

      return
    }

    run('/usr/sbin/system_profiler', ['SPHardwareDataType', '-json'], { timeout: 5_000 }, (error, stdout) => {
      if (error) {
        resolve(undefined)

        return
      }

      try {
        const value = JSON.parse(String(stdout)) as { SPHardwareDataType?: Array<{ machine_name?: unknown }> }
        const name = value.SPHardwareDataType?.[0]?.machine_name

        resolve(typeof name === 'string' && name ? name : undefined)
      } catch {
        resolve(undefined)
      }
    })
  })
}
