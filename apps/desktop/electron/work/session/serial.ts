/** Runs async jobs one at a time, in order. A failed job does not block the next. */
export class Serial {
  private tail: Promise<unknown> = Promise.resolve()

  run<T>(job: () => Promise<T>): Promise<T> {
    const result = this.tail.then(job, job)
    this.tail = result.catch(() => undefined)

    return result
  }
}
