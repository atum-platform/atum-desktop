import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const MAX_AGE_MS = 30 * 60_000

export interface UpdateHandoffBounds {
  x: number
  y: number
  width: number
  height: number
}

function finiteBounds(value: unknown): UpdateHandoffBounds | null {
  if (!value || typeof value !== 'object') {return null}
  const { x, y, width, height } = value as Record<string, unknown>

  if (![x, y, width, height].every(each => typeof each === 'number' && Number.isFinite(each))) {return null}

  if ((width as number) < 200 || (height as number) < 200 || (width as number) > 20_000 || (height as number) > 20_000) {return null}

  return { x: Math.round(x as number), y: Math.round(y as number), width: Math.round(width as number), height: Math.round(height as number) }
}

/** The saved place, kept on the display it now matches and fully inside its work area. */
export function restoredUpdateBounds(bounds: UpdateHandoffBounds, workArea: UpdateHandoffBounds): UpdateHandoffBounds {
  const width = Math.min(bounds.width, workArea.width)
  const height = Math.min(bounds.height, workArea.height)

  return {
    width,
    height,
    x: Math.min(Math.max(bounds.x, workArea.x), workArea.x + workArea.width - width),
    y: Math.min(Math.max(bounds.y, workArea.y), workArea.y + workArea.height - height)
  }
}

export function saveUpdateBounds(directory: string, bounds: UpdateHandoffBounds): void {
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const temporary = path.join(directory, `bounds.${process.pid}.tmp`)
    writeFileSync(temporary, JSON.stringify({ bounds, startedAt: Date.now() }), { mode: 0o600 })
    renameSync(temporary, path.join(directory, 'bounds.json'))
  } catch {
    // A bounds preference never gates installing a verified update.
  }
}

export function readUpdateBounds(directory: string): UpdateHandoffBounds | null {
  // The first bridge release also consumes bounds written by the prior app.
  for (const name of ['bounds.json', 'handoff.json']) {
    const file = path.join(directory, name)
    try {
      const record = JSON.parse(readFileSync(file, 'utf8'))
      const age = Date.now() - record.startedAt
      rmSync(file, { force: true })
      if (typeof record.startedAt === 'number' && age >= 0 && age <= MAX_AGE_MS) {
        return finiteBounds(record.bounds)
      }
    } catch {
      // A missing or invalid layout can use the normal window placement.
    }
  }

  return null
}
