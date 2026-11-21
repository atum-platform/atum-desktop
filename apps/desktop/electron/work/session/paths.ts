import { join } from 'node:path'

/**
 * Where lane R keeps its state. Everything here lives under the account's
 * `work` directory and OUTSIDE T3's home (`work/server`), so a SQLite restore
 * can never roll it back. The home layout is lane S's (`sidecar/process.ts`);
 * `WorkSession` asserts at runtime that a live incarnation's home equals
 * `paths.home`.
 */
export interface WorkSessionAccount {
  key: string
  generation: number
  root: string
}

export interface WorkSessionPaths {
  work: string
  /** T3CODE_HOME of the account's Work server. */
  home: string
  userdata: string
  database: string
  signingKey: string
  /** Durable "auth reset pending" marker (records restore completion). */
  marker: string
  update: string
  updateState: string
  snapshot: string
}

export function workSessionPaths(account: Pick<WorkSessionAccount, 'root'>): WorkSessionPaths {
  const work = join(account.root, 'work')
  const home = join(work, 'server')
  const userdata = join(home, 'userdata')
  const update = join(work, 'update')

  return {
    work,
    home,
    userdata,
    database: join(userdata, 'statev2.sqlite'),
    signingKey: join(userdata, 'secrets', 'server-signing-key.bin'),
    marker: join(work, 'auth-reset.json'),
    update,
    updateState: join(update, 'state.json'),
    snapshot: join(update, 'snapshot')
  }
}

export function partitionFor(accountKey: string): string {
  return `persist:atum-work-${accountKey}`
}
