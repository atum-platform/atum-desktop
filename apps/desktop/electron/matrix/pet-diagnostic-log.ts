import { formatMatrixPetDiagnostic, parseMatrixPetDiagnostic } from '../../shared/matrix-pet-diagnostic'

/** The most companion lines one budget window may write; the window already rate-limits its
 * own, so this only bounds a renderer gone wrong. */
export const MATRIX_PET_LOG_BUDGET = 120
export const MATRIX_PET_LOG_BUDGET_MS = 10 * 60_000
/** The same line again, straight after itself, within this long is folded into it. */
export const MATRIX_PET_LOG_REPEAT_MS = 10_000

/**
 * The chat companion's lifecycle in main.log (0.19.4: "Nothing about the pet is ever logged").
 * Only a line that is exactly the closed shape is written (`parseMatrixPetDiagnostic`); the same
 * line twice in a row within seconds is one (counted on its next write as `count=N`), and a
 * budget bounds the rest, saying how many it dropped (`dropped=N`) on the next line it writes.
 * Only a repeat straight after itself folds: a line that comes back after another (idle, failed,
 * idle) is always written, so the last line says where she is now.
 */
export class MatrixPetDiagnosticLog {
  private windowStart = Number.NEGATIVE_INFINITY
  private used = 0
  private dropped = 0
  private last: { line: string; at: number; since: number } | undefined

  constructor(
    private readonly write: (line: string) => void,
    private readonly now: () => number = Date.now
  ) {}

  observe(value: unknown): void {
    const parsed = parseMatrixPetDiagnostic(value)

    if (!parsed) {
      return
    }

    const line = formatMatrixPetDiagnostic(parsed)
    const at = this.now()
    const last = this.last

    if (last?.line === line && at - last.at < MATRIX_PET_LOG_REPEAT_MS) {
      last.since += 1

      return
    }

    const folded = last?.line === line ? last.since : 0
    this.last = { line, at, since: 0 }
    this.budgeted(folded ? `${line} count=${folded + 1}` : line)
  }

  private budgeted(line: string): void {
    const at = this.now()

    if (at - this.windowStart >= MATRIX_PET_LOG_BUDGET_MS) {
      this.windowStart = at
      this.used = 0
    }

    if (this.used >= MATRIX_PET_LOG_BUDGET) {
      this.dropped += 1

      return
    }

    this.used += 1
    const dropped = this.dropped
    this.dropped = 0
    this.write(dropped ? `${line} dropped=${dropped}` : line)
  }
}
