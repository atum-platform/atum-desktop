/**
 * A diagnostic that may repeat on every sync, written so it never buries the rest of the log:
 * the first of each distinct line at once, then at most one per window, which says how many
 * there were since the last one written (`count=N`, that one included). Lines are a closed,
 * payload-free set chosen by the caller; the oldest entries are forgotten past `limit`.
 */
export class MatrixWindowedLog {
  private readonly written = new Map<string, { at: number; since: number }>()

  constructor(
    private readonly write: (line: string) => void,
    private readonly windowMs = 10 * 60_000,
    private readonly now: () => number = Date.now,
    private readonly limit = 500
  ) {}

  line(line: string): void {
    const at = this.now()
    const last = this.written.get(line)

    if (last && at - last.at < this.windowMs) {
      last.since += 1

      return
    }

    // A Map keeps insertion order: re-inserting moves this line last, so the oldest go first.
    this.written.delete(line)
    this.written.set(line, { at, since: 0 })

    while (this.written.size > this.limit) {
      this.written.delete(this.written.keys().next().value!)
    }

    this.write(last ? `${line} count=${last.since + 1}` : line)
  }
}
