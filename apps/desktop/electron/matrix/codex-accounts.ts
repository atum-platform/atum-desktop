import { type Dirent, mkdirSync, readdirSync } from 'node:fs'
import path from 'node:path'

/**
 * How many Atum accounts this Mac has held, and so where assistants keep a ChatGPT plan
 * sign-in (0.18.4 hotfix, ).
 *
 * 0.18.3 gave every Atum account its own ChatGPT sign-in folder (hermes-runtime.ts
 * `matrixAccountCodexScope`) so one account could never use another's plan. On the Mac most
 * people have, with one Atum account, that only cost them their sign-in: the one migration
 * cleared it, and nothing pointed the assistants at the sign-in they already had. So:
 *
 * - one account on this Mac: assistants use the Codex store exactly as 0.18.2 did (`shared`:
 *   no per-account override; packaged builds pin Hermes's shared folder, runtime-selection.ts);
 * - two or more: each account keeps its own (`account`), and its assistants sign in once.
 *
 * The record is `<userData>/accounts/<account key>/`: one folder per Atum account
 * (account.ts `appScope.accountKey`, a SHA-256 of the sign-in server, the person's subject
 * there and Atum's resource). The local brain has made that folder for every account whose
 * brain started on this Mac (local-brain.ts), and nothing ever removes it, not even sign-out;
 * every assistant launch now makes it too (`matrixCodexStoreMode`), so an account counts from
 * its first launch whether or not its brain ever ran. Only real folders named by a key count.
 */
export const MATRIX_ACCOUNTS_FOLDER = 'accounts'

const ACCOUNT_KEY = /^[a-f0-9]{64}$/

/** The Atum accounts this Mac has held, by account key. Missing folder: none. */
export function matrixAccountsOnThisMac(userData: string): string[] {
  let entries: Dirent[]

  try {
    entries = readdirSync(path.join(userData, MATRIX_ACCOUNTS_FOLDER), { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return []
    }

    throw error
  }

  return entries.filter(entry => entry.isDirectory() && ACCOUNT_KEY.test(entry.name)).map(entry => entry.name)
}

/** Count `accountKey` as one of this Mac's accounts from now on. Safe to repeat. */
export function rememberMatrixAccountOnThisMac(userData: string, accountKey: string): void {
  if (!ACCOUNT_KEY.test(accountKey)) {
    return
  }

  mkdirSync(path.join(userData, MATRIX_ACCOUNTS_FOLDER, accountKey), { recursive: true, mode: 0o700 })
}

export type MatrixCodexStoreMode = 'shared' | 'account'

/**
 * Where an assistant launch for the signed-in account (`accountKey`, when known) keeps its
 * ChatGPT sign-in, recording the account first. A folder that cannot be read or written keeps
 * accounts apart: never another account's sign-in, at worst one more sign-in.
 */
export function matrixCodexStoreMode(userData: string, accountKey?: string): MatrixCodexStoreMode {
  try {
    const known = new Set(matrixAccountsOnThisMac(userData))

    if (accountKey && ACCOUNT_KEY.test(accountKey)) {
      known.add(accountKey)
      rememberMatrixAccountOnThisMac(userData, accountKey)
    }

    return known.size >= 2 ? 'account' : 'shared'
  } catch {
    return 'account'
  }
}

/**
 * Whether an assistant launch keeps its ChatGPT sign-in in the shared store (a Mac that has held
 * one Atum account), recording the signed-in account first. No account read (`accountKey` gives
 * none or throws: signed out, a vault it cannot read, a launch for no account): never the shared
 * store, which may hold another account's sign-in. At worst, one more sign-in.
 */
export function matrixSharedCodexHere(userData: string, accountKey: () => string | undefined): boolean {
  let key: string | undefined

  try {
    key = accountKey()
  } catch {
    key = undefined
  }

  if (!key || !ACCOUNT_KEY.test(key)) {
    return false
  }

  return matrixCodexStoreMode(userData, key) === 'shared'
}
