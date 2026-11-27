/**
 * The first greeting's internal opening intent (atum-app `feat/first-run-backend`,
 * docs/session-logs/2026-11-27-first-run-backend.md): the owner's hidden first message to the new primary assistant, which then
 * writes its own welcome. `io.atum.first-run.greeting/1 en|vi`, optionally a space and the owner's display name (one line,
 * at most 80 characters). The window never shows it, and it is never the person's answer to anything (first-run naming).
 */
export const FIRST_RUN_GREETING_INTENT = 'io.atum.first-run.greeting/1'

const SEED = /^io\.atum\.first-run\.greeting\/1 (en|vi)(?: [^\n]{1,80})?$/u

export function isFirstRunGreetingSeed(body: unknown): boolean {
  return typeof body === 'string' && SEED.test(body)
}

/** The seed for this locale (English unless Vietnamese) and the owner's display name, trimmed to one short line. */
export function firstRunGreetingSeed(locale: string, displayName?: string): string {
  const language = locale === 'vi' ? 'vi' : 'en'
  const name = (displayName ?? '').replace(/\s+/gu, ' ').trim().slice(0, 80).trim()

  return name ? `${FIRST_RUN_GREETING_INTENT} ${language} ${name}` : `${FIRST_RUN_GREETING_INTENT} ${language}`
}
