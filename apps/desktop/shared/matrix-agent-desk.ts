/**
 * The agent's desk reads (`POST /api/host/desk`, platform 145de8f852 → G14 `/v1/shell/desk`):
 * read-only, owner-scoped views of a native Hermes agent's cloud home. Mirrors
 * `@atum/protocol` host-desk.ts exactly. Main owns the bearer and validates every reply; the
 * renderer names an agent principal and a read, nothing else.
 */
import { z } from 'zod'

// The contract refuses control characters in names and paths, exactly as `@atum/protocol` does.
/* eslint-disable no-control-regex */

export const MATRIX_HOST_DESK_MAX_BYTES = 64 * 1024

const basename = z
  .string()
  .min(1)
  .refine(name => !/[/\\\u0000]/u.test(name) && name !== '.' && name !== '..')

const relative = z
  .string()
  .max(2048)
  .refine(
    path =>
      path === path.normalize('NFC') &&
      !path.startsWith('/') &&
      !/[\u0000-\u001f\\]/u.test(path) &&
      !path.split('/').some(part => part === '..' || part === '.')
  )

/** `home[/…]` or `work[/…]`; omitted means home. */
export const MatrixHostDeskPathSchema = z
  .string()
  .max(2048)
  .refine(
    path =>
      path === path.normalize('NFC') &&
      !/[\u0000-\u001f\\]/u.test(path) &&
      !path.startsWith('/') &&
      !path.split('/').some(part => part === '..' || part === '.') &&
      /^(home|work)(\/[^/]+)*$/u.test(path)
  )

export type MatrixHostDeskRead = { read: 'schedule' } | { read: 'memory' } | { read: 'files'; path?: string }

const stamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const date = z.iso.datetime({ offset: true }).nullable()

export const MatrixHostDeskScheduleSchema = z
  .object({
    read: z.literal('schedule'),
    observedAt: stamp,
    jobs: z
      .array(
        z
          .object({
            id: z.string(),
            name: z.string(),
            kind: z.enum(['cron', 'interval', 'once']),
            display: z.string(),
            timezone: z.string().nullable(),
            state: z.enum(['scheduled', 'paused', 'running', 'completed', 'error']),
            nextRunAt: date,
            lastRunAt: date,
            lastStatus: z.enum(['ok', 'error']).nullable(),
            expr: z.string().nullable(),
            minutes: z.number().positive().nullable(),
            runAt: date
          })
          .strict()
      )
      .max(32),
    truncated: z.boolean()
  })
  .strict()

export const MatrixHostDeskFilesSchema = z
  .object({
    read: z.literal('files'),
    root: z.enum(['home', 'work']),
    path: relative,
    rows: z
      .array(
        z.object({ name: basename, kind: z.enum(['file', 'folder', 'link']), size: stamp, modifiedAt: stamp }).strict()
      )
      .max(200),
    truncated: z.boolean()
  })
  .strict()

export const MatrixHostDeskMemorySchema = z
  .object({
    read: z.literal('memory'),
    enabled: z.object({ memory: z.boolean(), user: z.boolean() }).strict(),
    notes: z.array(z.string()),
    aboutYou: z.array(z.string()),
    modifiedAt: stamp,
    truncated: z.boolean()
  })
  .strict()

export const MatrixHostDeskResponseSchema = z.discriminatedUnion('read', [
  MatrixHostDeskScheduleSchema,
  MatrixHostDeskFilesSchema,
  MatrixHostDeskMemorySchema
])

export type MatrixHostDeskSchedule = z.infer<typeof MatrixHostDeskScheduleSchema>
export type MatrixHostDeskFiles = z.infer<typeof MatrixHostDeskFilesSchema>
export type MatrixHostDeskMemory = z.infer<typeof MatrixHostDeskMemorySchema>
export type MatrixHostDeskResponse = z.infer<typeof MatrixHostDeskResponseSchema>

type ReplyFor<T extends MatrixHostDeskRead> = T extends { read: 'schedule' }
  ? MatrixHostDeskSchedule
  : T extends { read: 'memory' }
    ? MatrixHostDeskMemory
    : MatrixHostDeskFiles

/**
 * The agent's controls (`POST /api/host/agent-control`, platform 5b47b6eddc → G14 native cron
 * pause/resume with no catch-up). Mirrors `@atum/protocol` host-agent-control.ts exactly.
 */
export type MatrixHostAgentControl =
  | { action: 'pause' }
  | { action: 'resume' }
  | { action: 'routine_on'; job: string }
  | { action: 'routine_off'; job: string }

export const MatrixHostAgentControlRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('pause') }).strict(),
  z.object({ action: z.literal('resume') }).strict(),
  z.object({ action: z.literal('routine_on'), job: z.string().min(1).max(512) }).strict(),
  z.object({ action: z.literal('routine_off'), job: z.string().min(1).max(512) }).strict()
])

export const MatrixHostAgentControlResponseSchema = z
  .object({
    action: z.enum(['pause', 'resume', 'routine_on', 'routine_off']),
    changed: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
  })
  .strict()

export type MatrixHostAgentControlResponse = z.infer<typeof MatrixHostAgentControlResponseSchema>

/** Main's bridge for one of the owner's native Hermes agents, by principal. */
export interface MatrixAgentDeskBridge {
  read<T extends MatrixHostDeskRead>(agentPrincipal: string, request: T): Promise<ReplyFor<T>>
  /** Optional while the renderer and main can be upgraded on separate clocks. Rejects with
   * `matrix_host_control_stopped` when its runtime is stopped (409). */
  control?(agentPrincipal: string, request: MatrixHostAgentControl): Promise<MatrixHostAgentControlResponse>
}
/* eslint-enable no-control-regex */
