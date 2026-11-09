/**
 * Device-local sudo (S1 build plan §3, WS-4 `device/sudo.ts`).
 *
 * `sudo` on a cloud-mode agent's device command is a device-local operation, never a relay: there is no
 * Hermes `sudo.request` on the cloud-mode path. The device service first takes one Touch ID for the
 * exact command (the protected `sudo` capability; since 2026-10-20 that Touch ID, and the password
 * below, are asked once per agent per task window, not per command: `ApprovalWindow`,
 * `SudoPasswordWindow`). Then a native password window owned by main asks
 * for the owner's password, and the host runs the approved argv under `sudo -S -k`, the password on
 * stdin. **The password is zeroed after use and never relayed** to the controller, the model or a log:
 * the agent never learns it.
 *
 * Deviation from the plan, forced by macOS (finding F6, `seatbelt.boundary.test.ts`): a setuid binary
 * cannot be executed inside any Seatbelt sandbox, so `sudo` cannot run "inside the same profile". The
 * owner-approved argv runs outside the profile, as root, which is what sudo means. To keep what runs
 * exactly what the owner read on the sheet, only one plain command is accepted: no shell operators,
 * expansions or redirections, no shells or nested privilege tools, no sudo options.
 */

export type SudoParse = { readonly ok: true; readonly argv: string[] } | { readonly ok: false; readonly reason: string }

const SHELL_SYNTAX = /[;&|<>`$(){}*?!\\\n\r#~]/
const NOT_RUNNABLE = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'tcsh', 'csh', 'su', 'sudo', 'doas', 'login', 'env', 'osascript'])

/** Split one plain `sudo …` command into the argv sudo will run, or say why it is not one. */
export function parseSudoCommand(command: string): SudoParse {
  const text = command.trim()

  if (!/^sudo\s/.test(text)) {
    return { ok: false, reason: 'not a sudo command' }
  }

  const words: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let started = false

  for (const char of text) {
    if (quote) {
      if (char === quote) {
        quote = null
      } else {
        current += char
      }

      continue
    }

    if (char === '"' || char === "'") {
      quote = char
      started = true

      continue
    }

    if (SHELL_SYNTAX.test(char)) {
      return { ok: false, reason: 'sudo runs one plain command: no shell operators, expansions or redirections' }
    }

    if (/\s/.test(char)) {
      if (started) {
        words.push(current)
        current = ''
        started = false
      }

      continue
    }

    current += char
    started = true
  }

  if (quote) {
    return { ok: false, reason: 'unbalanced quotes' }
  }

  if (started) {
    words.push(current)
  }

  const argv = words.slice(1)

  if (argv[0] === '--') {
    argv.shift()
  }

  if (!argv.length) {
    return { ok: false, reason: 'no command after sudo' }
  }

  if (argv[0].startsWith('-')) {
    return { ok: false, reason: 'sudo options are not supported on this Mac' }
  }

  if (NOT_RUNNABLE.has((argv[0].split('/').pop() ?? '').toLowerCase())) {
    return { ok: false, reason: `sudo will not start ${argv[0]} here: name the exact program to run` }
  }

  return { ok: true, argv }
}

export interface SudoResult {
  readonly state: 'completed' | 'failed_no_effect' | 'unknown'
  readonly result?: unknown
}

export interface DeviceSudoDeps {
  /** The native password window owned by main; null when the owner cancels. The returned buffer is the
   * only copy, and it is zeroed here after use. */
  promptPassword(command: string): Promise<Buffer | null>
  /** Pause the device while the window is up (the GUI broker refuses meanwhile). */
  setPaused(paused: boolean): void
  /** Run the argv as root through the device host (`device.sudo`). */
  run(argv: string[], password: string): Promise<SudoResult>
}

/**
 * Run one Touch-ID-approved `sudo` command: parse it, ask for the password, run it, zero the password.
 * A command that is not one plain invocation, or a cancelled window, has no effect.
 */
export async function runDeviceSudo(command: string, deps: DeviceSudoDeps): Promise<SudoResult> {
  const parsed = parseSudoCommand(command)

  if (parsed.ok === false) {
    return { state: 'failed_no_effect', result: { output: '', exit_code: -1, error: parsed.reason } }
  }

  deps.setPaused(true)
  let password: Buffer | null

  try {
    password = await deps.promptPassword(command)
  } finally {
    deps.setPaused(false)
  }

  if (!password) {
    return { state: 'failed_no_effect', result: { output: '', exit_code: -1, error: 'The owner cancelled the password prompt.' } }
  }

  try {
    return await deps.run(parsed.argv, password.toString('utf8'))
  } finally {
    password.fill(0)
  }
}

/**
 * The administrator password, asked once per agent per task window (owner decision 2026-10-20: "15
 * consecutive prompts" is unacceptable; sudo still asks for the password per macOS, but at most once per
 * window). The password stays in this process's memory only, for at most 30 minutes, and is zeroed when
 * the window ends, when a sudo run fails (a wrong password must not be replayed), and on every Stop.
 * `obtain` hands out a COPY each time, because `runDeviceSudo` zeroes the buffer it is given.
 */
export class SudoPasswordWindow {
  private held?: { agent: string; password: Buffer; timer: ReturnType<typeof setTimeout> }
  private pending?: { agent: string; promise: Promise<unknown> }
  private generation = 0

  constructor(private readonly windowMs: number = 30 * 60_000) {}

  async obtain(agent: string, prompt: () => Promise<Buffer | null>): Promise<Buffer | null> {
    if (this.held?.agent === agent) {
      return Buffer.from(this.held.password)
    }

    // A second sudo while the password window is up joins it; if the owner cancelled, it gets no password.
    if (this.pending?.agent === agent) {
      await this.pending.promise.catch(() => undefined)

      return this.held?.agent === agent ? Buffer.from(this.held.password) : null
    }

    this.forget()
    const generation = this.generation
    const promise = prompt()
    this.pending = { agent, promise }

    try {
      const password = await promise

      if (!password) {
        return null
      }

      const copy = Buffer.from(password)

      if (generation === this.generation) {
        const timer = setTimeout(() => this.forget(), this.windowMs)
        timer.unref?.()
        this.held = { agent, password, timer }
      } else {
        password.fill(0)
      }

      return copy
    } finally {
      if (this.pending?.promise === promise) {
        this.pending = undefined
      }
    }
  }

  /** Zero and drop the held password (window end, failed run, Stop). */
  forget(): void {
    this.generation += 1
    this.pending = undefined

    if (this.held) {
      clearTimeout(this.held.timer)
      this.held.password.fill(0)
      this.held = undefined
    }
  }
}
