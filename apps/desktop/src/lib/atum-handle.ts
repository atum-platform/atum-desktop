/**
 * Atum usernames (handles), shared by the sign-up step and the account dialog.
 *
 * The rule is the hosted plane's: 3–32 characters, lowercase ASCII letters,
 * digits or hyphens, starting with a letter or digit. The plane rejects any
 * input that is not already lowercase and trimmed rather than normalizing it,
 * so the client normalizes before every check and every save.
 */
export const ATUM_HANDLE_PATTERN = /^[a-z0-9][a-z0-9-]{2,31}$/u

const COMBINING_MARKS = /[̀-ͯ]/gu
const D_WITH_STROKE = /[đĐ]/gu

/** What the person typed, as the plane will see it: no `@`, lowercase, trimmed. */
export function normalizeHandleInput(raw: string): string {
  return raw.trim().replace(/^@+/u, '').toLowerCase()
}

export function isValidHandle(value: string): boolean {
  return ATUM_HANDLE_PATTERN.test(value)
}

/**
 * A starting point for "choose your username": the person's name folded to
 * the handle alphabet (`Nguyễn An Anh` → `nguyen-minh-anh`, `fixture-0b018cf98a@example.invalid` →
 * `minh`). Returns `''` when nothing usable survives, so callers fall back
 * to the plane's auto-generated handle rather than inventing one.
 */
export function suggestHandle(source: string | null | undefined): string {
  const local = (source ?? '').split('@')[0] ?? ''

  const folded = local
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .replace(D_WITH_STROKE, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 32)
    .replace(/-+$/u, '')

  return isValidHandle(folded) ? folded : ''
}
