/** Keeps idempotency IDs stable while the person retries the same visible intent. */
export class CloudIntents {
  private readonly ids = new Map<string, string>()
  constructor(private readonly newId: () => string = () => crypto.randomUUID()) {}
  requestId(intent: string): string {
    let id = this.ids.get(intent)
    if (!id) { id = this.newId(); this.ids.set(intent, id) }
    return id
  }
}
