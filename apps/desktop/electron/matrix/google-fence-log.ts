import { formatMatrixGoogleFenceFailure } from './google-fence'
import { MatrixWindowedLog } from './windowed-log'

// Kept apart from google-fence.ts on purpose: that module is also loaded by
// scripts/prove-local-brain.mjs under Node's type stripping, which cannot resolve an
// extensionless value import, so it must hold type-only imports.
/**
 * The fence's diagnostics: the first of each distinct failure, then at most one line per
 * window, which says how many there were since the last line (`count=N`, this one included).
 * The formatter's lines are a closed set, so this keeps a handful of entries at most; a failure
 * that repeats on every sync (an older server without the route: 12,000 lines a Mac in 0.18.2)
 * no longer buries the rest of the log.
 */
export class MatrixGoogleFenceLog {
  private readonly log: MatrixWindowedLog

  constructor(write: (line: string) => void, windowMs = 10 * 60_000, now: () => number = Date.now) {
    this.log = new MatrixWindowedLog(write, windowMs, now)
  }

  failure(error: unknown): void {
    this.log.line(formatMatrixGoogleFenceFailure(error))
  }
}
