/** A hatch can be grounded by a photo alone, while ordinary text-only hatches
 * should never wake the native picker. Keep this pure boundary shared by UI
 * enablement and the submit guard. */
export function canGenerateMatrixPet(prompt: string, hasPhoto: boolean): boolean {
  return prompt.length <= 300 && (Boolean(prompt.trim()) || hasPhoto)
}

/** The subsidized draft allowance (per person and platform-wide) resets at the next UTC
 * midnight after the server's clock; the person sees that moment in their own time. */
export function matrixPetRoundsResetAt(serverTime: string, locale: string, timeZone?: string): string {
  const now = new Date(serverTime)
  const base = Number.isNaN(now.getTime()) ? new Date() : now
  const reset = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + 1))

  return reset.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', ...(timeZone ? { timeZone } : {}) })
}
